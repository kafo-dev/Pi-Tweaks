# Extras

## `pi`

A POSIX `sh` wrapper around Pi that runs the agent inside a
[`bwrap`](https://github.com/containers/bubblewrap) sandbox.

Pi has no built-in sandbox: built-in tools, extensions, and package installs
run with the permissions of the user account. This wrapper binds the whole
filesystem read-only and re-binds only the project directory, an agent
scratchpad, and a few state directories read-write, so a session cannot write
anywhere else under `$HOME`. It writes nothing to stderr on the sandboxed path,
except when it starts from `$HOME` (see below) or a session lock fails
(see [Session locks](#session-locks)); every session it starts carries
the system-prompt note described under
[Sandbox notice](#sandbox-notice).

### Install

Link the script into your `PATH` so it shadows the `pi` command:

```sh
ln -s "$PWD/extras/pi" "$HOME/.local/bin/pi"
```

The wrapper finds the real `pi` on `PATH`, skipping itself so that
shadowing the command name does not cause recursion. The first executable
named `pi` that is not the wrapper is used; `/usr/bin/pi` is the fallback
when `PATH` has none. Set `PI_REAL_PI` to point at a specific binary
instead:

```sh
PI_REAL_PI="$HOME/.nvm/versions/node/$(node -v)/bin/pi" pi
```

An npm prefix or version-manager install usually lands outside `/usr/bin`,
so the `PATH` search is what makes the wrapper work on those systems. The
resolved binary is read through the sandbox's read-only root, so it does not
need to be a system package.

### Session locks

Pi keeps no lock on the session it has open: it opens the JSONL file only to
append, so a second process cannot see that the session is in use. The wrapper
writes a lock file per run instead, before pi starts, under
`<cacheDir>/pi-tweaks/session-locks/`. A lock records the process id, the
working directory, the start time, and the session file when `--session` names
one.

`extensions/experiments/prune-sessions.ts` reads the locks, so it does not move
a session that a live process still holds. "Held" means a live pi process
recorded a lock for that session, or was started after the session file was
last written.

`extras/pi-session-pick.mjs` writes the lock. Locks of processes that have
exited are removed the next time the locks are read, so they do not accumulate.
Node must be on `PATH`; without it the wrapper starts no lock. A `node` that is
present but cannot run, and a picker that exits non-zero, are reported on
stderr. A management subcommand (`install`, `remove`, `uninstall`, `update`,
`list`, `config`, `auth`) starts no session and is not locked.

### What is writable

| Path | Why |
|------|-----|
| `$PWD` | the project |
| `$PI_CODING_AGENT_DIR` (default `~/.pi/agent`) | settings, sessions, trust, packages, auth |
| scratchpad, beside the agent directory (default `~/.pi/scratchpad`) | agent scratch files; the fallback when started from `$HOME` |
| `$XDG_CACHE_HOME` (default `~/.cache`) | tool caches, browser profiles |
| `$XDG_DATA_HOME/Trash` (default `~/.local/share/Trash`) | the XDG trash; the prune-sessions experiment moves an old session file here instead of deleting it |
| `~/.agents` | global skills (`~/.agents/skills`) |

Everything else is read-only. Language and package-manager directories are
deliberately not bound: add the ones a session needs to the `rw-paths.txt` file
(see below).

The agent directory is shared read-write with the host, so auth, sessions, and
installed packages carry over between sandboxed and unsandboxed runs. That also
means provider credentials are visible inside the sandbox; treat untrusted
projects accordingly.

Starting from `$HOME` or an ancestor of it would expose all of `$HOME` if the
project directory were bound read-write. Instead the project directory stays
read-only for that run, and the appended note names the scratchpad, not the
project directory, as the place for new files. Management subcommands
(`install`, `remove`, `update`, `list`, `config`, `auth`) start no agent session
and are passed through unchanged: pi recognizes them only as the first argument,
so no note can be inserted before one.

### Sandbox notice

The sandbox is invisible from inside, so a blocked write reads as a broken
environment: the agent either gives up or tries to work around the mount. To
prevent that, the wrapper appends a note to the system prompt of every session
it starts. The note names the sandbox rather than the mounts, which the user
can change between runs, and states what to do on a permission or
read-only-filesystem error — report it and ask the user to lift the restriction
on that path, either by listing it in `rw-paths.txt` or by restarting with
`BWRAP=0`.

A second part of the note covers scratch files. `/tmp` is a private tmpfs that
is wiped whenever the agent restarts, so the note sends the agent to the
scratchpad instead, and tells it to create a subdirectory of the scratchpad for
the session, keep its files there, and delete nothing outside that
subdirectory. The scratchpad is shared by every session, so both rules keep
concurrent agents out of each other's way.

The note travels as `--append-system-prompt` text, so the note itself needs no
file. The wrapper writes one small lock file per run under
`<cacheDir>/pi-tweaks/session-locks/`; see
[Session locks](#session-locks).
A management subcommand starts no session and gets no note.

### Scratchpad

The agent gets a scratchpad beside the agent directory, at `~/.pi/scratchpad`
with the default agent directory, and bound read-write on every run. It is the
designated place for temporary files when the project directory is read-only.
Like `rw-paths.txt`, the path follows the parent of `PI_CODING_AGENT_DIR`, so
moving the agent directory moves the scratchpad with it.

Concurrent agents share the scratchpad, and it outlives a session, so the
sandbox notice tells each one to work inside a subdirectory of its own and to
delete nothing outside it, including the scratchpad itself (see [Sandbox
notice](#sandbox-notice)).

### Extra read-write paths

List additional host paths to bind read-write, one per line, in a file next to
the agent directory. With the default agent directory that is
`~/.pi/rw-paths.txt`; overriding `PI_CODING_AGENT_DIR` moves the file to its
parent directory:

```
# comments and blank lines are ignored
~/Documents
/home/user/shared
```

`~` expands to `$HOME`. Each entry is mounted with `--bind-try`, so a path that
does not exist is skipped and the wrapper still starts. A device node, and any
path under `/dev`, is mounted with `--dev-bind-try` instead: the sandbox mounts
a fresh tmpfs over `/dev`, and `--bind` sets `nodev` on the mount, which makes
the device nodes under it deny access. An entry is taken literally: do not quote
it, even when the path contains spaces. Non-absolute entries are ignored with a
warning. The wrapper reads the file on the host before entering the sandbox,
and mounts the file itself read-only, after every configured bind. The agent can
read the list it is told to ask the user to extend, and neither the file nor
`wrapper-config.txt` becomes writable when a listed directory holds it. Every
listed path becomes writable by the agent, so list only paths the agent may
modify; listing `/` or `$HOME` defeats the sandbox. A single file works as well
as a directory, for example a notes file the agent maintains.

### Hidden home

The wrapper mounts the whole filesystem read-only, so by default the agent can
read every file under `$HOME`, even though it can write only a few. A
`hide-home` line in `wrapper-config.txt` takes the rest of the home directory
out of view: the sandbox mounts an empty read-only tmpfs over `$HOME`, then
binds back the paths the wrapper itself uses.

```text
# hide the home directory, except for the mounted paths
hide-home
```

Under `$HOME` the agent then sees only:

- the agent directory, the cache directory, the skills tree (`.agents`), the
  scratchpad, and the XDG trash, which the wrapper mounts on every run;
- `rw-paths.txt` and `wrapper-config.txt`, read-only;
- every path listed in `rw-paths.txt`;
- the working directory, when the wrapper mounts it read-write.

Everything else is gone rather than read-only. A directory that is not listed
does not appear at all, and the parent directories of a listed path appear as
empty directories holding only that path. Writing into the hidden part fails
with a read-only filesystem error, so the write cannot land in the tmpfs and
disappear when the session ends.

Tools that keep their state under `$HOME` lose it too. `~/.ssh`, `~/.gitconfig`,
`~/.config/git`, and `~/.gnupg` are not mounted, so a `git` command that needs
one of them fails until the path is listed in `rw-paths.txt`.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `BWRAP` | Set to `0` to skip the sandbox. The wrapper then warns and runs `pi` unsandboxed with the same arguments. |
| `PI_CODING_AGENT_DIR` | Override the agent directory that is bound read-write. Default `~/.pi/agent`. The scratchpad, `rw-paths.txt`, and `wrapper-config.txt` move to its parent. |
| `XDG_CACHE_HOME` | Override the cache directory that is bound read-write. Default `~/.cache`. Pi-Tweaks keeps its runtime state in `<cacheDir>/pi-tweaks`: the session locks and the time of the last automatic prune round. |
| `XDG_DATA_HOME` | Override the data directory whose `Trash` is bound read-write. Default `~/.local/share`. |

### Notes and limitations

- **X11:** `--tmpfs /tmp` hides `/tmp/.X11-unix`, so an X11 display is
  unavailable inside the sandbox. Wayland (via read-only `/run/user/$UID`)
  works. Add a `--bind /tmp/.X11-unix /tmp/.X11-unix` line after `--tmpfs /tmp`
  if you need X11.
- **Network:** `--share-net` keeps full network access for provider APIs and
  browser tools.
