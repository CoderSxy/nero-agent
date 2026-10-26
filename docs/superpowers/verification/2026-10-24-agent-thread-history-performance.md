# Agent Thread History Performance Verification

Date: 2026-10-24

后续修复后的有效验证结果见 [Review fixes](2026-10-24-agent-thread-history-performance-fixes.md)。本文以下保留 Cursor 首次实现阶段的原始记录，remaining risks 不代表修复后状态。

## Automated

| Suite | Result | Notes |
| --- | --- | --- |
| `tests/history-turns.test.ts` | pass | 11 tests |
| `tests/history-repository.test.ts` | pass with local DB | EXPLAIN used `mastra_messages_thread_id_createdat_idx`; no migration |
| `tests/history-routes.test.ts` / `history-memory-boundary.test.ts` | pass | auth/owner/mutex/no-store |
| web history client/state/cache/hook | pass | |
| `HistoryBoundary` / shells / deferred text | pass | |
| `use-turn-artifacts` settled identity loop | pass | equal-content new arrays do not re-fetch |
| `AgentPage` / `AgentChat` regression | pass with window flag mocked false in AgentPage tests | |

Commands:

```bash
node --import tsx --test tests/history-turns.test.ts
node --env-file-if-exists=.env --import tsx --test tests/history-repository.test.ts
node --import tsx --test tests/history-routes.test.ts tests/history-memory-boundary.test.ts
npm run test --prefix web -- src/agent/history-window-client.test.ts src/agent/history-window-state.test.ts src/agent/thread-history-cache.test.ts src/agent/use-thread-history.test.tsx src/agent/history src/agent/use-turn-artifacts.test.tsx src/agent/use-reconciled-chat-messages.test.tsx
```

## Browser profiling

Not executed in this implementation session. Record cold/warm median/p95 against the same fixture before claiming the 50% cold improvement.

## Build switch

`VITE_THREAD_HISTORY_WINDOW_ENABLED` defaults to enabled. Explicit `false` keeps `loadScopedThread` UI path. Artifact loop fix remains independent of the switch.

## Remaining risks

- MessageList virtualization/deferred markdown for every historical turn is only partially wired (`HistoryTurnShell` / `DeferredHistoryText` exist; MessageList deep integration deferred to avoid clobbering in-flight MessageList edits).
- Scheduled-tasks polling still has a full-history fallback path; window merge is used for chat settle reconciliation.
- Real browser scroll-anchor ±4px and chart mount counts need manual Performance/Network passes.
