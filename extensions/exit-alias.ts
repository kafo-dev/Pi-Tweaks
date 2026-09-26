/**
 * exit-alias — `/exit` as an alias for pi's built-in `/quit`.
 *
 * pi's TUI handles `/quit` before extensions see the input, so an extension
 * command cannot call that handler; `ctx.shutdown()` is the same graceful
 * exit (deferred until the agent is idle, emits `session_shutdown`).
 *
 * Config: `"enabled": false` under `exit-alias` in `pi-tweaks.json` turns the
 * extension off. See pi-tweaks-config.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isExtensionEnabled } from "../lib/pi-tweaks-config";

export default function (pi: ExtensionAPI) {
	if (!isExtensionEnabled("exit-alias")) return;

	pi.registerCommand("exit", {
		description: "Exit pi (alias for /quit)",
		handler: async (_args, ctx) => ctx.shutdown(),
	});
}
