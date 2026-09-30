# Experiment

Experimental extensions that test a hypothesis about the agent. They are
listed in the [`pi` manifest](../../package.json), so pi loads them, but each
registers nothing until enabled by hand in `pi-tweaks.json`:

```json
{
  "experiment-pop": { "enabled": true }
}
```

A missing section, any value other than the boolean `true`, and a malformed
file all leave an experiment off (`isExperimentEnabled`). Enable it there, then
restart pi or run `/reload`.

Experiments are unmaintained relative to the package: they can change or be
moved to [`.archived/`](../../.archived/) once the hypothesis is settled. A
settled idea that proves beneficial graduates by moving the file next to the
packaged extensions and dropping the `experiment-` prefix from its
`pi-tweaks.json` section.

## `pop.ts`

Hypothesis: the last thing a session did is often the thing to take back, and
reaching for it should cost one command rather than a trip through the `/tree`
picker.

A session is an append-only tree, and what the model sees is the path from the
root to the leaf, so moving the leaf is how an entry leaves the context. `/pop`
points the leaf at the parent of the current entry: that one entry drops out of
the branch, the transcript is re-rendered without it, and everything before it
stays.

pi's navigation treats a user message as a special case: navigating to one
points the leaf at that message's own parent and hands the text to the caller,
which puts it in the editor. `/pop` inherits that, so a pop that lands on a
user message removes it as well and gives it back for editing — the result
`/tree` produces when that message is picked.

`/pop user` aims the same move at the last message the user wrote on the branch.
One navigation takes everything after it out of the context — usually the whole
turn — and that message comes back to the editor; repeated `/pop` reaches the
same place one render at a time.

A turn that is still streaming is ended first: `/pop` aborts it, waits for the
session to go idle, and reads the cursor only then, because the abort has moved
the cursor onto the aborted turn's own last entry. So `/pop` during a response
is how that response is taken back. In the TUI the abort also moves any queued
message into the editor, where the busy-editor refusal below applies to it.

```json
{
  "experiment-pop": { "enabled": true }
}
```

The command refuses, rather than guess, when the cursor is already at the first
entry, when `/pop user` finds no user message on the branch or the cursor
already sits on the one it would target, when a user message would come
back with no room in the editor, when the entry above the cursor is a user
message too, and in print and json modes, which carry no editor state. An RPC
client receives the text of a message handed back as a `set_editor_text`
request, and pi cannot read an RPC client's editor, so the check for a busy
editor is the client's to make.

Popping a tool result, then the assistant message that asked for it, leaves the
branch ending on a tool call with no result, and pi sends the branch to the
provider without repairing the pair.

## `url.ts`

Hypothesis: a link that scrolled past is worth reaching without scrolling back,
and the address is the part to take, not the sentence around it.

`/url` opens the same picker as `/snippet`, over links instead of code: one tab
for markdown links, one for bare URLs. Tab switches tabs, arrows move, and the
most recently printed link comes first. A markdown row shows the host and the
link text; a bare row shows the host and the path. Enter copies the address to
the clipboard — the brackets and the link text stay behind — and Escape closes
the picker.

The source is the text of user and assistant messages on the active branch,
fenced code blocks included, because a URL in a command is often the one worth
copying. Tool results are skipped, so a link inside a fetched page cannot bury
the links of the conversation.

A URL is recognised by its scheme (`https://`, `ftp://`, `mailto:`, …); a bare
host such as `www.example.com` is not listed. Punctuation glued to an address
by the sentence around it is trimmed, and a closing bracket is trimmed only
when the URL holds no opener for it, so `/wiki/Foo_(bar)` survives and
`(see https://example.com/a)` loses its bracket. A URL written both ways is
listed once, in the markdown tab.

```json
{
  "experiment-url": { "enabled": true }
}
```

## `prune-sessions.ts`

Hypothesis: an unnamed session that has seen no use for three months is dead
weight, while a named session is worth keeping forever, and neither should be
deleted when another pi still has it open.

A session file is moved to the XDG trash when all three hold:

- the file mtime is older than `olderThanDays` (default 90). The mtime is the
  last append, so it is the last use, not the creation date.
- the session carries no name from `/name` or `--name`.
- no live pi process holds it, by the locks written by the sandbox wrapper
  (`extras/pi-session-pick.mjs`, see [extras](../../extras/README.md)).

```json
{
  "experiment-prune-sessions": {
    "enabled": true,
    "disableAutoPruning": false,
    "olderThanDays": 90,
    "pruneIntervalHours": 24
  }
}
```

With `disableAutoPruning` false, a round runs in the background five seconds
after startup, at most once per `pruneIntervalHours`; it streams the session
files, so a slow filesystem delays the round rather than the agent.
`/pi-tweaks prune-sessions` runs a round on demand, and `--dry-run` reports
without moving anything. The time of the last automatic round is kept beside
the session locks, in the Pi-Tweaks cache directory: runtime state belongs in
the cache, not in the agent directory that holds configuration.

The XDG trash lives at `$XDG_DATA_HOME/Trash` (default
`~/.local/share/Trash`), which the sandbox does not bind read-write. A move
from a sandboxed pi therefore needs `~/.local/share/Trash` in `rw-paths.txt`; a
failed move is reported and nothing is lost.
