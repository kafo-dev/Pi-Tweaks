#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Stop the agent's Chromium without matching the invoking shell. Adapted from
// mitsuhiko/agent-stuff `skills/web-browser/scripts/stop.js` and
// `browser-processes.js` (MIT).

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_PROFILE = join(homedir(), ".cache", "browser-tools");
const DEBUG_PORT = Number(process.env.BROWSER_DEBUG_PORT || 9222);
const args = process.argv.slice(2);
const all = args.includes("--all");

if (args.some((arg) => arg !== "--all")) {
	console.log("Usage: browser-stop.js [--all]");
	console.log("\nOptions:");
	console.log(`  --all  Stop every agent browser on its user-data-dir, not only :${DEBUG_PORT}`);
	process.exit(1);
}

// Inspect the processes themselves: the agent user-data-dir is the reliable
// owner marker, and `pgrep -f --user-data-dir=...` would match this shell.
function parseBrowserProcesses(output) {
	const flag = `--user-data-dir=${AGENT_PROFILE}`;
	return output.split("\n").flatMap((line) => {
		const match = line.trim().match(/^(\d+)\s+(.+)$/);
		if (!match) return [];
		const [, pid, command] = match;
		if (/(?:^|\s)--type=/.test(command)) return [];
		const index = command.indexOf(flag);
		if (index < 0 || !/\s/.test(command[index - 1] ?? "")) return [];
		const after = index + flag.length;
		if (after !== command.length && !/\s/.test(command[after] ?? "")) return [];
		const port = command.match(/(?:^|\s)--remote-debugging-port=(\d+)(?:\s|$)/);
		return [{ pid: Number(pid), port: port ? Number(port[1]) : null }];
	});
}

let output;
try {
	output = execFileSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" });
} catch (e) {
	console.error("✗ Could not list processes:", e.message);
	process.exit(1);
}

const browsers = parseBrowserProcesses(output).filter(
	(browser) => all || browser.port === DEBUG_PORT,
);
if (browsers.length === 0) {
	console.log(`✓ No agent browser is running${all ? "" : ` on :${DEBUG_PORT}`}`);
	process.exit(0);
}

for (const browser of browsers) {
	try {
		process.kill(browser.pid, "SIGTERM");
		console.log(
			`✓ Stopped PID ${browser.pid}${browser.port ? ` (port ${browser.port})` : ""}`,
		);
	} catch (e) {
		console.error(`✗ Could not stop PID ${browser.pid}: ${e.message}`);
	}
}
