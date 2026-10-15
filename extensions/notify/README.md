# notify

Alerts when pi stops and needs attention: a local notification — a desktop
banner, or an Android one through
[`termux-notification`](https://wiki.termux.com/wiki/Termux-notification) when
pi runs inside [Termux](https://termux.dev) — and optionally a push to a phone
over [ntfy](https://ntfy.sh).

| Event | When |
|-------|------|
| `agent_settled` | pi finished the turn and is waiting for a reply |
| `ui_prompt_start` | pi is blocked on a confirm / select / input / editor dialog |

An abort does not suppress the alert. Escape and Ctrl+C stop the turn, and
`notify` treats the settle that follows like any other.

## Install

Ships with the package (declared in `package.json` under `pi.extensions`), so
`pi install git:github.com/kafo-dev/Pi-Tweaks` is enough. Run `/reload` after
updating.

## Configure

`backend` defaults to `termcodes`, and `topic` and `token` to `""`: terminal
notifications work straight away, and no phone is pushed to until a topic is
set. When pi runs inside Termux, set `backend` to `termux` instead. Settings
live in the `notify` section of `pi-tweaks.json` in pi's agent directory
(`$PI_CODING_AGENT_DIR/pi-tweaks.json`, or `~/.pi/agent/pi-tweaks.json`).
`/pi-tweaks notify` creates and updates that section; the other sections and
the `enabled` switch are preserved.

```json
{
  "notify": {
    "enabled": true,
    "backend": "termcodes",
    "topic": "pi-a1b2c3",
    "server": "https://ntfy.sh",
    "token": "tk_a1b2c3d4"
  }
}
```

Set `"enabled": false` to turn the extension off.

| Key | Values | Meaning |
|-----|--------|---------|
| `backend` | `off`, `termcodes`, `notify-send`, `termux` | `termcodes` writes OSC 777, understood by Ghostty, iTerm2 and WezTerm. `notify-send` is a freedesktop notification and needs a desktop session. `termux` runs `termux-notification`, the local choice for pi running inside Termux. |
| `topic` | an ntfy topic, or `""` | Empty for no push. The body POSTs to `<server>/<topic>`; subscribe to that topic in the ntfy app. |
| `server` | an http(s) URL | Base URL of the ntfy server. Default `https://ntfy.sh`; point it at a self-hosted instance. |
| `token` | an ntfy access token, or `""` | Sent as `Authorization: Bearer …`. Empty for a server that allows anonymous publishing. Reports mask the value. |

The push is a plain HTTP POST, so it needs no client on the desktop and no
account. Pick a topic that is hard to guess, because anyone who knows it can
publish to it on the public server. A self-hosted server with authentication
enabled rejects an anonymous publish with `40301 forbidden`, which is where
`token` comes in: `ntfy token add` mints one, and the extension sends it with
every alert. The push title names the host and the chat, so a topic shared by
several machines identifies which one needs attention: the chat is the session
name, or the session file when the session has no name.

## Commands

The extension registers no command of its own; the package's `/pi-tweaks`
command answers it. Each call reads the section and writes it back.

```
/pi-tweaks notify                     show settings and the file path
/pi-tweaks notify backend <value>
/pi-tweaks notify topic <topic|off>
/pi-tweaks notify server <url>
/pi-tweaks notify token <value|off>
/pi-tweaks notify test                fire a dialog, so the whole path is heard
```

## Requirements

- `notify-send` (package `libnotify`) for the `notify-send` backend.
- `termux-notification` (package `termux-api`) and the Termux:API app for the
  `termux` backend.
- An ntfy topic for the push. No local client is needed; the extension POSTs
  the message itself.
- An ntfy access token when that server requires authentication. Mint one with
  `ntfy token add` on the server host.

Missing tools are not an error: the call simply fails silently, so pi is never
blocked by a broken notifier. Headless runs (`-p`, `--mode json`, subagents)
never notify — `ctx.hasUI` is false there, so a script cannot push to a phone.
