/**
 * pi-pinned-skills — append the full text of chosen skills to the system prompt.
 *
 * pi loads skills on demand: only each skill's name, description, and path
 * reach the system prompt, and the model decides whether to read the file. This
 * extension forces the full text of the skills named in a config file into the
 * system prompt on every turn, so their rules always apply.
 *
 * Config, first found wins:
 *   <cwd>/.pi/pinned-skills.json     project, honored only when the project is trusted
 *   <agent-dir>/pinned-skills.json   global
 *
 * Format: a JSON array of skill names.
 *
 *   ["brand-guidelines", "sql-style"]
 *
 * The appended block is byte-identical on every turn and follows config order,
 * so it stays inside the provider's cached prefix. Unknown names are skipped;
 * run /pinned-skills to see which ones resolved.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONFIG_FILE = "pinned-skills.json";

type SkillEntry = { name: string; filePath: string };

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

function configPath(ctx: ExtensionContext): string | null {
	const project = join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE);
	if (ctx.isProjectTrusted() && existsSync(project)) return project;
	const global = join(getAgentDir(), CONFIG_FILE);
	return existsSync(global) ? global : null;
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

	const text = parts.length > 0 ? `<pinned_skills>\n${parts.join("\n\n")}\n</pinned_skills>` : "";
	return { text, missing };
}

export default function pinnedSkills(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const path = configPath(ctx);
		if (!path) return;

		const names = readNames(path);
		if (!names || names.length === 0) return;

		const { text } = build(event.systemPromptOptions.skills ?? [], names);
		if (!text) return;

		return { systemPrompt: `${event.systemPrompt}\n\n${text}\n` };
	});

	pi.registerCommand("pinned-skills", {
		description: "Show pinned skills and report names that did not resolve",
		handler: async (_args, ctx) => {
			const path = configPath(ctx);
			if (!path) {
				ctx.ui.notify(`No ${CONFIG_FILE} found`, "warning");
				return;
			}

			const names = readNames(path);
			if (!names) {
				ctx.ui.notify(`${path} is not a JSON array of skill names`, "error");
				return;
			}

			const { text, missing } = build(ctx.getSystemPromptOptions().skills ?? [], names);
			const lines = [
				`config: ${path}`,
				`pinned: ${names.join(", ") || "none"}`,
				`resolved: ${names.length - missing.length} of ${names.length}`,
				`appended: ${Buffer.byteLength(text)} bytes`,
			];
			if (missing.length > 0) lines.push(`missing: ${missing.join(", ")}`);
			ctx.ui.notify(lines.join("\n"), missing.length > 0 ? "warning" : "info");
		},
	});
}
