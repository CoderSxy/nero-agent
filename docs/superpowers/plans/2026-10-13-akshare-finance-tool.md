# AKShare Finance Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, per-thread AKShare finance capability with a persistent Composer category chip, and run AKTools privately on the existing ECS.

**Architecture:** The browser persists an explicit category on its authenticated Mastra thread. Server middleware reads that thread's category and sets a trusted request-context value; the Agent exposes three finance tools only when it is valid. A small versioned interface catalog handles discovery and validation, while AKTools on the same ECS supplies data over loopback HTTP.

**Tech Stack:** React 19, TypeScript, Mastra `@mastra/core@1.71.0`, PostgreSQL-backed Mastra thread storage, AKShare/AKTools, Docker on ECS, systemd/Nginx for the existing app.

**Spec:** `docs/superpowers/specs/2026-10-13-akshare-finance-tool-design.md`

## Global Constraints

- Load `.claude/skills/mastra/SKILL.md` and the installed `@mastra/core/dist/docs/` before editing Mastra code. Register all new tools in `src/mastra/index.ts`. Run repository `dev` and `build` scripts, never `mastra dev` or `mastra build` directly.
- Keep the finance entry inert until a second-layer category is selected. Valid values: `all`, `a_stock`, `fund`, `index`, `macro`, `futures`; `null` means no chip and no finance tools. `all` means the union of supported catalog entries, not every AKShare function.
- Persist category per thread on the server. Never authorize tool use from prompt text, local storage, or an untrusted client request-context key. A tool call without an authenticated owned thread and trusted category fails closed.
- Do not expose AKTools through public Nginx routes or a public ECS port. The app is the only caller. Pin the tested AKTools image by digest, and record the included AKShare version.
- Preserve current unrelated worktree changes; add only task-owned files and hunks. Do not access ECS until the user later provides Workbench access.

## File Map

| File | Responsibility |
| --- | --- |
| `src/mastra/finance/catalog.ts`, `src/mastra/finance/catalog.json` (new) | Supported interface metadata, categories, searchable text and parameter rules. |
| `src/mastra/finance/aktools-client.ts` (new) | Fixed-base-URL HTTP client, timeout, JSON/size/row limits and normalized errors. |
| `src/mastra/finance/scope.ts` (new) | Category constants, metadata parsing and trusted request-context accessor. |
| `src/mastra/finance/routes.ts` (new) | Authenticated read-only capability endpoint for the feature flag and category choices. |
| `src/mastra/finance/tools.ts` (new) | `finance_search`, `finance_interface_info`, `finance_fetch`; each enforces scope and catalog validation. |
| `src/mastra/auth/authorization.ts` | After thread ownership check, load the current thread metadata and place a validated finance category in server request context; overwrite client-supplied value with `null` when absent. |
| `src/mastra/auth/thread-guard.ts` | Extend the thread lookup record shape to expose metadata as needed without weakening ownership checks. |
| `src/mastra/agents/agent.ts`, `src/mastra/index.ts` | Conditionally expose finance tools and register all tools/routes centrally. |
| `web/src/agent/finance-category.ts` (new) | Frontend category type, labels, metadata read/merge/save helper and owned-thread check. |
| `web/src/agent/AgentComposer.tsx`, `web/src/styles.css` | Two-level menu and removable chip above the Composer, including busy/error/disabled states. |
| `web/src/agent/AgentPage.tsx`, `web/src/agent/AgentChat.tsx`, `web/src/agent/use-thread-list.ts` | Restore per-thread category; create a thread when the first category is selected; persist before allowing send; pass category UI state. |
| `docs/deployment/aktools-ecs.md` (new) | Version/digest, loopback-only ECS runbook, health checks, rollout and rollback. |
| Targeted `*.test.ts(x)` files | Contract, authorization, client normalization, persistence and UI behavior. |

## Review Focus

1. A forged request context says `a_stock` but the owned thread has no category: the finance tool must remain unavailable (Task 2 test).
2. A direct tool API call or another user's thread ID must not bypass scope and ownership checks (Task 2 and Task 3 tests).
3. A stale category write must not overwrite existing model or title metadata; simultaneous send waits for category persistence (Task 4 test).
4. AKTools returns malformed, huge, empty or stale data: the client returns an explicit bounded result/error and never asks the model to invent values (Task 3 test).
5. A category from thread A must not flash in thread B after a slow fetch; refresh and relogin must restore the right chip (Task 4 test).

---

### Task 1: Verify AKTools and define the supported catalog

**Files:** Create `src/mastra/finance/catalog.ts`, `src/mastra/finance/catalog.json` and focused catalog tests; record probe results in `docs/deployment/aktools-ecs.md`.

**Interfaces:** Export `FinanceCategory = 'all' | 'a_stock' | 'fund' | 'index' | 'macro' | 'futures'`, `FinanceInterface` with `name`, `category`, `description`, `source`, `parameters`, `outputFields`, `maxRows`, `maxRangeDays`, `ttlSeconds`; `searchFinanceCatalog(query, category, limit)` and `getFinanceInterface(name, category)`.

- [ ] **Step 1: Probe one fixed AKTools image locally.** Record image digest, AKShare version, HTTP status/shape for representative no-argument and parameterized data calls, plus `search`, `interface_info`, `list_categories` compatibility. Do not assume the latter three work over AKTools HTTP. Record the observed output fields, date formats and unit definitions.
- [ ] **Step 2: Write failing catalog tests.** Assert `all` returns the supported union; A 股 excludes non-A 股 stock functions; cross-category names and unknown names do not resolve; keyword search returns no more than five ranked candidates; optional and required parameters retain their documented types.
- [ ] **Step 3: Verify red.** Run `npm test`; expect the new finance-catalog tests to fail for missing behavior, not setup errors.
- [ ] **Step 4: Implement the catalog.** Seed documented, probe-verified functions for each selected category and record exact parameters. Maintain a small curated allowlist; list the supported functions in the runbook. Do not copy the entire AKShare data dictionary into tool descriptions or commit unreviewed full registry data.
- [ ] **Step 5: Verify green and commit task files.** Rerun the focused test and `git diff --check`; stage only Task 1 files.

### Task 2: Enforce per-thread server scope and conditional tool availability

**Files:** Create `src/mastra/finance/scope.ts`, `src/mastra/finance/routes.ts` and tests; modify `src/mastra/auth/authorization.ts`, `src/mastra/auth/thread-guard.ts`, `src/mastra/agents/agent.ts`, `src/mastra/index.ts` and focused auth/agent tests.

**Interfaces:** `FINANCE_CATEGORY_CONTEXT_KEY = 'nero-agent.finance-category.trusted'`; `readFinanceCategory(metadata: unknown): FinanceCategory | null`; `trustedFinanceCategory(requestContext): FinanceCategory | null`; `resolveAgentTools(requestContext)` adds the three finance tools only for a trusted non-null category. The tool executor rechecks `trustedFinanceCategory` and authenticated identity.

- [ ] **Step 1: Write failing authorization tests.** Exercise owned threads with each valid category, no metadata, malformed metadata, a forged client key, a foreign thread, first-stream thread creation, a non-stream API request and a direct tool request. Assert only an owned existing thread with valid saved category activates finance tools; foreign threads retain 403. Assert the authenticated capability endpoint reflects the feature flag and never leaks server URL.
- [ ] **Step 2: Verify red.** Run `npm test`; expect the new finance-scope tests to fail for missing behavior.
- [ ] **Step 3: Implement server scope.** Extend the existing `authorizeThreadRoute` after ownership verification to read metadata and overwrite the trusted key, including explicit `null`. Do not trust a key carried by the browser. Handle a missing thread in the initial stream as generic; the UI must persist selection after creating the thread and before its first send. Add the authenticated capability route and register it in `index.ts`. Make the registered tools executable only when their own scope check passes.
- [ ] **Step 4: Verify green and commit task files.** Rerun focused tests and existing thread authorization tests; stage only Task 2 files.

### Task 3: Implement finance discovery and AKTools access

**Files:** Create `src/mastra/finance/aktools-client.ts`, `src/mastra/finance/tools.ts` and focused tests; finish tool registration in `src/mastra/index.ts` if Task 2 used test stubs.

**Interfaces:** `finance_search({query,limit})` returns at most five catalog summaries; `finance_interface_info({name})` returns the selected catalog entry's parameter/output contract; `finance_fetch({name,parameters})` calls AKTools only after category and parameter validation, returning bounded rows and `{source,dataTime,fetchedAt,units,truncated,versions}` metadata. `AKTOOLS_BASE_URL` is server configured; `FINANCE_TOOL_ENABLED` defaults off.

- [ ] **Step 1: Write failing tool tests with a fake HTTP server/fetch.** Assert no request for unknown interface, cross-category interface, extra key, invalid code/date/range or suspicious parameter text. Assert fixed origin, encoded query, no redirect, timeout, response byte/row caps, no-JSON/500/empty response handling and explicit unknown data time. Prove a direct execution without trusted scope fails before HTTP.
- [ ] **Step 2: Verify red.** Run `npm test`; expect the new finance-tool tests to fail for missing behavior.
- [ ] **Step 3: Implement minimal adapter and tools.** Keep the base URL fixed and private; validate all parameter names and types against the catalog before URL creation. Use an abortable timeout, limited response body, bounded output and conservative retry policy. Return structured errors and make model instructions ask for clarification when multiple candidates fit; never present fetch time as market data time.
- [ ] **Step 4: Verify green and commit task files.** Rerun focused tests and `npm run build`; inspect registered tool IDs and tool output shapes.

### Task 4: Add persistent Composer selection

**Files:** Create `web/src/agent/finance-category.ts` and tests; modify `web/src/agent/client.ts`, `web/src/agent/AgentComposer.tsx`, `web/src/agent/AgentPage.tsx`, `web/src/agent/AgentChat.tsx`, `web/src/agent/use-thread-list.ts`, `web/src/styles.css` and focused UI tests.

**Interfaces:** `readThreadFinanceCategory(metadata): FinanceCategory | null`; `withThreadFinanceCategory(metadata, category): Record<string, unknown>`; `saveThreadFinanceCategory(thread, category, resourceId): Promise<void>`. Composer props `financeCategory`, `financeSaving`, `onFinanceCategoryChange`; the parent owns persistence and blocks send during save. On `/agent/new`, category selection calls the existing thread creation path and then persists selection before showing an active chip.

- [ ] **Step 1: Write failing UI and persistence tests.** Opening the first-level entry alone leaves category `null`; choosing `all` creates an active chip; remove restores generic mode; send clears draft but preserves chip; thread A/B selections remain separate; reload and new login restore from thread metadata; a historical thread without metadata has no chip. Cover save failure, double-click/new-thread race, pending save with Send, stale async completion after thread switch, preservation of model/title metadata, and a disabled capability response that hides new selection but shows an existing chip as inactive.
- [ ] **Step 2: Verify red.** Run `npm test --prefix web -- src/agent/finance-category.test.ts src/agent/AgentComposer.test.tsx src/agent/AgentPage.test.tsx`; expect missing UI/behavior.
- [ ] **Step 3: Implement selection.** Use the reference project's two-level visual pattern without importing its code. Fetch server capability through `client.ts` and hide/disable the entry while off. Reuse current `AgentPage` thread creation logic; first-level click only opens menu. Keep selection outside draft state. Save immediately on second-level selection/removal; reflect success only after save. Serialize model and category metadata writes per thread through a shared read/merge/update queue, preserving unrelated metadata fields.
- [ ] **Step 4: Verify green and commit task files.** Rerun focused tests, `npm test --prefix web` and `npm run build:web`; stage only Task 4 files and CSS hunks.

### Task 5: Local end-to-end acceptance

**Files:** Only focused fixes to Tasks 1–4 and their tests; update `docs/deployment/aktools-ecs.md` with measured versions and examples.

- [ ] **Step 1: Start the tested AKTools image locally and the app with `npm run dev`.** Set `AKTOOLS_BASE_URL` to loopback and explicitly enable finance in the local environment.
- [ ] **Step 2: Exercise one query per category and one multi-turn follow-up.** Confirm interface search → detail → fetch, source/time display, `all` behavior, incompatible category handling, empty result and upstream failure.
- [ ] **Step 3: Exercise isolation.** Confirm untagged conversation never offers finance tools, selected tag survives send/refresh/relogin, A/B threads differ, removal stops tool use, and a forged category in request context does not bypass the server.
- [ ] **Step 4: Run release checks.** `npm test`, `npm test --prefix web`, `npm run build`, `git diff --check`; fix concrete failures and record only unresolved environmental limitations.

### Task 6: ECS Workbench deployment and rollback (later, with user-provided access)

**Files:** Complete `docs/deployment/aktools-ecs.md`; use the existing `docs/deployment/ecs-release-from-local-build.md` for the app release. No ECS operations are part of this planning turn.

- [ ] **Step 1: Preflight.** In Workbench check architecture, Docker state, memory/disk headroom, available loopback port, outbound connectivity to the required data sources, and current app/systemd/Nginx status. Preserve the current release path and AKTools image digest for rollback.
- [ ] **Step 2: Deploy AKTools privately.** Pull the locally tested digest, run one restartable container with resource/log limits and `127.0.0.1:18080:8080`; do not alter the existing PostgreSQL Compose service or sandbox containers. Verify `/` locally and a representative data endpoint. Confirm no public Nginx route or ECS security-group ingress for port 18080.
- [ ] **Step 3: Release app with finance initially off.** Build with the repository release script; upload and switch using the existing ECS runbook. Set `AKTOOLS_BASE_URL=http://127.0.0.1:18080` server-side. Validate ordinary login, generic chat, thread persistence and AKTools connectivity, then enable the feature flag and restart the app.
- [ ] **Step 4: Production smoke and rollback.** Test a selected category, multi-turn query, remove chip, A/B isolation, refresh/relogin and data provenance. If failure occurs, turn off the feature flag; if needed revert the app release symlink and AKTools container to the recorded digest. Confirm generic chat still works.

## Delivery Boundary

Tasks 1–5 produce locally verified product code. Task 6 is a separate later execution stage after the user grants Workbench access. Do not call the feature deployed or operational until Task 6 checks pass.
