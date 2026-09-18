/**
 * pi-notify — alert the user when pi needs them.
 *
 * Events:
 *   agent_settled    pi finished the turn and is waiting for your reply
 *   ui_prompt_start  pi is blocked on a confirm/select/input/editor dialog
 *
 * Settings: $PI_CODING_AGENT_DIR/pi-notify.json (~/.pi/agent/pi-notify.json)
 *   {
 *     "backend": "off" | "termcodes" | "notify-send",
 *     "phone":   "off" | "ping" | "ring",
 *     "device":  "kdeconnect device id"     // empty = auto-detect
 *   }
 *
 * `backend` defaults to "termcodes" and `phone` to "off": installing the
 * package gives you terminal notifications immediately, and no phone is rung
 * until you ask for one. `/notify` writes changes back to that file.
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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SETTINGS_PATH = join(
	process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
	"pi-notify.json",
);

interface Settings {
	backend: string;
	phone: string;
	device: string;
}

const DEFAULTS: Settings = { backend: "termcodes", phone: "off", device: "" };

/** Allowed values per key. An empty list means "any non-empty string". */
const OPTIONS: Record<keyof Settings, string[]> = {
	backend: ["off", "termcodes", "notify-send"],
	phone: ["off", "ping", "ring"],
	device: [],
};

const KEYS = Object.keys(OPTIONS) as (keyof Settings)[];

function loadSettings(): Settings {
	let file: Partial<Settings>;
	try {
		file = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
	} catch {
		return { ...DEFAULTS };
	}

	const settings = { ...DEFAULTS };
	for (const key of KEYS) {
		const value = file[key];
		if (typeof value !== "string") continue;
		if (OPTIONS[key].length ? OPTIONS[key].includes(value) : value !== "") settings[key] = value;
	}
	return settings;
}

const settings = loadSettings();

function saveSettings() {
	try {
		mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
		writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
	} catch {
		// Read-only config dir: keep going with in-memory settings.
	}
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
		settings.phone === "ring" ? ["-d", device, "--ring"] : ["-d", device, "--ping-msg", body],
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
	// `/stop` aborts the turn on purpose, so the settle that follows is not news.
	// pi-stop announces the abort; skip that one alert.
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
		description: "Show or change pi-notify settings (persisted to pi-notify.json)",
		handler: async (args, ctx) => {
			const [name, value] = args.trim().split(/\s+/);
			const key = name as keyof Settings;
			const choices = OPTIONS[key];

			if (!name) {
				ctx.ui.notify(`${describe()} — ${SETTINGS_PATH}`, "info");
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
				ctx.ui.notify(`${name} must be one of: ${choices.join(", ") || "a device id"}`, "error");
				return;
			}

			settings[key] = value;
			saveSettings();
			ctx.ui.notify(describe(), "info");
		},
	});

	pi.registerCommand("notify-test", {
		description: "Fire a confirmation dialog to test phone and local notifications",
		handler: async (_args, ctx) => {
			await ctx.ui.confirm("Pi", "Notification test");
		},
	});
}
