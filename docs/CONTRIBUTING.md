# Contributing to Codindex

Thanks for taking a look. This document covers the practical parts: how to build,
how to run the tests, and what a mergeable change looks like.

## Requirements

- **Node.js ≥ 22.5** — Codindex uses the built-in `node:sqlite`, so older Node
  will fail at import time rather than at runtime with a clear message.
- npm (bundled with Node).

## Setup

```bash
git clone https://github.com/Bencibr/codindex.git codindex
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
   `src/mcp/server.ts` (`TOOL_DEFS`), [docs/TOOLS.md](TOOLS.md),
   the tool table in [README.md](../README.md), and
   [AGENTS.md](../AGENTS.md) / [CLAUDE.md](../CLAUDE.md).
   The tool count (currently 32, grouped 6/5/3/8/5/5) appears in several places
   and has drifted before — grep for it.
5. Note user-visible changes under `## [Unreleased]` in [CHANGELOG.md](../CHANGELOG.md).

CI runs typecheck → tests → build → a boot probe of `dist/`, then a self-scan
job that exercises the public API. A green CI is required.

## Releasing

Version lives in three places that must agree — `package.json`, `package-lock.json`,
and the banner SVG (`assets/codindex-hero-{dark,light}.svg`, the `v… · MIT` string).
The first two are handled by `npm version <x.y.z> --no-git-tag-version`; the SVG is
manual and easy to forget. `codindex --version` reads `package.json` at runtime, so
it is never a fourth source.

```bash
npm version 0.1.3 --no-git-tag-version   # still updates package-lock.json
# edit assets/*.svg  →  v0.1.3 · MIT
npx tsc --noEmit && npm test && npm run build
npm view codindex@0.1.3 version          # must exit non-zero — npm never allows republishing
git commit -am "chore(release): 0.1.3" && git push
git tag -a v0.1.3 -m "codindex v0.1.3" && git push origin v0.1.3
gh release create v0.1.3 --verify-tag --title "v0.1.3 — …" --notes-file -
npm stage publish                        # see below
```

Tag the commit that **matches what you are publishing**, not whatever `HEAD` happens to
be later. `v0.1.0` deliberately points at `6e89e79` (the tree npm has) rather than the
newest commit at the time.

Always use an **annotated** tag (`git tag -a`): it records tagger and date, and
`gh release create` attaches to it. `v0.1.1` and `v0.1.2` were created as lightweight
tags, which is why `git cat-file -t` reports `commit` for them and `tag` for `v0.1.0`.
`--verify-tag` makes the release step fail loudly if the tag is missing from the remote,
instead of silently creating one from the local default branch.

### npm's field limits

These are enforced by the registry, silently in some cases. Check before publishing:

| Field | Limit | What happens if you exceed it |
|---|---|---|
| `description` | **255 chars** | Truncated mid-sentence in the registry metadata — and that truncated string is what npm shows in search results and on the package page. Not reported as an error. |
| `keywords` | no hard cap in practice; keep it under ~40 | Each keyword is a search facet; padding with high-volume but irrelevant terms (`rag`, `vibe-coding` for this project) attracts the wrong traffic without converting. |
| `name` | 214 chars, but keep it short | — |
| `version` | — | Must be strictly greater than the published `latest`. The registry never allows republishing a version. |

`description` is the one that bit us: 0.1.1 shipped 334 characters and the registry
stored `… for AI coding agents (Claude Code, Cursor,` — cut exactly where it mattered.
**Budget 250, not 255**, so you have room to rephrase.

`npm publish --dry-run` does **not** catch this; it prints your local string unchanged.
Verify after publishing — use `--json` and count the parsed string, not `wc -c`
(the latter counts npm's surrounding quotes and trailing newline, reporting 217 for a
214-character field):

```bash
npm view codindex@<version> description --json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))'
node -p "require('./package.json').description.length"   # compare before publishing
```

### Publishing takes two steps

This account's npm token is staging-only. `npm publish` fails with `E403 E_STAGE_REQUIRED`;
the flow is:

```bash
npm stage publish                          # uploads, returns a stage id
npm stage view <stage-id>                  # wait until status: staged
npm stage approve <stage-id>               # opens a browser 2FA prompt
```

`npm stage approve` prints a `https://www.npmjs.com/auth/cli/<uuid>` URL that must be
opened and confirmed in a browser. In a non-interactive shell npm masks the URL as
`***` and the command blocks on `Press ENTER` — run it under a pty (`script -q`) or with
`expect` if you need to scrape the link.

A classic token with *bypass 2FA* would make `npm publish` work directly and skip all of
this; until then, budget one manual browser confirmation per release. Batch metadata-only
changes rather than shipping 0.1.1 → 0.1.2 for a single string fix.

### Verify what actually shipped

Local checks validate the working tree, not the published package:

```bash
npm view codindex@<version> version description keywords   # registry metadata
npm pack codindex@<version> && tar -tzf codindex-*.tgz    # file list in the tarball
npm i -g --prefix /tmp/chk codindex@<version> && /tmp/chk/bin/codindex --version
```

The tarball only contains what `package.json`'s `files` allows plus the always-included
`package.json` / `README.md` / `LICENSE`. Anything else — `docs/`, `AGENTS.md`, the
`.github/` folder — is absent, so **README links pointing at them must be absolute
GitHub URLs**; npm does not rewrite relative paths and will render them as 404s.

Check this mechanically before every release — anything that resolves locally but is
outside `files` will break on the registry:

```bash
python3 - <<'EOF'
import re
for f in ['README.md', 'README.en.md']:
    s = open(f, encoding='utf-8').read()
    bad = re.findall(r'(?:href|src|srcset)="(?!https?:|#)([^"]+)"', s) \
        + re.findall(r'\]\((?!https?:|#|mailto:)([^)]+)\)', s)
    print(f, '→ 相对链接:', bad or '无')
EOF
```

Keywords are a search surface, so keep them honest: every keyword should appear
in at least one README. Verify with:

```bash
python3 - <<'EOF'
import json
k = json.load(open('package.json'))['keywords']
norm = lambda x: x.lower().replace('-', ' ').replace('_', ' ')
for f in ['README.md', 'README.en.md']:
    s = norm(open(f, encoding='utf-8').read())
    print(f, '→ 未覆盖:', [x for x in k if norm(x) not in s] or '无')
EOF
```

## Numbers that appear in several places

A few counts are duplicated across files with no single source of truth. Grep for them
whenever the underlying number changes:

| Number | Where it is hardcoded |
|---|---|
| `32` (tools) | `src/mcp/server.ts` `TOOL_DEFS` (the real source), `README.md` ×2, `README.en.md` ×2, `docs/TOOLS.md`, `AGENTS.md`, `CLAUDE.md`, `package.json` `description`, both banner SVGs |
| `6` (languages) | `README.md`, both banner SVGs, `package.json` `description` |
| tool grouping `6/5/3/8/5/5` | `README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/TOOLS.md` |
| version `0.1.x` | `package.json`, `package-lock.json`, both banner SVGs |

The banner SVG pills are the easiest to miss — they are not rendered from any variable,
so a stale number there stays visually wrong long after the text is fixed.

```bash
grep -rn "\b32\b" README.md README.en.md docs/ AGENTS.md CLAUDE.md package.json assets/*.svg
```

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
(see [LICENSE](../LICENSE)).
