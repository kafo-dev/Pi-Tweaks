# TODO

## Resume the session picker from an extension

Today the sandbox wrapper (`extras/pi`) picks the session: before pi starts,
`extras/pi-session-pick.mjs` chooses the most recently used named session that
no live process holds, else the most recently used unheld session, and passes
it as `--session`. This needs the wrapper, so a bare `pi` started outside it
still opens a new session.

The goal is the same choice from an extension, with no wrapper. The obstacle
is architectural in pi: the startup session is created before extensions load,
and only command handlers receive `ctx.switchSession`; event handlers do not.

Sketch of an extension-only approach:

1. On `session_start` with reason `startup`, when the invocation carries no
   session flag, the session is empty, and a candidate exists, defer a
   self-command with `pi.sendUserMessage("/pick-session", {
   expandPromptTemplates: true })`. Extension commands run without a model
   turn.
2. The command handler calls `ctx.switchSession(path)`, which tears down the
   empty session, loads the candidate, and rebinds the UI.

Risks and reasons not to do it yet:

- The switch must run after the interactive UI has set its rebind hook and
  after `session_start` finishes; a deferred call is timing-dependent. Switching
  during startup can leave the UI bound to the discarded session.
- It relies on undocumented re-entrancy of command context from a startup
  event.
- The empty startup session may flash in the transcript before the switch.

Revisit when pi exposes a session-selection hook, such as an event result for
`session_start` carrying a session path, or `switchSession` on
`ExtensionContext` with a documented safe point for startup.
