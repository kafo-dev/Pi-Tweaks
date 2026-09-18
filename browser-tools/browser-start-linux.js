#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Linux port of browser-start.js.
//
// Differences from the author's macOS script:
//   - Auto-detects a Chromium/Chrome binary (or honors $CHROME_BIN).
//   - Uses a dedicated, persistent profile for the agent at
//     ~/.cache/browser-tools (never your live profile directory).
//   - Always opens a named profile inside that user-data-dir, the agent's own
//     "Pi-Coding-Agent-Dedicated-Profile" by default, so Chrome never shows the
//     profile picker and never falls back to the unusable Guest profile.
//   - With --profile, refreshes the seeded user profiles from your real Chromium
//     profile (rsync --delete) while the agent's own dedicated profile is never
//     touched. Otherwise it uses whatever the agent profile has.
//
// Usage:
//   browser-start-linux.js                       # Agent's own dedicated profile
//   browser-start-linux.js --profile             # Refresh seeded profiles from yours
//   browser-start-linux.js --list-profiles       # List profiles inside the agent profile
//   browser-start-linux.js --profile-directory "Profile 1"
//   browser-start-linux.js --class "Pi-Agent"    # Custom window class (Wayland app_id)
//
// Environment:
//   CHROME_BIN          Override the browser binary
//   BROWSER_PROFILE     Override the source profile dir used with --profile
//   BROWSER_PROFILE_DIR Override the agent profile directory (default: Pi-Coding-Agent-Dedicated-Profile)
//   BROWSER_APP_CLASS   Linux window class (Wayland app_id / X11 WM_CLASS); empty disables (default: Pi-Coding-Agent-Control-chromium)

import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

let useProfile = false;
let listProfiles = false;

// Name of the agent's own profile inside the agent user-data-dir. Chosen so it
// is unlikely to exist in a seeded user profile, so seeding never collides
// with or overwrites the agent's own data.
const AGENT_DEFAULT_PROFILE = "Pi-Coding-Agent-Dedicated-Profile";
const AGENT_PROFILE_NAME = "Pi Coding Agent";
const AGENT_DEFAULT_CLASS = "Pi-Coding-Agent-Control-chromium";
let profileDir = process.env.BROWSER_PROFILE_DIR || AGENT_DEFAULT_PROFILE;
let appClass = process.env.BROWSER_APP_CLASS ?? AGENT_DEFAULT_CLASS;

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
	} else if (arg === "--class") {
		appClass = argv[++i];
	} else if (arg.startsWith("--class=")) {
		appClass = arg.slice("--class=".length);
	} else {
		console.log("Usage: browser-start-linux.js [--profile] [--profile-directory <name>] [--class <name>] [--list-profiles]");
		console.log("\nOptions:");
		console.log("  --profile                    Refresh seeded profiles from your real browser profile (agent's own profile is kept)");
		console.log("  --profile-directory <name>   Profile inside ~/.cache/browser-tools to open (default: Pi-Coding-Agent-Dedicated-Profile)");
		console.log("  --class <name>               Linux window class: Wayland app_id / X11 WM_CLASS (default: Pi-Coding-Agent-Control-chromium)");
		console.log("  --list-profiles              List the profiles available in the agent profile");
		process.exit(1);
	}
}

if (!profileDir) {
	console.error("✗ --profile-directory needs a value (the directory name, e.g. \"Profile 1\").");
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

// Read and parse the agent profile's Local State, or null when absent/invalid.
function readLocalState() {
	const localState = join(AGENT_PROFILE, "Local State");
	if (!existsSync(localState)) return null;
	try {
		return JSON.parse(readFileSync(localState, "utf8"));
	} catch {
		return null;
	}
}

// rsync --delete replaces the agent's Local State with the source's, which drops
// the agent's own profile registration. Re-register the dedicated profile (its
// directory is excluded from the rsync) and keep the agent's top-level Local
// State, so the agent's existing profile keeps its cookie-encryption key.
function mergeSeededLocalState(previousState) {
	const seeded = readLocalState() ?? {};
	const base = previousState ?? {};
	const seededProfile = seeded.profile ?? {};
	const baseProfile = base.profile ?? {};
	const infoCache = { ...(seededProfile.info_cache ?? {}), ...(baseProfile.info_cache ?? {}) };
	if (!infoCache[AGENT_DEFAULT_PROFILE]) {
		infoCache[AGENT_DEFAULT_PROFILE] = { name: AGENT_PROFILE_NAME, is_using_default_name: false };
	}
	const merged = {
		...seeded,
		...base,
		profile: {
			...seededProfile,
			...baseProfile,
			info_cache: infoCache,
			profiles_order: [
				...new Set([
					...(baseProfile.profiles_order ?? []),
					...(seededProfile.profiles_order ?? []),
					AGENT_DEFAULT_PROFILE,
				]),
			],
			last_used: baseProfile.last_used ?? seededProfile.last_used ?? AGENT_DEFAULT_PROFILE,
		},
	};
	writeFileSync(join(AGENT_PROFILE, "Local State"), JSON.stringify(merged));
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
	const previousState = readLocalState();
	console.log(`Refreshing seeded profiles from ${source} (agent's own profile is kept) ...`);
	// 'External Extensions' is kept as well: it is the agent's own extension
	// provisioning directory (external_crx/external_update_url files), and
	// --delete would otherwise remove it and Chrome would uninstall those
	// extensions on the next launch.
	execSync(
		`rsync -a --delete \
			--exclude='SingletonLock' \
			--exclude='SingletonSocket' \
			--exclude='SingletonCookie' \
			--exclude='${AGENT_DEFAULT_PROFILE}' \
			--exclude='External Extensions' \
			--exclude='*/Sessions/*' \
			--exclude='*/Current Session' \
			--exclude='*/Current Tabs' \
			--exclude='*/Last Session' \
			--exclude='*/Last Tabs' \
			"${source}/" "${AGENT_PROFILE}/"`,
		{ stdio: "pipe" },
	);
	mergeSeededLocalState(previousState);
}

// Guest windows refuse Target.createTarget over CDP, which breaks --new.
if (profileDir === "Guest Profile") {
	console.error('✗ Guest Profile cannot open new tabs over CDP. Pick a real profile (e.g. "Default").');
	process.exit(1);
}

// Refuse an unknown profile instead of letting Chrome show its picker. The
// agent's own dedicated profile is always allowed: Chrome creates and registers
// it on first launch, and a seed from a real profile would not list it.
const { profiles } = readAgentProfiles();
const knownDirs = Object.keys(profiles);
if (knownDirs.length > 0 && !knownDirs.includes(profileDir) && profileDir !== AGENT_DEFAULT_PROFILE) {
	console.error(`✗ No profile "${profileDir}" in ${AGENT_PROFILE}.`);
	printAgentProfiles();
	process.exit(1);
}

const chromeArgs = [
	"--remote-debugging-port=9222",
	`--user-data-dir=${AGENT_PROFILE}`,
	`--profile-directory=${profileDir}`,
	"--no-first-run",
	"--no-default-browser-check",
	"--hide-crash-restore-bubble",
];
// --class sets the Wayland toplevel app_id (and the X11 WM_CLASS). Empty
// disables it; by default the agent's own class is used so its window is
// identifiable and grouped apart from a normal Chromium.
if (appClass) chromeArgs.push(`--class=${appClass}`);
spawn(chrome, chromeArgs, { detached: true, stdio: "ignore" }).unref();

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
		useProfile ? " (refreshed from your profile)" : ""
	}`,
);
