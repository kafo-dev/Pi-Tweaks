/**
 * pi-pinned-skills — append the full text of chosen skills to the system prompt.
 *
 * pi loads skills on demand: only each skill's name, description, and path
 * reach the system prompt, and the model decides whether to read the file. This
 * extension forces the full text of the skills named in a config file into the
 * system prompt on every turn, so their rules always apply.
 *
 * Config, first found wins:
 *   <cwd>/.pi/pinned-skills.json           project, honored only when trusted
 *   `pi-pinned-skills.skills` in pi-tweaks.json   global (see pi-tweaks-config.ts)
 *   <agent-dir>/pinned-skills.json         legacy global, until the section exists
 *
 * Format: a JSON array of skill names, or a `skills` array in the section:
 *
 *   ["brand-guidelines", "sql-style"]
 *
 *   { "pi-pinned-skills": { "enabled": true, "skills": ["sql-style"] } }
 *
 * The appended block is byte-identical on every turn and follows config order,
 * so it stays inside the provider's cached prefix. Unknown names are skipped;
 * run /pinned-skills to see which ones resolved. `"enabled": false` turns the
 * extension off.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	configFilePath,
	isExtensionEnabled,
	readSection,
	stringArrayValue,
} from "./pi-tweaks-config";

const EXTENSION = "pi-pinned-skills";
const LEGACY_FILE = "pinned-skills.json"; // the previous global home

type SkillEntry = { name: string; filePath: string };
type ResolvedNames =
	| { kind: "names"; path: string; names: string[] }
	| { kind: "missing" }
	| { kind: "invalid"; path: string };

function readNames(path: string): string[] | null {
	if (!existsSync(path)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!Array.isArray(parsed)) return null;
		return parsed.filter((name): name is string => typeof name === "string");
	} catch {
		return null;
	}
}

function resolveNames(ctx: ExtensionContext): ResolvedNames {
	const project = join(ctx.cwd, CONFIG_DIR_NAME, LEGACY_FILE);
	if (ctx.isProjectTrusted() && existsSync(project)) {
		const names = readNames(project);
		return names
			? { kind: "names", path: project, names }
			: { kind: "invalid", path: project };
	}

	const section = readSection(EXTENSION);
	if (section?.skills !== undefined) {
		if (!Array.isArray(section.skills)) {
			return { kind: "invalid", path: configFilePath() };
		}
		return {
			kind: "names",
			path: configFilePath(),
			names: stringArrayValue(section, "skills", []),
		};
	}

	const global = join(getAgentDir(), LEGACY_FILE);
	if (!existsSync(global)) return { kind: "missing" };
	const names = readNames(global);
	return names
		? { kind: "names", path: global, names }
		: { kind: "invalid", path: global };
}

/** Frontmatter is metadata: the description is already in the skills list. */
function stripFrontmatter(text: string): string {
	return text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "");
}

function build(
	skills: readonly SkillEntry[],
	names: readonly string[],
): { text: string; missing: string[] } {
	const byName = new Map(skills.map((skill) => [skill.name, skill]));
	const seen = new Set<string>();
	const missing: string[] = [];
	const parts: string[] = [];

	for (const name of names) {
		if (seen.has(name)) continue;
		seen.add(name);

		const skill = byName.get(name);
		let body: string | undefined;
		if (skill) {
			try {
				body = stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
			} catch {
				body = undefined;
			}
		}

		if (!body) {
			missing.push(name);
			continue;
		}
		parts.push(`<skill name="${name}">\n${body}\n</skill>`);
	}

	const text =
		parts.length > 0
			? `<pinned_skills>\n${parts.join("\n\n")}\n</pinned_skills>`
			: "";
	return { text, missing };
}

export default function pinnedSkills(pi: ExtensionAPI) {
	if (!isExtensionEnabled(EXTENSION)) return;

	pi.on("before_agent_start", async (event, ctx) => {
		const resolved = resolveNames(ctx);
		if (resolved.kind !== "names" || resolved.names.length === 0) return;

		const { text } = build(
			event.systemPromptOptions.skills ?? [],
			resolved.names,
		);
		if (!text) return;

		return { systemPrompt: `${event.systemPrompt}\n\n${text}\n` };
	});

	pi.registerCommand("pinned-skills", {
		description: "Show pinned skills and report names that did not resolve",
		handler: async (_args, ctx) => {
			const resolved = resolveNames(ctx);
			if (resolved.kind === "missing") {
				ctx.ui.notify(
					`No ${LEGACY_FILE} or ${EXTENSION}.skills found`,
					"warning",
				);
				return;
			}
			if (resolved.kind === "invalid") {
				ctx.ui.notify(`${resolved.path} is not a list of skill names`, "error");
				return;
			}

			const { text, missing } = build(
				ctx.getSystemPromptOptions().skills ?? [],
				resolved.names,
			);
			const lines = [
				`config: ${resolved.path}`,
				`pinned: ${resolved.names.join(", ") || "none"}`,
				`resolved: ${resolved.names.length - missing.length} of ${resolved.names.length}`,
				`appended: ${Buffer.byteLength(text)} bytes`,
			];
			if (missing.length > 0) lines.push(`missing: ${missing.join(", ")}`);
			ctx.ui.notify(lines.join("\n"), missing.length > 0 ? "warning" : "info");
		},
	});
}
