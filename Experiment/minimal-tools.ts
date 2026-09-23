/**
 * minimal-tools — an experimental two-tool agent surface.
 *
 * The active tool set is reduced to `media` and `bash`:
 *
 * - `media` replaces `read`. It delegates to the built-in read tool, so text
 *   and images work today; the name signals the intended role, reading media
 *   the model cannot consume as text (audio, video).
 * - `bash` is everything else: `sed` and `patch` for file changes, plus `fd`,
 *   `rg`, and arbitrary commands.
 *
 * `read`, `write`, `edit`, `find`, `grep`, and `ls` are removed from the
 * active set. `media` and `bash` carry short descriptions so the prompt does
 * not advertise behavior the experiment drops.
 *
 * `bash` runs through `pi.exec` so its output is bounded: output longer than
 * `maxLines` lines is cut to the first and last half, with the dropped count
 * and a temp file holding the full output in a marker between them. Output with
 * few lines but too many bytes is cut at the byte budget instead. `bash` also
 * receives the same default `timeout` as pi-bash-timeout.
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
	createReadTool,
	type ExtensionAPI,
	isToolCallEventType,
	truncateHead,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	isExperimentEnabled,
	numberValue,
	readSection,
} from "../pi-tweaks-config";

const EXTENSION = "experiment-minimal-tools";
const MEDIA_TOOL = "media"; // replaces the built-in `read`
const DISABLED_TOOLS = new Set(["read", "write", "edit", "find", "grep", "ls"]);
const DEFAULT_BASH_TIMEOUT_SECONDS = 32; // when the model passes none
const DEFAULT_MAX_LINES = 1024; // total lines before truncating, split per end
const DEFAULT_MAX_BYTES = 32 * 1024; // total bytes before truncating
const MAX_TIMEOUT_SECONDS = 2147483647 / 1000; // 32-bit setTimeout ceiling
const TEMP_FILE_PREFIX = "pi-bash"; // matches the built-in bash tool

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

function resolveTimeoutSeconds(timeout: number | undefined, fallback: number) {
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

export default function (pi: ExtensionAPI) {
	if (!isExperimentEnabled(EXTENSION)) return;

	const section = readSection(EXTENSION);
	const timeoutSeconds = numberValue(
		section,
		"timeoutSeconds",
		DEFAULT_BASH_TIMEOUT_SECONDS,
		{ positive: true, atMost: MAX_TIMEOUT_SECONDS },
	);
	const maxLines = numberValue(section, "maxLines", DEFAULT_MAX_LINES, {
		positive: true,
		integer: true,
	});
	const maxBytes = numberValue(section, "maxBytes", DEFAULT_MAX_BYTES, {
		positive: true,
		integer: true,
	});

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

	pi.registerTool({
		name: "bash",
		label: "bash",
		description:
			"Execute a bash command in the current working directory. Returns stdout and stderr.",
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to execute" }),
			timeout: Type.Optional(
				Type.Number({ description: "Timeout in seconds" }),
			),
		}),
		promptSnippet: "Execute bash commands",
		promptGuidelines: [
			"You can inspect PI_* environment variables for current model and session details.",
		],
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const timeout = resolveTimeoutSeconds(params.timeout, timeoutSeconds);
			const result = await pi.exec("bash", ["-c", params.command], {
				cwd: ctx.cwd,
				signal,
				timeout: timeout * 1000,
			});
			const output = truncateOutput(combinedOutput(result), maxLines, maxBytes);
			const text = output || "(no output)";

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
	});

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

	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) {
			return;
		}
		if (event.input.timeout !== undefined) {
			return;
		}
		event.input.timeout = timeoutSeconds;
	});
}
