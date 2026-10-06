#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Set, list, or clear a persistent device emulation, adapted from
// mitsuhiko/agent-stuff `skills/web-browser/scripts/emulate.js` (MIT).

import puppeteer from "puppeteer-core";
import {
	applyDevicePreset,
	clearDeviceEmulation,
	listDevicePresets,
	resolveDevicePreset,
} from "./browser-devices.js";
import {
	clearEmulationPreference,
	writeEmulationPreference,
} from "./browser-emulation.js";

const args = process.argv.slice(2);
const list = args.includes("--list");
const reset = args.includes("--reset");
const landscape = args.includes("--landscape");
const deviceName = args.find((arg) => !arg.startsWith("--"));

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

if (!reset && !deviceName) {
	console.log("Usage: browser-emulate.js <device> [--landscape]");
	console.log("       browser-emulate.js --reset");
	console.log("       browser-emulate.js --list");
	console.log("\nExamples:");
	console.log("  browser-emulate.js --list");
	console.log("  browser-emulate.js iphone-14");
	console.log("  browser-emulate.js pixel-7 --landscape");
	console.log("  browser-emulate.js --reset");
	process.exit(1);
}

const preset = reset ? null : resolveDevicePreset(deviceName);
if (!reset && !preset) {
	console.error(`✗ Unknown device "${deviceName}". Run browser-emulate.js --list.`);
	process.exit(1);
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

if (reset) {
	await clearDeviceEmulation(p);
	clearEmulationPreference();
	console.log("✓ Device emulation cleared");
} else {
	const metrics = await applyDevicePreset(p, preset, { landscape });
	writeEmulationPreference({ device: preset.id, landscape });
	console.log(
		`✓ Emulating ${preset.title}${landscape ? " (landscape)" : ""} (${metrics.width}x${metrics.height})`,
	);
}

await b.disconnect();
