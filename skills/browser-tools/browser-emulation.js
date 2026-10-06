// SPDX-License-Identifier: MIT
// Persistent device-emulation preference, adapted from
// mitsuhiko/agent-stuff `skills/web-browser/scripts/emulation-state.js` (MIT).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { applyDevicePreset, resolveDevicePreset } from "./browser-devices.js";

const CACHE_ROOT = join(homedir(), ".cache", "browser-tools");
const STATE_FILE = join(CACHE_ROOT, "emulation.json");

// Headless Chromium advertises itself as `HeadlessChrome` in its user agent,
// and sites that check for the headless token refuse the request. The version
// and the platform stay those of the running browser, so the substituted
// string needs no maintenance.
const HEADLESS_PRODUCT = "HeadlessChrome/";
const CHROME_PRODUCT = "Chrome/";

// A stored user agent with this value resolves to the running browser.
const CHROME_USER_AGENT = "chrome";

function ensureStateDir() {
	if (!existsSync(CACHE_ROOT)) {
		mkdirSync(CACHE_ROOT, { recursive: true });
	}
}

export function readEmulationPreference() {
	if (!existsSync(STATE_FILE)) return null;
	try {
		const data = JSON.parse(readFileSync(STATE_FILE, "utf8"));
		if (!data || typeof data !== "object") return null;
		const device =
			typeof data.device === "string" && data.device.length > 0
				? data.device.toLowerCase()
				: null;
		const userAgent =
			typeof data.userAgent === "string" && data.userAgent.length > 0
				? data.userAgent
				: null;
		if (!device && !userAgent) return null;
		return {
			device,
			landscape: data.landscape === true,
			userAgent,
			updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
		};
	} catch {
		return null;
	}
}

// Write the full preference. With no device and no user agent there is nothing
// to apply, so the file goes away instead of describing a no-op.
export function writeEmulationPreference({
	device = null,
	landscape = false,
	userAgent = null,
}) {
	if (!device && !userAgent) {
		clearEmulationPreference();
		return;
	}
	ensureStateDir();
	const payload = {};
	if (device) payload.device = String(device).toLowerCase();
	payload.landscape = landscape === true;
	if (userAgent) payload.userAgent = String(userAgent);
	payload.updatedAt = new Date().toISOString();
	writeFileSync(STATE_FILE, `${JSON.stringify(payload, null, 2)}\n`);
}

export function clearEmulationPreference() {
	try {
		rmSync(STATE_FILE, { force: true });
	} catch {
		// Ignore a missing or unremovable state file.
	}
}

// Resolve a stored user agent to the string the page sends. `chrome` means the
// running browser with the headless product name swapped for the plain one;
// anything else goes out verbatim.
async function resolveUserAgent(page, stored) {
	if (stored !== CHROME_USER_AGENT) return stored;
	const browserUserAgent = await page.browser().userAgent();
	return browserUserAgent.replace(HEADLESS_PRODUCT, CHROME_PRODUCT);
}

// Apply only the stored user-agent override, for a caller that sets the
// viewport itself, such as `browser-screenshot.js --device`. Returns the
// applied string, or `null` when no override is stored.
export async function applyActiveUserAgent(page) {
	const preference = readEmulationPreference();
	if (!preference?.userAgent) return null;
	const userAgent = await resolveUserAgent(page, preference.userAgent);
	await page.setUserAgent({ userAgent });
	return userAgent;
}

// Apply the stored preference to `page`. A command that does not call this
// keeps whatever viewport the page already has. The user-agent override goes
// last, so it also wins over the one a device preset carries.
export async function applyActiveEmulation(page) {
	const preference = readEmulationPreference();
	if (!preference) return null;

	let device = null;
	if (preference.device) {
		const preset = resolveDevicePreset(preference.device);
		if (preset) {
			const metrics = await applyDevicePreset(page, preset, {
				landscape: preference.landscape,
			});
			device = { preset, ...metrics };
		} else {
			// The stored preset is gone: drop it but keep the user agent.
			writeEmulationPreference({
				landscape: false,
				userAgent: preference.userAgent,
			});
		}
	}

	const userAgent = await applyActiveUserAgent(page);
	return { ...(device ?? {}), userAgent };
}
