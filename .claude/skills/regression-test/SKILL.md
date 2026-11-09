---
name: regression-test
description: >
  Universal automated regression testing for any project. Auto-detects language, framework,
  MCP servers, and Web UI. Self-healing loop: test → fix → regress → report.
  Triggers on: run regression test, full feature test, self-regression,
  回归测试, 全功能测试, 自回归, 跑回归测试, 测试所有功能
---

# Universal Regression Test Skill

Works on **any project** — any language, any framework, any MCP server.
Auto-discovers everything. Zero hardcoded knowledge.

## Parameters

Parse `args` as JSON. All optional except `project_path`.

| Param | Default | Description |
|-------|---------|-------------|
| `project_path` | (required) | Absolute path to test target |
| `scope` | `"full"` | `"full"` / `"mcp"` / `"web"` / `"api"` |
| `max_rounds` | `10` | Max fix-test loops |
| `report_path` | auto | Report output (default: `<project>/docs/REGRESSION-REPORT.md`) |
| `regression_rate` | `0.5` | Sampling rate for unchanged passed tests |
| `web_port` | auto | Web UI port (auto-detected) |
| `api_base` | auto | API base URL (auto-detected) |
| `environments` | `[]` | Multi-env configs: `[{name, web_port, env_vars}]` |

If `project_path` not in args, ask user once. Then proceed autonomously.

---

## Iron Rule

**NEVER STOP to ask the user.** Bug → fix → continue. Only stop when all PASS or max rounds.

---

## Phase 0: Project Detection

Auto-detect everything about the target project. **No hardcoded assumptions.**

```
1. Read project root files to detect language + framework:
   - go.mod          → Go. Extract module name, go version
   - package.json    → Node. Extract scripts.test, scripts.dev, scripts.start
   - Cargo.toml      → Rust. Extract [dependencies]
   - pyproject.toml  → Python. Extract [project.scripts], [tool.pytest]
   - setup.py        → Python (legacy)
   - pom.xml         → Java/Maven
   - build.gradle    → Java/Gradle
   - Makefile        → Check for test/build targets
   - CMakeLists.txt  → C/C++

2. Detect test command (priority order):
   - scripts.test in package.json  → `npm test`
   - go.mod exists                 → `go test ./...`
   - Cargo.toml exists             → `cargo test`
   - pyproject.toml with pytest    → `pytest`
   - Makefile with test target     → `make test`

3. Detect web server:
   - scripts.dev in package.json → extract --port or default 3000/5173
   - Check common ports: 3000, 3100, 5173, 8080, 8000 with `curl -s http://localhost:<port>`
   - First responding port = WEB_PORT
   - If none respond → no Web UI, skip web tests

4. Detect API server:
   - Check if WEB_PORT returns JSON for /api/* paths
   - If yes → API_BASE = http://localhost:<WEB_PORT>

5. Detect MCP servers:
   - Read .claude/settings.json or .claude/settings.local.json
   - Extract mcpServers entries
   - Also scan system prompt for available mcp__* tools

6. Store detected config:
   PROJECT = { path, language, framework, test_cmd, web_port, api_base, mcp_servers }
```

---

## Phase 1: MCP Tool Discovery

**Fully dynamic.** No hardcoded tool names.

```
1. Scan your available tools for mcp__<server>__* pattern
   (exclude mcp__playwright__* — those are for web tests)

2. For each MCP server found:
   - List all tool names (strip mcp__<server>__ prefix)
   - Read tool descriptions from your system prompt to understand purpose

3. Skip infrastructure tools (used only in setup):
   - add_project, create_project, register, init, setup
   - scan, scan_project, index (used once in Phase 0)

4. Classify each remaining tool:
   QUERY:    get_*, search_*, find_*, list_*, read_*, fetch_*, query_*
   MUTATION: update_*, delete_*, set_*, create_*, add_*, remove_*, write_*
   ACTION:   start_*, stop_*, restart_*, trigger_*, execute_*, run_*

5. Assign IDs: T01, T02, ...
```

---

## Phase 2: Test Args Generation

**Universal parameter inference.** Works with any MCP tool.

```
For each tool, generate minimal valid args:

Step 1 — Identify required params:
  - Read tool description/schema from system prompt
  - Required params are listed in the tool's inputSchema
  - Optional params: skip (test minimal first)

Step 2 — Fill common params:
  - project_id / projectId → use value from Phase 0 setup
  - project / repo → project name or path

Step 3 — Fill specific params by inference:

  Param contains "name" or "func" or "function":
    → Call a list/get tool first to get a valid name, use first result

  Param contains "query" or "search" or "keyword":
    → Use a generic keyword: "test", "main", "handle", "init"

  Param contains "path" or "file":
    → Use a known file from the project: README.md, go.mod, package.json

  Param contains "id":
    → Call a list tool first, use first result's id

  Param contains "type":
    → Try common values: "function", "class", "module"

  Param contains "depth" or "limit" or "max":
    → Use small value: 1 or 10

  Param contains "url":
    → Use WEB_PORT: http://localhost:<port>

Step 4 — If still unknown:
  → Call tool with only required params
  → If error mentions missing param → add it from error message
  → Retry once
```

---

## Phase 3: Web UI Page Discovery

**Auto-discover pages from the live Web UI.** No hardcoded routes.

```
If Playwright MCP not available or scope excludes "web" → skip.

1. Navigate to home page:
   browser_navigate { url: "http://localhost:<WEB_PORT>" }
   browser_snapshot

2. Extract navigation links from snapshot:
   - Find all <a> tags, buttons with href, menu items
   - Collect unique paths: /projects, /settings, /dashboard, etc.
   - Filter: skip external URLs, skip #anchors, skip mailto:

3. For each discovered path, generate a test:
   W01: /              (home — already loaded)
   W02: /<link1>       (first nav link)
   W03: /<link2>       (second nav link)
   ...

4. For each page test:
   - browser_navigate to the path
   - browser_snapshot — verify page loads (no error state)
   - browser_take_screenshot as evidence
   - Check for console errors (browser_console_messages)
   - If 404 or crash → FAIL

5. Deep-link discovery (optional, max depth 2):
   - On each page, look for clickable elements (cards, rows, links)
   - Click the first one → snapshot → verify detail page loads
   - This discovers /projects/:id, /users/:id, etc.

6. Search/form discovery:
   - Find input[type="text"], textarea, search boxes
   - Type a test value → verify results appear or form submits
```

---

## Phase 4: Execute Tests

```
For each test in TESTS where status in ["pending", "FAIL"]:

  1. Record start_time = current timestamp (ms)

  2. Call the tool with generated args:
     - MCP tool: mcp__<server>__<tool>(args)
     - Web test: browser_navigate + browser_snapshot
     - API test: curl -s -o /dev/null -w "%{http_code}" <url>

  3. Record end_time, compute duration_ms

  4. Evaluate result:
     MCP:
       - Error/thrown → FAIL
       - Empty result on query tool → N/A (no data, tool works)
       - Valid JSON response → PASS
     Web:
       - Page loads, no console errors → PASS
       - 404/crash/console error → FAIL
     API:
       - HTTP 2xx → PASS
       - HTTP 4xx/5xx → FAIL

  5. Record: TESTS[id] = {
       status, round: ROUND, duration_ms,
       error?, response_preview (first 200 chars)?
     }

  6. If FAIL → attempt fix:
     a. Read error message
     b. Locate source code (grep, read files, use MCP search tools)
     c. Apply minimal fix
     d. Re-run test
     e. If PASS → record FIXED, continue
     f. If still FAIL → record FAIL permanently, continue
```

---

## Phase 5: Performance Tracking

Record `duration_ms` for every test call. Compare against previous round.

```
For each test with duration_ms data:

  if PREV_REPORT exists and this test was in it:
    prev_duration = previous report's duration for this test
    change_pct = (duration_ms - prev_duration) / prev_duration * 100

    if change_pct > 200 and duration_ms > 500:
      flag = "🐢 PERF REGRESSION" (>200% slower, >500ms)
    elif change_pct > 50 and duration_ms > 200:
      flag = "⚠️ SLOW" (>50% slower, >200ms)
    else:
      flag = "✅ OK"

  Store in report: { id, tool, duration_ms, prev_ms, change_pct, flag }
```

Report section:
```markdown
## Performance

| ID | Tool | Duration | Prev | Change | Flag |
|----|------|----------|------|--------|------|
| T01 | get_summary | 120ms | 80ms | +50% | ⚠️ SLOW |
| T02 | scan | 3.5s | 3.2s | +9% | ✅ OK |
```

---

## Phase 6: Incremental Testing

Read previous report to skip unchanged passed tests.

```
If REPORT_PATH exists:
  1. Read previous report
  2. Parse "Test Results" table → extract {id, status, round}
  3. For each test:
     - prev PASS + no code change affecting it → SKIP (mark as "⏭ CACHED R<N>")
     - prev PASS + code changed → MUST retest
     - prev FAIL → MUST retest
     - new test (not in prev report) → MUST test
  4. CACHED tests still count as PASS in report totals

Skip logic:
  changed_files = git diff --name-only HEAD~1..HEAD 2>/dev/null || git diff --name-only
  for each test:
    if test.type == "mcp":
      impacted = any changed_file matches mcp server's source path
    elif test.type == "web":
      impacted = any changed_file matches web source path
    else:
      impacted = any changed_file matches project src path
```

---

## Phase 7: Smart Regression

After each code fix, determine regression scope.

```
changed = git diff --name-only HEAD

Classify changes:
  CORE:    src/scan/ src/db/ src/core/ src/lib/ src/main.* src/app.*
  MCP:     src/mcp/ src/api/ src/tools/ src/server/
  WEB:     src/web/ src/pages/ src/components/ src/views/ src/static/
  CONFIG:  package.json go.mod Cargo.toml tsconfig.json .env
  DOCS:    docs/ *.md README*

Regression rules:
  CORE changed   → 100% ALL tests
  MCP changed    → 100% MCP tests + REG_RATE% Web tests
  WEB changed    → 100% Web tests + REG_RATE% MCP tests
  CONFIG changed → 100% ALL tests
  DOCS changed   → no regression needed

REG_RATE adjustment:
  if CLEAN_STREAK >= 2: REG_RATE = max(0.3, REG_RATE - 0.1)
  if regression found:  REG_RATE = min(1.0, REG_RATE + 0.2), CLEAN_STREAK = 0

Execute regression:
  if any regression FAIL → fix → re-run 100% ALL tests
  if all pass → CLEAN_STREAK++
```

---

## Phase 8: Multi-Environment Testing

If `environments` param provided, test each environment serially.

```
for each env in environments:
  1. Apply env.env_vars (export or process.env)
  2. Restart web server on env.web_port (if different)
  3. Run full test suite
  4. Store results as ENV_RESULTS[env.name]

Compare environments in report:
| Test | Dev | Staging | Diff |
|------|-----|---------|------|
| T01  | ✅  | ✅      | -    |
| T02  | ✅  | ❌      | ← regression |
| W01  | 120ms | 350ms | +192% |

Flag differences between environments as potential issues.
```

---

## Phase 9: Report

**Overwrite** `REPORT_PATH` after each round (always shows latest state).

```markdown
# Regression Test Report

**Generated**: YYYY-MM-DD HH:MM
**Project**: <project_path>
**Language**: <detected_language> / <framework>
**Scope**: <scope>
**Rounds**: <ROUND> / <MAX_ROUNDS>

## Round History

| Round | New FAIL | Fixed | Regress | Still FAIL | Rate | Duration |
|-------|----------|-------|---------|------------|------|----------|
| 1     | X        | X     | X       | [...]      | 100% | Xm Xs    |
| 2     | X        | X     | X       | [...]      | 50%  | Xm Xs    |

## Current Status

| Category | Total | PASS | FAIL | N/A | BLOCKED | CACHED |
|----------|-------|------|------|-----|---------|--------|
| MCP (<server>) | N | ... | ... | ... | ... | ... |
| Web UI         | M | ... | ... | ... | ... | ... |
| API            | K | ... | ... | ... | ... | ... |
| **Total**      |   | ... | ... | ... | ... | ... |

## Test Results

| ID | Tool / Feature | Status | Round | Duration | Notes |
|----|---------------|--------|-------|----------|-------|
| T01 | tool_name | ✅ PASS | 1 | 120ms | |
| T02 | tool_name | ❌ FAIL | 1 | 50ms | error msg |
| T03 | tool_name | ⏭ CACHED R1 | - | - | unchanged |

## Performance

| ID | Tool | Duration | Prev | Change | Flag |
|----|------|----------|------|--------|------|
| T01 | tool | 120ms | 80ms | +50% | ⚠️ SLOW |
| T02 | tool | 3.5s | 3.2s | +9% | ✅ OK |

## Bugs Found & Fixed

| Bug | Description | Root Cause | Fix | Files | Round |
|-----|-------------|------------|-----|-------|-------|

## Remaining Issues

| Priority | Bug | Description | Blocked Tests |
|----------|-----|-------------|---------------|

## Environment Comparison (if multi-env)

| Test | Env1 | Env2 | Diff |
|------|------|------|------|

## Changed Files
`git diff --name-only HEAD`

## Project Info

| Property | Value |
|----------|-------|
| Language | <lang> |
| Framework | <fw> |
| Test Command | <cmd> |
| Web Port | <port> |
| MCP Servers | <list> |
```

---

## Phase 10: Loop Control

```
ROUND = 0
CLEAN_STREAK = 0

while ROUND < MAX_ROUNDS:
    ROUND++
    round_start = now()

    # Determine test set (incremental if not first round)
    if ROUND == 1:
        run ALL tests
    else:
        run: failed + impacted + sampled_from_passed

    # Execute
    for each test to run:
        execute_test(test)  // Phase 4

    # Fix failures
    for each FAIL:
        attempt fix → retest
        if fixed: run smart regression  // Phase 7

    # Performance check  // Phase 5
    compare durations with previous round

    round_duration = now() - round_start

    # Generate report  // Phase 9
    write report with round_duration

    # Termination
    if all PASS or N/A:
        CLEAN_STREAK++
        if CLEAN_STREAK >= 2:
            DONE
    else:
        CLEAN_STREAK = 0

# Final output
"=== Regression complete: XX/YY PASS, Z bugs fixed, N rounds, T minutes ==="
```

---

## Error Handling

| Situation | Action |
|-----------|--------|
| MCP tool not available | Mark N/A, continue |
| MCP tool error | Mark FAIL, attempt fix |
| Fix fails | Mark FAIL permanently, continue to next |
| Regression found | Fix immediately → 100% full regression |
| Web UI unreachable | Mark all Web BLOCKED, continue MCP/API |
| API unreachable | Mark all API BLOCKED, continue MCP |
| Project won't scan/register | Report error, test what's available |
| Playwright not available | Skip all Web tests |
| Previous report not found | Run full test (no incremental) |
| git not initialized | Skip incremental, run all each round |
| Max rounds reached | Final report, list remaining failures |

---

## Notes

- **Truly universal**: no language/framework/server-specific knowledge baked in
- **Self-contained**: all logic in this file, no external scripts
- **Adaptive**: learns from each round (performance baselines, regression rates)
- **Evidence-based**: screenshots for web, response previews for MCP, durations for perf
- Each fix should be **minimal** — don't refactor unrelated code
- If a tool's description mentions "deprecated" or "legacy", skip it (mark N/A)
- For mutation tools (create/delete/update): test with care, prefer read-only first
  - If a mutation has side effects, try to undo/revert after testing
  - Mark mutation tests clearly in the report
