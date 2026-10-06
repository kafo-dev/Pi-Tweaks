// SPDX-License-Identifier: MIT
// Persistent device-emulation preference, adapted from
// mitsuhiko/agent-stuff `skills/web-browser/scripts/emulation-state.js` (MIT).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { applyDevicePreset, resolveDevicePreset } from "./browser-devices.js";

const CACHE_ROOT = join(homedir(), ".cache", "browser-tools");
const STATE_FILE = join(CACHE_ROOT, "emulation.json");

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
		if (typeof data.device !== "string" || data.device.length === 0) return null;
		return {
			device: data.device.toLowerCase(),
			landscape: data.landscape === true,
			updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
		};
	} catch {
		return null;
	}
}

export function writeEmulationPreference({ device, landscape }) {
	ensureStateDir();
	const payload = {
		device: String(device).toLowerCase(),
		landscape: landscape === true,
		updatedAt: new Date().toISOString(),
	};
	writeFileSync(STATE_FILE, `${JSON.stringify(payload, null, 2)}\n`);
}

export function clearEmulationPreference() {
	try {
		rmSync(STATE_FILE, { force: true });
	} catch {
		// Ignore a missing or unremovable state file.
	}
}

// Apply the stored preference to `page`. A command that does not call this
// keeps whatever viewport the page already has.
export async function applyActiveEmulation(page) {
	const preference = readEmulationPreference();
	if (!preference) return null;

	const preset = resolveDevicePreset(preference.device);
	if (!preset) {
		clearEmulationPreference();
		return null;
	}

	const metrics = await applyDevicePreset(page, preset, {
		landscape: preference.landscape,
	});

	return { preset, ...metrics };
}
