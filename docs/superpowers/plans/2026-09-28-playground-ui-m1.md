# Playground-UI Agent 壳 M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `http://127.0.0.1:5173` 用 `@mastra/playground-ui` + `@mastra/react` 的真实 Agent 对话主区跑通多轮对话，并修正默认模型为 DeepSeek。

**Architecture:** 保留现有中文左栏与路由；中间对话区替换为 `MastraReactProvider` + `useChat` + `ChatShell`/`Composer`（playground-ui）。Vite 继续把 `/api` 代理到 Mastra `:4111`。Config / Traces 完整对齐留给 M2–M3。

**Tech Stack:** 现有 Vite React 壳；新增 `@mastra/playground-ui@59.0.0`、`@mastra/react@1.6.3`、`@mastra/client-js@1.50.0`、`@tanstack/react-query@^5.90.21`、`lucide-react@^1.37.0`、`tailwindcss@^4`、`@tailwindcss/vite@^4`。后端 `@mastra/core@1.71.0` / `mastra@1.31.3` 保持不动。

## Global Constraints

- Agent id = `agent`；`resourceId = local-user`
- 默认模型改为 `deepseek/deepseek-v4-flash`（匹配 `.env` 的 `DEEPSEEK_API_KEY`）
- M1 不做完整右侧 Config、不做 Traces；左栏继续用现有中文 `LeftPanel`
- 不引入 iframe 作为对话主区
- 用 `npm run dev` / `npm run build`；不要要求日常裸跑 `mastra
  dev`
- 安装 registry 用 `https://registry.npmjs.org`（避免 npmmirror 403）
- 不提交 `.env`、`.superpowers/`、`web/tsconfig.tsbuildinfo`

## File Structure

| 文件 | 职责 |
|---|---|
| `src/mastra/agents/agent.ts` | 默认模型改为 DeepSeek |
| `.env.example` | 文档化 `DEEPSEEK_API_KEY` |
| `web/package.json` | 新增 Mastra UI / React / Tailwind 依赖 |
| `web/vite.config.ts` | Tailwind Vite 插件；保持 `/api` 代理 |
| `web/src/index.css` | 引入 playground-ui `style.css` + Tailwind |
| `web/src/mastra-provider.tsx` | `QueryClientProvider` + `MastraReactProvider` |
| `web/src/components/AgentChatPanel.tsx` | `useChat` + ChatShell/Composer 对话主区 |
| `web/src/pages/ChatPage.tsx` | 左栏保留；中栏改为 `AgentChatPanel` |
| `web/src/main.tsx` / `App.tsx` | 包上 provider |
| `tests/chat-shell.test.ts` | 增加模型默认值断言；退役与主路径无关的旧流式 UI 断言时保持通过 |
| `README.md` | 注明 DeepSeek 密钥与 5173 对话入口 |

---

### Task 1: 默认模型改为 DeepSeek

**Files:**
- Modify: `src/mastra/agents/agent.ts`
- Modify: `.env.example`
- Modify: `tests/chat-shell.test.ts`（或新建 `tests/agent-model.test.ts`）
- Modify: `README.md`（Get started 补一句 DeepSeek）

**Interfaces:**
- Consumes: 无
- Produces: Agent `model === 'deepseek/deepseek-v4-flash'`

- [ ] **Step 1: Write the failing test**

新建 `tests/agent-model.test.ts`：

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('agent default model uses DeepSeek', () => {
  const source = readFileSync(new URL('../src/mastra/agents/agent.ts', import.meta.url), 'utf8');
  assert.match(source, /model:\s*'deepseek\/deepseek-v4-flash'/);
  assert.doesNotMatch(source, /model:\s*'openai\/gpt-5\.6-terra'/);
});

test('env example documents DEEPSEEK_API_KEY', () => {
  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(envExample, /DEEPSEEK_API_KEY=/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/agent-model.test.ts`

Expected: FAIL（仍是 openai 模型 / `.env.example` 无 DEEPSEEK）

- [ ] **Step 3: Write minimal implementation**

`src/mastra/agents/agent.ts` 把：

```typescript
model: 'openai/gpt-5.6-terra',
```

改成：

```typescript
model: 'deepseek/deepseek-v4-flash',
```

`.env.example`：

```bash
DEEPSEEK_API_KEY=
TAVILY_API_KEY=
# Optional if you switch the agent model to an OpenAI id:
# OPENAI_API_KEY=
```

README Get started 在密钥说明处加上：本地对话需要 `DEEPSEEK_API_KEY`。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/agent-model.test.ts`

Expected: PASS。

然后重启或依赖已运行的 `npm run dev` 热更新后，对 `http://localhost:4111/api/agents/agent/stream` 发一条带 `memory.thread`/`resource` 的请求，确认 SSE 出现 `text-delta` 而不是 `OPENAI_API_KEY` 错误（手工）。若仍失败，检查进程是否加载了 `.env` 中的 `DEEPSEEK_API_KEY`。

- [ ] **Step 5: Commit**

```bash
git add src/mastra/agents/agent.ts .env.example README.md tests/agent-model.test.ts
git commit -m "$(cat <<'EOF'
fix: default the agent model to DeepSeek

EOF
)"
```

---

### Task 2: 安装 playground-ui 依赖与 Tailwind

**Files:**
- Modify: `web/package.json`
- Modify: `web/vite.config.ts`
- Create: `web/src/index.css`（或改名替换现有 `styles.css` 的入口职责）
- Modify: `web/src/main.tsx`
- Test: `tests/agent-model.test.ts` 保持绿；新增依赖锁定文件

**Interfaces:**
- Consumes: 现有 Vite 代理
- Produces: 可 `import '@mastra/playground-ui/style.css'` 与 `ChatShell` / `Composer`

- [ ] **Step 1: Write the failing test**

追加到 `tests/agent-model.test.ts`（或 `tests/chat-shell.test.ts`）：

```typescript
test('web package depends on playground-ui and mastra react', () => {
  const pkg = JSON.parse(readFileSync(new URL('../web/package.json', import.meta.url), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  assert.ok(pkg.dependencies['@mastra/playground-ui']);
  assert.ok(pkg.dependencies['@mastra/react']);
  assert.ok(pkg.dependencies['@mastra/client-js']);
  assert.ok(pkg.dependencies['@tanstack/react-query']);
  assert.ok(pkg.dependencies.tailwindcss);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/agent-model.test.ts`

Expected: FAIL，缺少依赖。

- [ ] **Step 3: Install and wire CSS**

在 `web/` 执行（强制 npmjs）：

```bash
npm install --registry https://registry.npmjs.org \
  @mastra/playground-ui@59.0.0 \
  @mastra/react@1.6.3 \
  @mastra/client-js@1.50.0 \
  @tanstack/react-query@^5.90.21 \
  lucide-react@^1.37.0 \
  tailwindcss@^4.0.0 \
  @tailwindcss/vite@^4.0.0
```

`web/vite.config.ts`：

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { mastraProxyTarget } from './src/dev-proxy';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: mastraProxyTarget, changeOrigin: true },
    },
  },
});
```

`web/src/index.css`：

```css
@import 'tailwindcss';
@import '@mastra/playground-ui/style.css';

html, body, #root { height: 100%; margin: 0; }
```

`web/src/main.tsx` 改为 `import './index.css'`（可暂时继续 import `./styles.css` 以保留左栏布局，或把左栏规则合并进 `index.css` / 继续双引）。

- [ ] **Step 4: Verify install and typecheck path**

Run:

```bash
node --import tsx --test tests/agent-model.test.ts
npm run build --prefix web
```

Expected: 依赖测试 PASS。若 `build` 因尚未替换页面而仍通过，保持通过；若 playground-ui 的 peer 报错，按报错补齐 peer，不要降到 iframe。

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/package-lock.json web/vite.config.ts web/src/index.css web/src/main.tsx tests/agent-model.test.ts
git commit -m "$(cat <<'EOF'
feat: add playground-ui and Tailwind for the chat shell

EOF
)"
```

---

### Task 3: MastraReactProvider 与 AgentChatPanel

**Files:**
- Create: `web/src/mastra-provider.tsx`
- Create: `web/src/components/AgentChatPanel.tsx`
- Modify: `web/src/App.tsx` 或 `main.tsx` 包 provider
- Modify: `web/src/pages/ChatPage.tsx`（下一任务接线；本任务先实现面板可独立渲染）
- Test: 对 provider baseUrl 与 panel props 的轻量断言（读源码或抽常量）

**Interfaces:**
- Consumes: `AGENT_ID`、`RESOURCE_ID`、`MastraReactProvider`、`useChat`、`ChatShell`、`Composer`
- Produces:

```tsx
export function MastraAppProvider(props: { children: React.ReactNode }): JSX.Element;
export function AgentChatPanel(props: {
  threadId?: string;
  onTitleSeed?: (text: string) => void;
}): JSX.Element;
```

`MastraReactProvider` 使用 `baseUrl: ''`（同源，走 Vite `/api` 代理）。`apiPrefix` 默认 `/api`（若类型要求显式传入则传 `'/api'`）。

`AgentChatPanel` 行为：

1. `const { messages, sendMessage, isRunning, cancelRun, approveToolCall, declineToolCall, isAwaitingToolApproval } = useChat({ agentId: AGENT_ID, resourceId: RESOURCE_ID, threadId })`
2. 用 `ChatShell` 搭舞台：`ChatShell` / `Stage` / `Viewport` / `Content` / `Column` / `Dock`
3. 消息先用可读渲染：用户/助手文本从 `MastraDBMessage` 的 parts/`content` 抽出纯文本；工具调用显示名称 + 审批按钮（调用 `approveToolCall` / `declineToolCall`）。优先使用 `@mastra/playground-ui/domains/chat` 已导出的 text renderer（如 `MessageText`），没有稳定导出则用本地薄包装，但外壳必须是 `ChatShell` + `Composer`
4. `Composer`：`ComposerBox` + `ComposerInput` + 发送/停止按钮；发送调用 `sendMessage({ message: text, mode: 'stream' })`；`isRunning` 时显示停止并 `cancelRun()`
5. 无 `threadId` 时显示欢迎文案「想从哪里开始？」（中文）与建议 prompts（可从 agent metadata 硬编码三条现有英文 prompt，或暂固定三条中文）
6. 发送首条时若父组件需要建 thread，由 ChatPage 负责；面板在已有 `threadId` 时直接 stream

- [ ] **Step 1: Write the failing test**

```typescript
test('MastraAppProvider points at the Vite /api prefix', () => {
  const source = readFileSync(new URL('../web/src/mastra-provider.tsx', import.meta.url), 'utf8');
  assert.match(source, /MastraReactProvider/);
  assert.match(source, /apiPrefix:\s*['"]\/api['"]|baseUrl:\s*['"]['"]/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: 文件不存在。

- [ ] **Step 3: Implement provider and panel**

`web/src/mastra-provider.tsx`：

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MastraReactProvider } from '@mastra/react';
import { useState, type ReactNode } from 'react';

export function MastraAppProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <MastraReactProvider baseUrl="" apiPrefix="/api">
        {children}
      </MastraReactProvider>
    </QueryClientProvider>
  );
}
```

若 `MastraReactProvider` 的 props 不接受 `apiPrefix`，改为只设 `baseUrl: ''` 并确认 client 默认走 `/api`；以安装包的 `.d.ts` 为准。

`AgentChatPanel.tsx`：按上面 Interfaces 实现。审批 UI：当 message parts 中工具状态需要审批或 `isAwaitingToolApproval` 为真时，渲染「批准 / 拒绝」按钮。

`main.tsx` 用 `MastraAppProvider` 包裹 `BrowserRouter`/`App`。

- [ ] **Step 4: Typecheck**

Run: `npm run build --prefix web`

Expected: 通过，或仅剩 ChatPage 未接线的可接受 warning。修好所有 TS 错误再提交。

- [ ] **Step 5: Commit**

```bash
git add web/src/mastra-provider.tsx web/src/components/AgentChatPanel.tsx web/src/main.tsx tests/agent-model.test.ts
git commit -m "$(cat <<'EOF'
feat: add Mastra React chat panel with playground-ui shell

EOF
)"
```

---

### Task 4: ChatPage 接线（中栏替换）

**Files:**
- Modify: `web/src/pages/ChatPage.tsx`
- Keep: `web/src/components/LeftPanel.tsx` 中文历史
- Optionally stop using: `ChatView` 作为主路径（可留文件但路由不再引用）

**Interfaces:**
- Consumes: `AgentChatPanel`、现有 `createMastraClient` 仅用于 list/create thread（或逐步改为 client-js；M1 允许左栏仍用现有 `createMastraClient`）
- Produces: `/chat/new` 与 `/chat/:threadId` 使用 playground-ui 对话区

行为：

1. 左栏逻辑保持（listThreads、标题、新对话）
2. 中栏：`<AgentChatPanel threadId={threadId} />`（`/chat/new` 时 `threadId` 为空）
3. 在 `/chat/new` 发送：需要在面板发送前建 thread。做法二选一（推荐 A）：
   - **A.** `AgentChatPanel` 接收 `ensureThread: (firstMessage: string) => Promise<string>`；无 threadId 时先 `await ensureThread(text)`，由 ChatPage `createThread` + `navigate(..., { replace: true })` + 更新左栏，再让 panel 用返回的 id `sendMessage`
   - **B.** ChatPage 包一层输入只负责建 thread，建完再挂 panel —— 交互差，不采用
4. 去掉对旧 `ChatView`/`streamMessage` 主路径的依赖（停止、审批改由 `useChat`）
5. 保留 list 失败 banner

- [ ] **Step 1: Write the failing test**

```typescript
test('ChatPage renders AgentChatPanel instead of ChatView', () => {
  const source = readFileSync(new URL('../web/src/pages/ChatPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /AgentChatPanel/);
  assert.doesNotMatch(source, /from ['\"]\.\.\/components\/ChatView['\"]/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: 仍 import ChatView。

- [ ] **Step 3: Wire ChatPage**

按推荐 A 改 `ChatPage` 与 `AgentChatPanel` 的 `ensureThread`。确保 StrictMode 下不会重复 create（沿用/简化既有 skipLoad 思路：navigate 后 panel 只带新 threadId 发一次）。

- [ ] **Step 4: Build + unit tests**

Run:

```bash
node --import tsx --test tests/*.test.ts
npm run build --prefix web
```

Expected: 全部 PASS；构建成功。若旧 `chat-shell` 测试仍假设自写 SSE 客户端用于主 UI，保留客户端库测试（仍可用于左栏），不要删掉仍被左栏使用的 `mastra-client` 测试。

- [ ] **Step 5: 手工验收**

1. 停掉旧进程后执行 `npm run dev`
2. 打开 `http://localhost:5173/chat/new`
3. 发送「你好」：URL 变为 `/chat/<id>`，左栏出现中文标题，中间出现助手回复
4. 再发一条，确认多轮上下文
5. 打开 `http://localhost:5173/studio` 仍可进官方 Studio

若对话失败：看 Mastra 终端是否仍报缺 key；确认 `.env` 有 `DEEPSEEK_API_KEY` 且模型已是 DeepSeek。

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/ChatPage.tsx web/src/components/AgentChatPanel.tsx tests
git commit -m "$(cat <<'EOF'
feat: route chat threads through the playground-ui agent panel

EOF
)"
```

---

## Spec coverage (M1 only)

| Spec M1 项 | Task |
|---|---|
| DeepSeek 默认模型 + env 文档 | Task 1 |
| 安装 playground-ui / client / react / Tailwind | Task 2 |
| 对话主区组件复用（ChatShell/Composer/useChat） | Task 3–4 |
| 保留中文左栏与路由 | Task 4 |
| 真实可对话验收 | Task 4 Step 5 |
| Config / Traces | 不在 M1 |

## 计划自检

- 无 TBD；`MastraReactProvider` props 以实现时包内 `.d.ts` 为准并在 Task 3 写明回退。
- 版本钉死在 Global Constraints。
- M2/M3 不在本计划展开。
