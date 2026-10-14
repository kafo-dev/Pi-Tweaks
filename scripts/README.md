# Pre-commit hook

Runs the repository's formatter (Prettier) and linter (ESLint), the TypeScript
type checker, and a leftover-debug-print check in verification mode. It never
rewrites files: fix what it reports, then commit again.

The hook runs, in order:

    prettier --check .
    eslint .
    tsc --noEmit -p tsconfig.json
    git grep -nI '!D: ' -- . ':(exclude)scripts'

The debug-print grep skips `scripts/` so that this hook and this file, which
both contain the literal marker, do not match themselves.

`prettier`, `eslint`, and `tsc` come from `node_modules/`; run `npm install`
after a fresh clone. The same checks run through `npm run check`. No test suite
is configured, so the hook does not run tests.

## Install

    git config core.hooksPath scripts

## Uninstall

    git config --unset core.hooksPath
