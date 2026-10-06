#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Summarize network responses from the newest watch log. Adapted from
// mitsuhiko/agent-stuff `skills/web-browser/scripts/net-summary.js` (MIT).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_ROOT = join(homedir(), ".cache", "browser-tools", "logs");
const MAX_LIST = 30;

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

const records = readFileSync(file, "utf8")
	.split("\n")
	.filter(Boolean)
	.flatMap((line) => {
		try {
			return [JSON.parse(line)];
		} catch {
			return [];
		}
	});

const responses = records.filter((record) => record.type === "network.response");
const failures = records.filter((record) => record.type === "network.failure");

const statusClasses = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 };
const hosts = new Map();
for (const response of responses) {
	const status = Number(response.status) || 0;
	const className =
		status >= 200 && status < 300 ? "2xx"
		: status >= 300 && status < 400 ? "3xx"
		: status >= 400 && status < 500 ? "4xx"
		: status >= 500 && status < 600 ? "5xx"
		: "other";
	statusClasses[className] += 1;

	let host = "?";
	try {
		host = new URL(response.url).host;
	} catch {
		// Keep the fallback host.
	}
	hosts.set(host, (hosts.get(host) || 0) + 1);
}

console.log(`Log: ${file}`);
console.log(`Responses: ${responses.length}  Failures: ${failures.length}`);
console.log(
	`Status: 2xx ${statusClasses["2xx"]}  3xx ${statusClasses["3xx"]}  4xx ${statusClasses["4xx"]}  5xx ${statusClasses["5xx"]}  other ${statusClasses.other}`,
);

const topHosts = [...hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
if (topHosts.length > 0) {
	console.log("\nTop hosts:");
	for (const [host, count] of topHosts) console.log(`  ${count.toString().padStart(4)}  ${host}`);
}

const notOk = responses.filter((response) => Number(response.status) >= 400);
if (notOk.length > 0) {
	console.log("\nNon-OK responses:");
	for (const response of notOk.slice(0, MAX_LIST)) {
		console.log(`  ${response.status} ${response.statusText || ""} ${response.url}`);
	}
	if (notOk.length > MAX_LIST) console.log(`  ... ${notOk.length - MAX_LIST} more`);
}

if (failures.length > 0) {
	console.log("\nFailures:");
	for (const failure of failures.slice(0, MAX_LIST)) {
		console.log(`  ${failure.errorText || "?"}${failure.canceled ? " (canceled)" : ""} ${failure.url}`);
	}
	if (failures.length > MAX_LIST) console.log(`  ... ${failures.length - MAX_LIST} more`);
}
