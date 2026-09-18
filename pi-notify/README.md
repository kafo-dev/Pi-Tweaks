# pi-notify

Alerts you when pi stops and needs you: a desktop notification, and optionally
an alarm on your phone over KDE Connect.

| Event | When |
|-------|------|
| `agent_settled` | pi finished the turn and is waiting for your reply |
| `ui_prompt_start` | pi is blocked on a confirm / select / input / editor dialog |

A turn stopped with `/stop` does not notify: the user just stopped it. `/stop`
tells pi-notify over pi's shared event bus, so no desktop or phone alert fires
for that settle. A normal settle still alerts.

## Install

Ships with the package (declared in `package.json` under `pi.extensions`), so
`pi install git:github.com/kafo-dev/Pi-Tweaks` is enough. Run `/reload` after
updating.

## Configure

`backend` defaults to `termcodes` and `phone` to `off`: you get terminal
notifications straight away, and no phone is rung until you set one. Settings
live in the `pi-notify` section of `pi-tweaks.json` in pi's agent directory
(`$PI_CODING_AGENT_DIR/pi-tweaks.json`, or `~/.pi/agent/pi-tweaks.json`).
`/notify` creates and updates that section; the other sections and the
`enabled` switch are preserved.

```json
{
  "pi-notify": {
    "enabled": true,
    "backend": "termcodes",
    "phone": "ring",
    "device": ""
  }
}
```

Set `"enabled": false` to turn the extension off. The old `pi-notify.json` is
still read until the section exists; the first `/notify` write migrates the
settings into `pi-tweaks.json`.

| Key | Values | Meaning |
|-----|--------|---------|
| `backend` | `off`, `termcodes`, `notify-send` | `termcodes` writes OSC 777, understood by Ghostty, iTerm2 and WezTerm. `notify-send` is a freedesktop notification and needs a desktop session. |
| `phone` | `off`, `ping`, `ring` | `ping` sends a `--ping-msg` with the reason; `ring` is the loud Find My Phone alarm and drops the message. |
| `device` | a KDE Connect device id, or `""` | Empty auto-detects the first available device via `kdeconnect-cli -a --id-only`. |

## Commands

```
/notify                      show settings and the file path
/notify backend <value>
/notify phone <value>
/notify device <id|auto>
/notify-test                 fire a dialog, so you can hear the whole path
```

## Requirements

- `notify-send` (package `libnotify`) for the `notify-send` backend.
- `kdeconnect-cli` for the phone. `ring` needs the **Find My Phone** plugin
  enabled on both phone and desktop; `ping` needs **Ping**.

Missing tools are not an error: the call simply fails silently, so pi is never
blocked by a broken notifier. Headless runs (`-p`, `--mode json`, subagents)
never notify — `ctx.hasUI` is false there, so a script cannot ring your phone.
