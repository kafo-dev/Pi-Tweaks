/**
 * url — an experimental `/url` command that copies a link from the
 * conversation to the system clipboard.
 *
 * `/url` opens a picker over the links shown in the current session: one tab
 * for markdown links, one for bare URLs. Tab switches between them (arrow
 * left/right too), and the most recently printed link comes first. A markdown
 * link is listed with its host and its link text ("github.com  mitsuhiko"),
 * a bare URL with its host and its path. Enter copies the URL to the system
 * clipboard — for a markdown link the address only, without the brackets or
 * the link text — and closes the picker. Escape closes it without copying.
 *
 * The source is the text of user and assistant messages on the active branch,
 * fenced code blocks included: a URL in a command is often the one worth
 * copying. Tool results and tool-call arguments are not read, so a link in a
 * fetched page does not bury the links of the conversation.
 *
 * A URL is recognised by its scheme (`https://`, `ftp://`, `mailto:`, …), so
 * a bare host such as `www.example.com` is not listed. The punctuation a
 * sentence glues to an address is trimmed, and a closing bracket is trimmed
 * only when the URL holds no opener for it, so a path like `/wiki/Foo_(bar)`
 * survives while `(see https://example.com/a)` does not keep the bracket. A
 * URL that appears in both forms is listed once, in the markdown tab.
 *
 * Loading the file does not publish the command: it registers only when the
 * `experiment-url` section of `pi-tweaks.json` sets `"enabled": true`.
 *
 *   { "experiment-url": { "enabled": true } }
 *
 * See the Experiment README and pi-tweaks-config.ts.
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
import { isExperimentEnabled } from "../../lib/pi-tweaks-config";

const EXTENSION = "experiment-url";

/** Tab labels, in tab-bar order. */
const TABS = ["links", "plain"] as const;

/** A markdown link: optional image mark, text, then the address in parens. */
const MARKDOWN_LINK =
	/!?\[([^\]]*)\]\(\s*<?([^\s<>]+?)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

/** A bare URL: a scheme with an authority, or a `mailto:` address. */
const BARE_URL = /\b(?:[a-z][a-z0-9+.-]*:\/\/|mailto:)[^\s<>"'`]+/gi;

/** Punctuation a sentence glues to a URL, which the URL itself does not own. */
const GLUED = new Set([".", ",", ";", ":", "!", "?", "*", "_"]);

/** One link, as listed and copied. */
type Link = {
	/** The address, without the markdown brackets. */
	url: string;
	/** The markdown link text, when the link had one. */
	text?: string;
};

/** What the picker offers, one list per tab. */
type Links = {
	links: Link[];
	plain: string[];
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

/** How often a character appears in the text. */
function countOf(text: string, char: string): number {
	let count = 0;
	for (const character of text) {
		if (character === char) count += 1;
	}
	return count;
}

/**
 * Drop the punctuation a sentence glues to a URL. A closing bracket goes only
 * when the URL holds no opener for it, so a path that ends in one survives.
 */
function trimUrl(url: string): string {
	let result = url;
	while (result.length > 0) {
		const last = result[result.length - 1] ?? "";
		const opener = last === ")" ? "(" : last === "]" ? "[" : undefined;
		if (
			opener !== undefined &&
			countOf(result, last) > countOf(result, opener)
		) {
			result = result.slice(0, -1);
			continue;
		}
		if (GLUED.has(last)) {
			result = result.slice(0, -1);
			continue;
		}
		break;
	}
	return result;
}

/** The markdown links of one text block, in the order they appear. */
function scanLinks(text: string): Link[] {
	const links: Link[] = [];
	for (const match of text.matchAll(MARKDOWN_LINK)) {
		const url = trimUrl(match[2] ?? "");
		if (url.length === 0) continue;
		const label = (match[1] ?? "").replace(/\s+/g, " ").trim();
		links.push(label.length > 0 ? { url, text: label } : { url });
	}
	return links;
}

/** The bare URLs of one text block, in the order they appear. */
function scanBare(text: string): string[] {
	const urls: string[] = [];
	for (const match of text.matchAll(BARE_URL)) {
		const url = trimUrl(match[0]);
		if (url.length > 0) urls.push(url);
	}
	return urls;
}

/** Most recent first, and one entry per distinct body. */
function newestFirst<T>(items: T[], body: (item: T) => string): T[] {
	const seen = new Set<string>();
	const result: T[] = [];
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item === undefined) continue;
		const key = body(item);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(item);
	}
	return result;
}

/** Every link the conversation shows, newest first and listed once. */
function collectLinks(ctx: ExtensionCommandContext): Links {
	const links: Link[] = [];
	const plain: string[] = [];

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || !isConversationText(entry.message)) {
			continue;
		}
		for (const text of textBlocks(entry.message)) {
			links.push(...scanLinks(text));
			plain.push(...scanBare(text));
		}
	}

	const newestLinks = newestFirst(links, (link) => link.url);
	const linked = new Set(newestLinks.map((link) => link.url));
	return {
		links: newestLinks,
		plain: newestFirst(
			plain.filter((url) => !linked.has(url)),
			(url) => url,
		),
	};
}

/** The host of a URL, or its scheme when it has no authority (`mailto:`). */
function hostOf(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.host !== "") return parsed.host;
		return parsed.protocol.replace(/:$/, "");
	} catch {
		return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0] ?? "";
	}
}

/** What a URL says beyond its host: the path, query, and fragment. */
function restOf(url: string): string {
	let rest: string;
	try {
		const parsed = new URL(url);
		rest = `${parsed.pathname}${parsed.search}${parsed.hash}`;
	} catch {
		rest = url.slice(hostOf(url).length);
	}
	return rest === "/" ? "" : rest;
}

/** The markdown rows: the host, then the link text. */
function linkItems(links: Link[]): SelectItem[] {
	return links.map((link) => ({
		value: link.url,
		label: hostOf(link.url),
		description: link.text ?? restOf(link.url),
	}));
}

/** The bare rows: the host, then the path. */
function plainItems(urls: string[]): SelectItem[] {
	return urls.map((url) => ({
		value: url,
		label: hostOf(url),
		description: restOf(url),
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
	onSelect: (url: string) => void,
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
				theme.fg("accent", theme.bold("URLs")),
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

async function copyUrl(
	ctx: ExtensionCommandContext,
	url: string,
): Promise<void> {
	try {
		await copyToClipboard(url);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`url: could not copy: ${message}`, "error");
		return;
	}
	ctx.ui.notify("URL copied to clipboard", "info");
}

export default function url(pi: ExtensionAPI) {
	if (!isExperimentEnabled(EXTENSION)) return;

	pi.registerCommand("url", {
		description: "Copy a URL from the conversation to the clipboard",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("url: the picker needs the TUI", "warning");
				return;
			}

			const found = collectLinks(ctx);
			const lists = [linkItems(found.links), plainItems(found.plain)];
			if (lists[0].length === 0 && lists[1].length === 0) {
				ctx.ui.notify("url: no URLs in this conversation", "warning");
				return;
			}

			const url = await ctx.ui.custom<string | null>(
				(tui, theme, _keybindings, done) =>
					buildPicker(tui, theme, lists, done, () => done(null)),
			);
			if (url === null) return;

			await copyUrl(ctx, url);
		},
	});
}
