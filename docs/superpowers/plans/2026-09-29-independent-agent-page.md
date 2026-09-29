# Independent Agent Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在当前分支新增可真实对话的 `/agent/*` 独立页面，以“组件 + Hook”粒度复用 Mastra Studio 同源 UI，并保持现有 Studio 页面可用。

**Architecture:** `web/` 是独立 React + Vite 应用，`/api` 代理到当前 Mastra 服务。页面自行管理路由、会话与 Config 数据，使用 `@mastra/playground-ui` 的公开组件及 `@mastra/react` 的 `useChat`；不导入 Studio 打包页面、不使用 iframe。

**Tech Stack:** React 19、Vite、TypeScript、`@mastra/playground-ui@59.0.0`、`@mastra/react@1.6.3`、`@mastra/client-js@1.50.0`、Tailwind CSS 4；后端保持 `@mastra/core@1.71.0` 与 `mastra@1.31.3`。

**Spec:** `docs/superpowers/specs/2026-09-29-independent-agent-page-design.md`

## Global Constraints

- 在 `dev_sxy1` 当前分支实施，不引用或合并 `dev_sxy` 的源码。
- 用户路由为 `/agent/new`、`/agent/:threadId`；Studio `/agents` 与其 HTML 中间件不变。
- 注册的 Agent id 固定为 `agent`；实施时先确认 Studio 正在使用的会话 `resourceId`，再确定前端取值。现有本地库中同时存在 `agent`、`local-user`、`nero-agent`，不能盲用某个历史值。
- Config 第一版只读；不加入登录、多用户公开访问、模型切换、追踪和评分器。
- 使用项目 `dev`、`build` 脚本，不在执行说明中裸跑 `mastra dev` / `mastra build`。
- 前端只使用已公开的 `playground-ui` 导出。完整 Agent 页面与 Config 面板需要组装；不要复制 Studio 打包 JS 或 CSS 选择器。
- 真实流式验收必须使用已配置的可用模型；模拟文本仅用于组件测试。

## Review Focus

1. Studio 与独立页的会话作用域不一致：同一 thread 不能意外丢失或串到别的 `resourceId`。Task 2 测试此边界。
2. 流式消息中止或失败：已收到的文本保留，页面明确显示未完成。Task 3 测试此状态。
3. 工具批准重复点击或拒绝后继续：只提交一次操作，状态与服务端一致。Task 4 测试此行为。
4. 不存在或无权访问的 thread：跳回新建页并显示提示，不渲染旧会话内容。Task 2 测试此行为。
5. Config 数据缺字段：显示“未提供”或省略对应项，不推测服务端配置。Task 5 测试此行为。

## File Structure

| 文件 | 职责 |
| --- | --- |
| `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json`, `web/index.html` | 独立前端构建与 `/api` 代理 |
| `web/src/main.tsx`, `web/src/App.tsx`, `web/src/styles.css` | Provider、路由及主题入口 |
| `web/src/agent/client.ts` | 唯一 Mastra Client 实例与 Agent id |
| `web/src/agent/thread-scope.ts` | Studio 会话作用域及 thread 校验 |
| `web/src/agent/use-thread-list.ts` | 会话查询、创建、刷新和错误状态 |
| `web/src/agent/ThreadSidebar.tsx` | `ThreadList` 组件组装 |
| `web/src/agent/AgentPage.tsx` | 三栏页面与路由状态 |
| `web/src/agent/AgentChat.tsx` | `useChat`、消息流与操作绑定 |
| `web/src/agent/AgentComposer.tsx` | `Composer` 输入、提交与停止 |
| `web/src/agent/MessageList.tsx`, `web/src/agent/message-parts.ts` | 消息部件和运行状态展示 |
| `web/src/agent/ConfigPanel.tsx` | 只读 Agent 详情及折叠交互 |
| `web/src/agent/*.test.ts(x)` | 作用域、会话、流式、批准与缺字段验证 |
| `package.json`, `README.md` | 根脚本与启动说明 |

---

### Task 1: 独立前端入口和 Studio 共存

**Files:** Create `web/package.json`, `web/package-lock.json`, `web/vite.config.ts`, `web/tsconfig.json`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/styles.css`, `web/src/agent/client.ts`, `web/src/App.test.tsx`; modify root `package.json`, `package-lock.json`, `README.md`.

**Interfaces:** Produces `/agent/new` and `/agent/:threadId` React routes; `/api` from web points to the existing Mastra service. `web/src/agent/client.ts` exports `client` and `AGENT_ID = 'agent'`.

- [ ] Create `web/package.json` with compatible UI packages plus Vitest and DOM test dependencies, then install them to establish a test runner.
- [ ] Add a route smoke test: `/agent/new` renders, an unknown web route falls back to `/agent/new`, and the new app contains no iframe; run `npm run test --prefix web -- src/App.test.tsx` and confirm it fails before the route exists.
- [ ] Create the Vite app with the `playground-ui` stylesheet, `MastraReactProvider` and QueryClient provider. Add root scripts that start/build both projects while retaining separate `build:mastra` and `build:web` targets.
- [ ] Run `npm run test --prefix web -- src/App.test.tsx` and `npm run build`; confirm both pass. Run `npm run dev`; verify independent page and Studio can open concurrently, including Studio `/agents` and a tool page.
- [ ] Commit the independently runnable shell and documentation.

### Task 2: 对齐 Studio 会话作用域并实现列表

**Files:** Create `web/src/agent/thread-scope.ts`, `web/src/agent/use-thread-list.ts`, `web/src/agent/ThreadSidebar.tsx`, `web/src/agent/AgentPage.tsx`, `web/src/agent/thread-scope.test.ts`, `web/src/agent/use-thread-list.test.tsx`.

**Interfaces:** `client.ts` exports `AGENT_ID`; `thread-scope.ts` exports `RESOURCE_ID` after verification. `useThreadList()` returns `{ threads, loading, error, refresh, createThread }`. `ThreadSidebar` receives the current id and navigation callbacks.

- [ ] Inspect Studio's current Agent page requests and compare with existing thread records. Confirm its `resourceId` before coding the constant; record the observed value and method in a short note in `thread-scope.ts`. If the Studio value is not stable, derive it from a documented runtime source instead of hardcoding.
- [ ] Write tests for listing only the chosen resource's threads, sorting by `updatedAt`, creating a thread, and rejecting an unavailable thread without showing stale messages; verify they fail.
- [ ] Implement list/create/read using `MastraClient.listMemoryThreads`, `createMemoryThread`, and `getMemoryThread`, with `agentId` and `resourceId` supplied according to the installed SDK types. Compose the sidebar from `ThreadList` exports; route `/agent/new` to `/agent/:threadId` after creation.
- [ ] Run `npm run test --prefix web -- src/agent/thread-scope.test.ts src/agent/use-thread-list.test.tsx` and `npm run build:web`. Manually open one Studio-created conversation from the independent list, refresh, and confirm messages belong to that thread.
- [ ] Commit the thread feature.

### Task 3: Composer 与真实流式消息

**Files:** Create `web/src/agent/AgentChat.tsx`, `web/src/agent/AgentComposer.tsx`, `web/src/agent/MessageList.tsx`, `web/src/agent/message-parts.ts`, `web/src/agent/AgentChat.test.tsx`; modify `AgentPage.tsx`.

**Interfaces:** `AgentChat` consumes `{ threadId, resourceId, initialMessages }`; it owns `useChat({ agentId: AGENT_ID, resourceId, threadId, initialMessages })`. `AgentComposer` receives `{ draft, isRunning, onSend, onStop }`; `MessageList` receives Hook messages and running/error state.

- [ ] Add tests that send with `mode: 'stream'`, show successive assistant text updates, retain partial text after abort/error, and disable duplicate submit while running; verify they fail.
- [ ] Compose `ChatShell`, `Composer`, `Message`, and `MarkdownRenderer`. Bind send/stop to `useChat.sendMessage` and `cancelRun`. The UI must not implement its own SSE parser. Show a clear unfinished state on abort/error.
- [ ] Run `npm run test --prefix web -- src/agent/AgentChat.test.tsx` and `npm run build:web`. With a valid model key, send a real multi-turn message and verify text arrives incrementally and survives refresh. If the current OpenAI model lacks credentials, report the exact missing prerequisite; do not substitute the simulated stream for this check.
- [ ] Commit the conversation feature.

### Task 4: 工具调用与批准交互

**Files:** Modify `MessageList.tsx`, `message-parts.ts`, `AgentChat.tsx`; create `web/src/agent/tool-approval.test.tsx`.

**Interfaces:** `message-parts.ts` turns public Mastra message parts into text, tool and approval view models. `MessageList` calls `onApprove(toolCallId)` or `onDecline(toolCallId)` exactly once per pending action; `AgentChat` binds them to the corresponding `useChat` methods.

- [ ] Add tests for tool pending, approved, declined, duplicate clicks, and API failure while preserving the visible pending decision; verify they fail.
- [ ] Use public `playground-ui` tool-call and tool-approval components. Follow the installed `@mastra/react` message types, including persisted and streamed tool part shapes. Keep approval disabled while submitting and show tool name plus operation summary.
- [ ] Run `npm run test --prefix web -- src/agent/tool-approval.test.tsx` and `npm run build:web`. Exercise one safe real approval and one refusal without executing a dangerous command; verify state after reopening the thread.
- [ ] Commit the tool interaction feature.

### Task 5: 只读 Config 面板

**Files:** Create `web/src/agent/ConfigPanel.tsx`, `web/src/agent/ConfigPanel.test.tsx`; modify `AgentPage.tsx`.

**Interfaces:** `ConfigPanel` accepts the installed SDK `GetAgentResponse` plus optional `GetMemoryConfigResponse`; its parent fetches them via `client.getAgent(AGENT_ID).details()` and `client.getMemoryConfig({ agentId: AGENT_ID })`. The panel performs no mutation.

- [ ] Add tests for populated Agent details, absent optional fields, and expand/collapse behavior; verify they fail.
- [ ] Compose the panel from `SectionCard` and `SettingsRow` or other public primitives. Display overview, model, tools, workspace, memory and instructions only when returned; render “未提供” for absent required display slots. No editing controls.
- [ ] Run `npm run test --prefix web -- src/agent/ConfigPanel.test.tsx` and `npm run build:web`. Compare displayed values with Studio, Agent details and memory config responses.
- [ ] Commit the Config feature.

### Task 6: 双页面回归与交付

**Files:** Modify `README.md` only if final commands or limitations differ from earlier tasks; add no new product feature.

**Interfaces:** Delivers a working `/agent/*` and unchanged Studio `/agents` under `npm run dev`.

- [ ] Run root `npm test`, root `npm run build`, and `npm run test --prefix web`. Record commands and results.
- [ ] In a browser, verify new conversation, existing conversation, stream, stop, tool approval/refusal, Config, and Studio Agent/tool/observability pages. Check console errors and refresh behavior.
- [ ] Confirm `git diff` does not modify `src/mastra/studio-zh.ts` or Studio assets, and note that this build still uses a shared local workspace and lacks multi-user authorization.
- [ ] Commit any required fixes and summarize completed behavior plus any unverified live checks.
