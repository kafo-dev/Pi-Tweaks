# Archived tools

Tools in this directory were removed from the [`pi` manifest](../package.json),
so pi no longer installs or loads them. They stay in the tree rather than being
deleted so that the approach remains readable and available.

## Why they were retired

Each tool was built to test an idea against real sessions, then judged on what
those sessions showed. The `python` tool and the `pi-timestamps` extension were
hypotheses about model behavior; `pi-stop` was a convenience written without
knowing that pi already binds Escape to cancel/abort. Retirement is a judgement
about the tool's value, not a claim that the code is broken.

The first case was the `python` tool. The hypothesis was that passing raw
Python source as one argv entry would remove the quoting friction of
`python -c` and become the model's default way to run Python. In practice the
model kept reaching for `python -c`, often to `cat` a file at the start of a
pipeline, and sometimes it used `python -c` even with the tool available. The
choice was inconsistent, so the extra tool did not justify the additional
context it consumed or the decision fatigue it added.

The `pi-timestamps` extension came next. The hypothesis was that a clock in the
transcript — a date and time stamp on each sent prompt and on the final answer
of a turn — would give the model time awareness. In practice the model made no
use of the stamp, and the extension conflicted with other features often
enough to cost more than it gave. The stamp was appended to the raw input,
before pi expanded a prompt template, so the template argument parser read it
as extra arguments.

The `pi-stop` extension came third. It was written without knowing that pi
already binds Escape to cancel/abort, so `/stop` duplicated a key the TUI
handled on its own. Double-Escape is a separate binding (`/tree`) and was never
part of the command's case. The extension also announced its aborts on pi's
shared event bus so pi-notify could skip the settle they cause; that event has
no other producer, so the archived source is what keeps the announcement
available.

The source is kept for two reasons:

- The approach can inspire a future tool, or the idea can be revisited under
  conditions that did not hold at retirement.
- The tool still works for anyone who wants it, even though the package no
  longer carries it.

Archived tools are unmaintained: they receive no fixes and no guarantees that
they track later pi or Pi-Tweaks changes.

## Using an archived tool

An archived extension may import the shared configuration in
[`pi-tweaks-config.ts`](../pi-tweaks-config.ts) and read its settings from
`pi-tweaks.json` under the section named after the file.

Load one for a single session without installing it:

```bash
pi -e .archived/<name>.ts
```

Or add the file as a local extension source:

```bash
pi install .archived/<name>.ts
```

## Contents

| Path | What |
|------|------|
| [`pi-python.ts`](pi-python.ts) | Adds a `python` tool that runs raw Python 3 source passed as one argv entry, so the source needs no shell quoting or code fences. A `pip` field installs packages into a shared virtual environment before the run, and `retry_previous` re-runs the last program. |
| [`pi-timestamps.ts`](pi-timestamps.ts) | Appends a date and time stamp to each sent prompt and to the final answer of a turn. The stamp is added before pi expands a prompt template, so the template argument parser reads it as extra arguments and a `${1:-default}` argument loses its default. |
| [`pi-stop.ts`](pi-stop.ts) | Adds `/stop`, which aborts the running turn — the same abort as Escape. Commands are dispatched before pi decides whether an input is a steering message, so the command also works while the agent is streaming. It emits `turn-aborted` on pi's shared event bus so pi-notify can skip the alert for the settle it causes. |
