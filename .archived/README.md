# Archived tools

Tools in this directory were removed from the [`pi` manifest](../package.json),
so pi no longer installs or loads them. They stay in the tree rather than being
deleted so that the approach remains readable and available.

## Why they were retired

Each tool started as an experiment: a hypothesis about how the model behaves
when it drives the tool loop, built to test that hypothesis against real
sessions. After observation, the authors did not find the tool beneficial
enough to keep it in the package. Retirement is a judgement about the tool's
value, not a claim that the code is broken.

The first case was the `python` tool. The hypothesis was that passing raw
Python source as one argv entry would remove the quoting friction of
`python -c` and become the model's default way to run Python. In practice the
model kept reaching for `python -c`, often to `cat` a file at the start of a
pipeline, and sometimes it used `python -c` even with the tool available. The
choice was inconsistent, so the extra tool did not justify the additional
context it consumed or the decision fatigue it added.

The source is kept for two reasons:

- The approach can inspire a future tool, or the hypothesis can be revisited
  under conditions that did not hold at retirement.
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
