/**
 * pi-bash-timeout — a default timeout for the built-in `bash` tool.
 *
 * The bash tool accepts a `timeout` in seconds but ships with no default, so a
 * hung command stalls the turn until it is aborted. This extension fills the
 * parameter in when the model leaves it out; an explicit model value wins.
 * `tool_call` mutations are applied to the actual execution, so this is the
 * supported way to give a built-in tool a default.
 */

import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_BASH_TIMEOUT_SECONDS = 10; // default when the model passes none

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) {
			return;
		}
		if (event.input.timeout !== undefined) {
			return;
		}
		event.input.timeout = DEFAULT_BASH_TIMEOUT_SECONDS;
	});
}
