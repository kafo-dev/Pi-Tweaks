// SPDX-License-Identifier: MIT
// Device presets and viewport/UA emulation helpers, adapted from
// mitsuhiko/agent-stuff `skills/web-browser/scripts/devices.js` (MIT).

export const DEVICE_PRESETS = {
	"iphone-se": {
		title: "iPhone SE",
		width: 375,
		height: 667,
		deviceScaleFactor: 2,
		userAgent:
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
		platform: "iPhone",
	},
	"iphone-14": {
		title: "iPhone 14",
		width: 390,
		height: 844,
		deviceScaleFactor: 3,
		userAgent:
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
		platform: "iPhone",
	},
	"pixel-7": {
		title: "Pixel 7",
		width: 412,
		height: 915,
		deviceScaleFactor: 2.625,
		userAgent:
			"Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
		platform: "Android",
	},
	"galaxy-s20": {
		title: "Galaxy S20",
		width: 360,
		height: 800,
		deviceScaleFactor: 3,
		userAgent:
			"Mozilla/5.0 (Linux; Android 13; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
		platform: "Android",
	},
};

export function listDevicePresets() {
	return Object.entries(DEVICE_PRESETS).map(([id, preset]) => ({
		id,
		...preset,
	}));
}

export function resolveDevicePreset(name) {
	if (!name) return null;
	const normalized = String(name).toLowerCase();
	const preset = DEVICE_PRESETS[normalized];
	if (!preset) return null;
	return { id: normalized, ...preset };
}

export async function applyDevicePreset(page, preset, options = {}) {
	const landscape = options.landscape === true;
	const width = landscape ? preset.height : preset.width;
	const height = landscape ? preset.width : preset.height;

	// Emulation goes through raw CDP, not `page.setUserAgent`: Chromium rejects
	// the partial `userAgentMetadata` that a platform-only override produces.
	const client = await page.createCDPSession();

	await client.send("Emulation.setDeviceMetricsOverride", {
		width,
		height,
		deviceScaleFactor: preset.deviceScaleFactor,
		mobile: true,
		screenOrientation: landscape
			? { type: "landscapePrimary", angle: 90 }
			: { type: "portraitPrimary", angle: 0 },
	});
	await client.send("Emulation.setTouchEmulationEnabled", {
		enabled: true,
		maxTouchPoints: 5,
	});
	try {
		await client.send("Emulation.setEmitTouchEventsForMouse", {
			enabled: true,
			configuration: "mobile",
		});
	} catch {
		// Optional on some protocol versions.
	}
	await client.send("Emulation.setUserAgentOverride", {
		userAgent: preset.userAgent,
		platform: preset.platform,
		acceptLanguage: "en-US,en",
	});

	return {
		width,
		height,
		deviceScaleFactor: preset.deviceScaleFactor,
		landscape,
	};
}

export async function clearDeviceEmulation(page) {
	const client = await page.createCDPSession();

	await client.send("Emulation.clearDeviceMetricsOverride");
	try {
		await client.send("Emulation.clearUserAgentOverride");
	} catch {
		try {
			await client.send("Emulation.setUserAgentOverride", {
				userAgent: "",
				platform: "",
			});
		} catch {
			// Ignore if the protocol version rejects an empty override.
		}
	}
	await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });
	try {
		await client.send("Emulation.setEmitTouchEventsForMouse", {
			enabled: false,
			configuration: "mobile",
		});
	} catch {
		// Optional on some protocol versions.
	}
}
