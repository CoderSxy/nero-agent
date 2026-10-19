# Chart Output and Rendering Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline for the approved scope.

**Goal:** Prefer inline charts, safely accept common option formatting variations, and recover from rendering errors.

**Architecture:** Keep Markdown fences as the protocol. Separate typed data parsing from a source-keyed canvas lifecycle; do not execute model code. Use existing Mastra instructions and the installed ECharts 6.1.0.

**Tech Stack:** TypeScript, React, ECharts 6.1.0, JSON5 2.2.3, Vitest, node:test.

**Spec:** ../specs/2026-10-17-chart-output-and-rendering-design.md

## Global Constraints

- No ECharts upgrade, arbitrary JavaScript execution or new chart tools.
- Preserve current frontend mobile work and temporal A–C changes; stay in current checkout.
- Retain raw chart source; only render complete fences; keep Mermaid strict security.
- Use project npm scripts. Build backend in a temporary copy if the dev server is running.
- No commits requested. Live production model calls are not part of automated tests.

## Review Focus

- A malformed option must never invoke callbacks or evaluate expressions.
- Comment/quote/escape-aware newline normalization must preserve data rather than fill missing structures.
- Code changes must discard old errors and prevent late asynchronous updates.
- Hidden containers must wait for measurable size and not lose manual source view on resize.
- Mocked-provider prompt checks are not evidence of real-model compliance.

## Task 1: Safe parsing and recognition

Files: web/src/agent/markdown/echarts-option.ts; new echarts-option.test.ts; web/package.json and lockfile.
Interfaces: parseEChartsResult(code) returns {ok:true,option,format} or {ok:false,kind,message}; retain parseEChartsOption(code) nullable wrapper and isEChartsCode(code) boolean for existing callers.

- [x] Write and observe failing tests for JSON5, parentheses, raw string newlines, unsafe keys, nonfinite numbers, unsupported code, length limits and single-object series.
- [x] Implement strict JSON first, safe normalization and JSON5 fallback with value checks. Declare direct json5 dependency.
- [x] Run parser tests, including real ECharts SVG SSR smoke tests.

## Task 2: Canvas recovery and diagnostics

Files: web/src/agent/markdown/EChartsBlock.tsx; new EChartsBlock.test.tsx; existing chart-load-error.test.tsx; MessageList.test.tsx.
Interfaces: source-keyed child owns view/error/lifecycle; consumes Task 1 result. Error categories are syntax, structure, limit, load and render; preserve code and copying in all failure modes.

- [x] Reproduce stuck failure and zero-size initialization with failing tests.
- [x] Implement reset-by-source child, deferred init, ResizeObserver/window resize, disposal and asynchronous cancellation. Separate error copy from raw source.
- [x] Verify manual source selection, corrected options, resizing, module failure, stale async callbacks and Markdown fence behavior; run Mermaid regressions.

## Task 3: Agent output protocol

Files: new src/mastra/agents/chart-instructions.ts; src/mastra/agents/agent.ts; new tests/chart-instructions.test.ts.
Interfaces: chartInstructions string combined with existing Agent instructions.

- [x] Add provider-payload integration test checking application Agent passes chart protocol into a real Mastra request with mocked HTTP model.
- [x] Centralize inline ECharts/Mermaid defaults, explicit HTML/file exceptions, strict JSON and honest data rules. Trend example uses line.
- [x] Verify the integrated prompt and existing temporal tests.

## Task 4: End-to-end verification and evidence

Files: docs/chart-rendering-verification.md; regression additions to MessageList.test.tsx as needed.

- [x] Run targeted web tests, full web suite and web typecheck/build.
- [x] Run npm test and backend tsc; compare pre-existing failures against previous baseline.
- [x] Run backend build via npm scripts in an isolated temporary source copy if necessary.
- [x] Independently review this task's code, fix actionable defects and rerun affected tests.
- [x] Record live-model/manual-browser evaluation status without claiming unrun checks.

## Execution record

- User approved design. No extra authorization needed for implementation.
- Pre-flight: Task 2 consumes Task 1 result; Task 3 is independent; Task 4 verifies all three.
- Source baseline has existing TypeScript errors and disk-protection-related test failures documented in docs/temporal-accuracy-verification.md. Existing mobile edits are outside this task.

- Task 1 complete: parsing RED→GREEN; real ECharts SSR line/bar checks pass; existing JSON5 2.2.3 promoted to direct dependency using existing lock metadata because offline registry metadata was unavailable.
- Task 2 complete: stuck error/zero-size regression RED→GREEN; async cancellation, source persistence, isolated chart failures, cleanup and Mermaid tests pass.
- Task 3 complete: application instructions verified at actual Mastra HTTP provider boundary; model compliance itself is not mocked into a passing claim.
- Ruling: share in-flight ECharts import to avoid duplicate chart module loads and reset the promise after load failure. No additional dependency or module subsystem.
- Ruling: browser QA revealed low-contrast default chart labels on the app's dark background. Match existing light/default-dark app convention, keep explicit chart backgrounds, and preserve source selection across theme changes. Dark-theme regression RED→GREEN.
- Task 4 complete for code verification: 343/343 web tests pass; frontend build passes; backend build passes in a temporary copy; 48 backend failures and 7 tsc errors match existing baseline. Independent reviewer verified 59 focused tests and no actionable findings.
- Browser QA: actual ECharts and Mermaid, error→corrected recovery, source persistence, hidden→visible and narrow container all checked. The temporary fixture is removed afterwards.
- Deferred measurement: real-model 30-run compliance evaluation was not performed; this is recorded in docs/chart-rendering-verification.md and is not claimed as passed.
