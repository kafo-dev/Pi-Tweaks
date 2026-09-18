#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Provision a CRX extension into the agent's Chromium user-data-dir.
//
// Chromium reads descriptors from "<user-data-dir>/External Extensions/" on
// every launch and installs the CRX they point at. Each descriptor is named
// "<extension-id>.json" and holds an absolute CRX path plus its version:
//
//   { "external_crx": "/path/to/<id>.crx", "external_version": "1.2.3" }
//
// An external install is one-shot: once Chromium has registered the extension
// in the profile's Preferences, it trusts that entry and does not re-read the
// CRX. Re-provisioning therefore deletes "extensions.settings.<id>" first, so
// the next launch installs the CRX again. Chromium owns Preferences while it
// runs, so the script refuses to touch it while the agent browser is up.
//
// Usage:
//   browser-install-extension.js --id <extension-id> [--version <version>]
//   browser-install-extension.js --crx <file> [--id <extension-id>] [--version <version>]
//
// The id and version are read from the CRX when they are not given, so --crx
// alone is enough for a local file. --version overrides a version that cannot
// be read from the archive.
//
// Environment:
//   CHROME_BIN          Override the browser binary used to pick the download version
//   BROWSER_PROFILE_DIR Override the agent profile directory (default: Pi-Coding-Agent-Dedicated-Profile)

import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { inflateRawSync } from "node:zlib";

const AGENT_PROFILE = join(homedir(), ".cache", "browser-tools");
const CRX_DIR = join(homedir(), ".cache", "browser-tools-extensions");
const EXTERNAL_DIR = join(AGENT_PROFILE, "External Extensions");
const AGENT_DEFAULT_PROFILE = "Pi-Coding-Agent-Dedicated-Profile";
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

function usage(message) {
	if (message) console.error(`✗ ${message}`);
	console.log("Usage: browser-install-extension.js (--id <extension-id> | --crx <file>) [options]");
	console.log("\nOptions:");
	console.log("  --id <extension-id>        Download the CRX for this extension id");
	console.log("  --crx <file>               Use a local CRX file instead of downloading");
	console.log("  --version <version>        Override the version read from the CRX");
	console.log("  --profile-directory <name> Agent profile to reset (default: Pi-Coding-Agent-Dedicated-Profile)");
	process.exit(message ? 1 : 0);
}

let extensionId = null;
let crxFile = null;
let version = null;
let profileDir = process.env.BROWSER_PROFILE_DIR || AGENT_DEFAULT_PROFILE;

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if (arg === "--id") {
		extensionId = argv[++i];
	} else if (arg.startsWith("--id=")) {
		extensionId = arg.slice("--id=".length);
	} else if (arg === "--crx") {
		crxFile = argv[++i];
	} else if (arg.startsWith("--crx=")) {
		crxFile = arg.slice("--crx=".length);
	} else if (arg === "--version") {
		version = argv[++i];
	} else if (arg.startsWith("--version=")) {
		version = arg.slice("--version=".length);
	} else if (arg === "--profile-directory") {
		profileDir = argv[++i];
	} else if (arg.startsWith("--profile-directory=")) {
		profileDir = arg.slice("--profile-directory=".length);
	} else {
		usage(`unknown option: ${arg}`);
	}
}

if (!extensionId && !crxFile) usage("give either --id or --crx");
if (extensionId && !EXTENSION_ID_PATTERN.test(extensionId)) {
	usage(`"${extensionId}" is not a 32-character extension id (a-p)`);
}
if (!profileDir) usage("--profile-directory needs a value");

// --- CRX parsing -----------------------------------------------------------
//
// A CRX is "Cr24", a format version, a header, and a ZIP. CRX3 carries the
// extension id in the header's signed_header_data (field 10000) as a 16-byte
// crx_id. CRX2 has no crx_id; its id is the first 16 bytes of SHA-256 over the
// inline DER public key. Either way each nibble 0-9a-f maps onto the letters
// a-p.

function isCrx(buf) {
	return buf.length > 12 && buf.subarray(0, 4).toString("latin1") === "Cr24";
}

function readVarint(buf, offset) {
	let value = 0;
	let shift = 0;
	let i = offset;
	for (;;) {
		const byte = buf[i++];
		value += (byte & 0x7f) * 2 ** shift;
		if (!(byte & 0x80)) return [value, i];
		shift += 7;
	}
}

function* protobufFields(buf) {
	let i = 0;
	while (i < buf.length) {
		const [tag, afterTag] = readVarint(buf, i);
		i = afterTag;
		const field = tag >> 3;
		const wire = tag & 7;
		if (wire === 0) {
			const [value, next] = readVarint(buf, i);
			i = next;
			yield [field, wire, value];
		} else if (wire === 2) {
			const [length, next] = readVarint(buf, i);
			i = next;
			yield [field, wire, buf.subarray(i, i + length)];
			i += length;
		} else if (wire === 5) {
			yield [field, wire, buf.subarray(i, i + 4)];
			i += 4;
		} else if (wire === 1) {
			yield [field, wire, buf.subarray(i, i + 8)];
			i += 8;
		} else {
			throw new Error(`unsupported protobuf wire type ${wire}`);
		}
	}
}

function extensionIdFromBytes(bytes) {
	let id = "";
	for (const byte of bytes.subarray(0, 16)) {
		id += String.fromCharCode(97 + (byte >> 4));
		id += String.fromCharCode(97 + (byte & 0x0f));
	}
	return id;
}

function readCrxId(buf) {
	if (!isCrx(buf)) throw new Error("not a CRX file (missing Cr24 magic)");
	const crxVersion = buf.readUInt32LE(4);
	if (crxVersion === 2) {
		const keyLength = buf.readUInt32LE(8);
		const publicKey = buf.subarray(16, 16 + keyLength);
		return extensionIdFromBytes(createHash("sha256").update(publicKey).digest());
	}
	if (crxVersion !== 3) throw new Error(`unsupported CRX version ${crxVersion}`);
	const headerLength = buf.readUInt32LE(8);
	const header = buf.subarray(12, 12 + headerLength);
	for (const [field, wire, value] of protobufFields(header)) {
		if (field !== 10000 || wire !== 2) continue;
		for (const [subField, subWire, subValue] of protobufFields(value)) {
			if (subField === 1 && subWire === 2) return extensionIdFromBytes(subValue);
		}
	}
	throw new Error("no crx_id in the CRX3 header");
}

function crxZipOffset(buf) {
	if (!isCrx(buf)) throw new Error("not a CRX file (missing Cr24 magic)");
	const crxVersion = buf.readUInt32LE(4);
	if (crxVersion === 2) {
		return 16 + buf.readUInt32LE(8) + buf.readUInt32LE(12);
	}
	if (crxVersion === 3) {
		return 12 + buf.readUInt32LE(8);
	}
	throw new Error(`unsupported CRX version ${crxVersion}`);
}

// Minimal ZIP reader: walk the central directory and inflate one stored entry.
function readZipEntry(buf, wanted) {
	const zip = buf.subarray(crxZipOffset(buf));
	const eocd = zip.lastIndexOf(Buffer.from("PK\x05\x06", "latin1"));
	if (eocd < 0) throw new Error("no ZIP end-of-central-directory record");
	const entryCount = zip.readUInt16LE(eocd + 10);
	let offset = zip.readUInt32LE(eocd + 16);
	for (let entry = 0; entry < entryCount; entry++) {
		if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("corrupt ZIP central directory");
		const method = zip.readUInt16LE(offset + 10);
		const compressedSize = zip.readUInt32LE(offset + 20);
		const nameLength = zip.readUInt16LE(offset + 28);
		const extraLength = zip.readUInt16LE(offset + 30);
		const commentLength = zip.readUInt16LE(offset + 32);
		const localOffset = zip.readUInt32LE(offset + 42);
		const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
		if (name === wanted) {
			const localNameLength = zip.readUInt16LE(localOffset + 26);
			const localExtraLength = zip.readUInt16LE(localOffset + 28);
			const dataStart = localOffset + 30 + localNameLength + localExtraLength;
			const data = zip.subarray(dataStart, dataStart + compressedSize);
			if (method === 8) return inflateRawSync(data);
			if (method === 0) return data;
			throw new Error(`unsupported ZIP compression method ${method}`);
		}
		offset += 46 + nameLength + extraLength + commentLength;
	}
	throw new Error(`no ${wanted} in the CRX`);
}

function readCrxVersion(buf) {
	const manifest = JSON.parse(readZipEntry(buf, "manifest.json").toString("utf8"));
	if (!manifest.version) throw new Error("the CRX manifest has no version");
	return manifest.version;
}

// --- Download --------------------------------------------------------------

function findChrome() {
	if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
	for (const name of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "brave", "brave-browser"]) {
		try {
			return execSync(`command -v ${name}`, { encoding: "utf8" }).trim();
		} catch {}
	}
	for (const path of ["/usr/bin/chromium", "/opt/google/chrome/chrome"]) {
		if (existsSync(path)) return path;
	}
	return null;
}

function detectBrowserMajor() {
	const chrome = findChrome();
	if (!chrome) return null;
	try {
		const output = execFileSync(chrome, ["--version"], { encoding: "utf8" });
		return output.match(/(\d+)\./)?.[1] ?? null;
	} catch {
		return null;
	}
}

async function downloadCrx(id) {
	const major = detectBrowserMajor();
	if (!major) {
		throw new Error("could not detect the Chromium version; set $CHROME_BIN");
	}
	const url =
		"https://clients2.google.com/service/update2/crx" +
		`?response=redirect&prodversion=${major}&acceptformat=crx2,crx3` +
		`&x=${encodeURIComponent(`id=${id}&uc`)}`;
	console.log(`Downloading ${id} for Chromium ${major} ...`);
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
	return Buffer.from(await response.arrayBuffer());
}

// --- Agent profile ---------------------------------------------------------

// Chromium's SingletonLock is a symlink to "<hostname>-<pid>" while a browser
// owns the user-data-dir. Matching argv with pgrep is not an option: a shell
// that merely mentions --user-data-dir=<agent> would match itself (and be
// killed by the usual pkill workaround). Resolve the lock and confirm the pid
// really is a browser on this directory instead.
function chromiumIsRunning() {
	const lock = join(AGENT_PROFILE, "SingletonLock");
	let target;
	try {
		target = readlinkSync(lock);
	} catch {
		return false;
	}
	const pid = Number(target.slice(target.lastIndexOf("-") + 1));
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(`--user-data-dir=${AGENT_PROFILE}`);
	} catch {
		return false;
	}
}

// Delete extensions.settings.<id> so the next launch reinstalls the CRX. The
// entry lives in Preferences; Secure Preferences is checked defensively and
// left alone unless it actually holds the id.
function forgetExtension(id) {
	for (const file of ["Preferences", "Secure Preferences"]) {
		const path = join(AGENT_PROFILE, profileDir, file);
		if (!existsSync(path)) continue;
		let data;
		try {
			data = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			continue;
		}
		const settings = data?.extensions?.settings;
		if (!settings || !(id in settings)) continue;
		delete settings[id];
		const macs = data?.protection?.macs?.extensions?.settings;
		if (macs && id in macs) delete macs[id];
		writeFileSync(path, JSON.stringify(data));
		console.log(`Removed extensions.settings.${id} from ${file}`);
	}
}

// --- Run -------------------------------------------------------------------

if (chromiumIsRunning()) {
	console.error("✗ Chromium is running with the agent user-data-dir; it would overwrite Preferences.");
	console.error("  Close it, or stop just the agent instance:");
	console.error(`    pkill -f '[u]ser-data-dir=${AGENT_PROFILE}'`);
	process.exit(1);
}

let crx;
if (crxFile) {
	if (!existsSync(crxFile)) {
		console.error(`✗ No such CRX file: ${crxFile}`);
		process.exit(1);
	}
	crx = readFileSync(crxFile);
} else {
	try {
		crx = await downloadCrx(extensionId);
	} catch (error) {
		console.error(`✗ ${error.message}`);
		process.exit(1);
	}
}

let derivedId;
try {
	derivedId = readCrxId(crx);
} catch (error) {
	console.error(`✗ ${error.message}`);
	process.exit(1);
}
if (extensionId && extensionId !== derivedId) {
	console.error(`✗ --id ${extensionId} does not match the CRX's id ${derivedId}`);
	process.exit(1);
}
const id = extensionId ?? derivedId;

const resolvedVersion = version ?? (() => {
	try {
		return readCrxVersion(crx);
	} catch (error) {
		console.error(`✗ could not read the version from the CRX (${error.message}); pass --version`);
		process.exit(1);
	}
})();

mkdirSync(CRX_DIR, { recursive: true });
mkdirSync(EXTERNAL_DIR, { recursive: true });
const storedCrx = join(CRX_DIR, `${id}.crx`);
if (!crxFile || resolve(crxFile) !== resolve(storedCrx)) {
	writeFileSync(storedCrx, crx);
}
const descriptor = join(EXTERNAL_DIR, `${id}.json`);
writeFileSync(descriptor, `${JSON.stringify({ external_crx: storedCrx, external_version: resolvedVersion }, null, 2)}\n`);

forgetExtension(id);

console.log(`✓ Provisioned ${id} (${resolvedVersion})`);
console.log(`  CRX:        ${storedCrx}`);
console.log(`  Descriptor: ${descriptor}`);
console.log("  Start Chromium with browser-start-linux.js to install it.");
