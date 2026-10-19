# Temporal Accuracy A–C Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement the approved A–C scope inline. D is deferred.

**Goal:** Give each model run a trusted current date, add reusable structured date coverage validation, and expose Tavily time filters.

**Architecture:** Inject execution-scoped time at the provider prompt boundary using a Mastra processor. Keep date coverage validation independent of natural language and of the deferred weather integration. Extend the existing search tool compatibly.

**Tech Stack:** TypeScript, Mastra 1.71.0, Zod 4, node:test.

**Spec:** ../specs/2026-10-17-temporal-accuracy-optimization-design.md

## Global Constraints

- Implement A, B, C only. Preserve the offline sandbox and existing frontend edits.
- Ordinary requests default to Asia/Shanghai; scheduled requests use their persisted task timezone.
- Do not trust client-supplied current timestamps. Do not store injected current time in conversation memory.
- Register new tools in src/mastra/index.ts (no new tool in A–C).
- Use npm test and npm run build. No commits or external writes requested.

## Review Focus

- Same RequestContext reused in later or concurrent runs must not reuse an old clock snapshot.
- Model retries and multiple tool steps must not accumulate time messages; midnight must refresh the date.
- Calendar-day coverage must survive leap days and DST and reject impossible dates.
- Date keys remain bound to their values when input rows are reordered; missing/nonfinite fields fail.
- Search time windows filter source publication/update time, not forecast validity.

## Task 1: A — execution time and policy

Files: create src/mastra/temporal/context.ts, instructions.ts, processor.ts; modify agents/agent.ts and scheduled-tasks/hooks.ts; add tests/temporal-context.test.ts, tests/temporal-processor.test.ts; extend scheduled-tasks-hooks.test.ts.

Interfaces: createTemporalContext(now: Date, timezone?: string), formatTemporalContext(context), setScheduledTimezone(requestContext, timezone), createTemporalProcessor({ now? }). Processor state owns the run snapshot; a WeakMap holds trusted scheduler timezone only.

- [x] Add failing tests for timezone date boundaries, DST offset, invalid timezone, reused context and midnight refresh, and scheduled timezone propagation.
- [x] Implement the clock helper, policy and transient provider prompt injection. Use one snapshot per run until midnight; policy requires refreshing explicit relative ranges then. Log snapshot metadata to existing tracing.
- [x] Verify with node --import tsx --test tests/temporal-context.test.ts tests/temporal-processor.test.ts tests/scheduled-tasks-hooks.test.ts.

## Task 2: B — date coverage validation

Files: create src/mastra/temporal/date-range.ts and tests/temporal-date-range.test.ts.

Interfaces: isCalendarDate(value), calendarDates(startDate, endDate), validateDateCoverage({startDate,endDate,timezone,rows,requiredNumericFields?}). Return discriminated complete/invalid/partial result with explicit issues and sorted rows; never detach values from dates.

- [x] Add failing tests for seven valid dates, wrong endpoints, missing/duplicate/invalid dates, empty data, leap day, month/year rollover, DST, invalid/null numeric fields and unsorted input.
- [x] Implement bounded date-only arithmetic and deterministic validation. No weather tool or automatic LLM output validator.
- [x] Verify with node --import tsx --test tests/temporal-date-range.test.ts.

## Task 3: C — Tavily time evidence

Files: modify src/mastra/tools/tavily-search-tool.ts and tests/tavily-search-tool.test.ts; add docs/temporal-accuracy-evaluation.md.

Interfaces: keep searchTavily old inputs; add optional timeRange/startDate/endDate/searchDepth. Export input schema for boundary checks; parse inside direct helper too. Include retrievedAt and requested publication-date metadata; missing publication date stays null.

- [x] Add failing tests for parameter mapping, invalid/conflicting windows, default maxResults, missing published dates, and retrieval timestamp.
- [x] Implement optional filters, explicit include_published_date and documentation of time-filter semantics.
- [x] Verify with node --import tsx --test tests/tavily-search-tool.test.ts.
- [x] Document reproducible dialogue cases and distinguish mocked-provider prompt verification from real-model evaluation.
- [x] Run npm test, npx tsc --noEmit and npm run build. Review only this change and report any unrun live-model evaluation.

## Execution record

- User approved A–C together and deferred D. Work continues in the current dev_sxy1 checkout; unrelated frontend changes are left untouched.
- Ruling: use processLLMRequest rather than resolving instructions to capture the clock. Installed Mastra docs confirm provider prompt mutations are transient and processor state is per request. This covers SDK and scheduler calls without relying on HTTP middleware.
- Pre-flight: task 3 consumes isCalendarDate from task 2. Task 2 is otherwise independent of task 1; neither consumes a weather client.

- Task 1: complete — fixed-clock boundary tests, real generate/stream provider payload tests, task-timezone propagation and context reconstruction covered. Review finding on serialized timezone fixed RED→GREEN.
- Task 2: complete — date-only arithmetic, structured coverage, numeric-field validation, source timezone and sorting verified. No weather integration added.
- Task 3: complete — optional publication filters/depth, validation, retrievedAt, explicit published-date request and null handling verified.
- Final full suite: 333 tests, 266 pass, 48 existing disk-protection-related failures reproduced against original source, 19 skips. No new failures.
- TypeScript: 7 baseline errors remain, no new diagnostic files/messages. See docs/temporal-accuracy-verification.md for limits and failed test names.
- Ruling: current working directory has a live Mastra dev server; build ran in a temporary source copy rather than disrupting that server. Full npm run build passed; final backend rebuild passed (exit 0).
- Review: independent reviewer confirmed serialization fix and no remaining actionable findings; processor/integration subset independently passed 9/9.
- Final targeted verification: 38 tests, 37 passed, 1 existing skip, 0 failures. Full build and final backend build both passed in the isolated temporary source copy.
