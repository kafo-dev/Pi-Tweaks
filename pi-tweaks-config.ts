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
 *     "pi-exit": { "enabled": false }
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
