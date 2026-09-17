/**
 * pi-compaction-prompt — summarize with your own prompt instead of pi's.
 *
 * pi compacts by asking the model to summarize the messages it is about to
 * drop. This extension replaces that instruction with the body of a Markdown
 * file, so a summary can keep what this project cares about. Configure it in
 * `settings.json`:
 *
 *   {
 *     "compaction": {
 *       "promptFile": "prompts/compact.md"
 *     }
 *   }
 *
 * The value is a path: absolute, `~`-prefixed, or relative to the pi agent
 * directory (so `prompts/compact.md` means `<agent-dir>/prompts/compact.md`,
 * the same place pi keeps prompt templates). A project settings file wins
 * over the global one and is honored only for trusted projects.
 *
 * The file's body is the instruction text; YAML frontmatter is metadata and
 * is stripped. The extension appends the previous summary, any `/compact`
 * instructions, and the conversation, so the file only says what a good
 * summary contains.
 *
 * Without a readable `compaction.promptFile` the extension stays out of the
 * way and pi's default compaction runs.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	convertToLlm,
	getAgentDir,
	serializeConversation,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const SETTINGS_FILE = "settings.json";
const PROMPT_FILE_KEY = "promptFile";
const SUMMARY_MAX_TOKENS = 8192;

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

/** Project settings win, then the global ones. */
function configuredPromptFile(ctx: ExtensionContext): string | null {
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
): string {
	const parts = [instructions];
	if (previousSummary) {
		parts.push(`Previous summary, for continuity:\n\n${previousSummary}`);
	}
	if (customInstructions) {
		parts.push(`Instructions for this summary:\n\n${customInstructions}`);
	}
	parts.push(`<conversation>\n${conversation}\n</conversation>`);
	return parts.join("\n\n");
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
	pi.on("session_start", (_event, ctx) => {
		const prompt = resolvePrompt(ctx);
		if (prompt.kind === "missing") {
			ctx.ui.notify(
				`compaction.promptFile is not readable: ${prompt.path}`,
				"warning",
			);
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const prompt = resolvePrompt(ctx);
		if (prompt.kind === "off") return;
		if (prompt.kind === "missing") {
			ctx.ui.notify(
				`compaction.promptFile is not readable: ${prompt.path}`,
				"warning",
			);
			return;
		}

		const { preparation, customInstructions, signal } = event;
		const conversation = serializeConversation(
			convertToLlm([
				...preparation.messagesToSummarize,
				...preparation.turnPrefixMessages,
			]),
		);
		const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
		const request = buildRequest(
			prompt.instructions,
			preparation.previousSummary,
			customInstructions,
			conversation,
		);

		try {
			const response = await ctx.modelRegistry.complete(
				ctx.model,
				{
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
