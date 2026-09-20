/**
 * pi-timestamps — put the clock in the transcript, where the model can read it.
 *
 * A sent prompt gets a blank line and `[YYYY-Mon-DD HH:MM Ddd +1m30s]` appended, and the
 * answer gets the same stamp — the final assistant message of the run. The blank
 * line tells the model the stamp was inserted, not typed. The delta
 * is the time since the previous stamp, written the way Go prints a
 * `time.Duration` (`45s`, `1m30s`, `1h2m3s`, rounded to whole seconds), so the
 * model can see the pause between turns. The counter resets at each session
 * start, so a restart is visible as a stamp with no delta.
 * `registerMarkdownTransformer` removes the trailing stamp from the display, so
 * only the model reads it; the session and the model context keep it. A stamp
 * quoted mid-answer is prose, not the clock, so it stays visible. Messages that
 * stopped to call a tool are skipped, so only the answer carries a stamp. Both
 * live in the messages themselves, so the model can see when it last spoke and
 * when you last wrote.
 *
 * The stamp is appended, never prepended: pi matches "/cmd" and "/skill:name" on
 * the start of the input, and prepending would rewrite text the model has
 * already seen.
 *
 * A steering or follow-up message is left unstamped. It waits in a queue that
 * pi restores to the editor verbatim, so a stamp would come back as text the
 * user looks to have typed. The answer that follows still carries a stamp.
 *
 * A message that already ends in a stamp is left alone, so a handler left bound
 * by a reload cannot double-stamp through the chained input transform.
 *
 * Config: `"enabled": false` under `pi-timestamps` in `pi-tweaks.json` turns
 * the extension off; it has no other settings. See pi-tweaks-config.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isExtensionEnabled } from "./pi-tweaks-config";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/** 24-hour `16:52`. */
function clock(date: Date): string {
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `1h2m3s`, `1m0s`, `45s` — the shape of Go's `time.Duration.String()`, rounded to whole seconds. */
function goDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
	if (minutes > 0) return `${minutes}m${seconds}s`;
	return `${seconds}s`;
}

/** `[2026-Sep-17 16:52 Thu +1m30s]`; `elapsedMs` is null for the first stamp. */
function stamp(date: Date, elapsedMs: number | null): string {
	const day = `${date.getFullYear()}-${MONTHS[date.getMonth()]}-${pad(date.getDate())}`;
	const delta = elapsedMs === null ? "" : ` +${goDuration(elapsedMs)}`;
	return `[${day} ${clock(date)} ${WEEKDAYS[date.getDay()]}${delta}]`;
}

let previousStampMs: number | null = null;

/** Stamps `date` and remembers it as the previous stamp. */
function nextStamp(date: Date): string {
	const elapsedMs =
		previousStampMs === null
			? null
			: Math.max(0, date.getTime() - previousStampMs);
	previousStampMs = date.getTime();
	return stamp(date, elapsedMs);
}

/** Appends a stamp to `text`, unless it already ends in one. */
function withStamp(text: string): string {
	return TRAILING_STAMP.test(`\n${text}`)
		? text
		: `${text}\n\n${nextStamp(new Date())}`;
}

/** `[2026-Sep-17 16:52 Thu +1m30s]` — what the model reads. */
const STAMP =
	"\\[\\d{4}-[A-Za-z]{3}-\\d{2} \\d{2}:\\d{2} \\w{3}(?: \\+(?:\\d+h)?(?:\\d+m)?\\d+s)?\\]";
/** A stamp at the end of the text, on its own line or after a blank line. */
const TRAILING_STAMP = new RegExp(`\\n+${STAMP}$`);
/**
 * The trailing stamp and its newlines, plus the `<!-- -->` a legacy stamp may
 * wear. Anchored to the end: a stamp the model quotes mid-answer is prose, not
 * the clock, and must stay visible.
 */
const DISPLAY_STAMP = new RegExp(`\\n+(?:<!--\\s*${STAMP}\\s*-->|${STAMP})$`);

if (!TRAILING_STAMP.test(`\n${stamp(new Date(), null)}`)) {
	throw new Error("pi-timestamps: TRAILING_STAMP does not match stamp()");
}
const onceStamped = withStamp("hello");
if (withStamp(onceStamped) !== onceStamped) {
	throw new Error("pi-timestamps: withStamp is not idempotent");
}
const displayed = onceStamped.replace(DISPLAY_STAMP, "");
if (displayed !== "hello") {
	throw new Error("pi-timestamps: DISPLAY_STAMP does not hide the stamp");
}
const inlineStamp = `the stamp ${stamp(new Date(), null)} stays put`;
if (inlineStamp.replace(DISPLAY_STAMP, "") !== inlineStamp) {
	throw new Error(
		"pi-timestamps: DISPLAY_STAMP eats a stamp quoted mid-answer",
	);
}
const wrapped = `hello\n\n<!-- ${stamp(new Date(), 1000)} -->`;
if (wrapped.replace(DISPLAY_STAMP, "") !== "hello") {
	throw new Error("pi-timestamps: DISPLAY_STAMP leaves an empty HTML comment");
}
for (const [ms, want] of [
	[0, "0s"],
	[45_400, "45s"],
	[90_000, "1m30s"],
	[60_000, "1m0s"],
	[3_723_000, "1h2m3s"],
] as const) {
	if (goDuration(ms) !== want)
		throw new Error(`pi-timestamps: goDuration(${ms}) !== ${want}`);
	if (!TRAILING_STAMP.test(`\n${stamp(new Date(), ms)}`)) {
		throw new Error(`pi-timestamps: TRAILING_STAMP does not match +${want}`);
	}
}

/** Appends to the last text block. Returns null when there is nothing to stamp. */
function appendToLastText(
	content: unknown,
	suffix: () => string,
): unknown[] | null {
	if (!Array.isArray(content)) return null;

	const blocks = content as Array<Record<string, unknown>>;
	for (let index = blocks.length - 1; index >= 0; index -= 1) {
		const block = blocks[index];
		if (block?.type !== "text" || typeof block.text !== "string") continue;
		if (TRAILING_STAMP.test(block.text)) return null;
		const next = [...blocks];
		next[index] = { ...block, text: `${block.text}\n\n${suffix()}` };
		return next;
	}

	return null;
}

export default function timestamps(pi: ExtensionAPI) {
	if (!isExtensionEnabled("pi-timestamps")) return;

	// Hide the stamp from the reader: the session and the model context keep it.
	pi.registerMarkdownTransformer((markdown) =>
		markdown.replace(DISPLAY_STAMP, ""),
	);

	// A new session starts at zero, so the first stamp has no delta and the model
	// can tell a session boundary from a fresh start.
	pi.on("session_start", async () => {
		previousStampMs = null;
	});

	pi.on("input", async (event) => {
		if (event.source === "extension") return { action: "continue" };
		// A queued message must stay clean: pi restores the queue to the editor.
		if (event.streamingBehavior !== undefined) return { action: "continue" };
		return { action: "transform", text: withStamp(event.text) };
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		if (event.message.stopReason === "toolUse") return;

		const content = event.message.content;
		const blocks = appendToLastText(content, () => nextStamp(new Date()));
		if (!blocks) return;
		return { message: { ...event.message, content: blocks as typeof content } };
	});
}
