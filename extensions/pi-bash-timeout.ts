/**
 * pi-bash-timeout — a default timeout for the built-in `bash` tool.
 *
 * The bash tool accepts a `timeout` in seconds but ships with no default, so a
 * hung command stalls the turn until it is aborted. This extension fills the
 * parameter in when the model leaves it out; an explicit model value wins.
 * `tool_call` mutations are applied to the actual execution, so this is the
 * supported way to give a built-in tool a default.
 *
 * Config: `pi-bash-timeout.timeoutSeconds` in `pi-tweaks.json` overrides the
 * built-in 10 seconds; `"enabled": false` turns the extension off. See
 * pi-tweaks-config.ts for the file and its location.
 */

import {
	type ExtensionAPI,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import {
	isExtensionEnabled,
	numberValue,
	readSection,
} from "../lib/pi-tweaks-config";

const EXTENSION = "pi-bash-timeout";
const DEFAULT_BASH_TIMEOUT_SECONDS = 10; // when the model passes none
const MAX_TIMEOUT_SECONDS = 2147483647 / 1000; // 32-bit setTimeout ceiling

export default function (pi: ExtensionAPI) {
	if (!isExtensionEnabled(EXTENSION)) return;

	const timeoutSeconds = numberValue(
		readSection(EXTENSION),
		"timeoutSeconds",
		DEFAULT_BASH_TIMEOUT_SECONDS,
		{ positive: true, atMost: MAX_TIMEOUT_SECONDS },
	);

	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) {
			return;
		}
		if (event.input.timeout !== undefined) {
			return;
		}
		event.input.timeout = timeoutSeconds;
	});
}
