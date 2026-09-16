# Extras

## `pi`

A POSIX `sh` wrapper around Pi that runs the agent inside a
[`bwrap`](https://github.com/containers/bubblewrap) sandbox.

Pi has no built-in sandbox: built-in tools, extensions, and package installs
run with the permissions of the user account. This wrapper binds the whole
filesystem read-only and re-binds only the project directory plus a few state
directories read-write, so a session cannot write anywhere else under `$HOME`.
It is silent on the sandboxed path.

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
| `$XDG_CACHE_HOME` (default `~/.cache`) | tool caches, browser profiles |
| `$npm_config_cache` (default `~/.npm`) | npm cache |
| `~/.local/share/go` | Go install tree |

Everything else is read-only. The wrapper refuses to start if `$PWD` is `$HOME`
or an ancestor of it, since binding the project read-write would expose
`$HOME`.

The agent directory is shared read-write with the host, so auth, sessions, and
installed packages carry over between sandboxed and unsandboxed runs. That also
means provider credentials are visible inside the sandbox; treat untrusted
projects accordingly.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `BWRAP` | Set to `0` to skip the sandbox. The wrapper then warns and runs `pi` unsandboxed with the same arguments. |
| `PI_CODING_AGENT_DIR` | Override the agent directory that is bound read-write. Default `~/.pi/agent`. |
| `XDG_CACHE_HOME` | Override the cache directory that is bound read-write. Default `~/.cache`. |
| `npm_config_cache` | Override the npm cache that is bound read-write. Default `~/.npm`. |

### Notes and limitations

- **X11:** `--tmpfs /tmp` hides `/tmp/.X11-unix`, so an X11 display is
  unavailable inside the sandbox. Wayland (via read-only `/run/user/$UID`)
  works. Add a `--bind /tmp/.X11-unix /tmp/.X11-unix` line after `--tmpfs /tmp`
  if you need X11.
- **Network:** `--share-net` keeps full network access for provider APIs and
  browser tools.
