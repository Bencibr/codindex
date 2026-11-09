# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via either:

- GitHub Security Advisories: <https://github.com/Bencibr/codeindex/security/advisories/new>
- Email: **line@oksu.club**

Include what you can:

- Affected version (`codindex --version`)
- A description of the issue and its impact
- Reproduction steps or a minimal proof of concept
- Any suggested fix

You can expect an acknowledgement within a few days. Once a fix is available
the advisory will be published and you'll be credited unless you prefer not to be.

## Scope

Codindex is a **local-first** tool. It reads source files from paths you register
and writes a SQLite database. It makes no outbound network requests, calls no
model APIs, and collects no telemetry.

Issues worth reporting:

- **Path traversal / arbitrary file read** — `get_file_content` and the scanners
  should stay inside the registered project root.
- **Command injection** — file discovery shells out to `git`; it uses
  `spawnSync` with an argument array rather than a shell string, and that
  property must hold.
- **SQL injection** — user-supplied search terms go through parameterized
  queries and `escapeLike()` for `LIKE` patterns.
- **Denial of service on the local API** — the Hono server binds localhost and
  restricts CORS to localhost origins; bypasses matter.
- **Data exposure through the MCP surface** — a tool returning content from
  outside the registered project.

## Out of scope

- Anything that requires an attacker to already have local code execution or
  read access to the index database.
- The index being stale or incomplete (that's a correctness bug, not a
  vulnerability — use the normal issue tracker).
- Reports generated purely by a scanner without a plausible exploit path.

## Hardening already in place

Recorded here so reports can be judged against intent:

| Area | Measure |
|---|---|
| File discovery | `spawnSync` with argv array — no shell string interpolation |
| `LIKE` queries | `escapeLike()` applied to every user-supplied pattern |
| CORS | Restricted to localhost origins |
| Error messages | Generalized so internal paths aren't leaked to clients |
| SQLite access | Parameterized queries via Drizzle ORM |
| Network | None. No API calls, no upload, no telemetry |

## Supported versions

Codindex is published to npm as `codindex`. Pre-1.0, so the interface is still
moving — fixes land on `main` and in the latest published minor version.
Older versions are not maintained.
