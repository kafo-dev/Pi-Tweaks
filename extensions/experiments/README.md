# Experiment

Experimental extensions that test a hypothesis about the agent. They are
listed in the [`pi` manifest](../../package.json), so pi loads them, but each
registers nothing until enabled by hand in `pi-tweaks.json`:

```json
{
  "experiment-minimal-mode": {
    "enabled": true,
    "timeoutSeconds": 32,
    "maxLines": 1024,
    "maxBytes": 32768
  }
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

## `minimal-mode.ts`

Hypotheses: a smaller tool surface cuts the choices the model makes per turn,
and a one-line `bash` row keeps the command visible while the output stays out
of the way until it is asked for.

After the extension loads, the active tools are:

| Tool | Role |
|------|------|
| `media` | reads files, including images; the built-in `read` under a name that signals the intended role for audio and video |
| `bash` | everything else — `sed` and `patch` for file changes, plus `fd`, `rg`, and arbitrary commands |

The built-in `read`, `write`, `edit`, `find`, `grep`, and `ls` tools are
removed from the active set. `media` delegates to the built-in `read` tool and
`bash` runs through `pi.exec`, and both replace their descriptions with shorter
ones, so text and images keep working while the prompt does not advertise
behavior the mode drops.

`bash` bounds its output: past `maxLines` lines total (split evenly between the
two ends) or `maxBytes` bytes, the middle is dropped and the full output is
written to a temp file named in the marker. Output with few lines but too many
bytes is cut at the byte budget instead. `timeoutSeconds` applies when the
model passes no timeout of its own.

Every option is required. With `"enabled": true` the section has to list all
three, as in the example at the top of this file; a missing option, or a value
that breaks its rule, registers nothing and reports one error per problem when
the session starts, and `/pi-tweaks list` shows the experiment as switched on
but unusable, with the same messages. `timeoutSeconds` is a positive number of
seconds, at most 2147483.647, the ceiling of a 32-bit timer; `maxLines` and
`maxBytes` are positive integers. The mode changes which tools the model has,
so a fallback value is never used in place of one the section did not set.

The `bash` row is collapsed. The collapsed row holds `$ ` and the command,
whitespace collapsed to a single line and cut to the viewport width, and no
output, successful or failed. Expanding the row with `ctrl+o`, or by clicking it,
untruncates the command in place and shows the full output below it. The
click is handled by the row itself, so it also works while the command is
still streaming, before the call has a result.

The command line ends with the command's wall-clock time rounded to the
nearest second in Go's `time.Duration` format, its exit code, and an output
estimate at four characters per token. A part is dropped when it is not worth showing: the time
below two seconds, `exit 0`, and an estimate below 128 tokens. So a fast,
successful, small command keeps just its command, while
`$ make test (2.4s, exit 1, ~140 tokens)` shows all three parts and
`$ make test (2.4s, ~140 tokens)` drops the zero exit code.

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
without moving anything.

The XDG trash lives at `$XDG_DATA_HOME/Trash` (default
`~/.local/share/Trash`), which the sandbox does not bind read-write. A move
from a sandboxed pi therefore needs `~/.local/share/Trash` in `rw-paths.txt`; a
failed move is reported and nothing is lost.

## Conflicts

`minimal-mode` sets a default bash timeout, which `pi-bash-timeout` also does.
Enable only one: with both on, the value depends on extension load order, and
the experiment warns on startup while both are still on. An extension cannot
disable another, so disable the packaged extension in the same file:

```json
{
  "experiment-minimal-mode": {
    "enabled": true,
    "timeoutSeconds": 32,
    "maxLines": 1024,
    "maxBytes": 32768
  },
  "pi-bash-timeout": { "enabled": false }
}
```
