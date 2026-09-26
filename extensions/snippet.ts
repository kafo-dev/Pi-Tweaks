/**
 * snippet — copy a code block from the conversation to the system clipboard.
 *
 * `/snippet` opens a picker over the code shown in the current session: one tab
 * for fenced code blocks, one for inline code spans. Tab switches between them
 * (arrow left/right too), and the most recently printed block comes first.
 * A fenced block is listed with its language and its first and last lines
 * ("python: import matplotlib … # vi: ft=python"); an inline span with its
 * text. Enter copies the selection to the system clipboard — the text between
 * the markers only, without the backticks or the language mark — and closes the
 * picker. Escape closes it without copying.
 *
 * The source is the text of user and assistant messages on the active branch.
 * Tool results and tool-call arguments are not read: a file the agent wrote is
 * already on disk, and a `read` result would bury the conversation's own code.
 *
 * Config: `"enabled": false` under `snippet` in `pi-tweaks.json` turns the
 * command off. See pi-tweaks-config.ts.
 */

import {
	copyToClipboard,
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { isExtensionEnabled } from "../lib/pi-tweaks-config";

const EXTENSION = "snippet";

/** Tab labels, in tab-bar order. */
const TABS = ["code blocks", "inline code"] as const;

/** Fence opener: three or more backticks or tildes, then an info string. */
const OPEN_FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*(.*?)[ \t]*$/;

/** One code block, as listed and copied. */
type Snippet = {
	/** The fence info string's first word; `text` when it names no language. */
	lang: string;
	/** The text between the markers, with surrounding blank lines trimmed. */
	code: string;
};

/** What the picker offers, one list per tab. */
type Snippets = {
	fenced: Snippet[];
	inline: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text blocks of a message: a plain string, or the `text` content blocks. */
function textBlocks(message: unknown): string[] {
	const content = isRecord(message) ? message.content : undefined;
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];

	const texts: string[] = [];
	for (const block of content) {
		if (
			isRecord(block) &&
			block.type === "text" &&
			typeof block.text === "string"
		) {
			texts.push(block.text);
		}
	}
	return texts;
}

/** Whether a message is conversation text, rather than a tool result or call. */
function isConversationText(message: unknown): boolean {
	if (!isRecord(message)) return false;
	return message.role === "user" || message.role === "assistant";
}

/** Escape the regex metacharacters of a literal. */
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split markdown into its fenced code blocks and everything else. A fence
 * closes with its own marker character, repeated at least as many times; a
 * fence that never closes runs to the end of the text, as in markdown.
 */
function scanFences(text: string): { fenced: Snippet[]; rest: string } {
	const fenced: Snippet[] = [];
	const rest: string[] = [];
	const lines = text.split("\n");
	let index = 0;

	while (index < lines.length) {
		const opener = OPEN_FENCE.exec(lines[index]);
		if (!opener) {
			rest.push(lines[index]);
			index += 1;
			continue;
		}

		const marker = opener[1];
		const lang = (opener[2] ?? "").split(/\s+/)[0] ?? "";
		const closer = new RegExp(
			`^[ \\t]*${escapeRegExp(marker[0])}{${marker.length},}[ \\t]*$`,
		);

		const body: string[] = [];
		index += 1;
		while (index < lines.length && !closer.test(lines[index])) {
			body.push(lines[index]);
			index += 1;
		}
		index += 1; // Step over the closing fence, or the end of the text.

		const code = body.join("\n").trim();
		if (code.length > 0) fenced.push({ lang: lang || "text", code });
	}

	return { fenced, rest: rest.join("\n") };
}

/**
 * The inline code spans of markdown that has had its fences removed. A span
 * opens with a run of backticks and closes with a run of the same length, so
 * a doubled backtick can hold a single one. The body must be one line.
 */
function scanInline(text: string): string[] {
	const spans: string[] = [];
	let index = 0;

	while (index < text.length) {
		const open = text.indexOf("`", index);
		if (open === -1) break;

		let end = open;
		while (text[end] === "`") end += 1;
		const marker = "`".repeat(end - open);
		const close = text.indexOf(marker, end);
		if (close === -1) break;

		const code = text.slice(end, close).trim();
		if (code.length > 0 && !code.includes("\n")) spans.push(code);
		index = close + marker.length;
	}

	return spans;
}

/** Most recent first, and one entry per distinct body. */
function newestFirst<T>(items: T[], body: (item: T) => string): T[] {
	const seen = new Set<string>();
	const result: T[] = [];
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		const code = body(item);
		if (seen.has(code)) continue;
		seen.add(code);
		result.push(item);
	}
	return result;
}

/** Everything the picker can offer, read from the active branch. */
function collectSnippets(ctx: ExtensionCommandContext): Snippets {
	const fenced: Snippet[] = [];
	const inline: string[] = [];

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || !isConversationText(entry.message))
			continue;
		for (const text of textBlocks(entry.message)) {
			const scan = scanFences(text);
			fenced.push(...scan.fenced);
			inline.push(...scanInline(scan.rest));
		}
	}

	return {
		fenced: newestFirst(fenced, (snippet) => snippet.code),
		inline: newestFirst(inline, (code) => code),
	};
}

/** The first and last non-blank lines, for the list's description column. */
function summarize(code: string): string {
	const lines = code.split("\n");
	const first = lines.find((line) => line.trim().length > 0)?.trim() ?? "";
	const last =
		[...lines]
			.reverse()
			.find((line) => line.trim().length > 0)
			?.trim() ?? "";
	return first === last ? first : `${first} … ${last}`;
}

/** The fenced rows: the language, then the first and last lines. */
function fenceItems(snippets: Snippet[]): SelectItem[] {
	return snippets.map((snippet) => ({
		value: snippet.code,
		label: snippet.lang,
		description: summarize(snippet.code),
	}));
}

/** The inline rows: an `inline` label, then the span itself. */
function inlineItems(spans: string[]): SelectItem[] {
	return spans.map((span) => ({
		value: span,
		label: "inline",
		description: span,
	}));
}

/** The list colours, matching the built-in selectors. */
function listTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("warning", text),
	};
}

/**
 * The picker: a title, a tab bar, the active tab's list, and a key hint, framed
 * by borders. Tab and the arrow keys switch tabs; the rest of the input goes to
 * the list, which owns navigation and Enter.
 */
function buildPicker(
	tui: TUI,
	theme: Theme,
	lists: SelectItem[][],
	onSelect: (code: string) => void,
	onCancel: () => void,
): Component {
	const border = new DynamicBorder((text) => theme.fg("accent", text));
	const maxVisible = Math.max(1, tui.terminal.rows - 6);

	const selectLists = lists.map((items) => {
		const list = new SelectList(items, maxVisible, listTheme(theme));
		list.onSelect = (item) => onSelect(item.value);
		list.onCancel = () => onCancel();
		return list;
	});

	let current = 0;

	const tabBar = (): string =>
		TABS.map((label, index) => {
			const text = ` ${label} (${lists[index].length}) `;
			return index === current
				? theme.bg("selectedBg", theme.fg("text", text))
				: theme.fg("muted", text);
		}).join(" ");

	return {
		render(width: number): string[] {
			const lines = [
				...border.render(width),
				theme.fg("accent", theme.bold("Snippets")),
				truncateToWidth(tabBar(), width, ""),
			];
			if (lists[current].length === 0) {
				lines.push(theme.fg("dim", "  Nothing here"));
			} else {
				lines.push(...selectLists[current].render(width));
			}
			lines.push(
				truncateToWidth(
					theme.fg("dim", "tab switch • ↑↓ navigate • enter copy • esc cancel"),
					width,
					"",
				),
			);
			lines.push(...border.render(width));
			return lines;
		},

		handleInput(data: string): void {
			if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
				current = (current + 1) % selectLists.length;
			} else if (
				matchesKey(data, Key.shift("tab")) ||
				matchesKey(data, Key.left)
			) {
				current = (current - 1 + selectLists.length) % selectLists.length;
			} else {
				selectLists[current].handleInput(data);
			}
			tui.requestRender();
		},

		invalidate(): void {
			border.invalidate();
			for (const list of selectLists) list.invalidate();
		},
	};
}

async function copySnippet(
	ctx: ExtensionCommandContext,
	code: string,
): Promise<void> {
	try {
		await copyToClipboard(code);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`snippet: could not copy: ${message}`, "error");
		return;
	}
	ctx.ui.notify("Snippet copied to clipboard", "info");
}

export default function snippet(pi: ExtensionAPI) {
	if (!isExtensionEnabled(EXTENSION)) return;

	pi.registerCommand(EXTENSION, {
		description: "Copy a code block from the conversation to the clipboard",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("snippet: the picker needs the TUI", "warning");
				return;
			}

			const snippets = collectSnippets(ctx);
			const lists = [fenceItems(snippets.fenced), inlineItems(snippets.inline)];
			if (lists[0].length === 0 && lists[1].length === 0) {
				ctx.ui.notify(
					"snippet: no code blocks in this conversation",
					"warning",
				);
				return;
			}

			const code = await ctx.ui.custom<string | null>(
				(tui, theme, _keybindings, done) =>
					buildPicker(tui, theme, lists, done, () => done(null)),
			);
			if (code === null) return;

			await copySnippet(ctx, code);
		},
	});
}
