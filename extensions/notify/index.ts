/**
 * notify — alert the user when pi needs them.
 *
 * Events:
 *   agent_settled    pi finished the turn and is waiting for your reply
 *   ui_prompt_start  pi is blocked on a confirm/select/input/editor dialog
 *
 * Config: the `notify` section of `pi-tweaks.json` (see pi-tweaks-config.ts).
 *
 *   {
 *     "notify": {
 *       "enabled": true,
 *       "backend": "off" | "termcodes" | "notify-send",
 *       "phone":   "off" | "ping" | "ring",
 *       "device":  "kdeconnect device id"     // empty = auto-detect
 *     }
 *   }
 *
 * `backend` defaults to "termcodes" and `phone` to "off": installing the
 * package gives you terminal notifications immediately, and no phone is rung
 * until you ask for one. `"enabled": false` turns the extension off. The
 * `/pi-tweaks notify` subcommand writes changes back to that file.
 *
 * Commands (registered by pi-tweaks.ts, the package's one command):
 *   /pi-tweaks notify                     show settings
 *   /pi-tweaks notify backend <value>
 *   /pi-tweaks notify phone <value>
 *   /pi-tweaks notify device <id|auto>
 *   /pi-tweaks notify test                fire a dialog to exercise the path
 *
 * The command reads and writes the section on every call. pi loads each
 * extension with its own module cache, so the copy pi-tweaks.ts imports holds
 * no state that could go stale.
 *
 * Headless runs (`-p`, `--mode json`, subagents) never notify: `ctx.hasUI` is
 * false there, and a script must not ring your phone.
 *
 * `termcodes` is OSC 777 (Ghostty, iTerm2, WezTerm); `notify-send` needs a
 * desktop session. Phone needs `kdeconnect-cli`: `ring` needs KDE Connect's
 * Find My Phone plugin, `ping` needs Ping.
 */

import { execFile } from "node:child_process";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	configFilePath,
	isExtensionEnabled,
	readSection,
	stringValue,
	updateSection,
} from "../../lib/pi-tweaks-config";

const EXTENSION = "notify";

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

/** Read the section, applying defaults to missing or invalid values. */
function loadSettings(): Settings {
	const section = readSection(EXTENSION);
	const settings = { ...DEFAULTS };
	for (const key of KEYS) {
		settings[key] = stringValue(section, key, OPTIONS[key], DEFAULTS[key]);
	}
	return settings;
}

/** Persist to pi-tweaks.json; other sections and `enabled` are preserved. */
function saveSettings(settings: Settings) {
	updateSection(EXTENSION, { ...settings });
}

function describe(settings: Settings): string {
	const values = KEYS.map((key) => `${key}=${settings[key] || "(auto)"}`);
	return `notify: ${values.join(", ")}`;
}

function notifyLocal(settings: Settings, body: string) {
	if (settings.backend === "notify-send") {
		execFile("notify-send", ["Pi", body], () => {});
	} else if (settings.backend === "termcodes" && process.stdout.isTTY) {
		process.stdout.write(`\x1b]777;notify;Pi;${body}\x07`);
	}
}

let detectedDevice: string | null = null;

function resolveDevice(settings: Settings): Promise<string | undefined> {
	if (settings.device) return Promise.resolve(settings.device);
	if (detectedDevice) return Promise.resolve(detectedDevice);
	return new Promise((resolve) => {
		execFile("kdeconnect-cli", ["-a", "--id-only"], (err, out) => {
			if (!err) detectedDevice = out.trim().split("\n")[0] || null;
			resolve(detectedDevice ?? undefined);
		});
	});
}

async function notifyPhone(settings: Settings, body: string) {
	if (settings.phone === "off") return;
	const device = await resolveDevice(settings);
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
	const settings = loadSettings();
	notifyLocal(settings, body);
	await notifyPhone(settings, body);
}

/**
 * The `/pi-tweaks notify` subcommand. `args` is what follows `notify`: nothing
 * to report, a key and value to change, `test` for a dialog, or a key alone to
 * report that one value.
 */
export async function runNotify(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const [name, value] = args.trim().split(/\s+/);
	if (name === "test") {
		await ctx.ui.confirm("Pi", "Notification test");
		return;
	}

	const settings = loadSettings();
	const key = name as keyof Settings;
	const choices = OPTIONS[key];

	if (!name) {
		ctx.ui.notify(`${describe(settings)} — ${configFilePath()}`, "info");
		return;
	}
	if (!choices) {
		ctx.ui.notify(
			`Usage: /pi-tweaks notify [${KEYS.join("|")}|test] <value>`,
			"error",
		);
		return;
	}
	if (!value) {
		ctx.ui.notify(`${name} = ${settings[key] || "(auto)"}`, "info");
		return;
	}

	if (key === "device" && value === "auto") {
		settings.device = "";
		saveSettings(settings);
		ctx.ui.notify(describe(settings), "info");
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
	saveSettings(settings);
	ctx.ui.notify(describe(settings), "info");
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
}
