/**
 * pi-notify — alert the user when pi needs them.
 *
 * Events:
 *   agent_settled    pi finished the turn and is waiting for your reply
 *   ui_prompt_start  pi is blocked on a confirm/select/input/editor dialog
 *
 * Config: the `pi-notify` section of `pi-tweaks.json` (see
 * pi-tweaks-config.ts).
 *
 *   {
 *     "pi-notify": {
 *       "enabled": true,
 *       "backend": "off" | "termcodes" | "notify-send",
 *       "phone":   "off" | "ping" | "ring",
 *       "device":  "kdeconnect device id"     // empty = auto-detect
 *     }
 *   }
 *
 * `backend` defaults to "termcodes" and `phone` to "off": installing the
 * package gives you terminal notifications immediately, and no phone is rung
 * until you ask for one. `"enabled": false` turns the extension off. `/notify`
 * writes changes back to that file. The old `pi-notify.json` is still read
 * until the `pi-notify` section exists; the first write migrates the settings
 * and the old file is ignored from then on.
 *
 * Commands:
 *   /notify                      show settings
 *   /notify backend <value>
 *   /notify phone <value>
 *   /notify device <id|auto>
 *   /notify-test                 fire a dialog to exercise the whole path
 *
 * Headless runs (`-p`, `--mode json`, subagents) never notify: `ctx.hasUI` is
 * false there, and a script must not ring your phone.
 *
 * `termcodes` is OSC 777 (Ghostty, iTerm2, WezTerm); `notify-send` needs a
 * desktop session. Phone needs `kdeconnect-cli`: `ring` needs KDE Connect's
 * Find My Phone plugin, `ping` needs Ping.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	configFilePath,
	isExtensionEnabled,
	readSection,
	type Section,
	stringValue,
	updateSection,
} from "../../lib/pi-tweaks-config";

const EXTENSION = "pi-notify";
const LEGACY_FILE = "pi-notify.json"; // read until pi-tweaks.json has a section

interface Settings {
	backend: string;
	phone: string;
	device: string;
}

const DEFAULTS: Settings = { backend: "termcodes", phone: "off", device: "" };

/** Allowed values per key. An empty list means "any string". */
const OPTIONS: Record<keyof Settings, string[]> = {
	backend: ["off", "termcodes", "notify-send"],
	phone: ["off", "ping", "ring"],
	device: [],
};

const KEYS = Object.keys(OPTIONS) as (keyof Settings)[];

/** The previous home of these settings, read only until the section exists. */
function legacySection(): Section | null {
	try {
		const parsed: unknown = JSON.parse(
			readFileSync(join(getAgentDir(), LEGACY_FILE), "utf8"),
		);
		return typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
			? (parsed as Section)
			: null;
	} catch {
		return null;
	}
}

function loadSettings(): Settings {
	const section = readSection(EXTENSION) ?? legacySection();
	const settings = { ...DEFAULTS };
	for (const key of KEYS) {
		settings[key] = stringValue(section, key, OPTIONS[key], DEFAULTS[key]);
	}
	return settings;
}

const settings = loadSettings();

/** Persist to pi-tweaks.json; other sections and `enabled` are preserved. */
function saveSettings() {
	updateSection(EXTENSION, { ...settings });
}

const describe = () =>
	`pi-notify: ${KEYS.map((key) => `${key}=${settings[key] || "(auto)"}`).join(", ")}`;

function notifyLocal(body: string) {
	if (settings.backend === "notify-send") {
		execFile("notify-send", ["Pi", body], () => {});
	} else if (settings.backend === "termcodes" && process.stdout.isTTY) {
		process.stdout.write(`\x1b]777;notify;Pi;${body}\x07`);
	}
}

let detectedDevice: string | null = null;

function resolveDevice(): Promise<string | undefined> {
	if (settings.device) return Promise.resolve(settings.device);
	if (detectedDevice) return Promise.resolve(detectedDevice);
	return new Promise((resolve) => {
		execFile("kdeconnect-cli", ["-a", "--id-only"], (err, out) => {
			if (!err) detectedDevice = out.trim().split("\n")[0] || null;
			resolve(detectedDevice ?? undefined);
		});
	});
}

async function notifyPhone(body: string) {
	if (settings.phone === "off") return;
	const device = await resolveDevice();
	if (!device) return;
	execFile(
		"kdeconnect-cli",
		settings.phone === "ring"
			? ["-d", device, "--ring"]
			: ["-d", device, "--ping-msg", body],
		() => {},
	);
}

async function notifyUser(ctx: ExtensionContext, body: string) {
	// Headless runs (print, JSON, subagents) have no one watching, and must not
	// ring the phone from a script.
	if (!ctx.hasUI) return;
	notifyLocal(body);
	await notifyPhone(body);
}

export default function (pi: ExtensionAPI) {
	if (!isExtensionEnabled(EXTENSION)) return;

	// The retired pi-stop extension announced an intentional abort on this bus,
	// so the settle it causes is not news. The listener stays for the archived
	// copy, loadable with `pi -e .archived/pi-stop.ts`; Escape and Ctrl+C abort
	// without announcing.
	let turnAborted = false;
	pi.events.on("turn-aborted", () => {
		turnAborted = true;
	});
	pi.on("agent_start", () => {
		turnAborted = false;
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (turnAborted) {
			turnAborted = false;
			return;
		}
		notifyUser(ctx, "Ready for input");
	});
	pi.on("ui_prompt_start", (event, ctx) =>
		notifyUser(ctx, `Needs input: ${event.title ?? event.kind}`),
	);

	pi.registerCommand("notify", {
		description:
			"Show or change pi-notify settings (persisted to pi-tweaks.json)",
		handler: async (args, ctx) => {
			const [name, value] = args.trim().split(/\s+/);
			const key = name as keyof Settings;
			const choices = OPTIONS[key];

			if (!name) {
				ctx.ui.notify(`${describe()} — ${configFilePath()}`, "info");
				return;
			}
			if (!choices) {
				ctx.ui.notify(`Usage: /notify [${KEYS.join("|")}] <value>`, "error");
				return;
			}
			if (!value) {
				ctx.ui.notify(`${name} = ${settings[key] || "(auto)"}`, "info");
				return;
			}

			if (key === "device" && value === "auto") {
				settings.device = "";
				saveSettings();
				ctx.ui.notify(describe(), "info");
				return;
			}

			const valid = choices.length ? choices.includes(value) : value !== "";
			if (!valid) {
				ctx.ui.notify(
					`${name} must be one of: ${choices.join(", ") || "a device id"}`,
					"error",
				);
				return;
			}

			settings[key] = value;
			saveSettings();
			ctx.ui.notify(describe(), "info");
		},
	});

	pi.registerCommand("notify-test", {
		description:
			"Fire a confirmation dialog to test phone and local notifications",
		handler: async (_args, ctx) => {
			await ctx.ui.confirm("Pi", "Notification test");
		},
	});
}
