#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Linux port of browser-start.js.
//
// Differences from the author's macOS script:
//   - Auto-detects a Chromium/Chrome binary (or honors $CHROME_BIN).
//   - Uses a dedicated, persistent profile for the agent at
//     ~/.cache/browser-tools (never your live profile directory).
//   - Always opens a named profile inside that user-data-dir (default
//     "Default"), so Chrome never shows the profile picker and never falls
//     back to the unusable Guest profile.
//   - With --profile, seeds that dedicated profile from your real Chromium
//     profile; otherwise it uses whatever the agent profile already has.
//
// Usage:
//   browser-start-linux.js                       # Default agent profile
//   browser-start-linux.js --profile             # Seed dedicated profile from yours
//   browser-start-linux.js --list-profiles       # List profiles inside the agent profile
//   browser-start-linux.js --profile-directory "Profile 1"
//
// Environment:
//   CHROME_BIN          Override the browser binary
//   BROWSER_PROFILE     Override the source profile dir used with --profile
//   BROWSER_PROFILE_DIR Override the agent profile directory (default: Default)

import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

let useProfile = false;
let listProfiles = false;
let profileDir = process.env.BROWSER_PROFILE_DIR || "Default";

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if (arg === "--profile") {
		useProfile = true;
	} else if (arg === "--list-profiles") {
		listProfiles = true;
	} else if (arg === "--profile-directory") {
		profileDir = argv[++i];
	} else if (arg.startsWith("--profile-directory=")) {
		profileDir = arg.slice("--profile-directory=".length);
	} else {
		console.log("Usage: browser-start-linux.js [--profile] [--profile-directory <name>] [--list-profiles]");
		console.log("\nOptions:");
		console.log("  --profile                    Seed the dedicated agent profile from your real browser profile");
		console.log("  --profile-directory <name>   Profile inside ~/.cache/browser-tools to open (default: Default)");
		console.log("  --list-profiles              List the profiles available in the agent profile");
		process.exit(1);
	}
}

if (!profileDir) {
	console.error("✗ --profile-directory needs a value (the directory name, e.g. Default or \"Profile 1\").");
	process.exit(1);
}

// Dedicated profile for the agent. Persistent across runs, separate from yours.
const AGENT_PROFILE = join(homedir(), ".cache", "browser-tools");

// Read the profile list from the agent profile's Local State. Returns
// { lastUsed, profiles: { "<dir>": "<display name>" } }. Empty when the agent
// profile is fresh and has never been launched.
function readAgentProfiles() {
	const localState = join(AGENT_PROFILE, "Local State");
	if (!existsSync(localState)) return { lastUsed: null, profiles: {} };
	try {
		const state = JSON.parse(readFileSync(localState, "utf8"));
		const info = state.profile?.info_cache ?? {};
		const profiles = {};
		for (const [dir, meta] of Object.entries(info)) {
			profiles[dir] = meta?.name ?? dir;
		}
		return { lastUsed: state.profile?.last_used ?? null, profiles };
	} catch {
		return { lastUsed: null, profiles: {} };
	}
}

function printAgentProfiles() {
	const { lastUsed, profiles } = readAgentProfiles();
	console.log(`Profiles in ${AGENT_PROFILE}`);
	const dirs = Object.keys(profiles);
	if (dirs.length === 0) {
		console.log("  (none yet — the agent profile has never been launched)");
	} else {
		const width = Math.max(...dirs.map((d) => d.length));
		for (const dir of dirs) console.log(`  ${dir.padEnd(width)}  ${profiles[dir]}`);
	}
	if (lastUsed) console.log(`Last used: ${lastUsed}`);
}

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

if (listProfiles) {
	printAgentProfiles();
	process.exit(0);
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
	console.log(`  It may not be using profile "${profileDir}". If navigation or --new misbehaves,`);
	console.log("  close that Chrome and run this script again.");
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

// Guest windows refuse Target.createTarget over CDP, which breaks --new.
if (profileDir === "Guest Profile") {
	console.error('✗ Guest Profile cannot open new tabs over CDP. Pick a real profile (e.g. "Default").');
	process.exit(1);
}

// Refuse an unknown profile instead of letting Chrome show its picker.
const { profiles } = readAgentProfiles();
const knownDirs = Object.keys(profiles);
if (knownDirs.length > 0 && !knownDirs.includes(profileDir)) {
	console.error(`✗ No profile "${profileDir}" in ${AGENT_PROFILE}.`);
	printAgentProfiles();
	process.exit(1);
}

spawn(
	chrome,
	[
		"--remote-debugging-port=9222",
		`--user-data-dir=${AGENT_PROFILE}`,
		`--profile-directory=${profileDir}`,
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

console.log(
	`✓ Chrome started on :9222 using agent profile: ${AGENT_PROFILE} (profile "${profileDir}")${
		useProfile ? " (seeded from your profile)" : ""
	}`,
);
