# Extras

## `pi`

A POSIX `sh` wrapper around Pi that runs the agent inside a
[`bwrap`](https://github.com/containers/bubblewrap) sandbox.

Pi has no built-in sandbox: built-in tools, extensions, and package installs
run with the permissions of the user account. This wrapper binds the whole
filesystem read-only and re-binds only the project directory, an agent
scratchpad, and a few state directories read-write, so a session cannot write
anywhere else under `$HOME`. It is silent on the sandboxed path, except when it
starts from `$HOME` (see below).

### Install

Link the script into your `PATH` so it shadows the `pi` command:

```sh
ln -s "$PWD/Extras/pi" "$HOME/.local/bin/pi"
```

The wrapper execs the real binary at `/usr/bin/pi`, so shadowing the command
name on `PATH` does not cause recursion.

### What is writable

| Path | Why |
|------|-----|
| `$PWD` | the project |
| `$PI_CODING_AGENT_DIR` (default `~/.pi/agent`) | settings, sessions, trust, packages, auth |
| `$PI_CODING_AGENT_DIR/scratchpad` (default `~/.pi/agent/scratchpad`) | agent scratch files; the fallback when started from `$HOME` |
| `$XDG_CACHE_HOME` (default `~/.cache`) | tool caches, browser profiles |
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
read-only for that run, and the agent is told through an appended
system-prompt note that files it needs to write belong in the scratchpad.
Management subcommands (`install`, `remove`, `update`, `list`, `config`,
`auth`) start no agent session and are passed through unchanged: pi recognizes
them only as the first argument, so no note can be inserted before one.

### Scratchpad

The agent gets a scratchpad inside the agent directory, at
`$PI_CODING_AGENT_DIR/scratchpad` (default `~/.pi/agent/scratchpad`). It is
bound read-write on every run and is the designated place for temporary files
when the project directory is read-only.

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
does not exist is skipped and the wrapper still starts. An entry is taken
literally: do not quote it, even when the path contains spaces. Non-absolute
entries are ignored with a warning. The wrapper reads the file on the host
before entering the sandbox, so the file itself does not need to be reachable
inside it. Every listed path becomes writable by the agent, so list only paths
the agent may modify; listing `/` or `$HOME` defeats the sandbox. A single file
works as well as a directory, for example a notes file the agent maintains.
By default the file itself is outside the writable set, so the agent cannot
widen its own mounts.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `BWRAP` | Set to `0` to skip the sandbox. The wrapper then warns and runs `pi` unsandboxed with the same arguments. |
| `PI_CODING_AGENT_DIR` | Override the agent directory that is bound read-write. Default `~/.pi/agent`. Also moves `rw-paths.txt` to its parent and the scratchpad to `$PI_CODING_AGENT_DIR/scratchpad`. |
| `XDG_CACHE_HOME` | Override the cache directory that is bound read-write. Default `~/.cache`. |

### Notes and limitations

- **X11:** `--tmpfs /tmp` hides `/tmp/.X11-unix`, so an X11 display is
  unavailable inside the sandbox. Wayland (via read-only `/run/user/$UID`)
  works. Add a `--bind /tmp/.X11-unix /tmp/.X11-unix` line after `--tmpfs /tmp`
  if you need X11.
- **Network:** `--share-net` keeps full network access for provider APIs and
  browser tools.
