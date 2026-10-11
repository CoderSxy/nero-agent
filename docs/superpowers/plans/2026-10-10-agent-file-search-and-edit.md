# Agent File Search and Precise Edit Implementation Plan

> **For agentic workers:** Read the linked spec first. Execute tasks in order, using red/green tests and marking each checkbox when verified. Preserve unrelated working-tree changes; this repository already contains uncommitted work. Do not stage or commit unrelated files.

**Goal:** Add scoped `glob`, bounded literal `grep`, and version-checked single-replacement `edit` to the existing Agent file tools.

**Architecture:** Keep authentication and scope resolution in a shared file-scope service, bounded traversal/search in a separate search service, and versioned mutation in the existing workspace editor. `src/mastra/files/tools.ts` remains a thin Mastra adapter. Existing `read_file` returns an ETag so the Agent can call `edit` without guessing a version.

**Tech Stack:** TypeScript, Node.js filesystem, Zod, Mastra `createTool`, PostgreSQL-backed personal workspace quota, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-10-agent-file-search-and-edit-design.md`

## Global Constraints

- Load `.claude/skills/mastra/SKILL.md` and the installed `node_modules/@mastra/core/dist/docs/references/docs-agents-tools.md` before editing Mastra tools. Use `npm run dev` and `npm run build`, not direct Mastra commands.
- Register all new tools through `userFileTools` and verify `src/mastra/index.ts` includes them; preserve `USER_FILES_ENABLED` gating in `agent.ts`.
- Keep `thread` as the default scope and existing `read_file`/`write_file`/`list_files`/`delete_file` inputs compatible. `workspace` must be explicit. Reject `threads/<otherThreadId>` even in workspace scope.
- The server derives user ID, thread ID and roots from trusted context. No arbitrary root, host path, source override or shell execution.
- Search limits: 20,000 visited entries; `glob` 200 results/32 KiB output; `grep` 500 files, 2 MiB per file, 20 MiB total, 100 lines/32 KiB output. `grep` query <=256 Unicode characters; output line <=300 Unicode characters. Count limits before adding a result and always report truncation.
- `edit` requires SHA-256 `expectedEtag`, `oldText` nonempty and <=64 KiB, `newText` <=64 KiB, target/next file <=10 MiB, and exactly one match including overlapping occurrences. Keep 500 MiB personal quota/disk protection. No schema migration, front-end change or regex mode.
- Existing unrelated changes must remain intact. Do not run a formatter across the repository or commit the existing dirty working tree. If a test requires PostgreSQL or a live model and the environment lacks it, state the specific unverified check.

## File Map

| File | Responsibility |
| --- | --- |
| `src/mastra/files/file-scope.ts` (new) | Resolve authenticated thread/personal roots, normalize scope-relative paths, block foreign thread subtrees and symlink traversal. |
| `src/mastra/files/file-search.ts` (new) | Deterministic bounded walker, glob pattern matching, literal UTF-8 grep and truncation metadata. |
| `src/mastra/files/workspace-editor.ts` | Shared versioned text mutation and exact replacement, write/quotas/atomicity; retain online editor contract. |
| `src/mastra/files/service.ts` | Return ETag/size from `FileService.read` without changing its existing content behavior. |
| `src/mastra/files/tools.ts` | Zod schemas and thin `glob`/`grep`/`edit` adapters; expose `read_file.etag`. |
| `src/mastra/agents/agent.ts`, `src/mastra/index.ts` | Tell Agent how to use tools and verify registration/gating. |
| `tests/file-scope.test.ts`, `tests/file-search.test.ts`, `tests/file-tools.test.ts`, `tests/workspace-editor.test.ts` | Authorization, search budgets, tool contract and mutation regressions. |

## Review Focus

1. Explicit workspace search against `threads/<otherThreadId>` must fail or skip that subtree, never return another thread's file (Task 1 tests).
2. A symlink in any path segment must never redirect search or edit outside the resolved root (Tasks 1, 2 and 4 tests).
3. A truncated search must not look like an exhaustive negative result (Tasks 2 and 3 tests).
4. `oldText="aa"` in `"aaa"` has two overlapping matches and must be rejected without writing (Task 4 test).
5. Two edits using the same ETag must yield one success and one stale-version failure (Task 4 test).

---

### Task 1: Scoped path resolution and version-bearing reads

**Files:** Create `src/mastra/files/file-scope.ts`, `tests/file-scope.test.ts`; modify `src/mastra/files/service.ts`, `src/mastra/files/tools.ts`, `tests/file-tools.test.ts`.

**Interfaces:** Export `type FileToolScope = 'thread' | 'workspace'`; `resolveFileToolRoot(auth: AuthContext, threadId: string, lookup: ThreadLookup, scope: FileToolScope): Promise<string>`; `resolveScopedPath(root: string, relativePath: string, scope: FileToolScope, threadId: string, options?: { allowRoot?: boolean }): Promise<string>`. The second function validates `relativeFilePath` for non-root inputs, root containment, existing path segments, foreign `threads/` subtrees and symlinks. For a search root use omitted/empty `basePath` with `allowRoot`. Extend `FileService.read` to return `etag: string` and `size: number`, calculated from the bytes using `readWorkspaceVersion`.

- [x] **Step 1: Write failing tests.** In `file-scope.test.ts`, test owned thread and workspace roots; default and explicit scope; `uploads/<uuid>/x.txt` resolving under personal root; cross-user spoofing, foreign `threads/<id>`, absolute/`..`/backslash paths and a symlinked parent rejected; empty base path allowed only when `allowRoot` is true. In `file-tools.test.ts`, assert `read_file` still accepts `{path}` and now returns content, quoted 64-hex ETag and byte size for UTF-8 text.
- [x] **Step 2: Verify red.** Run `node --import tsx --test tests/file-scope.test.ts tests/file-tools.test.ts`; expect failures for missing exports/new ETag assertions.
- [x] **Step 3: Implement.** Reuse `ensureThreadDirectory`, `ensureUserWorkspace`, `relativeFilePath`, `assertContained`, `lstat` and `realpath`. Check ownership before resolving workspace scope as well. Reject `threads` paths except `threads/<trusted current thread ID>/...`; do not create a nonexistent edit target. Keep existing `FileService.read` return fields and tool output fields, adding only `etag`/`size`.
- [x] **Step 4: Verify green.** Rerun Step 2; expect zero failures.

### Task 2: Bounded `glob`

**Files:** Create `src/mastra/files/file-search.ts`, `tests/file-search.test.ts`; modify `src/mastra/files/tools.ts`, `tests/file-tools.test.ts`.

**Interfaces:** Export `globFiles(args: { root: string; scope: FileToolScope; threadId: string; basePath?: string; pattern: string; signal?: AbortSignal }): Promise<{ entries: Array<{path:string;size:number}>; visitedEntries:number; truncated:boolean; reason?:string }>`; implement a common deterministic `walkScopedFiles` inside `file-search.ts` for Task 3. Register `userFileTools.glob` with input `{pattern,scope?,basePath?}` and call it through trusted auth/thread/root resolution. The pattern language is `*`, `?`, `**` over `/`; `**/*` matches root files too. Only regular files appear in results.

- [x] **Step 1: Write failing tests.** Test `*.md` only at base root, `**/*.md` across nested paths and root, `?`, Unicode/spaces, deterministic order, regular-file-only results, basePath-relative matching with scope-root-relative returned paths. Test 200-result and 20,000-visited limits using fixture or injected walker budget; assert `truncated/reason`. Test symlink directory/file skipped, foreign thread skipped and abort signal stops traversal. Test invalid pattern rejection.
- [x] **Step 2: Verify red.** Run `node --import tsx --test tests/file-search.test.ts tests/file-tools.test.ts`; expect missing-tool/service failures.
- [x] **Step 3: Implement.** Add a small glob parser for the spec's three wildcards; reject unsupported metacharacters rather than silently treating them as regex. Traverse sorted `readdir(...,{withFileTypes:true})` entries with `lstat`, do not follow symlinks, enforce limits before adding an entry, and stop when the serialized result would exceed 32 KiB. Do not call `FileService.list()` and only truncate afterward. Check `signal.aborted` between entries. Register `glob` in `userFileTools`; no shell or new API route.
- [x] **Step 4: Verify green.** Rerun Step 2; expect zero failures.

### Task 3: Literal, bounded `grep`

**Files:** Modify `src/mastra/files/file-search.ts`, `src/mastra/files/tools.ts`, `tests/file-search.test.ts`, `tests/file-tools.test.ts`.

**Interfaces:** Export `grepFiles(args: { root:string; scope:FileToolScope; threadId:string; basePath?:string; filePattern?:string; query:string; caseSensitive?:boolean; signal?:AbortSignal }): Promise<{ matches:Array<{path:string;lineNumber:number;line:string;lineTruncated:boolean;etag:string}>; scannedFiles:number; skippedBinaryFiles:number; skippedLargeFiles:number; truncated:boolean; reason?:string }>`; register `userFileTools.grep` with the corresponding Zod schema. `filePattern` defaults to `**/*`; `caseSensitive` defaults to `true`.

- [x] **Step 1: Write failing tests.** Test literal characters such as `a.b` (not regex), case sensitivity, Chinese/emoji, CRLF line numbers, one result per matching line, stable order, quoted ETag matching `read_file`, binary/invalid UTF-8 skip, >2 MiB skip, and line clipping at 300 Unicode characters. Test 500-file, 20 MiB, 100-match, 32 KiB, 20,000-entry and abort budgets with explicit `truncated/reason`; assert a query with no match and no truncation is distinguishable from a truncated no-match search. Test scope default/exact workspace path/foreign thread and symlink exclusion.
- [x] **Step 2: Verify red.** Run `node --import tsx --test tests/file-search.test.ts tests/file-tools.test.ts`; expect new grep assertions to fail.
- [x] **Step 3: Implement.** Reuse Task 2's walker/pattern logic, read at most 2 MiB only after size check, use strict UTF-8 decoding and NUL detection, use literal substring matching (`toLowerCase()` only when requested), hash the read bytes for ETag, and stop on each budget. Validate query length in Unicode characters, not UTF-16 code units. Never return whole file content.
- [x] **Step 4: Verify green.** Rerun Step 2; expect zero failures.

### Task 4: Shared versioned exact replacement

**Files:** Modify `src/mastra/files/workspace-editor.ts`, `src/mastra/files/tools.ts`, `tests/workspace-editor.test.ts`, `tests/file-tools.test.ts`.

**Interfaces:** Export `replaceWorkspaceText(filesystem: WorkspaceFilesystem, path: string, oldText: string, newText: string, expectedEtag: string, userId: string): Promise<{etag:string;size:number}>`. Register `userFileTools.edit` with `{path,oldText,newText,expectedEtag,scope?}` and return `{path,etag,size,applicationPath,replacements:1}`. Both `saveWorkspaceText` (web editor) and `replaceWorkspaceText` must call a shared internal versioned mutation routine under the same per-path lock. `edit` resolves the authenticated scope before creating `LocalFilesystem({basePath:root,contained:true})`. URL-encode each path segment for `applicationPath`: `/user-files/<threadId>/<path>` for thread, `/current-workspace/files/<path>` for workspace.

- [x] **Step 1: Write failing tests.** Test one replacement and new ETag/size, empty `newText`, `oldText` zero/two/overlapping occurrences, stale/malformed ETag, missing/binary/invalid UTF-8/symlink target, >10 MiB result, >64 KiB old/new text, NUL, quota exceeded and disk protection. Assert every failure preserves original bytes and quota; concurrent edits sharing an ETag yield exactly one success. Test web `saveWorkspaceText` and tool `edit` share the same lock/version behavior; test one injected write failure leaves no temporary file or pending reservation. Assert application paths contain no host path.
- [x] **Step 2: Verify red.** Run `node --import tsx --test tests/workspace-editor.test.ts tests/file-tools.test.ts`; expect missing replacement/tool failures.
- [x] **Step 3: Implement.** Refactor existing `saveWorkspaceText` so ETag validation, current-byte read, text validation, transformation, size/disk/quota accounting and write occur inside one serialized mutation. Count overlapping old-text matches using a second search starting one character after the first match. Use a temporary file in the target directory and rename only after successful validation/write; remove it on error. Keep existing web editor signature and responses. Use a PostgreSQL transaction-scoped advisory lock keyed by user ID + scope-relative path when `DATABASE_URL` is configured; in-memory per-path queue remains the fallback for a local single process. Ensure the same path key is used by web and Agent edits. Do not add a migration.
- [x] **Step 4: Verify green.** Rerun Step 2; expect zero failures. Where PostgreSQL is available, run the same concurrent edit case in two independent processes and confirm one stale response; otherwise record this as an unverified deployment check.

### Task 5: Tool registration, Agent guidance and full acceptance

**Files:** Modify `src/mastra/agents/agent.ts`, `src/mastra/index.ts` if required, `tests/file-tools.test.ts`, `README.md`; create or modify a focused Agent tool-registration test in `tests/file-tools.test.ts`.

**Interfaces:** `userFileTools` exposes exact keys `glob`, `grep`, `edit`; `resolveAgentTools` exposes them only when `USER_FILES_ENABLED=true`; `src/mastra/index.ts` registers the same object with Mastra. Update instructions to prefer `glob → grep/read_file → edit`, pass the ETag unchanged, re-read on `STALE_VERSION`, and use `read_attached_file` for attachment IDs.

- [x] **Step 1: Write failing tests.** Assert tool IDs and Zod schemas are registered, absent from Agent resolution when user files are disabled, and enabled for regular authenticated users when on. Assert a complete in-memory flow: find `reports/a.md`, grep a line/ETag, edit once, re-read new content/ETag; then search an explicit `uploads/<UUID>/note.txt` via workspace scope. Verify no host path appears in outputs.
- [x] **Step 2: Verify red.** Run `node --import tsx --test tests/file-tools.test.ts`; expect new registration/flow assertions to fail.
- [x] **Step 3: Implement.** Extend `agent.ts` instructions and ensure `src/mastra/index.ts` includes the new tools via `...userFileTools`; update README with scope, budgets, literal search, ETag conflict behavior and examples. Do not add UI, routes or database changes.
- [x] **Step 4: Verify green.** Run `node --import tsx --test tests/file-scope.test.ts tests/file-search.test.ts tests/file-tools.test.ts tests/workspace-editor.test.ts`, then `npm test`, `npm test --prefix web`, `npm run build`, `git diff --check`; expect exit 0 for each.
- [x] **Step 5: Manual acceptance where available.** Run the project with `npm run dev` and an authenticated Agent session: ask it to find, grep, edit and reread a text file; repeat with an uploaded workspace text file. Confirm a stale ETag causes a retry prompt rather than overwrite. Do not modify production files during this test. Record any unavailable live-model or PostgreSQL checks in the implementation report.

## Completion Report

For each task, report changed files, exact test commands/results, any skipped environment-dependent checks and remaining limitations. Verify `git diff --check` and inspect `git diff` before claiming completion. Do not deploy or migrate: this plan adds no SQL migration.
