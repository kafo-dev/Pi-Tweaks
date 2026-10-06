#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Set, list, or clear a persistent device and user-agent emulation, adapted
// from mitsuhiko/agent-stuff `skills/web-browser/scripts/emulate.js` (MIT).

import puppeteer from "puppeteer-core";
import {
	clearDeviceEmulation,
	listDevicePresets,
	resolveDevicePreset,
} from "./browser-devices.js";
import {
	applyActiveEmulation,
	clearEmulationPreference,
	readEmulationPreference,
	writeEmulationPreference,
} from "./browser-emulation.js";

const args = process.argv.slice(2);

function usage(message) {
	if (message) console.error(`✗ ${message}`);
	console.log("Usage: browser-emulate.js <device> [--landscape]");
	console.log("       browser-emulate.js [<device>] --ua <user-agent>");
	console.log("       browser-emulate.js --ua reset");
	console.log("       browser-emulate.js --reset");
	console.log("       browser-emulate.js --list");
	console.log("\nExamples:");
	console.log("  browser-emulate.js --list");
	console.log("  browser-emulate.js iphone-14");
	console.log("  browser-emulate.js pixel-7 --landscape");
	console.log("  browser-emulate.js --ua chrome");
	console.log("  browser-emulate.js --ua reset");
	console.log("  browser-emulate.js --reset");
	process.exit(1);
}

let list = false;
let reset = false;
let landscape = false;
let deviceName = null;
// `undefined` keeps the stored override, `null` clears it, a string sets it.
let userAgent;

for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--list") {
		list = true;
	} else if (arg === "--reset") {
		reset = true;
	} else if (arg === "--landscape") {
		landscape = true;
	} else if (arg === "--ua" || arg.startsWith("--ua=")) {
		const value = arg === "--ua" ? args[++i] : arg.slice("--ua=".length);
		if (!value) usage("--ua needs a user agent, or `reset`.");
		userAgent = value === "reset" ? null : value;
	} else if (arg.startsWith("--")) {
		usage(`unknown option "${arg}".`);
	} else if (deviceName === null) {
		deviceName = arg;
	} else {
		usage(`unexpected argument "${arg}".`);
	}
}

if (reset && (deviceName !== null || userAgent !== undefined)) {
	usage("--reset cannot be combined with a device or --ua.");
}

if (list) {
	const presets = listDevicePresets();
	const width = Math.max(...presets.map((preset) => preset.id.length));
	for (const preset of presets) {
		console.log(
			`  ${preset.id.padEnd(width)}  ${preset.title} (${preset.width}x${preset.height} @${preset.deviceScaleFactor}x)`,
		);
	}
	process.exit(0);
}

if (!reset && deviceName === null && userAgent === undefined) usage();

let preset = null;
if (deviceName !== null) {
	preset = resolveDevicePreset(deviceName);
	if (!preset) {
		console.error(`✗ Unknown device "${deviceName}". Run browser-emulate.js --list.`);
		process.exit(1);
	}
}

// Merge the flags into the stored preference, so setting one field keeps the
// other. `--reset` drops both.
const stored = readEmulationPreference();
let state = { device: null, landscape: false, userAgent: null };
if (!reset) {
	state = {
		device: preset ? preset.id : (stored?.device ?? null),
		landscape: preset ? landscape : (stored?.landscape ?? false),
		userAgent: userAgent === undefined ? (stored?.userAgent ?? null) : userAgent,
	};
}

const b = await Promise.race([
	puppeteer.connect({
		browserURL: "http://localhost:9222",
		defaultViewport: null,
	}),
	new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
]).catch((e) => {
	console.error("✗ Could not connect to browser:", e.message);
	console.error("  Run: browser-start-linux.js");
	process.exit(1);
});

const p = (await b.pages()).at(-1);

if (!p) {
	console.error("✗ No active tab found");
	process.exit(1);
}

if (reset) clearEmulationPreference();
else writeEmulationPreference(state);

// Reconcile the page with the stored state: drop every override it carries,
// then apply what the preference now says.
await clearDeviceEmulation(p);
const applied = await applyActiveEmulation(p);

if (applied?.preset) {
	console.log(
		`✓ Emulating ${applied.preset.title}${applied.landscape ? " (landscape)" : ""} (${applied.width}x${applied.height})`,
	);
}
if (applied?.userAgent) {
	console.log(`✓ User agent: ${applied.userAgent}`);
}
if (!applied?.preset && !applied?.userAgent) {
	console.log("✓ Device and user-agent emulation cleared");
}

await b.disconnect();
