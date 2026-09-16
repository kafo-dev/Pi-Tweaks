#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Linux port of browser-start.js.
//
// Differences from the author's macOS script:
//   - Auto-detects a Chromium/Chrome binary (or honors $CHROME_BIN).
//   - Uses a dedicated, persistent profile for the agent at
//     ~/.cache/browser-tools (never your live profile directory).
//   - With --profile, seeds that dedicated profile from your real Chromium
//     profile; otherwise it uses whatever the agent profile already has.
//
// Usage:
//   browser-start-linux.js              # Dedicated agent profile
//   browser-start-linux.js --profile    # Seed dedicated profile from yours
//
// Environment:
//   CHROME_BIN        Override the browser binary
//   BROWSER_PROFILE   Override the source profile dir used with --profile

import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const useProfile = process.argv[2] === "--profile";
if (process.argv[2] && process.argv[2] !== "--profile") {
	console.log("Usage: browser-start-linux.js [--profile]");
	console.log("\nOptions:");
	console.log("  --profile  Seed the dedicated agent profile from your real browser profile");
	process.exit(1);
}

// Dedicated profile for the agent. Persistent across runs, separate from yours.
const AGENT_PROFILE = join(homedir(), ".cache", "browser-tools");

function findChrome() {
	if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
	const names = [
		"chromium",
		"chromium-browser",
		"google-chrome-stable",
		"google-chrome",
		"brave",
		"brave-browser",
		"microsoft-edge-stable",
	];
	for (const name of names) {
		try {
			return execSync(`command -v ${name}`, { encoding: "utf8" }).trim();
		} catch {}
	}
	for (const p of ["/usr/bin/chromium", "/opt/google/chrome/chrome"]) {
		if (existsSync(p)) return p;
	}
	return null;
}

function findUserProfile() {
	if (process.env.BROWSER_PROFILE) return process.env.BROWSER_PROFILE;
	const home = homedir();
	const candidates = [
		join(home, ".config", "chromium"),
		join(home, ".config", "google-chrome"),
		join(home, ".config", "chromium-browser"),
		join(home, ".config", "BraveSoftware", "Brave-Browser"),
	];
	// Prefer a source that actually has a Default profile directory.
	return (
		candidates.find((p) => existsSync(join(p, "Default"))) ??
		candidates.find((p) => existsSync(p)) ??
		null
	);
}

const chrome = findChrome();
if (!chrome) {
	console.error("✗ Could not find Chrome/Chromium. Set $CHROME_BIN.");
	process.exit(1);
}

// If something is already serving CDP on :9222, reuse it.
try {
	const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
	await browser.disconnect();
	console.log("✓ Chrome already running on :9222");
	process.exit(0);
} catch {}

// Create the dedicated profile dir.
execSync(`mkdir -p "${AGENT_PROFILE}"`, { stdio: "ignore" });

// Drop stale singleton locks so a fresh instance can take the dir.
execSync(
	`rm -f "${AGENT_PROFILE}/SingletonLock" "${AGENT_PROFILE}/SingletonSocket" "${AGENT_PROFILE}/SingletonCookie"`,
	{ stdio: "ignore" },
);

if (useProfile) {
	const source = findUserProfile();
	if (!source) {
		console.error("✗ Could not find a Chrome/Chromium profile under ~/.config. Set $BROWSER_PROFILE.");
		process.exit(1);
	}
	console.log(`Syncing profile from ${source} ...`);
	execSync(
		`rsync -a --delete \
			--exclude='SingletonLock' \
			--exclude='SingletonSocket' \
			--exclude='SingletonCookie' \
			--exclude='*/Sessions/*' \
			--exclude='*/Current Session' \
			--exclude='*/Current Tabs' \
			--exclude='*/Last Session' \
			--exclude='*/Last Tabs' \
			"${source}/" "${AGENT_PROFILE}/"`,
		{ stdio: "pipe" },
	);
}

spawn(
	chrome,
	[
		"--remote-debugging-port=9222",
		`--user-data-dir=${AGENT_PROFILE}`,
		"--no-first-run",
		"--no-default-browser-check",
	],
	{ detached: true, stdio: "ignore" },
).unref();

let connected = false;
for (let i = 0; i < 30; i++) {
	try {
		const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
		await browser.disconnect();
		connected = true;
		break;
	} catch {
		await new Promise((r) => setTimeout(r, 500));
	}
}

if (!connected) {
	console.error("✗ Failed to connect to Chrome on :9222");
	process.exit(1);
}

console.log(`✓ Chrome started on :9222 using agent profile: ${AGENT_PROFILE}${useProfile ? " (seeded from your profile)" : ""}`);
