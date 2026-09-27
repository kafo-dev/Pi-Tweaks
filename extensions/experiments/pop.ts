/**
 * pop — an experimental `/pop` command that steps the session tree back one
 * entry.
 *
 * A session is an append-only tree, and the context the model sees is the path
 * from the root to the leaf. Moving the leaf is therefore how an entry leaves
 * the context: `/pop` points the leaf at the parent of the current entry, so
 * that one entry drops out of the branch, the transcript is re-rendered
 * without it, and everything before it stays.
 *
 * pi's navigation has one special case, which `/pop` inherits: navigating to a
 * user message points the leaf at that message's own parent and hands the text
 * to the caller, which the TUI puts in the editor. So a pop that lands on a
 * user message removes it as well and gives it back for editing — the result
 * `/tree` produces when that message is picked.
 *
 * A running turn is ended first rather than refused. The abort leaves the
 * cursor on the aborted turn's own last entry, so `/pop` during a response is
 * how that response is taken back. In the TUI the abort also moves any queued
 * message into the editor, where the guard below applies to it.
 *
 * The command refuses, instead of guessing, when:
 *
 * - the cursor is already at the first entry: an extension cannot point the
 *   leaf above the first entry, because only `resetLeaf` does that and the
 *   extension API does not expose it;
 * - the editor holds text and a user message is what comes back: pi fills the
 *   editor only when it is empty, so the text would leave the branch and never
 *   reach the user;
 * - the entry above the cursor is a user message too, while the cursor is
 *   already on one: pi would drop both, and the pop would take two entries;
 * - the mode has no editor: print and json carry no editor state, so a user
 *   message handed back would have nowhere to land. The TUI has one, and an
 *   RPC client receives the text as a `set_editor_text` request.
 *
 * A branch that ends on an assistant message whose tool call has no result is
 * left as it is. Popping a tool result, then the assistant message that asked
 * for it, ends exactly there, and pi sends the branch to the provider without
 * repairing the pair.
 *
 * Loading the file does not publish the command: it registers only when the
 * `experiment-pop` section of `pi-tweaks.json` sets `"enabled": true`.
 *
 *   { "experiment-pop": { "enabled": true } }
 *
 * See the Experiment README and pi-tweaks-config.ts.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { isExperimentEnabled } from "../../lib/pi-tweaks-config";

const EXTENSION = "experiment-pop";

/** Refusal shown after the `pop: ` prefix, one constant per condition. */
const FIRST_ENTRY = "the cursor is already at the first entry";
const EDITOR_HOLDS_TEXT =
	"the editor holds text, so the message would have nowhere to land; clear it first";
const TWO_USER_MESSAGES =
	"a user message sits above the cursor, and pi would drop both";
const NO_EDITOR =
	"print and json modes have no editor to hand a message back to";

/** What `/pop` should do, decided before anything is touched. */
type PopDecision =
	| { kind: "navigate"; targetId: string }
	| { kind: "refill"; targetId: string; text: string }
	| { kind: "refuse"; reason: string };

/**
 * The text of a message content, joined the way pi joins it when it hands a
 * message back: the text blocks in order, one newline between them, and
 * nothing for a message that carries only images.
 */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

/**
 * The text of a user message, or undefined when the entry is anything else.
 * A message with no text block of its own, such as one that carries only
 * images, yields an empty string.
 */
function userText(entry: SessionEntry): string | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as { role?: unknown; content?: unknown };
	if (message.role !== "user") return undefined;
	return contentText(message.content);
}

/**
 * The move that carries `text` back to the editor. A message with no text of
 * its own, such as one that carries only images, needs no room there, and text
 * with no room in a busy editor is refused instead of dropped: pi fills the
 * editor only when it is empty, so a message handed back with nowhere to land
 * would leave the branch with no copy anywhere.
 */
function hand(
	targetId: string,
	text: string,
	editorEmpty: boolean,
): PopDecision {
	if (!text) return { kind: "navigate", targetId };
	if (!editorEmpty) return { kind: "refuse", reason: EDITOR_HOLDS_TEXT };
	return { kind: "refill", targetId, text };
}

/**
 * The move for the current cursor position, without side effects.
 *
 * `parent` is the entry above the leaf, absent when the leaf is the first
 * entry. `editorEmpty` reports whether the TUI editor holds no text: pi fills
 * the editor only when it is empty, so a pop that hands a message back must
 * not leave the text with nowhere to go.
 */
function decidePop(
	leaf: SessionEntry,
	parent: SessionEntry | undefined,
	editorEmpty: boolean,
): PopDecision {
	if (parent === undefined) return { kind: "refuse", reason: FIRST_ENTRY };

	// Landing on a user message makes pi move the cursor above it and return
	// its text, so the editor is the only place that text can go.
	const parentText = userText(parent);
	if (parentText !== undefined) {
		if (userText(leaf) !== undefined) {
			return { kind: "refuse", reason: TWO_USER_MESSAGES };
		}
		return hand(parent.id, parentText, editorEmpty);
	}

	// The leaf is the entry this pop removes, so a user message there comes
	// back with it, even though the cursor stops on a plain parent.
	const leafText = userText(leaf);
	if (leafText !== undefined) return hand(parent.id, leafText, editorEmpty);

	return { kind: "navigate", targetId: parent.id };
}

/** Move the cursor one entry back, reporting why when it cannot move. */
async function pop(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
		ctx.ui.notify(`pop: ${NO_EDITOR}`, "warning");
		return;
	}
	// A running turn is ended first: navigation needs an idle session, and the
	// entries the turn has already written are what the pop is about. The abort
	// moves the cursor onto the aborted turn's own last entry, so the cursor is
	// read only after the wait.
	if (!ctx.isIdle()) {
		ctx.abort();
		await ctx.waitForIdle();
	}

	const manager = ctx.sessionManager;
	const leaf = manager.getLeafEntry();
	if (leaf === undefined) {
		ctx.ui.notify("pop: the cursor is at the start of the session", "warning");
		return;
	}
	const parent =
		leaf.parentId === null ? undefined : manager.getEntry(leaf.parentId);
	const decision = decidePop(
		leaf,
		parent,
		ctx.ui.getEditorText().trim() === "",
	);
	if (decision.kind === "refuse") {
		ctx.ui.notify(`pop: ${decision.reason}`, "warning");
		return;
	}

	try {
		const result = await ctx.navigateTree(decision.targetId);
		if (result.cancelled) return;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`pop: ${message}`, "warning");
		return;
	}

	// pi's own refill only runs when the editor is empty; setting the text here
	// keeps the one case above, where the cursor moves off a user message and
	// nothing else returns its text, correct.
	if (decision.kind === "refill") ctx.ui.setEditorText(decision.text);
}

export default function (pi: ExtensionAPI) {
	if (!isExperimentEnabled(EXTENSION)) return;

	pi.registerCommand("pop", {
		description: "Go back one entry in the session tree",
		handler: async (_args, ctx) => {
			await pop(ctx);
		},
	});
}
