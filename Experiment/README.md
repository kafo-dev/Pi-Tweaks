# Experiment

Experimental extensions that test a hypothesis about the agent. They are
listed in the [`pi` manifest](../package.json), so pi loads them, but each
registers nothing until enabled by hand in `pi-tweaks.json`:

```json
{
  "experiment-minimal-tools": {
    "enabled": true,
    "timeoutSeconds": 32,
    "maxLines": 1024,
    "maxBytes": 32768
  }
}
```

A missing section, any value other than the boolean `true`, and a malformed
file all leave an experiment off (`isExperimentEnabled`). Enable one, then
restart pi or run `/reload`.

Experiments are unmaintained relative to the package: they can change or be
moved to [`.archived/`](../.archived/) once the hypothesis is settled. A
settled idea that proves beneficial graduates by moving the file next to the
packaged extensions and dropping the `experiment-` prefix from its
`pi-tweaks.json` section.

## `minimal-tools.ts`

Hypothesis: a smaller tool surface cuts the choices the model makes per turn.

After the extension loads, the active tools are:

| Tool | Role |
|------|------|
| `media` | reads files, including images; the built-in `read` under a name that signals the intended role for audio and video |
| `bash` | everything else — `sed` and `patch` for file changes, plus `fd`, `rg`, and arbitrary commands |

The built-in `read`, `write`, `edit`, `find`, `grep`, and `ls` tools are
removed from the active set. `media` delegates to the built-in `read` tool,
and `bash` runs through `pi.exec`. Both replace their descriptions with
shorter ones, so text and images keep working while the prompt does not
advertise behavior the experiment drops.

The `bash` tool runs through `pi.exec`. Its output is bounded: past
`maxLines` lines total (default 1024, split 512 at each end) or `maxBytes`
bytes (default 32768), the middle is dropped and the full output is written to
a temp file named in the marker. Output with few lines but too many bytes is
cut at the byte budget instead. The default command timeout is 32 seconds.

### Conflicts

The experiment sets a default bash timeout, which `pi-bash-timeout` also does.
Enable only one: with both on, the value depends on extension load order. An
extension cannot disable another, so enable the experiment and disable the
packaged extension in the same file, and the experiment warns on startup if
both are still on:

```json
{
  "experiment-minimal-tools": { "enabled": true },
  "pi-bash-timeout": { "enabled": false }
}
```
