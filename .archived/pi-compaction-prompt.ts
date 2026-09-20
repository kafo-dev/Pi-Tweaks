/**
 * pi-compaction-prompt — summarize with your own prompt instead of pi's.
 *
 * pi compacts by asking the model to summarize the messages it is about to
 * drop. This extension replaces that instruction with the body of a Markdown
 * file, so a summary can keep what this project cares about. Configure it in
 * the `pi-compaction-prompt` section of `pi-tweaks.json` (see
 * pi-tweaks-config.ts):
 *
 *   {
 *     "pi-compaction-prompt": {
 *       "enabled": true,
 *       "promptFile": "prompts/compact.md"
 *     }
 *   }
 *
 * The value is a path: absolute, `~`-prefixed, or relative to the pi agent
 * directory (so `prompts/compact.md` means `<agent-dir>/prompts/compact.md`,
 * the same place pi keeps prompt templates). For backward compatibility, the
 * old `compaction.promptFile` in `settings.json` is used when the section sets
 * no `promptFile`: a project settings file wins over the global one and is
 * honored only for trusted projects.
 *
 * The file's body is the instruction text; YAML frontmatter is metadata and
 * is stripped. The extension appends the previous summary, any `/compact`
 * instructions, and the conversation, so the file only says what a good
 * summary contains. Summarization runs under a fixed system prompt that
 * forbids continuing the conversation or calling tools, and the assistant's
 * thinking is left out of the transcript so reasoning does not become handoff
 * content. The retained messages pi keeps are appended so the summarizer can
 * see how the last turn ended.
 *
 * Without a readable prompt file the extension stays out of the way and pi's
 * default compaction runs. `"enabled": false` turns the extension off.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ContextEvent,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type SessionEntry,
	serializeConversation,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
	isExtensionEnabled,
	readSection,
	stringValue,
} from "../pi-tweaks-config";

const EXTENSION = "pi-compaction-prompt";
const SETTINGS_FILE = "settings.json";
const PROMPT_FILE_KEY = "promptFile";
const SUMMARY_MAX_TOKENS = 8192;

/**
 * The summarizer reads a transcript. Without this guard it tends to answer the
 * transcript or reach for tools instead of summarizing.
 */
const SYSTEM_PROMPT = `You are a context summarization assistant. Read the conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. Do NOT call any tools. ONLY output the structured summary.`;

/**
 * Marks the front half of one oversized turn. The kept tail is appended after
 * the conversation, under RETAINED, so the summarizer can see how the turn
 * ended.
 */
const TURN_PREFIX_MARKER = `--- TURN PREFIX ---
The messages below are the EARLY PART of one turn. The rest of that turn, including how it ended, is under RETAINED. Judge whether the turn finished from the RETAINED messages, never from this prefix alone.`;

/**
 * The kept messages pi shows after the summary. A small kept-token budget cuts
 * at the last assistant message, so the retained tail is the answer that ends
 * the turn. Withholding it makes the summarizer report finished work as
 * unfinished and reasoning as a result.
 */
const RETAINED_MARKER = `--- RETAINED ---
The messages below are kept verbatim and are shown to the next agent AFTER your summary. They are not replaced by it. Use them to judge what is finished and what to do next. Do not repeat their content in your summary.`;

/** File operations pi extracted from the messages being summarized. */
type FileOps = {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
};

/** What the settings point at, and whether it can be read. */
type Prompt =
	| { kind: "off" }
	| { kind: "ready"; path: string; instructions: string }
	| { kind: "missing"; path: string };

function readSettings(path: string): unknown {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as unknown;
	} catch {
		// Malformed JSON is pi's problem to report; stay out of the way.
		return null;
	}
}

/** The `compaction.promptFile` string in one settings file, if any. */
function promptFileValue(settingsPath: string): string | null {
	const settings = readSettings(settingsPath);
	if (typeof settings !== "object" || settings === null) return null;
	const compaction = (settings as { compaction?: unknown }).compaction;
	if (typeof compaction !== "object" || compaction === null) return null;
	const value = (compaction as Record<string, unknown>)[PROMPT_FILE_KEY];
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	return trimmed;
}

/** The pi-tweaks section wins, then project settings, then global settings. */
function configuredPromptFile(ctx: ExtensionContext): string | null {
	const fromTweaks = stringValue(
		readSection(EXTENSION),
		PROMPT_FILE_KEY,
		[],
		"",
	).trim();
	if (fromTweaks.length > 0) return fromTweaks;

	const project = join(ctx.cwd, CONFIG_DIR_NAME, SETTINGS_FILE);
	if (ctx.isProjectTrusted()) {
		const fromProject = promptFileValue(project);
		if (fromProject) return fromProject;
	}
	return promptFileValue(join(getAgentDir(), SETTINGS_FILE));
}

/**
 * Turn the configured value into a path. Relative values resolve against the
 * agent directory because `promptFile` most often names a pi prompt template.
 */
function resolvePromptPath(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	if (isAbsolute(value)) return value;
	return join(getAgentDir(), value);
}

/** Frontmatter is metadata; the summarizer only needs the body. */
function stripFrontmatter(text: string): string {
	return text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "");
}

function readInstructions(path: string): string | null {
	if (!existsSync(path)) return null;
	try {
		const body = stripFrontmatter(readFileSync(path, "utf-8")).trim();
		return body.length > 0 ? body : null;
	} catch {
		return null;
	}
}

function resolvePrompt(ctx: ExtensionContext): Prompt {
	const value = configuredPromptFile(ctx);
	if (!value) return { kind: "off" };
	const path = resolvePromptPath(value);
	const instructions = readInstructions(path);
	if (instructions === null) return { kind: "missing", path };
	return { kind: "ready", path, instructions };
}

function buildRequest(
	instructions: string,
	previousSummary: string | undefined,
	customInstructions: string | undefined,
	conversation: string,
	retained: string,
): string {
	const parts = [instructions];
	if (previousSummary) {
		parts.push(`Previous summary, for continuity:\n\n${previousSummary}`);
	}
	if (customInstructions) {
		parts.push(`Instructions for this summary:\n\n${customInstructions}`);
	}
	parts.push(`<conversation>\n${conversation}\n</conversation>`);
	if (retained.length > 0) {
		parts.push(`${RETAINED_MARKER}\n\n<retained>\n${retained}\n</retained>`);
	}
	return parts.join("\n\n");
}

/**
 * Messages pi keeps verbatim after the summary, in the order the next agent
 * sees them. Only a split turn needs them: it is the one case where the
 * summarizer's visible input ends in the middle of a turn. Empty when the cut
 * point is not on this branch.
 */
function retainedConversation(
	branchEntries: SessionEntry[],
	firstKeptEntryId: string,
): string {
	const start = branchEntries.findIndex(
		(entry) => entry.id === firstKeptEntryId,
	);
	if (start < 0) return "";
	const messages = branchEntries
		.slice(start)
		.flatMap((entry) => sessionEntryToContextMessages(entry));
	return messages.length === 0
		? ""
		: serializeConversation(convertToLlm(messages));
}

/**
 * Chain-of-thought is not a report. Summarizing it turns "the assistant
 * considered rejecting this" into handoff content the next agent cannot use.
 */
function stripThinking(
	messages: ContextEvent["messages"],
): ContextEvent["messages"] {
	return messages.flatMap((message) => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			return [message];
		}
		const content = message.content.filter(
			(block) => block.type !== "thinking",
		);
		if (content.length === message.content.length) return [message];
		return content.length === 0 ? [] : [{ ...message, content }];
	});
}

/**
 * A provider accepts a thinking block back only alongside the tool calls it was
 * produced with. Thinking on a plain answer has no such requirement, so it is
 * dropped: after a compaction that answer heads the context and would otherwise
 * be replayed whole on every request.
 */
function stripPlainThinking(
	messages: ContextEvent["messages"],
): ContextEvent["messages"] | undefined {
	let changed = false;
	const kept = messages.flatMap((message) => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			return [message];
		}
		if (message.content.some((block) => block.type === "toolCall")) {
			return [message];
		}
		const content = message.content.filter(
			(block) => block.type !== "thinking",
		);
		if (content.length === message.content.length) return [message];
		changed = true;
		return content.length === 0 ? [] : [{ ...message, content }];
	});
	return changed ? kept : undefined;
}

/**
 * Same split pi uses: a file that was written or edited is modified, even if
 * it was also read.
 */
function computeFileLists(fileOps: FileOps): {
	readFiles: string[];
	modifiedFiles: string[];
} {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readFiles = [...fileOps.read]
		.filter((path) => !modified.has(path))
		.sort();
	return { readFiles, modifiedFiles: [...modified].sort() };
}

/**
 * pi appends these blocks to a default summary; an extension-provided summary
 * skips that, so the file lists are added here.
 */
function fileBlocks(readFiles: string[], modifiedFiles: string[]): string {
	const blocks: string[] = [];
	if (readFiles.length > 0) {
		blocks.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		blocks.push(
			`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`,
		);
	}
	if (blocks.length === 0) return "";
	return `\n\n${blocks.join("\n\n")}`;
}

function summaryText(content: { type: string; text?: string }[]): string {
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n")
		.trim();
}

export default function compactionPrompt(pi: ExtensionAPI) {
	if (!isExtensionEnabled(EXTENSION)) return;

	pi.on("session_start", (_event, ctx) => {
		const prompt = resolvePrompt(ctx);
		if (prompt.kind === "missing") {
			ctx.ui.notify(`promptFile is not readable: ${prompt.path}`, "warning");
		}
	});

	pi.on("context", (event) => {
		const messages = stripPlainThinking(event.messages);
		return messages ? { messages } : undefined;
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const prompt = resolvePrompt(ctx);
		if (prompt.kind === "off") return;
		if (prompt.kind === "missing") {
			ctx.ui.notify(`promptFile is not readable: ${prompt.path}`, "warning");
			return;
		}

		const { preparation, branchEntries, customInstructions, signal } = event;
		const parts: string[] = [];
		if (preparation.messagesToSummarize.length > 0) {
			parts.push(
				serializeConversation(
					convertToLlm(stripThinking(preparation.messagesToSummarize)),
				),
			);
		}
		if (preparation.turnPrefixMessages.length > 0) {
			parts.push(
				`${TURN_PREFIX_MARKER}\n\n${serializeConversation(
					convertToLlm(stripThinking(preparation.turnPrefixMessages)),
				)}`,
			);
		}
		const conversation = parts.join("\n\n");
		const retained = preparation.isSplitTurn
			? retainedConversation(branchEntries, preparation.firstKeptEntryId)
			: "";
		const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
		const request = buildRequest(
			prompt.instructions,
			preparation.previousSummary,
			customInstructions,
			conversation,
			retained,
		);

		const model = ctx.model;
		if (!model) {
			ctx.ui.notify(
				"Compaction prompt skipped: no model is selected",
				"warning",
			);
			return;
		}

		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: SYSTEM_PROMPT,
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: request }],
							timestamp: Date.now(),
						},
					],
				},
				{
					maxTokens: SUMMARY_MAX_TOKENS,
					signal,
					cacheRetention: "none",
					sessionId: uuidv7(),
				},
			);

			const text = summaryText(response.content);
			if (text.length === 0) return;

			return {
				compaction: {
					summary: `${text}${fileBlocks(readFiles, modifiedFiles)}`,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					details: { readFiles, modifiedFiles },
					usage: response.usage,
				},
			};
		} catch (error) {
			// An aborted compaction is a user decision, not a failure.
			if (signal.aborted) return;
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(
				`Compaction with ${prompt.path} failed: ${message}`,
				"error",
			);
			return;
		}
	});
}
