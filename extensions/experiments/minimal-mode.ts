/**
 * minimal-mode — an experimental reduced agent surface with a collapsed
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
 *   not advertise behavior the mode drops.
 *
 * - The `bash` row is collapsed:
 *   - Collapsed: one line — `$ ` plus the command, cut to the viewport width,
 *     and no output.
 *   - Expanded (`ctrl+o`, or a click on the row): the full command in the same
 *     row, then the output. The click is handled by the row, so it also works
 *     while the command is still streaming, before pi gives the call a result.
 *   - The collapsed row shows no output, successful or failed; a non-zero exit
 *     appears only in the suffix.
 *   - The command line ends with `(<time>, exit <code>, ~<tokens> tokens)`,
 *     dropping any part the config says is not worth showing: the time below
 *     `minSeconds`, `exit 0`, and a token estimate below `minTokens`, while
 *     `showExitCode` drops the exit code itself. With nothing left to show,
 *     the row keeps just the command. The time is the command's wall-clock
 *     time rounded to the nearest second, in Go's `time.Duration` format, and
 *     the estimate is four characters per token.
 *
 * `bash` runs through `pi.exec`, so its output is bounded: past `maxLines`
 * lines total or `maxBytes` bytes, the result keeps the head, a run from the
 * middle, and the tail, in this shape:
 *
 *    1 first line
 *    2 second line
 *    ...
 *    9 ninth line
 *   10 tenth line
 *    ...
 *   20 last line
 *   [the output was truncated, each line was prefixed with its absolute number,
 *   file: /tmp/pi-bash-<hex>.log]
 *
 * Every kept line is prefixed with its number in the original output, a line
 * reading `...` stands in for each run of dropped lines, and the footer names
 * the temp file holding the whole output, so an omitted part is one
 * `sed -n 'N,Mp' <file>` away. The line budget splits in three, and so does the
 * byte budget; a slice whose first line does not fit its share is cut. Both
 * budgets are fixed by the config, so the model cannot raise them for a call,
 * and there is no value that turns truncation off: a budget wide enough never
 * to be reached is the way to ask for the whole output. The command timeout
 * applies when the model passes none.
 *
 * stdout and stderr reach one pipe: the shell runs `exec 2>&1` before the
 * command, so the two streams arrive interleaved in the order a terminal would
 * show them, and a line number addresses that merged text. Nothing marks which
 * stream a line came from, and the whole output is held in memory before it is
 * bounded, since `pi.exec` returns a string.
 *
 * `pi-bash-timeout` fills the same `timeout`, so enable only one: with both on,
 * the value depends on extension load order. An extension cannot disable
 * another, so this one warns on `session_start` when pi-bash-timeout is still
 * on.
 *
 * Config, all under `experiment-minimal-mode` in `pi-tweaks.json`. With
 * `"enabled": true` the section has to list every option: `timeoutSeconds`
 * (seconds, at most 2147483.647), `maxLines` (lines in total, split across the
 * three slices), `maxBytes` (bytes in total), `minSeconds` (seconds, from
 * which the row shows the time), `minTokens` (tokens, from which it shows the
 * estimate), and `showExitCode` (whether it shows a non-zero exit code). The
 * mode changes what the model can do, so a fallback is a value the user never
 * chose: a missing option, or one that breaks its rule, registers nothing and
 * reports one error per problem at session start.
 *
 * The extension is listed in the package manifest, so pi loads it, but it
 * registers nothing until enabled by hand:
 *
 *   {
 *     "experiment-minimal-mode": {
 *       "enabled": true,
 *       "timeoutSeconds": 32,
 *       "maxLines": 1024,
 *       "maxBytes": 32768,
 *       "minSeconds": 2,
 *       "minTokens": 128,
 *       "showExitCode": true
 *     }
 *   }
 *
 * `"enabled": false`, a missing section, and any other value all leave it off
 * silently. See the Experiment README and pi-tweaks-config.ts.
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
} from "@earendil-works/pi-coding-agent";
import {
	MouseRegion,
	sliceByColumn,
	Text,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	isExperimentEnabled,
	readSection,
	type Section,
} from "../../lib/pi-tweaks-config";

const EXTENSION = "experiment-minimal-mode";
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
const DEFAULT_MIN_SECONDS = 2; // show the time from this many seconds on
const DEFAULT_MIN_TOKENS = 128; // show the estimate from this many tokens on
const DEFAULT_SHOW_EXIT_CODE = true; // show a non-zero exit code
const META_CAP = 200; // tool rows whose suffix data is kept

/** Resolved settings for the mode. */
interface MinimalModeOptions {
	timeoutSeconds: number;
	maxLines: number;
	maxBytes: number;
	minSeconds: number;
	minTokens: number;
	showExitCode: boolean;
}

/** The number-valued keys of the section. */
type NumberKey = {
	[K in keyof MinimalModeOptions]: MinimalModeOptions[K] extends number
		? K
		: never;
}[keyof MinimalModeOptions];

/** The boolean-valued keys of the section. */
type FlagKey = {
	[K in keyof MinimalModeOptions]: MinimalModeOptions[K] extends boolean
		? K
		: never;
}[keyof MinimalModeOptions];

/** One option the section has to set. */
type OptionRule<K extends keyof MinimalModeOptions> = {
	/** Key in the section, and the name an error message uses. */
	key: K;
	/** The rule, as an error message states it. */
	rule: string;
	/** Whether a present value satisfies the rule; narrows it to its type. */
	accepts: (value: unknown) => value is MinimalModeOptions[K];
};

/**
 * Every number-valued option of the section, in error-message order. The guard
 * holds the rule, so an error message and the check that produced it cannot
 * drift apart.
 */
const REQUIRED_NUMBERS: readonly OptionRule<NumberKey>[] = [
	{
		key: "timeoutSeconds",
		rule: `a positive number of seconds, at most ${MAX_TIMEOUT_SECONDS}`,
		accepts: (value): value is number =>
			typeof value === "number" &&
			Number.isFinite(value) &&
			value > 0 &&
			value <= MAX_TIMEOUT_SECONDS,
	},
	{
		key: "maxLines",
		rule: "a positive integer",
		accepts: (value): value is number =>
			typeof value === "number" && Number.isInteger(value) && value > 0,
	},
	{
		key: "maxBytes",
		rule: "a positive integer",
		accepts: (value): value is number =>
			typeof value === "number" && Number.isInteger(value) && value > 0,
	},
	{
		key: "minSeconds",
		rule: "a non-negative number of seconds",
		accepts: (value): value is number =>
			typeof value === "number" && Number.isFinite(value) && value >= 0,
	},
	{
		key: "minTokens",
		rule: "a non-negative integer",
		accepts: (value): value is number =>
			typeof value === "number" && Number.isInteger(value) && value >= 0,
	},
];

/** Every boolean-valued option of the section, read after the numbers. */
const REQUIRED_FLAGS: readonly OptionRule<FlagKey>[] = [
	{
		key: "showExitCode",
		rule: "a boolean",
		accepts: (value): value is boolean => typeof value === "boolean",
	},
];

/**
 * The problems with the `experiment-minimal-mode` section, for `/pi-tweaks
 * list`, which cannot see this module's state. The file is read here rather
 * than shared, because pi gives each extension its own module cache. An empty
 * list means the section is complete; a section that is off reports nothing.
 */
export function minimalModeConfigErrors(): string[] {
	if (!isExperimentEnabled(EXTENSION)) return [];
	const config = readConfig(readSection(EXTENSION));
	return config.kind === "errors" ? config.messages : [];
}

/** The settings of the section, or the problems that stop them being read. */
type MinimalModeConfig =
	| { kind: "options"; options: MinimalModeOptions }
	| { kind: "errors"; messages: string[] };

/** One message for an option the section does not set to an accepted value. */
function optionError(key: string, rule: string, value: unknown): string {
	return value === undefined
		? `${EXTENSION}: "${key}" is missing; with "enabled": true the section must set it to ${rule}`
		: `${EXTENSION}: "${key}" is ${JSON.stringify(value)}, but it must be ${rule}`;
}

/** Read one table of options into `options`, one message per problem. */
function readOptions<K extends keyof MinimalModeOptions>(
	list: readonly OptionRule<K>[],
	section: Section | null,
	options: MinimalModeOptions,
	messages: string[],
): void {
	for (const option of list) {
		const value = section?.[option.key];
		if (value !== undefined && option.accepts(value)) {
			options[option.key] = value;
		} else {
			messages.push(optionError(option.key, option.rule, value));
		}
	}
}

/**
 * Read the section strictly: with `"enabled": true` every option has to be
 * listed and satisfy its rule. A section that omits one, or carries a value
 * that breaks its rule, comes back as one message per problem, and the caller
 * registers nothing.
 */
function readConfig(section: Section | null): MinimalModeConfig {
	const options: MinimalModeOptions = {
		timeoutSeconds: DEFAULT_BASH_TIMEOUT_SECONDS,
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
		minSeconds: DEFAULT_MIN_SECONDS,
		minTokens: DEFAULT_MIN_TOKENS,
		showExitCode: DEFAULT_SHOW_EXIT_CODE,
	};
	const messages: string[] = [];
	readOptions(REQUIRED_NUMBERS, section, options, messages);
	readOptions(REQUIRED_FLAGS, section, options, messages);
	// The starting values only give `options` its type; a section that reached
	// them with a value missing never gets here.
	return messages.length > 0
		? { kind: "errors", messages }
		: { kind: "options", options };
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

/** One run of kept lines: where it starts in the original output, and its text. */
type KeptRun = {
	/** 1-based number of the first kept line. */
	start: number;
	/** The kept lines, each prefixed with its own number. */
	lines: string[];
};

/** Slices a truncated result shows: a head, a run from the middle, and a tail. */
const SLICES = 3;

/** Bytes the ellipsis costs, so a cut line can be held to its budget. */
const ELLIPSIS_BYTES = Buffer.byteLength(ELLIPSIS);

/** The prefix that makes a line addressable: its number, right-aligned, and a tab. */
function numbered(number: number, width: number, line: string): string {
	return `${String(number).padStart(width)}\t${line}`;
}

/** The first `budget` bytes of `text`, dropping a character the cut splits. */
function headBytes(text: string, budget: number): string {
	const bytes = Buffer.from(text, "utf8").subarray(0, Math.max(0, budget));
	return new TextDecoder("utf-8").decode(bytes, { stream: true });
}

/**
 * The last `budget` bytes of `text`. A character the cut splits becomes a
 * replacement character, which is the price of not scanning the whole line.
 */
function tailBytes(text: string, budget: number): string {
	const bytes = Buffer.from(text, "utf8");
	return new TextDecoder("utf-8").decode(
		bytes.subarray(Math.max(0, bytes.length - budget)),
	);
}

/**
 * Take lines from one end of the offered range while they fit `budget` bytes,
 * numbering each one. A range whose first line does not fit keeps that line cut
 * to the budget, so a slice always shows something; the caller drops a run with
 * no lines. The kept lines are contiguous, so the caller can turn the numbers
 * around them into the omitted ranges.
 */
function takeLines(
	lines: readonly string[],
	first: number,
	count: number,
	budget: number,
	width: number,
	fromEnd: boolean,
): KeptRun | undefined {
	const kept: string[] = [];
	let bytes = 0;
	for (let offset = 0; offset < count; offset += 1) {
		const number = fromEnd ? first + count - 1 - offset : first + offset;
		const text = lines[number - 1];
		const cost = Buffer.byteLength(numbered(number, width, text));
		if (bytes + cost <= budget) {
			kept.push(numbered(number, width, text));
			bytes += cost;
			continue;
		}
		if (kept.length === 0) {
			const room = Math.max(0, budget - width - ELLIPSIS_BYTES - 1);
			const cut = fromEnd
				? `${ELLIPSIS}${tailBytes(text, room)}`
				: `${headBytes(text, room)}${ELLIPSIS}`;
			kept.push(numbered(number, width, cut));
		}
		break;
	}
	if (fromEnd) kept.reverse();
	if (kept.length === 0) return undefined;
	// Taking from the end leaves a run that no longer starts where the range did.
	const start = fromEnd ? first + count - kept.length : first;
	return { start, lines: kept };
}

/** The line that stands in for a run of dropped lines. */
const OMITTED_LINE = "...";

/**
 * The line that closes a truncated result. It names the file holding the whole
 * output and the numbering the kept lines carry, which is all a `sed -n 'N,Mp'`
 * against that file needs.
 */
function truncationFooter(file: string): string {
	return `[the output was truncated, each line was prefixed with its absolute number, file: ${file}]`;
}

/**
 * Keep the head, a run from the middle, and the tail of `output` once it
 * exceeds `maxLines` lines or `maxBytes` bytes. Every kept line carries its
 * number in the original output, a line reading `...` stands in for each run of
 * dropped lines, and a footer names the temp file holding the whole output, so
 * an omitted part is one `sed -n 'N,Mp' <file>` away. The line budget splits in
 * three, and so does the byte budget, which is what keeps all three slices in
 * the result.
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

	const total = lines.length;
	const width = String(total).length;
	// Few lines but too many bytes: the byte budget is what binds, and the line
	// budget only caps it. The head takes the remainder, and the tail never
	// takes lines the head has already spent, so one or two lines still split.
	const shown = Math.min(maxLines, total);
	const share = Math.ceil(shown / SLICES);
	const headCount = Math.min(share, shown);
	const tailCount = Math.min(share, Math.max(0, shown - headCount));
	const centerCount = Math.max(0, shown - headCount - tailCount);

	// The middle slice sits at the centre of what the head and the tail leave.
	const freeFirst = headCount + 1;
	const freeCount = Math.max(0, total - headCount - tailCount);
	const centerFirst =
		freeFirst + Math.floor(Math.max(0, freeCount - centerCount) / 2);
	const centerLines = Math.min(centerCount, freeCount);

	const byteShare = Math.floor(maxBytes / SLICES);
	const budget = [maxBytes - byteShare * (SLICES - 1), byteShare, byteShare];

	const runs = [
		takeLines(lines, 1, headCount, budget[0], width, false),
		takeLines(lines, centerFirst, centerLines, budget[1], width, false),
		takeLines(lines, total - tailCount + 1, tailCount, budget[2], width, true),
	].filter((run): run is KeptRun => run !== undefined);

	// The numbers around a gap say what the gap holds, so it needs no range of
	// its own; the footer names the file and closes the result.
	const parts: string[] = [];
	let next = 1;
	for (const run of runs) {
		if (run.start > next) parts.push(OMITTED_LINE);
		parts.push(...run.lines);
		next = run.start + run.lines.length;
	}
	if (next <= total) parts.push(OMITTED_LINE);
	parts.push(truncationFooter(file));
	return parts.join("\n");
}

/**
 * The merged output, trimmed. The command runs after `exec 2>&1`, so both
 * streams reach one pipe; the join is a safety net for output that escapes the
 * redirection, such as a parse error bash reports before running it.
 */
function combinedOutput(result: { stdout: string; stderr: string }): string {
	return [result.stdout, result.stderr]
		.filter((stream) => stream.trim())
		.join("\n")
		.trim();
}

/**
 * The command as the shell runs it: stderr is pointed at stdout first, so the
 * two streams reach one pipe and arrive in the order a terminal would show
 * them. The newline keeps a trailing comment from swallowing the redirection.
 */
function mergedCommand(command: string): string {
	return `exec 2>&1\n${command}`;
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
	options: MinimalModeOptions,
): ToolDefinition<typeof BASH_PARAMETERS, BashToolDetails | undefined> {
	return {
		name: "bash",
		label: "bash",
		description:
			"Execute a bash command in the current working directory. Returns stdout and stderr merged in arrival order, as a terminal shows them.",
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
			const result = await pi.exec(
				"bash",
				["-c", mergedCommand(params.command)],
				{
					cwd: ctx.cwd,
					signal,
					timeout: timeout * 1000,
				},
			);
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

/** Row-local expansion state, shared by the call and result slots. */
interface RowState {
	/** Effective expansion for this row. */
	expanded?: boolean;
	/** The last `context.expanded` seen, to notice a `ctrl+o` change. */
	global?: boolean;
}

/** The slice of the render context that row expansion needs. */
interface RowContext {
	state: RowState;
	expanded: boolean;
	invalidate: () => void;
}

/**
 * Whether the row shows the full command and its output.
 *
 * `ctrl+o` owns `context.expanded`, while a click writes the row-local value,
 * so the two are resynced whenever the global flag changes.
 */
function rowExpanded(context: RowContext): boolean {
	const state = context.state;
	if (state.global !== context.expanded) {
		state.global = context.expanded;
		state.expanded = context.expanded;
	}
	return state.expanded ?? context.expanded;
}

/**
 * Toggle the row from a left click.
 *
 * Pi hands a click to `renderCall`'s component only once the call has a result,
 * so a row that leaves the click to pi cannot be expanded while the command is
 * still streaming. Handling the click here keeps the row toggleable for the
 * whole life of the call.
 */
function rowClick(context: RowContext) {
	return (event: TuiMouseEvent) => {
		if (event.type !== "click" || event.button !== "left") return undefined;
		context.state.expanded = !rowExpanded(context);
		context.invalidate();
		return { handled: true };
	};
}

type BashRenderers = Pick<
	ToolDefinition<typeof BASH_PARAMETERS, BashToolDetails | undefined>,
	"renderCall" | "renderResult"
>;

export default function (pi: ExtensionAPI) {
	if (!isExperimentEnabled(EXTENSION)) return;

	const config = readConfig(readSection(EXTENSION));
	if (config.kind === "errors") {
		// The runtime is not available during load, so the errors wait for the
		// first session; registering nothing is what leaves the mode off.
		pi.on("session_start", (_event, ctx) => {
			for (const message of config.messages) {
				ctx.ui.notify(message, "error");
			}
		});
		return;
	}

	const options = config.options;

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
		// in place and the result slot stays free of it. The click is handled on
		// the row itself so it also works before the call has a result.
		renderCall(args, theme, context) {
			const prefix = `${theme.fg("toolTitle", theme.bold("$"))} `;
			const info = bashMeta.get(context.toolCallId);
			const parts: string[] = [];
			if (info) {
				if (info.elapsedNs >= options.minSeconds * SECOND) {
					parts.push(goDuration(roundToSecond(info.elapsedNs)));
				}
				if (options.showExitCode && info.code !== 0) {
					parts.push(`exit ${info.code}`);
				}
				if (info.tokens >= options.minTokens) {
					parts.push(`~${info.tokens} tokens`);
				}
			}
			const suffix =
				parts.length > 0 ? theme.fg("muted", ` (${parts.join(", ")})`) : "";
			const command = args.command ?? "";
			const onMouse = rowClick(context);

			// Expanded keeps the whole command, which may wrap. Collapsed fills
			// one line and cuts the command, never the suffix.
			if (rowExpanded(context)) {
				return new MouseRegion(
					new Text(
						`${prefix}${theme.fg("accent", command.trim())}${suffix}`,
						0,
						0,
					),
					onMouse,
				);
			}
			return new MouseRegion(
				new BashCallRow(prefix, collapse(command), suffix, (text) =>
					theme.fg("accent", text),
				),
				onMouse,
			);
		},

		renderResult(result, _options, theme, context) {
			const output = resultText(result);

			if (!rowExpanded(context) || !output) {
				return new Text("", 0, 0);
			}

			return new Text(theme.fg("toolOutput", output), 0, 0);
		},
	};

	pi.registerTool({ ...boundedBashTool(pi, options), ...renderers });

	// The runtime is not available during load, so the first application waits
	// for `session_start` (which also fires on `/reload`).
	pi.on("session_start", (_event, ctx) => {
		if (readSection("pi-bash-timeout")?.enabled !== false) {
			ctx.ui.notify(
				"experiment-minimal-mode: pi-bash-timeout is enabled in pi-tweaks.json and sets the same default bash timeout; disable it there so only one extension owns that value.",
				"warning",
			);
		}
		const active = pi
			.getActiveTools()
			.filter((name) => !DISABLED_TOOLS.has(name));
		pi.setActiveTools([...new Set([...active, MEDIA_TOOL])]);
	});
}
