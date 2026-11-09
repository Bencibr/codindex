# Contributing to Codindex

Thanks for taking a look. This document covers the practical parts: how to build,
how to run the tests, and what a mergeable change looks like.

## Requirements

- **Node.js ≥ 22.5** — Codindex uses the built-in `node:sqlite`, so older Node
  will fail at import time rather than at runtime with a clear message.
- npm (bundled with Node).

## Setup

```bash
git clone https://github.com/Bencibr/codeindex.git codindex
cd codindex
npm install
```

Run `npm install` **from the repo root**. The repo ships an `.npmrc` with
`legacy-peer-deps=true` because the tree-sitter grammar packages declare
mutually exclusive peer ranges (java `^0.21.1`, python/rust `^0.22.1`); outside
the repo root npm won't pick that file up and you'll get `ERESOLVE`.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Run from source with `tsx`, restarts on change |
| `npm test` | Full test suite (Vitest, 14 files / 325 tests) |
| `npx tsc --noEmit` | Typecheck only — CI fails on any error |
| `npm run build` | Emit `dist/` plus copy `src/web` assets |
| `npx tsx scripts/self-scan.ts` | End-to-end smoke test via the public API |

Tests use a temporary database injected by `vitest.config.ts`
(`CODINDEX_DB` → `<tmpdir>/codindex-test-<pid>-<rand>.db`), so `npm test` never
touches your real `data/codindex.db`.

## Before opening a pull request

1. `npx tsc --noEmit` passes.
2. `npm test` passes.
3. `npm run build` succeeds.
4. If you added or renamed an MCP tool, update **all** of:
   `src/mcp/server.ts` (`TOOL_DEFS`), [docs/TOOLS.md](docs/TOOLS.md),
   the tool table in [README.md](README.md), and
   [AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md).
   The tool count (currently 32, grouped 6/5/3/8/5/5) appears in several places
   and has drifted before — grep for it.
5. Note user-visible changes under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).

CI runs typecheck → tests → build → a boot probe of `dist/`, then a self-scan
job that exercises the public API. A green CI is required.

## Code style

- TypeScript, ESM, `.js` extensions on relative imports (required by ESM +
  `moduleResolution: node16`).
- Prefer explicit types at module boundaries; `catch (err: unknown)` rather than
  `catch (e)`.
- Comments explain *why*, not *what*. Several existing comments record a bug
  that was fixed and the symptom it produced — match that level of context when
  the code is non-obvious.
- Tests live next to the code in `src/tests/`. Add a regression test for any
  bug fix.

## Adding a language

New languages touch three places:

1. `src/scan/scanner-*.ts` — the tree-sitter grammar and node-type mapping.
2. `src/scan/languages.ts` (or equivalent language registry) — extension mapping.
3. Docs: the language table in both `README.md` and `README.en.md`.

The grammar package goes in `dependencies`, not `devDependencies` — users need it
at runtime.

## Reporting bugs

Open an issue with:

- Codindex version (`codindex --version`).
- Node version (`node -v`).
- The command you ran and the full error output.
- If it's a scan problem: the language and roughly what the file looks like
  (a minimal repro is ideal — don't paste proprietary source).

For security issues, **do not** open a public issue — see [SECURITY.md](SECURITY.md).

## License

By contributing you agree your contributions are licensed under the MIT License
(see [LICENSE](LICENSE)).
