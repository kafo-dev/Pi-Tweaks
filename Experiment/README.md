# Experiment

Experimental extensions that test a hypothesis about the agent. They are
listed in the [`pi` manifest](../package.json), so pi loads them, but each
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
moved to [`.archived/`](../.archived/) once the hypothesis is settled. A
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

`bash` bounds its output: past `maxLines` lines total (default 1024, split 512
at each end) or `maxBytes` bytes (default 32768), the middle is dropped and the
full output is written to a temp file named in the marker. Output with few
lines but too many bytes is cut at the byte budget instead. The default command
timeout is 32 seconds.

The `bash` row is collapsed. The collapsed row holds `$ ` and the command,
whitespace collapsed to a single line and cut to the viewport width, and no
output, successful or failed. Expanding the row with `ctrl+o` untruncates the
command in place and shows the full output below it.

The command line ends with the command's wall-clock time rounded to the
nearest second in Go's `time.Duration` format, its exit code, and an output
estimate at four characters per token. A part is dropped when it is not worth showing: the time
below two seconds, `exit 0`, and an estimate below 128 tokens. So a fast,
successful, small command keeps just its command, while
`$ make test (2.4s, exit 1, ~140 tokens)` shows all three parts and
`$ make test (2.4s, ~140 tokens)` drops the zero exit code.

## Conflicts

`minimal-mode` sets a default bash timeout, which `pi-bash-timeout` also does.
Enable only one: with both on, the value depends on extension load order, and
the experiment warns on startup while both are still on. An extension cannot
disable another, so disable the packaged extension in the same file:

```json
{
  "experiment-minimal-mode": { "enabled": true },
  "pi-bash-timeout": { "enabled": false }
}
```
