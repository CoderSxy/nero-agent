# Public and Private Model Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. If Cursor cannot load those skills, follow the same test-first, one-task-at-a-time sequence directly.

**Goal:** Replace environment-variable-based model connection selection with admin-managed public models and user-owned private models, both usable by the existing Agent for chat and memory.

**Architecture:** PostgreSQL stores separate public and private model records with encrypted keys. A shared server-side resolver turns an authorized `public:<uuid>` or `private:<uuid>` reference into Mastra's OpenAI-compatible model configuration. The independent Agent page manages private records; a project-owned page on port 4111 manages public records.

**Tech Stack:** TypeScript, Mastra `@mastra/core@1.71.0`, PostgreSQL/`pg`, React/Vite/Vitest, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-04-model-catalog-design.md` (read fully before Task 1).

## Cursor execution instructions

- Read `AGENTS.md` and `.claude/skills/mastra/SKILL.md` first. Before editing Mastra code, check the installed embedded docs and `.d.ts` files for dynamic `Agent.model`, dynamic `Agent.memory`, `OpenAICompatibleConfig`, `RequestContext`, and `registerApiRoute`; do not rely on remembered APIs.
- Work on the current checkout unless the human explicitly chooses another workspace. Check `git status --short` before each task. Preserve unrelated and uncommitted user changes; stage only task files.
- Execute tasks in order. For each behavior, add the stated failing test, run it and record the expected failure, implement, rerun the focused test, run the relevant root/web suite, then commit that task. Do not batch all tests at the end.
- Use `npm run dev` / `npm run build` from `package.json`; never invoke `mastra dev` or `mastra build` directly. Do not place real API keys in fixtures, command output, commits, browser storage, or logs.
- Stop and report a concrete blocker if the installed Mastra API cannot enforce the model authorization or the endpoint policy below. Do not silently fall back to client-supplied `model` or environment-variable providers.

## Global Constraints

- Register all agents, tools, workflows, and scorers in `src/mastra/index.ts`; add custom API routes to its `server.apiRoutes`.
- First version uses only OpenAI-compatible chat endpoints. Native Anthropic/Gemini protocols, auto-discovery, billing, and shared credential pools are outside scope.
- API keys are encrypted with `MODEL_CONFIG_ENCRYPTION_KEY` (Base64 of exactly 32 bytes) using AES-256-GCM. Read responses return only `hasApiKey` and last-four `keyHint`; never plaintext.
- Model references are `public:<uuid>` or `private:<uuid>`. Server-side auth and owner checks apply to every resolution; client-provided `resourceId`, model ref, and `RequestContext` never establish identity.
- A private endpoint must use HTTPS and an origin in admin-configured `MODEL_ENDPOINT_ALLOWLIST` (comma-separated exact origins). No allowlist means no custom model save/call; document how to add approved origins. Reject loopback, private/link-local IPs, URL credentials, fragments and redirects to unapproved origins. A development-only allowlist may include local test origins when explicitly enabled; production must not.
- Existing `neroAgentModels` metadata key remains. `provider/model` legacy values may convert only when exactly one enabled public record matches; otherwise show history and require explicit reselection.
- Admin public management runs at `/model-admin` on port 4111 and may require separate login. Independent page settings contain a private “API Key 管理” submenu. Existing theme control remains.

## File Map

| File | Responsibility |
| --- | --- |
| `migrations/002_model_catalog.sql` | Two tables, ownership FK, checks and indexes |
| `src/mastra/models/types.ts` | Shared refs, safe DTOs, input and domain error types |
| `src/mastra/models/crypto.ts` | Encryption and masked-key metadata |
| `src/mastra/models/endpoint-policy.ts` | URL normalization and allowlist checks |
| `src/mastra/models/repository.ts` | Parameterized SQL for both tables; owner-scoped private queries |
| `src/mastra/models/service.ts` | Validation, CRUD, selection list, default and legacy matching |
| `src/mastra/models/resolver.ts` | Authorized model ref to Mastra config; chat/memory context keys |
| `src/mastra/models/routes.ts` | Authenticated catalog/admin HTTP routes |
| `src/mastra/models/admin-page.ts` | Self-contained `/model-admin` HTML/CSS/JS |
| `src/mastra/agents/agent.ts`, `memory-model.ts`, `src/mastra/index.ts` | Dynamic model wiring and route registration |
| `web/src/agent/model-settings.ts`, `AgentPage.tsx`, `AgentChat.tsx`, `ModelSettingsMenu.tsx` | Reference-based selection, legacy state and UI |
| `web/src/agent/client.ts`, `model-catalog-client.ts`, `PrivateModelMenu.tsx` | Bearer-authenticated catalog API client and private management submenu |
| `src/mastra/studio-zh.ts`, `web/src/styles.css`, `README.md`, `.env.example` | Studio entry, styling and configuration instructions |

## Review Focus

1. Forged `RequestContext.user` with a real user's token must not unlock another user's private model (Task 5 runtime test).
2. Editing a model without `apiKey`, or with an empty `apiKey`, must respectively retain the old secret or return 400 (Tasks 2 and 4 tests).
3. A key replacement after a previous memory call must take effect on the next call, with no stale cached `Memory` instance (Task 5 test).
4. Ambiguous legacy `provider/model` matches must not silently choose one record (Task 6 test).
5. Disabled/deleted current selection must preserve message history but block the next send with a reselect message (Tasks 5 and 7 tests).

---

### Task 1: Schema and shared model contract

**Files:** Create `migrations/002_model_catalog.sql`, `src/mastra/models/types.ts`, `tests/model-schema.test.ts`; modify `package.json` only if adding a DB test script is needed.

**Interfaces:** Produce `ModelRef = \`public:${string}\` | \`private:${string}\``, `ModelScope`, `SafeModel`, `ModelInput`, `ModelCatalogError` and `parseModelRef(value: unknown): { scope: ModelScope; id: string } | null`. Fields and constraints match spec §4. Later tasks import these exact names.

- [ ] Write `parseModelRef accepts scoped UUIDs only`: assert `parseModelRef('public:550e8400-e29b-41d4-a716-446655440000')?.scope === 'public'` and `parseModelRef('openai/gpt') === null`. In a DB-gated test, insert public/private rows, verify the private owner FK and assert a second `is_default=true` public row fails with unique violation `23505`.
- [ ] Run `node --env-file-if-exists=.env --import tsx --test tests/model-schema.test.ts`; confirm failure because the contract or tables are absent.
- [ ] Add the type/ref parser and migration. Keep schema SQL independent of application code. Run `npm run db:migrate` against the configured test/local DB; then rerun the focused test and confirm pass. Test migration rerun with `npm run db:migrate` again.
- [ ] Run `npm test`; commit only Task 1 files with `feat: add public and private model schema`.

### Task 2: Key encryption and endpoint policy

**Files:** Create `src/mastra/models/crypto.ts`, `endpoint-policy.ts`, `tests/model-security.test.ts`; modify `.env.example` to document required encryption key and allowlist names.

**Interfaces:** Produce `encryptApiKey(plain: string): string`, `decryptApiKey(ciphertext: string): string`, `keyHint(plain: string): string`, `normalizeModelEndpoint(raw: string): URL`, `assertAllowedEndpoint(url: URL): Promise<void>`. `MODEL_CONFIG_ENCRYPTION_KEY` is parsed once per call or safely cached only by value; a wrong/missing key fails closed.

- [ ] Write `model key encryption is authenticated`: assert `decryptApiKey(encryptApiKey('sk-test-1234')) === 'sk-test-1234'`, two encryptions differ, tampering/wrong key throws, and `keyHint('sk-test-1234')` reveals at most `1234`. Write `endpoint policy rejects unsafe URLs`: assert HTTP, URL credentials, fragments, loopback/private/link-local/metadata addresses, and origins absent from `MODEL_ENDPOINT_ALLOWLIST` reject.
- [ ] Run `node --import tsx --test tests/model-security.test.ts`; confirm feature-missing failures.
- [ ] Implement versioned AES-256-GCM payload and exact-origin URL policy. Do not accept redirects to other origins; if installed model transport cannot enforce that, document and use the approved-origin restriction with a trusted provider list as required by spec §5.
- [ ] Rerun focused test and `npm test`; commit as `feat: protect model credentials and endpoints`.

### Task 3: Owner-scoped repository and catalog service

**Files:** Create `src/mastra/models/repository.ts`, `service.ts`, `tests/model-catalog-db.test.ts`.

**Interfaces:** Produce `listSelectableModels(user: AuthUser): Promise<SafeModel[]>`, `listManagedModels(scope: ModelScope, user: AuthUser): Promise<SafeModel[]>`, `createModel(scope: ModelScope, user: AuthUser, input: ModelInput): Promise<SafeModel>`, `updateModel(scope: ModelScope, id: string, user: AuthUser, patch: Partial<ModelInput>): Promise<SafeModel>`, `deleteModel(scope: ModelScope, id: string, user: AuthUser): Promise<void>`, `findAuthorizedModel(ref: ModelRef, user: AuthUser): Promise<ModelRecord>`, and `matchLegacyPublicModel(value: string): Promise<ModelRef | null>`. `ModelRecord` is server-only and contains ciphertext; safe DTOs do not.

- [ ] Write DB tests with one admin and two users. Assert `listSelectableModels(userB)` contains enabled public + user B's private ref and excludes user A's ref; `updateModel('private', userARecord.id, userB, ...)` returns not-found; `createModel('public', userB, ...)` is forbidden; disabling a record removes it from selection; setting a new default leaves exactly one default; two matching public rows make `matchLegacyPublicModel('provider/model') === null`.
- [ ] Run `node --env-file-if-exists=.env --import tsx --test tests/model-catalog-db.test.ts` against a migrated local/test DB; confirm service-missing failures. Mark only this DB integration test `skip` when `DATABASE_URL` is absent, following `tests/auth-db.test.ts`.
- [ ] Implement repository SQL with parameter binding and owner predicates; service enforces admin role, trims/validates fields, encrypts new Key and maps to safe DTO. `PATCH` omitted Key retains ciphertext; empty Key rejects. Use a transaction for changing public default.
- [ ] Rerun focused test and `npm test`; commit as `feat: add authorized model catalog service`.

### Task 4: Authenticated catalog HTTP API

**Files:** Create `src/mastra/models/routes.ts`, `tests/model-routes.test.ts`; modify `src/mastra/index.ts` to append `modelRoutes` to existing `authRoutes`.

**Interfaces:** Export `modelRoutes` as Mastra `registerApiRoute` entries for every method/path in spec §5. Use existing `AuthUser` from server auth context. Return safe DTOs and consistent `{ error: string }` responses with 400/401/403/404 statuses.

- [ ] Write route tests for `GET /model-catalog` and both CRUD sets. Assert no-token status 401, non-admin public POST status 403, foreign private PATCH/DELETE status 404, omitted `apiKey` leaves the stored Key usable, `apiKey: ''` returns 400, and `JSON.stringify(response)` never contains fixture secret `sk-test-1234`. Test registered handlers or an in-process Mastra/Hono server, not a mock copy of routing logic.
- [ ] Run `node --env-file-if-exists=.env --import tsx --test tests/model-routes.test.ts`; confirm missing-route failures.
- [ ] Implement and register routes. Route bodies use JSON validation with size limits; authentication/role decisions use server-established identity. Keep `GET /model-catalog` selectable-only and management lists inclusive of disabled records.
- [ ] Rerun focused test and `npm test`; commit as `feat: expose model catalog API`.

### Task 5: Connect Agent chat and memory to the authorized catalog

**Files:** Create `src/mastra/models/resolver.ts`, `tests/model-resolver.test.ts`; modify `src/mastra/agents/agent.ts`, `memory-model.ts`, `tests/agent-memory-model.test.ts`.

**Interfaces:** Produce `resolveModel(ref: ModelRef, user: AuthUser): Promise<OpenAICompatibleConfig>` and exported context keys `chatModelRefContextKey = 'nero-agent.chat-model-ref'`, `memoryModelRefContextKey = 'nero-agent.memory-model-ref'`. `Agent.model` and `Agent.memory` resolve per request. No public default means Studio requests without a ref fail with “请先配置公共模型”.

- [ ] Write `resolveModel enforces current user`: assert the public and own-private refs produce their stored `id`, `url`, decrypted `apiKey`, `api`; `resolveModel(otherUserRef, user)` and a disabled ref reject. Through an authenticated Agent request, send forged `requestContext.user` and assert the other user's ref remains forbidden. Assert memory observation, reflection and title use the chosen record; replace its Key and assert the next request uses the new Key.
- [ ] Run `node --env-file-if-exists=.env --import tsx --test tests/model-resolver.test.ts tests/agent-memory-model.test.ts`; confirm expected failures against current string-based implementation.
- [ ] Implement dynamic Mastra model and memory callbacks using the installed API types. Do not pass a client `model` override. Create request-scoped `Memory` or use a cache keyed by record version so Key changes take effect. Validate the selected ref at the trusted server entry before model resolution and again where Mastra requires it.
- [ ] Rerun focused tests and `npm test`; run `npm run build:mastra`; commit as `feat: resolve agent models from catalog`.

### Task 6: Reference-based thread settings and legacy compatibility

**Files:** Modify `web/src/agent/client.ts`, `model-settings.ts`, `model-settings.test.ts`, `AgentChat.tsx`, `AgentChat.test.tsx`, `use-thread-list.ts`; create `web/src/agent/model-catalog-client.ts`.

**Interfaces:** Extend existing `setAgentClientToken(token: string | null)` to hold the token in module memory and produce `apiFetch(path: string, init?: RequestInit): Promise<Response>`. Define browser-side `SafeModel` DTO with the exact fields from spec §4 (no server runtime import), and produce `getSelectableModels(): Promise<SafeModel[]>` in `model-catalog-client.ts`, `readThreadModels(metadata: unknown, catalog: SafeModel[]): { settings: Partial<ModelSettings>; invalid: boolean }`, `getDefaultModels(catalog: SafeModel[]): ModelSettings | null`, `createModelRequestContext(settings: ModelSettings): RequestContext`. `ModelSettings` values are model refs. Preserve unrelated thread metadata.

- [ ] Update tests: assert `getDefaultModels(catalog)` picks `isDefault` public before other entries; `readThreadModels()` maps a unique legacy string to its public ref and returns `invalid: true` for ambiguous/missing matches; a foreign private ref is invalid; `useChat.sendMessage()` options have no `model` property and context contains both selected refs.
- [ ] Run `npm run test --prefix web -- src/agent/model-settings.test.ts src/agent/AgentChat.test.tsx`; confirm current behavior fails the new assertions.
- [ ] Implement catalog client and reference-based utilities. Change thread creation/update to save refs only; block send when `invalid` or current ref disappears. Remove `providerModelIds()` and `listAgentsModelProviders()` from independent-page selection flow.
- [ ] Rerun focused tests and `npm run test --prefix web`; commit as `feat: store catalog model refs in threads`.

### Task 7: Private management submenu and chooser UI

**Files:** Create `web/src/agent/PrivateModelMenu.tsx`, `PrivateModelMenu.test.tsx`; modify `AgentPage.tsx`, `ModelSettingsMenu.tsx`, `ModelSettingsMenu.test.tsx`, `ThreadSidebar.tsx`, `web/src/styles.css`.

**Interfaces:** `PrivateModelMenu` consumes authenticated catalog CRUD functions from Task 6; `ModelSettingsMenu` receives grouped `SafeModel[]` and current `ModelSettings`. On mutation, `AgentPage` refreshes the catalog without resetting thread messages or theme.

- [ ] Write UI tests that click “设置 → API Key 管理”, submit a private record, then assert it appears only in “我的模型”; edit with blank Key and assert the request omits `apiKey`; replace Key and assert the request includes it; disable/delete and assert a current selection shows “重新选择模型” and send is blocked. Assert “公共模型” group and theme control still render.
- [ ] Run `npm run test --prefix web -- src/agent/PrivateModelMenu.test.tsx src/agent/ModelSettingsMenu.test.tsx src/agent/AgentPage.test.tsx`; confirm the new behavior fails.
- [ ] Implement forms, safe DTO rendering and explicit delete confirmation; never persist Key to browser storage, URL or thread metadata. Make submit and send controls respond to loading/error states.
- [ ] Rerun focused tests, `npm run test --prefix web`, and `npm run build:web`; commit as `feat: manage private models in agent settings`.

### Task 8: Port-4111 public management page and Studio entry

**Files:** Create `src/mastra/models/admin-page.ts`, `tests/model-admin-page.test.ts`; modify `src/mastra/index.ts`, `src/mastra/studio-zh.ts`, `tests/studio-zh.test.ts`.

**Interfaces:** `GET /model-admin` serves project-owned HTML with login and public-model CRUD. The injected Studio Settings link targets `/model-admin`; data calls use admin-only `/model-catalog/public` routes.

- [ ] Write tests that `localizeStudioHtml(studioHtml)` contains exactly one `/model-admin` link, and non-Studio HTML is unaffected; assert served admin HTML has create/edit/replace-Key/enable/default/delete controls. In DOM or browser-level tests, return 401 and 403 from public API and assert login or “无权访问” appears rather than editable controls.
- [ ] Run `node --import tsx --test tests/model-admin-page.test.ts tests/studio-zh.test.ts`; confirm failure from missing page/link.
- [ ] Serve the page using a Mastra custom route; implement separate `/auth/login` flow for this page with per-tab session storage. Insert the link narrowly in the existing Studio localization layer, without importing or modifying upstream Studio bundles.
- [ ] Rerun focused tests, `npm test`, and `npm run build:mastra`; commit as `feat: add public model admin page`.

### Task 9: Remove old connection path and complete integration checks

**Files:** Modify `README.md`, `.env.example`, any remaining imports in `web/src/agent/*`; update affected existing tests. Do not delete unrelated auth, Studio or Agent features.

**Interfaces:** Existing login and thread APIs continue to work; model selection exclusively uses catalog refs. Document `MODEL_CONFIG_ENCRYPTION_KEY`, `MODEL_ENDPOINT_ALLOWLIST`, migration, public-model bootstrap and the two management URLs.

- [ ] Write/update a regression test that rejects an arbitrary `provider/model` string as a new selection and confirms the independent page obtains choices from `GET /model-catalog` even when `VITE_AGENT_MODEL` is set. Run it and observe failure before cleanup.
- [ ] Remove obsolete provider connection code, environment-based model selection and old README guidance. Document public bootstrap before using Studio and how old threads prompt for reselection.
- [ ] Run `npm test`, `npm run test --prefix web`, `npm run build`, and `npm run db:migrate` against a provisioned local/test database. Check `git diff --check`. If a real test credential is available, verify one public and one private chat request plus memory behavior without printing the Key; otherwise report that live-provider verification was unavailable.
- [ ] Re-read every acceptance item in spec §8; record exact command results and remaining limitations in the implementation handoff. Commit as `feat: complete model catalog migration`.
