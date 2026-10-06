#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import {
	applyDevicePreset,
	clearDeviceEmulation,
	resolveDevicePreset,
} from "./browser-devices.js";
import {
	applyActiveEmulation,
	applyActiveUserAgent,
} from "./browser-emulation.js";

const args = process.argv.slice(2);
let fullPage = false;
let landscape = false;
let deviceName = null;

for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--full-page") {
		fullPage = true;
	} else if (arg === "--landscape") {
		landscape = true;
	} else if (arg === "--device") {
		deviceName = args[++i];
	} else if (arg.startsWith("--device=")) {
		deviceName = arg.slice("--device=".length);
	} else {
		console.log("Usage: browser-screenshot.js [--full-page] [--device <preset>] [--landscape]");
		console.log("\nExamples:");
		console.log("  browser-screenshot.js");
		console.log("  browser-screenshot.js --full-page");
		console.log("  browser-screenshot.js --device iphone-14");
		console.log("  browser-screenshot.js --device pixel-7 --landscape --full-page");
		process.exit(1);
	}
}

let devicePreset = null;
if (deviceName) {
	devicePreset = resolveDevicePreset(deviceName);
	if (!devicePreset) {
		console.error(`✗ Unknown device "${deviceName}". Run browser-emulate.js --list.`);
		process.exit(1);
	}
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

if (devicePreset) {
	await applyDevicePreset(p, devicePreset, { landscape });
	await applyActiveUserAgent(p);
} else {
	await applyActiveEmulation(p);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const filename = `screenshot-${timestamp}.png`;
const filepath = join(tmpdir(), filename);

await p.screenshot({ path: filepath, fullPage });

console.log(filepath);

// `--device` applies to this screenshot only; restore the stored preference.
if (devicePreset) {
	await clearDeviceEmulation(p);
	await applyActiveEmulation(p);
}

await b.disconnect();
