# Pre-commit hook

Runs the repository's formatter and linter (Biome), the TypeScript type
checker, and a leftover-debug-print check in verification mode. It never
rewrites files: fix what it reports, then commit again.

The hook runs, in order:

    biome ci .
    tsc --noEmit -p tsconfig.json
    git grep -nI '!D: ' -- . ':(exclude)scripts'

The debug-print grep skips `scripts/` so that this hook and this file, which
both contain the literal marker, do not match themselves.

`biome` and `tsc` come from `node_modules/`; run `npm install` after a fresh
clone. No test suite is configured, so the hook does not run tests.

## Install

    git config core.hooksPath scripts

## Uninstall

    git config --unset core.hooksPath
