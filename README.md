# Pi-Tweaks

Miscellaneous tools for the [pi](https://github.com/earendil-works/pi) coding
agent harness: skills, extensions, and a `bwrap` sandbox wrapper.

## Install

```bash
pi install git:github.com/kafo-dev/Pi-Tweaks
# or, from a local checkout:
pi install /path/to/Pi-Tweaks
```

The `pi` manifest in [`package.json`](package.json) declares the resources; pi
installs the dependencies and discovers each skill's `SKILL.md` plus every
extension listed in `pi.extensions`. The skills load on demand and are available
as `/skill:browser-tools` and `/skill:web-tools`; the extensions are always
loaded. `pi-notify` notifies on the terminal out of the box, while its phone leg
stays off until you configure it.

## Contents

| Path | What |
|------|------|
| [`package.json`](package.json) | pi package manifest (`pi.extensions`, `pi.skills`) + dependencies |
| [`pi-notify/`](pi-notify/) | Extension that notifies you — desktop and KDE Connect phone alarm — when pi settles a turn or blocks on a dialog. Terminal notifications on by default, phone off. See its [README](pi-notify/README.md). |
| [`pi-pinned-skills.ts`](pi-pinned-skills.ts) | Extension that appends the full text of skills named in `pinned-skills.json` to the system prompt on every turn, so they apply without the model deciding to read them. The block is deterministic, which keeps it inside the provider's cached prefix. `/pinned-skills` reports what resolved. |
| [`pi-compaction-prompt.ts`](pi-compaction-prompt.ts) | Extension that replaces pi's compaction prompt with the body of a Markdown file named by `compaction.promptFile` in `settings.json`. The previous summary, `/compact` instructions, and the conversation are appended, and the read/modified file lists pi normally adds are kept. Unset means pi's default compaction. |
| [`pi-exit.ts`](pi-exit.ts) | Extension that adds `/exit` as an alias for pi's built-in `/quit`. |
| [`pi-python.ts`](pi-python.ts) | Extension that adds a `python` tool: raw Python 3 source is passed as one argv entry, so no shell quoting, escaping, or code fences are needed. A `pip` field installs packages into a virtual environment shared by every pi session (`python-venv` inside pi's agent directory) before the code runs, and `retry_previous` re-runs the last program so the model can install a missing package without resending its code. A `cwd` field runs the code in another directory; a relative path resolves against the session working directory. The code run is killed after 10 seconds unless the `timeout` field (in seconds) says otherwise. |
| [`pi-bash-timeout.ts`](pi-bash-timeout.ts) | Extension that fills in the built-in `bash` tool's `timeout` parameter (in seconds) when the model omits it, so a hung command cannot stall a turn. An explicit model value wins. The default is `DEFAULT_BASH_TIMEOUT_SECONDS` in the file. |
| [`pi-stop.ts`](pi-stop.ts) | Extension that adds `/stop`, which aborts the running turn — the same abort as Escape. It works while the agent is streaming, because pi dispatches commands before it queues steering input. |
| [`pi-timestamps.ts`](pi-timestamps.ts) | Extension that appends a date and time stamp to each sent prompt and to the final answer of a turn, so the model can see when it last spoke and when you last wrote. Each stamp carries the gap since the previous one (`+1m30s`), and the counter resets at each session start. The stamp lives in the session and the model context but is hidden from the rendered transcript. Messages that stopped to call a tool are skipped. |
| [`browser-tools/`](browser-tools/) | CDP browser-automation skill. **Read [`browser-tools/NOTICE.md`](browser-tools/NOTICE.md)** for attribution and licensing before using or redistributing. |
| [`web-tools/`](web-tools/) | Free, keyless web search through Exa's hosted MCP server, plus `web-read`, a local POSIX `sh` reader that turns a URL into LLM-friendly markdown. No API key. See its [README](web-tools/README.md). |
| [`Extras/`](Extras/) | `bwrap` sandbox wrapper for the `pi` CLI. See its [README](Extras/README.md). |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to contribute — commit message style, etc. |
| [`LICENSE`](LICENSE) | ISC — this repository's own files. |

Subproject setup, usage, patches, and licensing live in each subdirectory —
see [`browser-tools/README.md`](browser-tools/README.md),
[`web-tools/README.md`](web-tools/README.md), and
[`pi-notify/README.md`](pi-notify/README.md).

## AI usage

This project is written with AI assistance. The extensions, the skills, and
the `bwrap` wrapper, along with this README and the other documentation, were
written and revised with an AI coding agent.

## Contributing

This project uses **scoped commits** (`<scope>: <description>`), not
Conventional Commits. See [CONTRIBUTING.md](CONTRIBUTING.md) for the format and
examples.

## License

- Repository files outside `browser-tools/`: ISC — see [`LICENSE`](LICENSE).
  This includes everything in `web-tools/` and `pi-notify/`.
- `browser-tools/`: MIT, overriding the root ISC for that directory. See
  [`browser-tools/LICENSE`](browser-tools/LICENSE) and
  [`browser-tools/NOTICE.md`](browser-tools/NOTICE.md).
- The package as a whole (`package.json`) is `(ISC AND MIT)`.
