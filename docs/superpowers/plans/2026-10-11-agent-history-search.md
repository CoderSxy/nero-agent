# Agent History Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `cmdk` history search beside “历史对话”, searching current-user question/answer text across Mastra threads and navigating to the matched turn.

**Architecture:** Keep text extraction and matching in a pure search-index module, lazy concurrent loading and per-user caching in a search hook, and the modal as a separate UI component. A shared frontend storage module is the sole IndexedDB opener; history search owns one object store inside that database. Reuse `loadScopedThread` for authorization. `AgentPage` owns selection/navigation; `AgentChat` and `MessageList` own target-message scrolling.

**Tech Stack:** React 19, TypeScript, `cmdk@^1.1.1`, Mastra client/message types, browser IndexedDB, Vitest and Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-11-agent-history-search-design.md`

## Global Constraints

- Search only the authenticated user's Agent threads via `loadScopedThread(threadId, resourceId)`; never use unscoped message calls or index another user's content.
- First load the latest 50 threads with concurrency at most 5. Offer full loading only when more than 50 exist. Limit visible results to 100 while reporting the full match count.
- Index visible question and assistant answer text only. Exclude reasoning, tools, observation markers, attachment protocol, files and standalone title matches. Use literal Unicode-normalized case-insensitive matching.
- Use `cmdk@^1.1.1` for keyboard result navigation. Do not add Ant Design, a backend route, database table or Mastra tool. If changing any Mastra API usage, read `.claude/skills/mastra/SKILL.md` and installed docs first. Use repository package scripts for builds.
- The frontend has exactly one project-managed IndexedDB database: `nero-agent-client`, version 1 initially. Only `web/src/storage/indexed-db.ts` may call `indexedDB.open/deleteDatabase`; history search uses the `historySearchDocuments` store within it. Future features add stores through versioned, non-destructive upgrades in that module. Do not add a dependency that creates another database.
- Preserve unrelated dirty working-tree changes. Existing `AgentPage.tsx`, `AgentChat.tsx`, `ThreadSidebar.tsx` and `styles.css` may already have unrelated edits; stage only this feature's hunks with `git add -p` or defer that task's commit. Do not reset or format unrelated files.

## File Map

| File | Responsibility |
| --- | --- |
| `web/package.json`, `web/package-lock.json` | Add `cmdk@^1.1.1` with npm in `web`; root lockfile is separate and does not change. |
| `web/src/agent/history-search-index.ts` (new) | Convert Mastra messages to per-turn documents, normalize/search, count and snippets. |
| `web/src/storage/indexed-db.ts` (new) | Sole frontend IndexedDB open/upgrade/connection point and shared schema constants. |
| `web/scripts/check-indexed-db.mjs` (new), `web/package.json` | Build guard rejecting direct IndexedDB open/delete outside shared storage module. |
| `web/src/agent/history-search-cache.ts` (new) | User-scoped cache adapter using the shared database and one object store, with memory fallback and invalidation. |
| `web/src/agent/use-history-search.ts` (new) | Lazy recent/full loading, bounded concurrency, progress, retries and stale-result protection. |
| `web/src/agent/HistorySearchDialog.tsx` (new) | Accessible `cmdk` search dialog, result list, progress and keyboard/IME behavior. |
| `web/src/agent/ThreadSidebar.tsx` | Search icon beside existing list-mode control, dialog launcher and shortcut. |
| `web/src/agent/AgentPage.tsx` | Pass current user/thread list to search; navigate selected result; invalidate current thread on new content. |
| `web/src/agent/MessageList.tsx`, `web/src/agent/AgentChat.tsx` | Stable message anchor and target-message scroll/highlight. |
| `web/src/styles.css` | Sidebar controls, dialog and result states, target highlight in both themes. |
| `web/src/agent/*.test.ts(x)` | Focused tests alongside the corresponding modules and integration tests for navigation. |

## Review Focus

1. A stale search request from user A must never populate user B's dialog after account switch (Task 3 test).
2. A direct second-database open outside the shared storage module must fail the build; a failed thread read must not be cached as an empty conversation (Tasks 2 and 3 tests).
3. An assistant tool/reasoning part containing the query must not appear as an answer match (Task 1 test).
4. An IME composition Enter must confirm Chinese input without selecting a result (Task 4 test).
5. Selecting two results in the same thread must reposition the viewport twice, without auto-follow pulling it back to the latest message (Task 5 test).

---

### Task 1: Pure per-turn index and literal matching

**Files:** Create `web/src/agent/history-search-index.ts`, `web/src/agent/history-search-index.test.ts`.

**Interfaces:** Export `type HistorySearchDocument = { threadId:string; threadTitle:string; threadUpdatedAt:string; userMessageId:string; questionText:string; answerText:string }`; `type HistorySearchResult = HistorySearchDocument & { matchSource:'question'|'answer'; matchedSnippet:string }`; `buildHistorySearchDocuments(thread: Pick<Thread,'id'|'title'|'updatedAt'>, messages: MastraDBMessage[]): HistorySearchDocument[]`; `searchHistoryDocuments(documents: HistorySearchDocument[], query: string): { results:HistorySearchResult[]; total:number }`. Convert `thread.updatedAt` to an ISO string at the index boundary. Export `RECENT_HISTORY_LIMIT = 50` and `MAX_HISTORY_SEARCH_RESULTS = 100`.

- [ ] **Step 1: Write failing tests.** Build real `MastraDBMessage` fixtures: two user turns with assistant responses, a user-signal message, tool/reasoning-only parts, an attachment protocol part, and an orphan assistant. Assert one document per nonempty user turn; only visible text is indexed; question wins when both fields match; `NFKC` + case-insensitive literal matching works with `[` and Chinese; total can exceed 100 but results length is 100; result order is question-first then newest thread; snippet remains valid when normalization changes string length.
- [ ] **Step 2: Verify red.** Run `npm test --prefix web -- src/agent/history-search-index.test.ts`; expect failures for missing exports/behavior, not test setup errors.
- [ ] **Step 3: Implement.** Use `messageParts` and `isUserMessage`; include only `kind === 'text'`, skip `streamError` content and blank text. Group assistant text until the next user message. Normalize with `trim().normalize('NFKC').toLocaleLowerCase()` and literal `includes`; build safe original-text snippets with a fallback when normalized offsets differ. Never render markup from the query.
- [ ] **Step 4: Verify green.** Rerun Step 2; expect all Task 1 tests to pass.
- [ ] **Step 5: Commit only Task 1 files.** `git add web/src/agent/history-search-index.ts web/src/agent/history-search-index.test.ts && git commit -m "feat: index agent history turns for search"`.

### Task 2: Shared IndexedDB foundation and user-scoped cache

**Files:** Create `web/src/storage/indexed-db.ts`, `web/src/storage/indexed-db.test.ts`, `web/src/storage/indexed-db-guard.test.ts`, `web/scripts/check-indexed-db.mjs`, `web/src/agent/history-search-cache.ts`, `web/src/agent/history-search-cache.test.ts`; modify `web/package.json` build script.

**Interfaces:** From `web/src/storage/indexed-db.ts`, export `APP_DB_NAME = 'nero-agent-client'`, `APP_DB_VERSION = 1`, `APP_DB_STORES = { historySearchDocuments: 'historySearchDocuments' } as const`, and `openAppDatabase(): Promise<IDBDatabase>`. From `history-search-cache.ts`, export `type HistorySearchCache` with `get(userId:string, threadId:string, updatedAt:string):Promise<HistorySearchDocument[]|null>`, `put(userId:string, threadId:string, updatedAt:string, documents:HistorySearchDocument[]):Promise<void>`, `removeMissing(userId:string, visibleThreadIds:Set<string>):Promise<void>`, `invalidate(userId:string, threadId:string):Promise<void>`; export `createHistorySearchCache(): HistorySearchCache`. Store records under an unambiguous `[userId, threadId]` key in the single `historySearchDocuments` object store. Future schema changes increment `APP_DB_VERSION` in the shared module.

- [ ] **Step 1: Write failing tests.** In `indexed-db.test.ts`, assert simultaneous `openAppDatabase()` calls use one `indexedDB.open('nero-agent-client', 1)`, create `historySearchDocuments`, and close the shared connection on `versionchange`; opening an already valid version-1 database must retain existing records. In cache tests, assert same-user/thread/version hits, changed version misses, user-scoped cleanup/invalidation and memory fallback when storage is absent/blocked. In `indexed-db-guard.test.ts`, invoke the guard with a temporary `--root` fixture directory containing `indexedDB.open('second-db')` and assert nonzero exit; a fixture with the shared module as its only opener passes.
- [ ] **Step 2: Verify red.** Run `npm test --prefix web -- src/storage/indexed-db.test.ts src/storage/indexed-db-guard.test.ts src/agent/history-search-cache.test.ts`; expect missing exports/behavior and guard failures.
- [ ] **Step 3: Implement.** Centralize the only `indexedDB.open` call, schema upgrade and reusable connection Promise in `web/src/storage/indexed-db.ts`; handle `versionchange`, `onblocked` and open failure without hanging callers. Cache uses only `openAppDatabase()`, with memory fallback on missing/failed IndexedDB; never cache failed network reads as empty documents. Add `web/scripts/check-indexed-db.mjs` with optional `--root <directory>` (default `web/src`) to scan production `.ts/.tsx/.js/.jsx` files, excluding `*.test.*`, and reject direct `indexedDB.open/deleteDatabase` outside `storage/indexed-db.ts`. Run it before `tsc -b` in `web/package.json`'s `build` script. Do not touch root build script or create a second DB.
- [ ] **Step 4: Verify green.** Rerun Step 2 and `npm run build:web`; expect the only opened database name to be `nero-agent-client`, new tests and build to pass.
- [ ] **Step 5: Commit only Task 2 files.** Stage `web/src/storage/indexed-db.ts`, both storage tests, `web/scripts/check-indexed-db.mjs`, cache implementation/test and the relevant `web/package.json` hunks; use `git commit -m "feat: add shared browser database and history cache"`.

### Task 3: Lazy recent/full loading with progress and retry

**Files:** Create `web/src/agent/use-history-search.ts`, `web/src/agent/use-history-search.test.tsx`; modify `web/src/agent/AgentPage.tsx` only if needed to provide invalidation/refresh callbacks.

**Interfaces:** Export `useHistorySearch(options: { userId:string; threads:Thread[]; cache:HistorySearchCache; loadThread?: typeof loadScopedThread }): { documents:HistorySearchDocument[]; scope:'recent'|'all'; recentStatus:'idle'|'loading'|'ready'|'error'; fullStatus:'idle'|'loading'|'ready'|'error'; recentProgress:{completed:number;total:number}; fullProgress:{completed:number;total:number}; recentFailedCount:number; fullFailedCount:number; ensureRecent():void; cancelRecent():void; loadAll():void; retryRecent():void; retryFull():void; invalidateThread(threadId:string):Promise<void> }`. `loadThread` defaults to `loadScopedThread` and is injectable only for tests.

- [ ] **Step 1: Write failing tests.** With 55 threads, opening loads exactly the newest 50, at most 5 concurrently, then `loadAll` fetches only 5 more. Assert progress, ready scope, cache hits avoiding fetch, recent failure count/retry failed IDs, full failure retaining recent documents/retry, closing via `cancelRecent` ignoring stale results, unmount ignoring stale completion, user switch discarding previous user documents, deleted thread cleanup, and explicit invalidation refreshing a thread even when `updatedAt` is unchanged.
- [ ] **Step 2: Verify red.** Run `npm test --prefix web -- src/agent/use-history-search.test.tsx`; expect missing-hook failures.
- [ ] **Step 3: Implement.** Load messages through `loadScopedThread(thread.id,userId)`, transform with Task 1, cache with Task 2. A generation counter must guard every async publish and user/list change; `cancelRecent` increments the generation when no full load is active. Give each thread an invalidation epoch so an earlier load cannot repopulate a cleared cache. Treat failed fetches as failed IDs, not empty documents. Search remains available after successful recent load while full load runs; failed recent load shows retry instead of claiming complete coverage. Avoid unhandled promise rejections.
- [ ] **Step 4: Verify green.** Rerun Step 2; expect all Task 3 tests to pass.
- [ ] **Step 5: Commit only Task 3 files.** `git add web/src/agent/use-history-search.ts web/src/agent/use-history-search.test.tsx && git commit -m "feat: load agent history search lazily"`.

### Task 4: Sidebar launcher and `cmdk` dialog

**Files:** Create `web/src/agent/HistorySearchDialog.tsx`, `web/src/agent/HistorySearchDialog.test.tsx`; modify `web/src/agent/ThreadSidebar.tsx`, `web/src/agent/ThreadSidebar.test.tsx`, `web/src/agent/AgentPage.tsx`, `web/src/styles.css`, `web/package.json` and the actual npm lockfile.

**Interfaces:** `HistorySearchDialog` props `{ open:boolean; search:ReturnType<typeof useHistorySearch>; onClose():void; onSelect(result:HistorySearchResult):void }`; add optional `ThreadSidebar` props `search?:ReturnType<typeof useHistorySearch>` and `onSearchSelect?:(result:HistorySearchResult)=>void`. `AgentPage` creates a per-user cache/hook and navigates on select to `/agent/${encodeURIComponent(result.threadId)}?targetMessageId=${encodeURIComponent(result.userMessageId)}`. Keep existing `historyMode` toggle.

- [ ] **Step 1: Write failing tests.** Assert icon appears beside “历史对话”; click and `Ctrl/Cmd + K` open one dialog; input receives focus; `Escape` and backdrop close and restore focus; input query displays question/answer hit source, snippet, total, loading status, retry buttons and “加载全部会话内容” only above 50; arrow keys + Enter select; composition Enter does not select; `AgentPage` navigation encodes thread/message IDs.
- [ ] **Step 2: Verify red.** Run `npm test --prefix web -- src/agent/HistorySearchDialog.test.tsx src/agent/ThreadSidebar.test.tsx src/agent/AgentPage.test.tsx`; expect missing UI/behavior failures.
- [ ] **Step 3: Implement.** Install `cmdk@^1.1.1` using npm in `web`; use `Command shouldFilter={false}` with Task 1 results. Put a `Search` icon beside the existing list-mode button; add dialog focus restoration, one page-level shortcut listener, `isComposing` guard and accessible states. Call `ensureRecent` on open and `cancelRecent` on close while recent loading is active. Use existing light/dark tokens in `web/src/styles.css`, with no Ant Design. Keep search index lazy until first open.
- [ ] **Step 4: Verify green.** Rerun Step 2; expect all Task 4 tests to pass.
- [ ] **Step 5: Commit only Task 4 files and lockfile.** Stage the listed files explicitly; use `git commit -m "feat: add agent history search dialog"`.

### Task 5: Result navigation and stable message targeting

**Files:** Modify `web/src/agent/AgentPage.tsx`, `web/src/agent/AgentChat.tsx`, `web/src/agent/MessageList.tsx`, `web/src/agent/AgentChat.test.tsx`, `web/src/agent/MessageList.test.tsx`, `web/src/agent/AgentPage.test.tsx`, `web/src/styles.css`.

**Interfaces:** Pass `targetMessageId?:string` from `AgentPage` query param into `AgentChat`. Give rendered `Message` a `data-message-id` attribute equal to the persisted Mastra message ID. On target change or post-load render, locate by DOM attribute equality under the local viewport, then scroll into that viewport and apply a temporary highlight class. Do not interpolate raw IDs into CSS selectors.

- [ ] **Step 1: Write failing tests.** Verify rendered message anchors; cross-thread result navigation waits for messages then scrolls to the requested user message; selecting another result in the same thread scrolls again; target is stable across ResizeObserver/auto-follow; absent target leaves conversation intact; query removal does not scroll; target highlight clears after its timer; message IDs with selector punctuation are safe.
- [ ] **Step 2: Verify red.** Run `npm test --prefix web -- src/agent/MessageList.test.tsx src/agent/AgentChat.test.tsx src/agent/AgentPage.test.tsx`; expect targeting assertions to fail.
- [ ] **Step 3: Implement.** Read `targetMessageId` from `useSearchParams` in `AgentPage`; pass it to `AgentChat`. In `AgentChat`, disable follow when a target is pending and scroll after target render with `useLayoutEffect`; use the actual ChatShell viewport for offset calculations. Track the last handled target so streamed messages and ResizeObserver do not re-scroll; reset only when `threadId` or `targetMessageId` changes. `MessageList` adds stable attributes without changing message content. If the target is missing after the initial message load, clear pending targeting and leave ordinary scrolling behavior. Highlight with theme-aware CSS.
- [ ] **Step 4: Verify green.** Rerun Step 2; expect all Task 5 tests to pass.
- [ ] **Step 5: Commit only Task 5 files.** Stage files explicitly; use `git commit -m "feat: navigate to history search matches"`.

### Task 6: Fresh-content invalidation and final verification

**Files:** Modify `web/src/agent/AgentPage.tsx`, `web/src/agent/AgentChat.tsx`, `web/src/agent/AgentPage.test.tsx`, `web/src/agent/AgentChat.test.tsx`; adjust `web/src/agent/use-history-search.test.tsx` for integration if needed.

**Interfaces:** `AgentChat` exposes optional `onResponseSettled?:()=>void` called when a running reply transitions to stopped; `AgentPage` calls `search.invalidateThread(threadId)` on existing successful `onMessageSent` and the settled reply callback, then refreshes thread list. Deleting a thread removes it from the next index state/cache cleanup.

- [ ] **Step 1: Write failing tests.** Search once, send a new user message with unchanged cached thread `updatedAt`, and assert next search loads the new content. Assert reply completion similarly refreshes assistant text; account switch and deleted thread remove stale results. Do not invalidate on a failed send as though it succeeded.
- [ ] **Step 2: Verify red.** Run `npm test --prefix web -- src/agent/use-history-search.test.tsx src/agent/AgentPage.test.tsx src/agent/AgentChat.test.tsx`; expect invalidation assertions to fail.
- [ ] **Step 3: Implement.** Wire successful send/response-settled callbacks to `invalidateThread`, refresh thread list, and guard against late stale cache writes from pre-invalidation loads. Keep existing attachment/title callbacks intact.
- [ ] **Step 4: Verify green.** Rerun Step 2; expect all Task 6 tests to pass.
- [ ] **Step 5: Run project checks.** `npm test --prefix web`; `npm run build:web`; `git diff --check`. If the known unrelated Blob tests remain red, list exact failures and show focused new tests plus build passing. Manually verify search, recent/full loading, navigation and shortcut in both themes if a browser session is available.
- [ ] **Step 6: Commit only Task 6 files.** Stage exact changed paths; use `git commit -m "fix: refresh agent history search after replies"`.
