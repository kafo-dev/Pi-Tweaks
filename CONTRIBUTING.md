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

## Dependencies

`package.json` overrides `encoding-sniffer` to v1. Cheerio still asks for
v0.2, whose `whatwg-encoding` dependency is deprecated and makes `npm install`
print a warning; v1 drops it for `@exodus/bytes` and keeps the API cheerio
uses. The override can go once cheerio depends on v1 itself.

## Tooling

Formatting and linting use the OpenJS-standard tools: [Prettier][prettier]
for formatting and [ESLint][eslint] with [typescript-eslint][tseslint] for
linting. `npm run check` runs the whole gate — `prettier --check`, `eslint`,
and `tsc --noEmit`; `npm run format` and `npm run lint:fix` rewrite files.

TypeScript needs a note. The compiler behind `tsc` is TypeScript 7, which
ships no programmatic compiler API, while typescript-eslint still parses with
the TypeScript 6 API. `package.json` therefore aliases two packages:
`typescript` to `@typescript/typescript6` (the API typescript-eslint imports)
and `@typescript/native` to `typescript@7` (the `tsc` binary). This is the
side-by-side setup the
[TypeScript 7 release notes](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6-0)
recommend. Keep both aliases: remove the TS 6 one and linting breaks; remove
the TS 7 one and `tsc` breaks.

[prettier]: https://prettier.io
[eslint]: https://eslint.org
[tseslint]: https://typescript-eslint.io

## Layout

- `skills/browser-tools/` is its own subproject. Keep its details (setup, usage,
  patches, licensing) in its own Markdown files, not in the root README.
- `skills/web-tools/` is its own subproject. Keep its details (usage, free-tier
  limits, licensing) in its own Markdown files, not in the root README.
- `extras/` is its own subproject. Keep wrapper behavior and limitations in
  `extras/README.md`.
- `extensions/experiments/` holds experimental extensions. They are listed in
  `pi.extensions` but default off in `pi-tweaks.json`. Keep each experiment's
  hypothesis and usage in `extensions/experiments/README.md`.
