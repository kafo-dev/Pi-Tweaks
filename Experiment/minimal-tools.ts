/**
 * minimal-tools — an experimental reduced agent surface with a collapsed
 * `bash` row.
 *
 * One switch enables two behaviors:
 *
 * - The active tool set is reduced to `media` and `bash`:
 *   - `media` replaces `read`. It delegates to the built-in read tool, so text
 *     and images work today; the name signals the intended role, reading media
 *     the model cannot consume as text (audio, video).
 *   - `bash` is everything else: `sed` and `patch` for file changes, plus
 *     `fd`, `rg`, and arbitrary commands.
 *
 *   `read`, `write`, `edit`, `find`, `grep`, and `ls` are removed from the
 *   active set. `media` and `bash` carry short descriptions so the prompt does
 *   not advertise behavior the experiment drops.
 *
 * - The `bash` row is collapsed:
 *   - Collapsed: one line — `$ ` plus the command, cut to the viewport width,
 *     and no output.
 *   - Expanded (`ctrl+o`): the full command in the same row, then the output.
 *   - The collapsed row shows no output, successful or failed; a non-zero exit
 *     appears only in the suffix.
 *   - The command line ends with `(<time>, exit <code>, ~<tokens> tokens)`,
 *     dropping any part not worth showing: the time below two seconds,
 *     `exit 0`, and a token estimate below 128. With nothing left to show, the
 *     row keeps just the command. The time is the command's wall-clock time
 *     rounded to the nearest second, in Go's `time.Duration` format, and the
 *     estimate is four characters per token.
 *
 * `bash` runs through `pi.exec`, so its output is bounded: past `maxLines`
 * lines total (default 1024, split 512 at each end) or `maxBytes` bytes
 * (default 32768), the middle is dropped and the full output is written to a
 * temp file named in the marker. Output with few lines but too many bytes is
 * cut at the byte budget instead. The command timeout defaults to
 * `timeoutSeconds` (32) when the model passes none.
 *
 * `pi-bash-timeout` fills the same `timeout`, so enable only one: with both on,
 * the value depends on extension load order. An extension cannot disable
 * another, so this one warns on `session_start` when pi-bash-timeout is still
 * on.
 *
 * Config, all under `experiment-minimal-tools` in `pi-tweaks.json`:
 * `timeoutSeconds` (32), `maxLines` (1024, 512 at each end), and `maxBytes`
 * (32768).
 *
 * The extension is listed in the package manifest, so pi loads it, but it
 * registers nothing until enabled by hand:
 *
 *   { "experiment-minimal-tools": { "enabled": true } }
 *
 * `"enabled": false`, a missing section, and any other value all leave it off.
 * See the Experiment README and pi-tweaks-config.ts.
 */

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BashToolDetails,
	createReadTool,
	type ExtensionAPI,
	type ToolDefinition,
	truncateHead,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import {
	sliceByColumn,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	isExperimentEnabled,
	numberValue,
	readSection,
	type Section,
} from "../pi-tweaks-config";

const EXTENSION = "experiment-minimal-tools";
const MEDIA_TOOL = "media"; // replaces the built-in `read`
const DISABLED_TOOLS = new Set(["read", "write", "edit", "find", "grep", "ls"]);

const DEFAULT_BASH_TIMEOUT_SECONDS = 32; // when the model passes none
const DEFAULT_MAX_LINES = 1024; // total lines before truncating, split per end
const DEFAULT_MAX_BYTES = 32 * 1024; // total bytes before truncating
const MAX_TIMEOUT_SECONDS = 2147483647 / 1000; // 32-bit setTimeout ceiling
const TEMP_FILE_PREFIX = "pi-bash"; // matches the built-in bash tool
const ELLIPSIS = "…"; // one cell wide, unlike "..."

const NANOSECOND = 1;
const MICROSECOND = 1000 * NANOSECOND;
const MILLISECOND = 1000 * MICROSECOND;
const SECOND = 1000 * MILLISECOND;
const CHARS_PER_TOKEN = 4; // rough token estimate for the row suffix
const MIN_SHOWN_SECONDS = 2; // omit the time below this
const MIN_SHOWN_TOKENS = 128; // omit the token estimate below this
const META_CAP = 200; // tool rows whose suffix data is kept

/** Resolved settings for the experiment. */
interface MinimalToolsOptions {
	timeoutSeconds: number;
	maxLines: number;
	maxBytes: number;
}

/** The settings of the `experiment-minimal-tools` section, with defaults. */
function minimalToolsOptions(section: Section | null): MinimalToolsOptions {
	return {
		timeoutSeconds: numberValue(
			section,
			"timeoutSeconds",
			DEFAULT_BASH_TIMEOUT_SECONDS,
			{ positive: true, atMost: MAX_TIMEOUT_SECONDS },
		),
		maxLines: numberValue(section, "maxLines", DEFAULT_MAX_LINES, {
			positive: true,
			integer: true,
		}),
		maxBytes: numberValue(section, "maxBytes", DEFAULT_MAX_BYTES, {
			positive: true,
			integer: true,
		}),
	};
}

// One read tool per cwd, created lazily and reused across calls.
const readTools = new Map<string, ReturnType<typeof createReadTool>>();

function readTool(cwd: string): ReturnType<typeof createReadTool> {
	const cached = readTools.get(cwd);
	if (cached !== undefined) {
		return cached;
	}
	const created = createReadTool(cwd);
	readTools.set(cwd, created);
	return created;
}

/** Collapse whitespace so the command fits on one line. */
function collapse(command: string): string {
	return command.replace(/\s+/g, " ").trim();
}

/** Split the last `prec` decimal digits of `v` into a trimmed fraction. */
function fmtFrac(v: number, prec: number): { int: number; frac: string } {
	let print = false;
	let frac = "";
	let n = v;
	for (let i = 0; i < prec; i++) {
		const digit = n % 10;
		print = print || digit !== 0;
		if (print) frac = `${digit}${frac}`;
		n = Math.floor(n / 10);
	}
	return { int: n, frac: print ? `.${frac}` : "" };
}

/** Round nanoseconds to the nearest whole second, halves up (Go's Round). */
function roundToSecond(ns: number): number {
	const rest = ns % SECOND;
	return 2 * rest < SECOND ? ns - rest : ns + (SECOND - rest);
}

/** Format nanoseconds like Go's `time.Duration.String()`. */
function goDuration(ns: number): string {
	const u = Math.max(0, Math.round(ns));
	if (u < SECOND) {
		if (u === 0) return "0s";
		let unit: string;
		let prec: number;
		if (u < MICROSECOND) {
			unit = "ns";
			prec = 0;
		} else if (u < MILLISECOND) {
			unit = "µs";
			prec = 3;
		} else {
			unit = "ms";
			prec = 6;
		}
		const { int, frac } = fmtFrac(u, prec);
		return `${int}${frac}${unit}`;
	}

	const { int, frac } = fmtFrac(u, 9);
	let rest = int;
	let out = `${rest % 60}${frac}s`;
	rest = Math.floor(rest / 60);
	if (rest > 0) {
		out = `${rest % 60}m${out}`;
		rest = Math.floor(rest / 60);
		if (rest > 0) {
			out = `${rest}h${out}`;
		}
	}
	return out;
}

/**
 * Cut plain text to `limit` columns, appending an ellipsis when it is cut.
 * `truncateToWidth` is not used here: it brackets the ellipsis with a full
 * reset (`\x1b[0m`), which clears the tool bar background for the ellipsis and
 * everything after it. Styling is applied to the sliced text instead.
 */
function fitPlain(text: string, limit: number): string {
	if (limit <= 0) return "";
	if (visibleWidth(text) <= limit) return text;
	const keep = Math.max(0, limit - visibleWidth(ELLIPSIS));
	return keep === 0
		? sliceByColumn(ELLIPSIS, 0, limit, true)
		: `${sliceByColumn(text, 0, keep, true)}${ELLIPSIS}`;
}

/** The call row: a prefix, a command cut to fit, and a suffix kept in view. */
class BashCallRow {
	private readonly prefix: string;
	private readonly command: string;
	private readonly suffix: string;
	private readonly accent: (text: string) => string;

	constructor(
		prefix: string,
		command: string,
		suffix: string,
		accent: (text: string) => string,
	) {
		this.prefix = prefix;
		this.command = command;
		this.suffix = suffix;
		this.accent = accent;
	}

	render(width: number): string[] {
		const room = Math.max(
			0,
			width - visibleWidth(this.prefix) - visibleWidth(this.suffix),
		);
		const line = `${this.prefix}${this.accent(fitPlain(this.command, room))}${this.suffix}`;
		// Only overflows when the suffix alone is wider than the row; the
		// common path stays free of resets so the tool bar background holds.
		return [
			visibleWidth(line) > width
				? truncateToWidth(line, width, ELLIPSIS)
				: line,
		];
	}

	invalidate(): void {
		// Nothing is cached; the row is rebuilt from the current width.
	}
}

/** Row suffix data for one bash call, filled in when the command finishes. */
interface BashMeta {
	elapsedNs: number;
	code: number;
	tokens: number;
}

// Keyed by tool call id so `renderCall` can read what `execute` measured. The
// row is redrawn when the result arrives, after `execute` has filled this in.
const bashMeta = new Map<string, BashMeta>();

function rememberBashMeta(toolCallId: string, value: BashMeta): void {
	bashMeta.set(toolCallId, value);
	if (bashMeta.size > META_CAP) {
		const oldest = bashMeta.keys().next().value;
		if (oldest !== undefined) bashMeta.delete(oldest);
	}
}

/** The text part of a tool result, or an empty string. */
function resultText(result: { content: readonly unknown[] }): string {
	const part = result.content.find(
		(entry): entry is { type: "text"; text: string } =>
			typeof entry === "object" &&
			entry !== null &&
			(entry as { type?: unknown }).type === "text",
	);
	return part?.text ?? "";
}

/**
 * Keep the head and the tail of `output` once it exceeds `maxLines` lines or
 * `maxBytes` bytes, writing the full text to a temp file named in the marker.
 * The line budget is split evenly between the two ends.
 */
function truncateOutput(
	output: string,
	maxLines: number,
	maxBytes: number,
): string {
	const lines = output ? output.split("\n") : [];
	if (lines.length <= maxLines && Buffer.byteLength(output) <= maxBytes) {
		return output;
	}

	const file = join(
		tmpdir(),
		`${TEMP_FILE_PREFIX}-${randomBytes(8).toString("hex")}.log`,
	);
	writeFileSync(file, output);

	// Few lines but too many bytes: cut at the byte budget. truncateHead is
	// line-oriented and returns nothing when the first line alone exceeds it, so
	// slice the encoded bytes; stream mode drops a character split by the cut.
	if (lines.length <= maxLines) {
		const bytes = Buffer.from(output, "utf8");
		const kept = new TextDecoder("utf-8").decode(bytes.subarray(0, maxBytes), {
			stream: true,
		});
		const omitted = bytes.length - Buffer.byteLength(kept, "utf8");
		return `${kept}\n[... ${omitted} bytes truncated; full output: ${file} ...]`;
	}

	const head = truncateHead(output, {
		maxLines: Math.max(1, Math.floor(maxLines / 2)),
		maxBytes: Math.max(1, Math.floor(maxBytes / 2)),
	});
	const tail = truncateTail(output, {
		maxLines: Math.max(1, Math.floor(maxLines / 2)),
		maxBytes: Math.max(1, Math.floor(maxBytes / 2)),
	});
	const omitted = lines.length - head.outputLines - tail.outputLines;
	return `${head.content}\n[... ${omitted} lines truncated; full output: ${file} ...]\n${tail.content}`;
}

function combinedOutput(result: { stdout: string; stderr: string }): string {
	return [result.stdout, result.stderr]
		.filter((stream) => stream.trim())
		.join("\n")
		.trim();
}

function resolveTimeoutSeconds(
	timeout: number | undefined,
	fallback: number,
): number {
	if (timeout === undefined) {
		return fallback;
	}
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("bash: timeout must be a positive finite number");
	}
	if (timeout > MAX_TIMEOUT_SECONDS) {
		throw new Error(
			`bash: timeout must be at most ${MAX_TIMEOUT_SECONDS} seconds`,
		);
	}
	return timeout;
}

const BASH_PARAMETERS = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});

/** The bounded `bash` tool: bounded output, and a default timeout. */
function boundedBashTool(
	pi: ExtensionAPI,
	options: MinimalToolsOptions,
): ToolDefinition<typeof BASH_PARAMETERS, BashToolDetails | undefined> {
	return {
		name: "bash",
		label: "bash",
		description:
			"Execute a bash command in the current working directory. Returns stdout and stderr.",
		parameters: BASH_PARAMETERS,
		promptSnippet: "Execute bash commands",
		promptGuidelines: [
			"You can inspect PI_* environment variables for current model and session details.",
		],
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const timeout = resolveTimeoutSeconds(
				params.timeout,
				options.timeoutSeconds,
			);
			const startedAt = process.hrtime.bigint();
			const result = await pi.exec("bash", ["-c", params.command], {
				cwd: ctx.cwd,
				signal,
				timeout: timeout * 1000,
			});
			const elapsedNs = Number(process.hrtime.bigint() - startedAt);
			const output = truncateOutput(
				combinedOutput(result),
				options.maxLines,
				options.maxBytes,
			);
			const text = output || "(no output)";
			rememberBashMeta(toolCallId, {
				elapsedNs,
				code: result.code,
				tokens: Math.ceil(text.length / CHARS_PER_TOKEN),
			});

			if (result.killed) {
				if (signal?.aborted) {
					throw new Error(`bash: aborted\n\n${text}`);
				}
				throw new Error(`bash: timed out after ${timeout}s\n\n${text}`);
			}
			if (result.code !== 0) {
				throw new Error(`${text}\n\n[exit code ${result.code}]`);
			}
			return {
				content: [{ type: "text", text }],
				details: {},
			};
		},
	};
}

type BashRenderers = Pick<
	ToolDefinition<typeof BASH_PARAMETERS, BashToolDetails | undefined>,
	"renderCall" | "renderResult"
>;

export default function (pi: ExtensionAPI) {
	if (!isExperimentEnabled(EXTENSION)) return;

	const options = minimalToolsOptions(readSection(EXTENSION));

	pi.registerTool({
		name: MEDIA_TOOL,
		label: MEDIA_TOOL,
		description:
			"Read the contents of a media file and send it as an attachment. Supports images (jpg, png, gif, webp, bmp).",
		parameters: Type.Object({
			path: Type.String({
				description: "Path to the file to read (relative or absolute)",
			}),
		}),
		promptSnippet: "Read media file contents",
		promptGuidelines: ["Use media to read files and view images."],
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return readTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
		},
	});

	const renderers: BashRenderers = {
		// The row is re-rendered on every expand toggle, so the command can grow
		// in place and the result slot stays free of it.
		renderCall(args, theme, context) {
			const prefix = `${theme.fg("toolTitle", theme.bold("$"))} `;
			const info = bashMeta.get(context.toolCallId);
			const parts: string[] = [];
			if (info) {
				if (info.elapsedNs >= MIN_SHOWN_SECONDS * SECOND) {
					parts.push(goDuration(roundToSecond(info.elapsedNs)));
				}
				if (info.code !== 0) parts.push(`exit ${info.code}`);
				if (info.tokens >= MIN_SHOWN_TOKENS) {
					parts.push(`~${info.tokens} tokens`);
				}
			}
			const suffix =
				parts.length > 0 ? theme.fg("muted", ` (${parts.join(", ")})`) : "";
			const command = args.command ?? "";

			// Expanded keeps the whole command, which may wrap. Collapsed fills
			// one line and cuts the command, never the suffix.
			if (context.expanded) {
				return new Text(
					`${prefix}${theme.fg("accent", command.trim())}${suffix}`,
					0,
					0,
				);
			}
			return new BashCallRow(prefix, collapse(command), suffix, (text) =>
				theme.fg("accent", text),
			);
		},

		renderResult(result, { expanded }, theme) {
			const output = resultText(result);

			if (!expanded) {
				return new Text("", 0, 0);
			}

			return output
				? new Text(theme.fg("toolOutput", output), 0, 0)
				: new Text("", 0, 0);
		},
	};

	pi.registerTool({ ...boundedBashTool(pi, options), ...renderers });

	// The runtime is not available during load, so the first application waits
	// for `session_start` (which also fires on `/reload`).
	pi.on("session_start", (_event, ctx) => {
		if (readSection("pi-bash-timeout")?.enabled !== false) {
			ctx.ui.notify(
				"experiment-minimal-tools: pi-bash-timeout is enabled in pi-tweaks.json and sets the same default bash timeout; disable it there so only one extension owns that value.",
				"warning",
			);
		}
		const active = pi
			.getActiveTools()
			.filter((name) => !DISABLED_TOOLS.has(name));
		pi.setActiveTools([...new Set([...active, MEDIA_TOOL])]);
	});
}
