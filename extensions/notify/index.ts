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
 *       "backend": "off" | "termcodes" | "notify-send" | "termux",
 *       "topic":   "" | "ntfy topic",
 *       "server":  "https://ntfy.sh",
 *       "token":   "" | "ntfy access token"
 *     }
 *   }
 *
 * `backend` defaults to "termcodes" and `topic` to "": installing the
 * package gives you terminal notifications immediately, and no phone is
 * pushed to until you set a topic. `"enabled": false` turns the extension off.
 * The `/pi-tweaks notify` subcommand writes changes back to that file.
 *
 * Commands (registered by pi-tweaks.ts, the package's one command):
 *   /pi-tweaks notify                     show settings
 *   /pi-tweaks notify backend <value>
 *   /pi-tweaks notify topic <topic|off>
 *   /pi-tweaks notify server <url>
 *   /pi-tweaks notify token <value|off>
 *   /pi-tweaks notify test                fire a dialog to exercise the path
 *
 * The command reads and writes the section on every call. pi loads each
 * extension with its own module cache, so the copy pi-tweaks.ts imports holds
 * no state that could go stale.
 *
 * Headless runs (`-p`, `--mode json`, subagents) never notify: `ctx.hasUI` is
 * false there, and a script must not push to your phone.
 *
 * `termcodes` is OSC 777 (Ghostty, iTerm2, WezTerm); `notify-send` needs a
 * desktop session; `termux` runs `termux-notification`, which puts the alert
 * in the Android notification shade, and suits pi running inside Termux. The
 * push POSTs the body to the ntfy topic on `server`, which defaults to the
 * hosted `https://ntfy.sh`, and carries `token` as a bearer token when one is
 * set, which a server with authentication enabled requires; subscribe to that
 * topic in the ntfy app to receive it. A report masks the token.
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
	topic: string;
	server: string;
	token: string;
}

const DEFAULTS: Settings = {
	backend: "termcodes",
	topic: "",
	server: "https://ntfy.sh",
	token: "",
};

/** Allowed values per key. An empty list means "any string". */
const OPTIONS: Record<keyof Settings, string[]> = {
	backend: ["off", "termcodes", "notify-send", "termux"],
	topic: [],
	server: [],
	token: [],
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

/**
 * Keys whose value never goes into a report: an access token belongs in the
 * file, and the command prints the path of that file.
 */
const SECRET_KEYS: ReadonlySet<keyof Settings> = new Set(["token"]);

/** One setting as a report prints it: an empty value shows as "(off)". */
function show(key: keyof Settings, value: string): string {
	if (value === "") return "(off)";
	if (!SECRET_KEYS.has(key)) return value;
	return value.length > 8 ? `${value.slice(0, 8)}…` : "…";
}

function describe(settings: Settings): string {
	const values = KEYS.map((key) => `${key}=${show(key, settings[key])}`);
	return `notify: ${values.join(", ")}`;
}

/**
 * The notification id the app reuses: Android replaces a notification whose id
 * it already shows, so alerts do not stack up one per turn.
 */
const TERMUX_ID = "pi";

function notifyLocal(settings: Settings, body: string) {
	if (settings.backend === "notify-send") {
		execFile("notify-send", ["Pi", body], () => {});
	} else if (settings.backend === "termux") {
		// pi runs inside Termux, so the terminal and the device are one and the
		// same: the alert belongs in the notification shade.
		execFile(
			"termux-notification",
			["-t", "Pi", "-i", TERMUX_ID, "-c", body],
			() => {},
		);
	} else if (settings.backend === "termcodes" && process.stdout.isTTY) {
		process.stdout.write(`\x1b]777;notify;Pi;${body}\x07`);
	}
}

/** POST the body to the ntfy topic. A failed push is dropped, never thrown. */
function notifyNtfy(settings: Settings, body: string) {
	if (!settings.topic) return;
	if (!settings.server) return;
	const server = settings.server.replace(/\/+$/, "");
	const url = `${server}/${encodeURIComponent(settings.topic)}`;
	const headers: Record<string, string> = { Title: "Pi", Tags: "robot" };
	// A server with authentication enabled answers `40301 forbidden` to an
	// anonymous publish, so the token rides along when one is set.
	if (settings.token) headers.Authorization = `Bearer ${settings.token}`;
	void fetch(url, {
		method: "POST",
		headers,
		body,
	}).catch(() => {});
}

function notifyUser(ctx: ExtensionContext, body: string) {
	// Headless runs (print, JSON, subagents) have no one watching, and must not
	// push to a phone from a script.
	if (!ctx.hasUI) return;
	const settings = loadSettings();
	notifyLocal(settings, body);
	notifyNtfy(settings, body);
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
		ctx.ui.notify(`${name} = ${show(key, settings[key])}`, "info");
		return;
	}

	if ((key === "topic" || key === "token") && value === "off") {
		settings[key] = "";
		saveSettings(settings);
		ctx.ui.notify(describe(settings), "info");
		return;
	}

	const valid = choices.length ? choices.includes(value) : value !== "";
	if (!valid) {
		ctx.ui.notify(
			`${name} must be one of: ${choices.join(", ") || "a non-empty value"}`,
			"error",
		);
		return;
	}
	if (key === "server" && !/^https?:\/\/\S+$/.test(value)) {
		ctx.ui.notify("server must be an http(s) URL", "error");
		return;
	}

	settings[key] = value;
	saveSettings(settings);
	ctx.ui.notify(describe(settings), "info");
}

export default function (pi: ExtensionAPI) {
	if (!isExtensionEnabled(EXTENSION)) return;

	pi.on("agent_settled", (_event, ctx) => {
		notifyUser(ctx, "Ready for input");
	});
	pi.on("ui_prompt_start", (event, ctx) =>
		notifyUser(ctx, `Needs input: ${event.title ?? event.kind}`),
	);
}
