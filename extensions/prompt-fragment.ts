/**
 * prompt-fragment — append the full text of chosen Markdown documents to the
 * system prompt.
 *
 * pi loads skills on demand: only each skill's name, description, and path
 * reach the system prompt, and the model decides whether to read the file. This
 * extension forces the full text of the documents named in a config file into
 * the system prompt on every turn, so their rules always apply.
 *
 * Config, first found wins:
 *   <cwd>/.pi/prompt-fragment.json                 project, honored only when trusted
 *   `prompt-fragment.fragments` in pi-tweaks.json  global (see pi-tweaks-config.ts)
 *
 * The project file is a JSON array of fragment objects; the global section
 * holds the same array under `fragments`:
 *
 *   [
 *     { "path": "docs/style.md", "showPathToAgent": true, "stripFrontmatter": false }
 *   ]
 *
 *   { "prompt-fragment": { "enabled": true, "fragments": [ ... ] } }
 *
 * `path` is required. A path that starts with `~` resolves against the home
 * directory; any other relative path resolves against the directory of the
 * config file that names it. `showPathToAgent` is required: when true, the
 * path is written into the block, so the model can read the file again for the
 * parts the block omits. The path is relative to the working directory when the
 * document is under it, `~/…` when it is under the home directory, and absolute
 * otherwise. `stripFrontmatter` is required too: when true, a leading YAML
 * frontmatter block is removed, for a document that is also a skill.
 *
 * A document is appended verbatim. It is wrapped in a `<document>` element only
 * when `showPathToAgent` or `stripFrontmatter` is true; the element carries the
 * path when `showPathToAgent` is true. The text is byte-identical on every turn
 * and follows config order, so it stays inside the provider's cached prefix.
 *
 * An invalid config, an invalid entry, or a document that cannot be read is an
 * error: nothing is pinned for that turn and the error is reported in the UI.
 * A config that does not exist at all is not an error; the extension is simply
 * off. Run /pi-tweaks prompt-fragment to inspect the resolved set; the command
 * lives in pi-tweaks.ts and calls reportPromptFragments below.
 * `"enabled": false` turns the extension off.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	configFilePath,
	isExtensionEnabled,
	readSection,
} from "../lib/pi-tweaks-config";

const EXTENSION = "prompt-fragment";
const PROJECT_FILE = "prompt-fragment.json";
const FRAGMENTS_KEY = "fragments";

type FragmentEntry = {
	/** Path as written in the config file, absolute or relative to it. */
	path: string;
	/** Whether the resolved path is written into the document element. */
	showPathToAgent: boolean;
	/** Whether a leading YAML frontmatter block is removed. */
	stripFrontmatter: boolean;
};

type Resolved =
	| {
			kind: "fragments";
			configPath: string;
			fragments: FragmentEntry[];
			invalid: number[];
	  }
	| { kind: "missing" }
	| { kind: "malformed"; path: string };

type Built = {
	text: string;
	/** Resolved paths that could not be read, or that read empty. */
	missing: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One fragment object, or null when any of its three required keys is absent. */
function parseFragment(value: unknown): FragmentEntry | null {
	if (!isRecord(value)) return null;

	const path = value.path;
	if (typeof path !== "string" || path.length === 0) return null;

	const showPathToAgent = value.showPathToAgent;
	if (typeof showPathToAgent !== "boolean") return null;

	const stripFrontmatter = value.stripFrontmatter;
	if (typeof stripFrontmatter !== "boolean") return null;

	return { path, showPathToAgent, stripFrontmatter };
}

/** The fragments of a value that must be an array, plus the indices that failed. */
function parseFragments(
	value: unknown,
): { fragments: FragmentEntry[]; invalid: number[] } | null {
	if (!Array.isArray(value)) return null;

	const fragments: FragmentEntry[] = [];
	const invalid: number[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const fragment = parseFragment(value[index]);
		if (fragment) {
			fragments.push(fragment);
		} else {
			invalid.push(index);
		}
	}
	return { fragments, invalid };
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function resolveConfig(ctx: ExtensionContext): Resolved {
	const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, PROJECT_FILE);
	if (ctx.isProjectTrusted() && existsSync(projectPath)) {
		const parsed = parseFragments(readJson(projectPath));
		if (!parsed) return { kind: "malformed", path: projectPath };
		return { kind: "fragments", configPath: projectPath, ...parsed };
	}

	const configPath = configFilePath();
	const configured = readSection(EXTENSION)?.[FRAGMENTS_KEY];
	if (configured !== undefined) {
		const parsed = parseFragments(configured);
		if (!parsed) return { kind: "malformed", path: configPath };
		return { kind: "fragments", configPath, ...parsed };
	}

	// `readSection` reads a malformed file as empty, so parse the file here to
	// tell "no fragments configured" apart from "the file does not parse".
	if (existsSync(configPath) && readJson(configPath) === null) {
		return { kind: "malformed", path: configPath };
	}

	return { kind: "missing" };
}

/** `~` or `~/…` resolved against the home directory; anything else unchanged. */
function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

/** The part of `path` below `parent`, or null when it is not below it. */
function relativeTo(parent: string, path: string): string | null {
	const prefix = parent.endsWith(sep) ? parent : parent + sep;
	if (!path.startsWith(prefix)) return null;
	return path.slice(prefix.length);
}

/**
 * `~` for home itself, working-directory-relative, then `~/…` under home, then
 * absolute.
 */
function displayPath(path: string, cwd: string): string {
	const home = resolve(homedir());
	if (path === home) return "~";

	const fromCwd = relativeTo(resolve(cwd), path);
	if (fromCwd !== null) return fromCwd;

	const fromHome = relativeTo(home, path);
	if (fromHome !== null) return `~/${fromHome}`;

	return path;
}

/** Remove a leading YAML frontmatter block. */
function stripFrontmatter(text: string): string {
	return text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "");
}

function build(
	fragments: readonly FragmentEntry[],
	configDir: string,
	cwd: string,
): Built {
	const seen = new Set<string>();
	const missing: string[] = [];
	const parts: string[] = [];

	for (const fragment of fragments) {
		const path = resolve(configDir, expandHome(fragment.path));
		if (seen.has(path)) continue;
		seen.add(path);

		let body: string;
		try {
			body = readFileSync(path, "utf8");
		} catch {
			missing.push(displayPath(path, cwd));
			continue;
		}
		if (fragment.stripFrontmatter) {
			body = stripFrontmatter(body);
		}
		body = body.trim();
		if (body.length === 0) {
			missing.push(displayPath(path, cwd));
			continue;
		}

		const keepTags = fragment.showPathToAgent || fragment.stripFrontmatter;
		const attributes = fragment.showPathToAgent
			? ` path="${displayPath(path, cwd)}"`
			: "";
		if (keepTags) {
			parts.push(`<document${attributes}>\n${body}\n</document>`);
		} else {
			parts.push(body);
		}
	}

	return { text: parts.join("\n\n"), missing };
}

/** One error message for everything wrong with the resolved config, or null. */
function describeProblem(
	configPath: string,
	invalid: readonly number[],
	missing: readonly string[],
): string | null {
	if (invalid.length === 0 && missing.length === 0) return null;

	const lines = [`prompt-fragment: ${configPath}`];
	if (invalid.length > 0) {
		lines.push(
			`invalid entries (need path, showPathToAgent, and stripFrontmatter): ${invalid.join(", ")}`,
		);
	}
	if (missing.length > 0) lines.push(`missing: ${missing.join(", ")}`);
	return lines.join("\n");
}

/** Report what `/pi-tweaks prompt-fragment` resolves, for the package's command. */
export function reportPromptFragments(ctx: ExtensionCommandContext): void {
	const resolved = resolveConfig(ctx);
	if (resolved.kind === "missing") {
		ctx.ui.notify(
			`No ${PROJECT_FILE} or ${EXTENSION}.${FRAGMENTS_KEY} found`,
			"warning",
		);
		return;
	}
	if (resolved.kind === "malformed") {
		ctx.ui.notify(
			`prompt-fragment: ${resolved.path} is not a list of fragments`,
			"error",
		);
		return;
	}

	const { text, missing } = build(
		resolved.fragments,
		dirname(resolved.configPath),
		ctx.cwd,
	);
	const total = resolved.fragments.length;
	// Rule of thumb: four characters per token.
	const tokens = Math.ceil(text.length / 4);
	const failed = missing.length > 0 || resolved.invalid.length > 0;
	const lines = [
		`config: ${resolved.configPath}`,
		`fragments: ${total}`,
		`resolved: ${total - missing.length} of ${total}`,
		failed
			? "appended: none (errors below)"
			: `appended: ${Buffer.byteLength(text)} bytes (~${tokens} tokens)`,
	];
	if (missing.length > 0) lines.push(`missing: ${missing.join(", ")}`);
	if (resolved.invalid.length > 0) {
		lines.push(
			`invalid entries (need path, showPathToAgent, and stripFrontmatter): ${resolved.invalid.join(", ")}`,
		);
	}
	ctx.ui.notify(lines.join("\n"), failed ? "error" : "info");
}

export default function promptFragment(pi: ExtensionAPI) {
	if (!isExtensionEnabled(EXTENSION)) return;

	pi.on("before_agent_start", async (event, ctx) => {
		const resolved = resolveConfig(ctx);
		if (resolved.kind === "missing") return;
		if (resolved.kind === "malformed") {
			ctx.ui.notify(
				`prompt-fragment: ${resolved.path} is not a list of fragments`,
				"error",
			);
			return;
		}

		const { text, missing } = build(
			resolved.fragments,
			dirname(resolved.configPath),
			ctx.cwd,
		);
		const problem = describeProblem(
			resolved.configPath,
			resolved.invalid,
			missing,
		);
		if (problem) {
			ctx.ui.notify(problem, "error");
			return;
		}
		if (text.length === 0) return;

		return { systemPrompt: `${event.systemPrompt}\n\n${text}\n` };
	});
}
