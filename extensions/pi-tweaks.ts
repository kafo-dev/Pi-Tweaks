/**
 * pi-tweaks — the package's own `/pi-tweaks` command.
 *
 * One entry point for every extension of the package:
 *
 *   /pi-tweaks list              the packaged extensions, split by enabled state
 *   /pi-tweaks notify …          the notify extension's settings and test
 *   /pi-tweaks pin-document      the documents pin-document resolves
 *   /pi-tweaks prune-sessions …  a pruning round over the session store
 *
 * A subcommand is named after the extension that answers it, and that
 * extension exports the work as a plain function; this file imports it.
 * Extensions cannot share module state: pi loads each one with its own module
 * cache, so a value read here is not the copy the extension itself uses.
 * Everything a subcommand needs is therefore read from disk at call time.
 *
 * `list` is the command's own: it reads `pi.extensions` and answers whether
 * each extension would register anything. A subcommand whose extension is off
 * says so, rather than report work that extension would not do.
 * `"enabled": false` under `pi-tweaks` in `pi-tweaks.json` removes the whole
 * command.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	configFilePath,
	isExtensionEnabled,
	isPackagedExtensionEnabled,
	packagedExtensions,
} from "../lib/pi-tweaks-config";
import { runPruneSessions } from "./experiments/prune-sessions";
import { runNotify } from "./notify/index";
import { reportPinnedDocuments } from "./pin-document";

const EXTENSION = "pi-tweaks";

/** One `/pi-tweaks` subcommand, answered by an extension of the package. */
type Subcommand = {
	/** Section name in `pi-tweaks.json` of the extension that answers it. */
	extension: string;
	/** What the subcommand reports, one line for the usage text. */
	description: string;
	/** Run the subcommand with the text that followed its name. */
	handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
};

/**
 * Every subcommand but `list`, in usage order. The extension name is the
 * section name in `pi-tweaks.json`, so the enabled switch and this table agree
 * by construction.
 */
const SUBCOMMANDS: Array<[name: string, subcommand: Subcommand]> = [
	[
		"notify",
		{
			extension: "notify",
			description: "notify settings: show one, change one, or test the path",
			handler: runNotify,
		},
	],
	[
		"pin-document",
		{
			extension: "pin-document",
			description: "the documents pin-document resolves, and its errors",
			handler: (_args, ctx) => reportPinnedDocuments(ctx),
		},
	],
	[
		"prune-sessions",
		{
			extension: "experiment-prune-sessions",
			description:
				"move old unnamed sessions to the trash (--dry-run to preview)",
			handler: runPruneSessions,
		},
	],
];

/** Whether the extension named here registers anything: off, on, or unknown. */
function extensionState(name: string): boolean | undefined {
	const extension = packagedExtensions()?.find((entry) => entry.name === name);
	return extension ? isPackagedExtensionEnabled(extension) : undefined;
}

/** Report whether each packaged extension registers anything. */
function list(ctx: ExtensionCommandContext): void {
	const extensions = packagedExtensions();
	if (extensions === null) {
		ctx.ui.notify(
			"pi-tweaks: no usable list of extensions under `pi.extensions` in the package.json at the package root",
			"error",
		);
		return;
	}
	const named = (on: boolean) =>
		extensions
			.filter((extension) => isPackagedExtensionEnabled(extension) === on)
			.map((extension) => extension.name);
	const enabled = named(true);
	const disabled = named(false);
	const listed = (names: string[]) =>
		names.length > 0 ? names.join(", ") : "none";
	ctx.ui.notify(
		[
			`config: ${configFilePath()}`,
			`enabled (${enabled.length} of ${extensions.length}): ${listed(enabled)}`,
			`disabled: ${listed(disabled)}`,
		].join("\n"),
		"info",
	);
}

/** The usage text, built from the subcommands this file knows. */
function usage(): string {
	const lines = [
		"Usage: /pi-tweaks <subcommand>",
		`  ${"list".padEnd(16)}every packaged extension, and whether it is enabled`,
	];
	for (const [name, subcommand] of SUBCOMMANDS) {
		lines.push(`  ${name.padEnd(16)}${subcommand.description}`);
	}
	return lines.join("\n");
}

export default function piTweaks(pi: ExtensionAPI) {
	if (!isExtensionEnabled(EXTENSION)) return;

	pi.registerCommand("pi-tweaks", {
		description: "Tweaks: report what the packaged extensions are doing",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const space = trimmed.search(/\s/);
			const name = space === -1 ? trimmed : trimmed.slice(0, space);
			const rest = space === -1 ? "" : trimmed.slice(space + 1);

			if (name === "list") {
				list(ctx);
				return;
			}
			const match = SUBCOMMANDS.find(([candidate]) => candidate === name);
			if (match === undefined) {
				ctx.ui.notify(usage(), name === "" ? "info" : "warning");
				return;
			}
			const [, subcommand] = match;
			if (extensionState(subcommand.extension) === false) {
				ctx.ui.notify(
					`${subcommand.extension} is disabled in ${configFilePath()}`,
					"warning",
				);
				return;
			}
			await subcommand.handler(rest, ctx);
		},
	});
}
