#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Print the newest watch log, or follow it. Adapted from
// mitsuhiko/agent-stuff `skills/web-browser/scripts/logs-tail.js` (MIT).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_ROOT = join(homedir(), ".cache", "browser-tools", "logs");
const follow = process.argv.includes("--follow");

function statSafe(path) {
	try {
		return statSync(path);
	} catch {
		return null;
	}
}

function findLatestFile() {
	if (!existsSync(LOG_ROOT)) return null;
	const dirs = readdirSync(LOG_ROOT)
		.filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
		.map((name) => join(LOG_ROOT, name))
		.filter((path) => statSafe(path)?.isDirectory())
		.sort();
	for (let i = dirs.length - 1; i >= 0; i--) {
		const files = readdirSync(dirs[i])
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => ({ path: join(dirs[i], name), mtime: statSafe(join(dirs[i], name))?.mtimeMs || 0 }))
			.sort((a, b) => b.mtime - a.mtime);
		if (files[0]) return files[0].path;
	}
	return null;
}

const file = findLatestFile();
if (!file) {
	console.error("✗ No watch log found. Start the browser, or run browser-watch.js.");
	process.exit(1);
}

let offset = 0;
function dump() {
	const data = readFileSync(file, "utf8");
	if (data.length > offset) {
		process.stdout.write(data.slice(offset));
		offset = data.length;
	}
}

dump();

if (follow) {
	setInterval(dump, 300);
} else {
	process.exit(0);
}
