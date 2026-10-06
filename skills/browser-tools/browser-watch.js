#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Record console, exception, log, and network events to JSONL. Adapted from
// mitsuhiko/agent-stuff `skills/web-browser/scripts/watch.js` (MIT), driven by
// puppeteer sessions instead of a separate `ws` CDP client.

import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const CACHE_ROOT = join(homedir(), ".cache", "browser-tools");
const LOG_ROOT = join(CACHE_ROOT, "logs");
const PID_FILE = join(LOG_ROOT, "watch.pid");

function ensureDir(dir) {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function isProcessAlive(pid) {
	if (!pid || Number.isNaN(pid)) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function dateDir() {
	const now = new Date();
	const yyyy = String(now.getFullYear());
	const mm = String(now.getMonth() + 1).padStart(2, "0");
	const dd = String(now.getDate()).padStart(2, "0");
	return join(LOG_ROOT, `${yyyy}-${mm}-${dd}`);
}

function compactStack(stackTrace) {
	if (!stackTrace || !Array.isArray(stackTrace.callFrames)) return null;
	return stackTrace.callFrames.slice(0, 8).map((frame) => ({
		functionName: frame.functionName || null,
		url: frame.url || null,
		lineNumber: frame.lineNumber,
		columnNumber: frame.columnNumber,
	}));
}

function serializeRemoteObject(obj) {
	if (!obj || typeof obj !== "object") return obj;
	const value = Object.hasOwn(obj, "value")
		? obj.value
		: obj.unserializableValue || obj.description || null;
	return {
		type: obj.type || null,
		subtype: obj.subtype || null,
		value,
		description: obj.description || null,
	};
}

ensureDir(LOG_ROOT);

if (existsSync(PID_FILE)) {
	try {
		const existing = Number(readFileSync(PID_FILE, "utf8").trim());
		if (isProcessAlive(existing)) {
			console.log("✓ watch already running");
			process.exit(0);
		}
	} catch {
		// Overwrite a stale or unreadable pid file.
	}
}

writeFileSync(PID_FILE, String(process.pid));

const dir = dateDir();
ensureDir(dir);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const stream = createWriteStream(join(dir, `watch-${stamp}.jsonl`), {
	flags: "a",
});

let pageCounter = 0;
const attached = new WeakSet();

function write(payload) {
	if (stream.writableEnded) return;
	stream.write(`${JSON.stringify({ ts: new Date().toISOString(), ...payload })}\n`);
}

function finish() {
	if (!stream.writableEnded) stream.end();
	try {
		unlinkSync(PID_FILE);
	} catch {
		// Already gone.
	}
	process.exit(0);
}

process.on("SIGINT", finish);
process.on("SIGTERM", finish);

async function attach(page) {
	if (attached.has(page)) return;
	attached.add(page);
	const label = `page-${++pageCounter}`;

	let cdp;
	try {
		cdp = await page.createCDPSession();
		await cdp.send("Runtime.enable");
		await cdp.send("Log.enable");
		await cdp.send("Network.enable");
	} catch (e) {
		console.error(`watch: attach error: ${e.message}`);
		return;
	}

	cdp.on("Runtime.consoleAPICalled", (params) => {
		write({
			type: "console",
			page: label,
			url: page.url(),
			level: params.type || null,
			args: (params.args || []).map(serializeRemoteObject),
			stack: compactStack(params.stackTrace),
		});
	});

	cdp.on("Runtime.exceptionThrown", (params) => {
		const details = params.exceptionDetails || {};
		write({
			type: "exception",
			page: label,
			url: details.url || page.url(),
			text: details.text || null,
			description: details.exception?.description || null,
			lineNumber: details.lineNumber,
			columnNumber: details.columnNumber,
			stack: compactStack(details.stackTrace),
		});
	});

	cdp.on("Log.entryAdded", (params) => {
		const entry = params.entry || {};
		write({
			type: "log",
			page: label,
			url: entry.url || page.url(),
			level: entry.level || null,
			source: entry.source || null,
			text: entry.text || null,
		});
	});

	cdp.on("Network.requestWillBeSent", (params) => {
		const request = params.request || {};
		write({
			type: "network.request",
			page: label,
			url: request.url || null,
			method: request.method || null,
			documentURL: params.documentURL || null,
			initiator: params.initiator?.type || null,
		});
	});

	cdp.on("Network.responseReceived", (params) => {
		const response = params.response || {};
		write({
			type: "network.response",
			page: label,
			url: response.url || null,
			status: response.status,
			statusText: response.statusText || null,
			mimeType: response.mimeType || null,
			fromDiskCache: !!response.fromDiskCache,
			fromServiceWorker: !!response.fromServiceWorker,
		});
	});

	cdp.on("Network.loadingFailed", (params) => {
		write({
			type: "network.failure",
			page: label,
			url: page.url(),
			errorText: params.errorText || null,
			canceled: !!params.canceled,
		});
	});

	write({ type: "target.attached", page: label, url: page.url() });
}

let browser;
try {
	browser = await puppeteer.connect({
		browserURL: "http://localhost:9222",
		defaultViewport: null,
	});
} catch (e) {
	console.error(`✗ watch failed to connect: ${e.message}`);
	process.exit(1);
}

browser.on("disconnected", finish);

browser.on("targetcreated", async (target) => {
	if (target.type() !== "page") return;
	try {
		const page = await target.page();
		if (page) await attach(page);
	} catch (e) {
		console.error(`watch: target error: ${e.message}`);
	}
});

for (const page of await browser.pages()) {
	await attach(page);
}

console.log(`✓ watch started (${stream.path})`);

await new Promise(() => {});
