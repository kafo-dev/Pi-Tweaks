/**
 * pi-tweaks-config — one configuration file for every Pi-Tweaks extension.
 *
 * The file is `pi-tweaks.json` in pi's agent directory:
 *
 *   $PI_CODING_AGENT_DIR/pi-tweaks.json   (~/.pi/agent/pi-tweaks.json)
 *
 * One top-level key per extension, named after its file. An extension's
 * section holds that extension's settings and an optional `enabled` switch:
 *
 *   {
 *     "pi-notify": {
 *       "enabled": true,
 *       "backend": "termcodes",
 *       "phone": "off",
 *       "device": ""
 *     },
 *     "exit-alias": { "enabled": false }
 *   }
 *
 * `"enabled": false` makes an extension register nothing. pi imports
 * extension modules at startup, so the switch takes effect on the next start
 * (or `/reload`). A missing file, a missing section, or a malformed file all
 * mean "enabled, with defaults": a typo can never silently disable a tool.
 *
 * Sections written by an extension (`updateSection`) merge into the file, so
 * the other sections and the `enabled` switch survive. A read-only agent
 * directory turns the write into a silent no-op, and an extension keeps its
 * in-memory settings.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** File name, inside pi's agent directory. */
export const CONFIG_FILE_NAME = "pi-tweaks.json";

/** One extension's section: arbitrary JSON, plus the reserved `enabled` key. */
export type Section = Record<string, unknown>;

/** Absolute path of the central configuration file. */
export function configFilePath(): string {
	return join(getAgentDir(), CONFIG_FILE_NAME);
}

function isSection(value: unknown): value is Section {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The parsed file as a whole; an absent or malformed file reads as empty. */
export function readConfigFile(): Section {
	try {
		const parsed: unknown = JSON.parse(readFileSync(configFilePath(), "utf8"));
		return isSection(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** The section named after an extension, or null when it is absent. */
export function readSection(extension: string): Section | null {
	const section = readConfigFile()[extension];
	return isSection(section) ? section : null;
}

/**
 * Whether an extension should register anything. Only the boolean `false`
 * disables; a missing section, any other value, and a malformed file all keep
 * the extension on.
 */
export function isExtensionEnabled(extension: string): boolean {
	return readSection(extension)?.enabled !== false;
}

/**
 * Whether an experimental extension should register anything. Unrelated to
 * `isExtensionEnabled`, which defaults a missing section to on: here the
 * section must set `"enabled": true`, so a missing section, any other value,
 * and a malformed file all leave the experiment off.
 */
export function isExperimentEnabled(extension: string): boolean {
	return readSection(extension)?.enabled === true;
}

/** One extension the package ships, in `pi.extensions` order. */
export type PackagedExtension = {
	/** Section name in `pi-tweaks.json`, taken from the file name. */
	name: string;
	/** Path as written in `pi.extensions`, from the package root. */
	path: string;
	/** Whether the file lives in `extensions/experiments/`, where a section defaults off. */
	experiment: boolean;
};

/**
 * Section name and kind of an extension, from its `pi.extensions` path. The
 * name follows the file: the `.ts` suffix goes, `index` stands for its
 * directory, and an experiment keeps that directory as a prefix, so
 * `extensions/experiments/minimal-mode.ts` is `experiment-minimal-mode`.
 */
function parseExtensionPath(path: string): PackagedExtension {
	const bare = path.replace(/^\.\//, "").replace(/\.ts$/, "");
	const parts = bare.split("/");
	// Extensions live under `extensions/`, experiments under a further
	// `experiments/` there. The section name drops both directory levels:
	// `extensions/pi-notify/index.ts` is `pi-notify`, and
	// `extensions/experiments/minimal-mode.ts` is `experiment-minimal-mode`.
	const afterRoot = parts[0] === "extensions" ? parts.slice(1) : parts;
	const experiment = afterRoot.length > 1 && afterRoot[0] === "experiments";
	const file = (experiment ? afterRoot.slice(1) : afterRoot).join("/");
	const name = file.endsWith("/index") ? file.slice(0, -"/index".length) : file;
	return { name: experiment ? `experiment-${name}` : name, path, experiment };
}

/**
 * Every extension in the package manifest, read from the `package.json` at
 * the package root. `null` when that file is missing or unreadable, or when
 * `pi.extensions` is absent or holds a non-string entry.
 */
export function packagedExtensions(): PackagedExtension[] | null {
	try {
		const manifest = JSON.parse(
			readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
		) as { pi?: { extensions?: unknown } };
		const paths = manifest.pi?.extensions;
		if (!Array.isArray(paths)) return null;
		if (!paths.every((path) => typeof path === "string")) return null;
		return (paths as string[]).map(parseExtensionPath);
	} catch {
		return null;
	}
}

/** Whether one extension of the package registers anything. */
export function isPackagedExtensionEnabled(
	extension: PackagedExtension,
): boolean {
	return extension.experiment
		? isExperimentEnabled(extension.name)
		: isExtensionEnabled(extension.name);
}

/** Replace the given keys of one section, preserving the rest of the file. */
export function updateSection(extension: string, values: Section): void {
	const path = configFilePath();
	const file = readConfigFile();
	const existing = file[extension];
	const section = isSection(existing)
		? { ...existing, ...values }
		: { ...values };
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			`${JSON.stringify({ ...file, [extension]: section }, null, 2)}\n`,
		);
	} catch {
		// Read-only agent directory: keep the in-memory value.
	}
}

/**
 * A string value from a section. When `allowed` is non-empty the value must be
 * one of its entries; otherwise any string is accepted.
 */
export function stringValue(
	section: Section | null,
	key: string,
	allowed: readonly string[],
	fallback: string,
): string {
	const value = section?.[key];
	if (typeof value !== "string") return fallback;
	if (allowed.length > 0 && !allowed.includes(value)) return fallback;
	return value;
}

/** A number value from a section, with optional positivity, integrality, and ceiling. */
export function numberValue(
	section: Section | null,
	key: string,
	fallback: number,
	options: { positive?: boolean; integer?: boolean; atMost?: number } = {},
): number {
	const value = section?.[key];
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	if (options.positive && value <= 0) return fallback;
	if (options.integer && !Number.isInteger(value)) return fallback;
	if (options.atMost !== undefined && value > options.atMost) return fallback;
	return value;
}

/** An array of strings from a section; a non-array falls back and non-strings are dropped. */
export function stringArrayValue(
	section: Section | null,
	key: string,
	fallback: string[],
): string[] {
	const value = section?.[key];
	if (!Array.isArray(value)) return fallback;
	return value.filter((entry): entry is string => typeof entry === "string");
}
