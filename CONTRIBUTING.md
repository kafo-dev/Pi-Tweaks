# Contributing

Thanks for contributing to Pi-Tweaks.

## Commit messages: scoped commits (not Conventional Commits)

This project uses **scoped commits**, as advocated by
[scopedcommits.com](https://scopedcommits.com) and
["Stop Using Conventional Commits"](https://sumnerevans.com/posts/software-engineering/stop-using-conventional-commits/).

Do **not** prefix messages with `feat`, `fix`, `chore`, `docs`, `refactor`,
`style`, `test`, etc. No `type(scope):` form.

### Format

```
<scope>: <description>

[optional body]
```

- **`<scope>`** is the *subject* of the change — the component or area touched,
  not the kind of change. Use the smallest meaningful area:
  `browser-tools`, `skill`, `readme`, `license`, `notice`, `patches`, `docs`, ...
- **`<description>`** is a short, imperative-mood summary with no trailing
  period. Capitalization is not required, but be consistent.
- Keep the subject line to ~72 characters.
- If the subject isn't self-explanatory, add a blank line and a body explaining
  **what** changed and **why**. Wrap the body at ~72 columns.
- The description should already make the type of change obvious; if it doesn't,
  say so in the body rather than adding a type prefix.

### Why

The scope is what readers care about when scanning a log, bisecting a bug, or
responding to an incident; the type is usually obvious from the description and
only encourages changelog-driven commit logs. See the links above.

### Examples

Good:

```
browser-tools: add Linux start script with a dedicated agent profile
browser-tools: fold output discipline into SKILL.md
readme: document the ISC/MIT license split
license: set copyright holder to Kafo Developers
```

Bad:

```
feat(browser-tools): add Linux start script
fix: typo
chore: update docs
refactor(skill): reword output guidance
```

## Layout

- `browser-tools/` is its own subproject. Keep its details (setup, usage,
  patches, licensing) in its own Markdown files, not in the root README.
- `web-tools/` is its own subproject. Keep its details (usage, free-tier
  limits, licensing) in its own Markdown files, not in the root README.
- `Extras/` is its own subproject. Keep wrapper behavior and limitations in
  `Extras/README.md`.
