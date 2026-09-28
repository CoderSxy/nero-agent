# 中文对话外壳 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在本仓库增加中文对话站：左栏历史、右栏自建 Agent 对话，`npm run dev` 同时拉起 Mastra 与外壳，`/studio` 用 iframe 打开现有 Studio。

**Architecture:** Vite + React 外壳走同域代理访问 Mastra 已有 HTTP API（`POST /api/memory/threads` 建会话，`POST /api/agents/agent/stream` 以 SSE `fullStream` 流式回复，`approve-tool-call` / `decline-tool-call` 处理审批）。会话仍写入现有 LibSQL Memory。Studio SPA 的资源路径固定在根上，不能改写成 `/studio` 子路径，因此管理入口是外壳路由 `/studio` 内的全屏 iframe，指向 `http://127.0.0.1:4111`。

**Tech Stack:** Vite 8、React 19、react-router-dom 7、TypeScript、Node 22 `tsx --test`、根目录 `concurrently`。Mastra 保持已安装版本（`@mastra/core` 1.71.0，`mastra` 1.31.3）。不要引入 `@mastra/client-js`。

## Global Constraints

- 固定 `resourceId = local-user`，Agent id = `agent`（与 `src/mastra/index.ts` 的注册键一致）。
- 左栏主标题：自定义标题（`metadata.customTitle` 字符串，第一版 UI 不提供改名）→ 否则服务端 `thread.title`（创建时写成首条用户提问）→ 否则「新对话」。过长单行省略，`title` 属性展示全文。
- 副标题优先 `updatedAt`，否则 `createdAt`，格式示例：`2026年9月28日 11:12:38`（月、日不补零；时分秒两位）。
- 列表按 `updatedAt` 倒序。
- `/` 固定重定向到 `/chat/new`。
- 首条消息：先 `POST /api/memory/threads?agentId=agent`，`history.replace` 到 `/chat/:threadId`，左栏立刻插入，再对该 thread 流式发送。
- 第一版不做登录、多用户、附件、语音、独立搜索开关、Studio UI 汉化、会话删除/改名 UI。
- 用户入口是 Vite 端口（默认 5173）；Mastra 仍在 4111（API + Studio 本体）。
- Memory `generateTitle` 改为 `false`，避免自动标题覆盖首条提问。
- 用 `npm run dev` / `npm run build` 脚本，不要在文档里要求裸跑 `mastra dev` 作为日常入口。
- 界面中文；第一版浅色；左栏宽 280px，可折叠。

## File Structure

| 文件 | 职责 |
|---|---|
| `web/package.json` | 前端依赖与 `dev`/`build` |
| `web/vite.config.ts` | 端口 5173，把 `/api` 代理到 Mastra |
| `web/src/dev-proxy.ts` | 代理目标常量，供配置和测试共用 |
| `web/src/constants.ts` | `AGENT_ID`、`RESOURCE_ID`、`MASTRA_ORIGIN` |
| `web/src/lib/thread-label.ts` | 标题、时间、排序 |
| `web/src/lib/sse.ts` | 解析 SSE `data:` 帧 |
| `web/src/lib/stream-reducer.ts` | 把 chunk 汇总成气泡、思考、工具卡 |
| `web/src/lib/mastra-client.ts` | 线程、消息、流式、中止、审批 |
| `web/src/styles.css` | 浅色布局 |
| `web/src/components/LeftPanel.tsx` | 新对话 + 历史列表 |
| `web/src/components/ChatView.tsx` | 欢迎语、消息、工具卡、输入框 |
| `web/src/pages/ChatPage.tsx` | 路由与数据接线 |
| `web/src/pages/StudioPage.tsx` | Studio iframe |
| `web/src/App.tsx` | 路由表 |
| `tests/chat-shell.test.ts` | 纯函数与客户端（注入 `fetch`） |
| `src/mastra/agents/agent.ts` | `generateTitle: false` |
| `package.json` | 根 `dev` 并行启动 |
| `README.md` | 用户入口与 `/studio` |

---

### Task 1: 前端骨架与一条 `npm run dev`

**Files:**
- Create: `web/package.json`
- Create: `web/tsconfig.json`
- Create: `web/index.html`
- Create: `web/vite.config.ts`
- Create: `web/src/dev-proxy.ts`
- Create: `web/src/main.tsx`
- Create: `web/src/App.tsx`
- Create: `web/src/styles.css`
- Create: `web/src/constants.ts`
- Modify: `package.json`
- Test: `tests/chat-shell.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export const mastraProxyTarget = 'http://127.0.0.1:4111'`（`web/src/dev-proxy.ts`）
  - `export const AGENT_ID = 'agent'`、`export const RESOURCE_ID = 'local-user'`、`export const MASTRA_ORIGIN = 'http://127.0.0.1:4111'`（`web/src/constants.ts`）

- [ ] **Step 1: Write the failing test**

把 `package.json` 的 `test` 改成 `"tsx --test tests/*.test.ts"` 已经覆盖本文件，无需改 glob。新建 `tests/chat-shell.test.ts`：

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mastraProxyTarget } from '../web/src/dev-proxy.ts';

test('dev script starts mastra and the web shell together', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.match(pkg.scripts.dev, /concurrently/);
  assert.match(pkg.scripts.dev, /mastra dev/);
  assert.match(pkg.scripts.dev, /--prefix web/);
  assert.ok(pkg.devDependencies.concurrently);
  assert.equal(mastraProxyTarget, 'http://127.0.0.1:4111');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/chat-shell.test.ts`

Expected: FAIL，找不到 `../web/src/dev-proxy.ts` 或 `scripts.dev` 不含 `concurrently`。

- [ ] **Step 3: Write minimal implementation**

`web/src/dev-proxy.ts`：

```typescript
export const mastraProxyTarget = 'http://127.0.0.1:4111';
```

`web/src/constants.ts`：

```typescript
export const AGENT_ID = 'agent';
export const RESOURCE_ID = 'local-user';
export const MASTRA_ORIGIN = 'http://127.0.0.1:4111';
```

`web/package.json`：

```json
{
  "name": "nero-agent-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "react-router-dom": "^7.6.2"
  },
  "devDependencies": {
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "@vitejs/plugin-react": "^4.5.2",
    "typescript": "^5.8.3",
    "vite": "^6.3.5"
  }
}
```

`web/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["vite/client"]
  },
  "include": ["src", "vite.config.ts"]
}
```

`web/vite.config.ts`：

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { mastraProxyTarget } from './src/dev-proxy';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: mastraProxyTarget, changeOrigin: true },
    },
  },
});
```

`web/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Nero</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/src/main.tsx`：

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
```

`web/src/App.tsx` 先放占位，Task 5 替换：

```tsx
export function App() {
  return <p>对话页准备中</p>;
}
```

`web/src/styles.css` 先写：

```css
html, body, #root { height: 100%; margin: 0; }
body { font-family: system-ui, sans-serif; color: #1f2328; background: #fff; }
```

根 `package.json`：在 `devDependencies` 增加 `"concurrently": "^9.2.0"`，把 `scripts.dev` 换成：

```json
"dev": "concurrently -k -n mastra,web \"mastra dev\" \"npm run dev --prefix web\""
```

然后 `npm install` 与 `npm install --prefix web`。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/chat-shell.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json web tests/chat-shell.test.ts
git commit -m "feat: scaffold Chinese chat shell and combined dev script"
```

---

### Task 2: 会话标题、副标题与排序

**Files:**
- Create: `web/src/lib/thread-label.ts`
- Modify: `tests/chat-shell.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:

```typescript
export type ThreadSummary = {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
};

export function formatThreadTime(iso: string): string;
export function threadTitle(thread: ThreadSummary): string;
export function threadSubtitle(thread: ThreadSummary): string;
export function sortThreads(threads: ThreadSummary[]): ThreadSummary[];
```

- [ ] **Step 1: Write the failing test**

追加到 `tests/chat-shell.test.ts`：

```typescript
import {
  formatThreadTime,
  sortThreads,
  threadSubtitle,
  threadTitle,
} from '../web/src/lib/thread-label.ts';

test('thread labels use custom title, then stored title, then a fallback', () => {
  const renamed = {
    id: 'a',
    title: '原始提问',
    createdAt: '2026-09-28T03:12:38.000Z',
    updatedAt: '2026-09-28T04:00:00.000Z',
    metadata: { customTitle: '改过的名字' },
  };
  assert.equal(threadTitle(renamed), '改过的名字');
  assert.equal(threadTitle({ ...renamed, metadata: {} }), '原始提问');
  assert.equal(threadTitle({ id: 'b', createdAt: renamed.createdAt, updatedAt: renamed.updatedAt }), '新对话');
});

test('subtitle prefers updatedAt and does not zero-pad month or day', () => {
  const thread = {
    id: 'a',
    createdAt: '2026-01-02T01:02:03.000Z',
    updatedAt: '2026-09-28T03:12:38.000Z',
  };
  const text = threadSubtitle(thread);
  const expected = formatThreadTime(thread.updatedAt);
  assert.equal(text, expected);
  const local = new Date(thread.updatedAt);
  assert.match(text, new RegExp(`${local.getFullYear()}年${local.getMonth() + 1}月${local.getDate()}日 `));
  assert.doesNotMatch(text, /年09月/);
});

test('sortThreads orders by updatedAt descending', () => {
  const sorted = sortThreads([
    { id: 'old', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'new', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
  ]);
  assert.deepEqual(sorted.map((item) => item.id), ['new', 'old']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/chat-shell.test.ts`

Expected: FAIL，`thread-label.ts` 不存在。

- [ ] **Step 3: Write minimal implementation**

`web/src/lib/thread-label.ts`：

```typescript
export type ThreadSummary = {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatThreadTime(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function threadTitle(thread: ThreadSummary): string {
  const custom = thread.metadata?.customTitle;
  if (typeof custom === 'string' && custom.trim()) return custom;
  if (thread.title?.trim()) return thread.title;
  return '新对话';
}

export function threadSubtitle(thread: ThreadSummary): string {
  return formatThreadTime(thread.updatedAt || thread.createdAt);
}

export function sortThreads(threads: ThreadSummary[]): ThreadSummary[] {
  return [...threads].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/chat-shell.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/thread-label.ts tests/chat-shell.test.ts
git commit -m "feat: label chat threads from the first question and timestamp"
```

---

### Task 3: SSE 解析与流式消息归并

**Files:**
- Create: `web/src/lib/sse.ts`
- Create: `web/src/lib/stream-reducer.ts`
- Modify: `tests/chat-shell.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:

```typescript
export async function readSse(stream: ReadableStream<Uint8Array>, onData: (data: string) => void): Promise<void>;

export type ToolCard = {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  approval: 'none' | 'pending' | 'approved' | 'declined';
};

export type AssistantTurn = {
  text: string;
  reasoning: string;
  tools: ToolCard[];
  error?: string;
  runId?: string;
};

export function emptyTurn(): AssistantTurn;
export function reduceChunk(turn: AssistantTurn, chunk: { type: string; runId?: string; payload?: Record<string, unknown> }): AssistantTurn;
export function markApproval(turn: AssistantTurn, toolCallId: string, approval: 'approved' | 'declined'): AssistantTurn;
```

- [ ] **Step 1: Write the failing test**

追加：

```typescript
import { readSse } from '../web/src/lib/sse.ts';
import { emptyTurn, reduceChunk } from '../web/src/lib/stream-reducer.ts';

test('readSse emits each data payload', async () => {
  const encoded = new TextEncoder().encode('data: {"type":"text-delta"}\n\ndata: [DONE]\n\n');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
  const events: string[] = [];
  await readSse(stream, (data) => events.push(data));
  assert.deepEqual(events, ['{"type":"text-delta"}', '[DONE]']);
});

test('reduceChunk accumulates text, reasoning, tools, approval, and errors', () => {
  let turn = emptyTurn();
  turn = reduceChunk(turn, { type: 'text-delta', runId: 'run-1', payload: { text: '你好' } });
  turn = reduceChunk(turn, { type: 'text-delta', payload: { text: '。' } });
  turn = reduceChunk(turn, { type: 'reasoning-delta', payload: { text: '先查一下' } });
  turn = reduceChunk(turn, { type: 'tool-call', payload: { toolCallId: 'c1', toolName: 'web_search', args: { q: '天气' } } });
  turn = reduceChunk(turn, { type: 'tool-call-approval', payload: { toolCallId: 'c1', toolName: 'web_search', args: { q: '天气' } } });
  turn = reduceChunk(turn, { type: 'tool-result', payload: { toolCallId: 'c1', toolName: 'web_search', result: { ok: true } } });
  turn = reduceChunk(turn, { type: 'error', payload: { message: '中断' } });
  assert.equal(turn.text, '你好。');
  assert.equal(turn.reasoning, '先查一下');
  assert.equal(turn.runId, 'run-1');
  assert.equal(turn.tools[0]?.approval, 'approved');
  assert.deepEqual(turn.tools[0]?.result, { ok: true });
  assert.equal(turn.error, '中断');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/chat-shell.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: Write minimal implementation**

`web/src/lib/sse.ts`：

```typescript
export async function readSse(stream: ReadableStream<Uint8Array>, onData: (data: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) onData(data);
    }
  }
}
```

`web/src/lib/stream-reducer.ts`：

```typescript
export type ToolCard = {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  approval: 'none' | 'pending' | 'approved' | 'declined';
};

export type AssistantTurn = {
  text: string;
  reasoning: string;
  tools: ToolCard[];
  error?: string;
  runId?: string;
};

type Chunk = { type: string; runId?: string; payload?: Record<string, unknown> };

export function emptyTurn(): AssistantTurn {
  return { text: '', reasoning: '', tools: [] };
}

function upsertTool(tools: ToolCard[], toolCallId: string, toolName: string, patch: Partial<ToolCard>): ToolCard[] {
  const index = tools.findIndex((tool) => tool.toolCallId === toolCallId);
  if (index === -1) {
    return [...tools, { toolCallId, toolName, approval: 'none', ...patch }];
  }
  const next = [...tools];
  next[index] = { ...next[index], ...patch, toolName: toolName || next[index].toolName };
  return next;
}

export function reduceChunk(turn: AssistantTurn, chunk: Chunk): AssistantTurn {
  const payload = chunk.payload ?? {};
  const next: AssistantTurn = { ...turn, runId: chunk.runId ?? turn.runId, tools: turn.tools };
  if (chunk.type === 'text-delta' && typeof payload.text === 'string') next.text += payload.text;
  if (chunk.type === 'reasoning-delta' && typeof payload.text === 'string') next.reasoning += payload.text;
  if (chunk.type === 'tool-call' || chunk.type === 'tool-call-approval') {
    const toolCallId = String(payload.toolCallId ?? '');
    const toolName = String(payload.toolName ?? '');
    next.tools = upsertTool(next.tools, toolCallId, toolName, {
      args: payload.args,
      approval: chunk.type === 'tool-call-approval' ? 'pending' : next.tools.find((tool) => tool.toolCallId === toolCallId)?.approval ?? 'none',
    });
  }
  if (chunk.type === 'tool-result') {
    const toolCallId = String(payload.toolCallId ?? '');
    const current = next.tools.find((tool) => tool.toolCallId === toolCallId);
    next.tools = upsertTool(next.tools, toolCallId, String(payload.toolName ?? ''), {
      result: payload.result,
      error: typeof payload.error === 'string' ? payload.error : undefined,
      approval: current?.approval === 'pending' ? 'approved' : current?.approval ?? 'none',
    });
  }
  if (chunk.type === 'error') {
    next.error = typeof payload.message === 'string' ? payload.message : '回复中断';
  }
  return next;
}

export function markApproval(turn: AssistantTurn, toolCallId: string, approval: 'approved' | 'declined'): AssistantTurn {
  return {
    ...turn,
    tools: turn.tools.map((tool) => (tool.toolCallId === toolCallId ? { ...tool, approval } : tool)),
  };
}
```

把下面这项和上一节测试一起写进 Step 1，不要等到实现之后再补：

```typescript
test('tool-result does not invent an approval', () => {
  const turn = reduceChunk(emptyTurn(), {
    type: 'tool-result',
    payload: { toolCallId: 'c2', toolName: 'web_fetch', result: 'ok' },
  });
  assert.equal(turn.tools[0]?.approval, 'none');
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/chat-shell.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/sse.ts web/src/lib/stream-reducer.ts tests/chat-shell.test.ts
git commit -m "feat: reduce Mastra SSE chunks into chat turns"
```

---

### Task 4: Mastra HTTP 客户端

**Files:**
- Create: `web/src/lib/mastra-client.ts`
- Modify: `tests/chat-shell.test.ts`

**Interfaces:**
- Consumes: `AGENT_ID`、`RESOURCE_ID`、`readSse`、`emptyTurn`、`reduceChunk`、`ThreadSummary`
- Produces:

```typescript
export type FetchLike = typeof fetch;

export function createMastraClient(fetchImpl: FetchLike = fetch);

// 返回值方法：
listThreads(): Promise<ThreadSummary[]>;
createThread(title: string): Promise<ThreadSummary>;
getThread(threadId: string): Promise<ThreadSummary>;
getMessages(threadId: string): Promise<unknown[]>;
streamMessage(threadId: string, text: string, onTurn: (turn: AssistantTurn) => void, signal?: AbortSignal): Promise<AssistantTurn>;
abortThread(threadId: string): Promise<void>;
approveTool(runId: string, toolCallId: string, onTurn: (turn: AssistantTurn) => void): Promise<void>;
declineTool(runId: string, toolCallId: string, onTurn: (turn: AssistantTurn) => void): Promise<void>;
```

已安装服务契约（不要改路径）：

- `GET /api/memory/threads?agentId=agent&resourceId=local-user&perPage=100&orderBy=updatedAt&sortDirection=DESC` → `{ threads: ThreadSummary[] }`
- `POST /api/memory/threads?agentId=agent` JSON `{ resourceId, title }` → thread 对象
- `GET /api/memory/threads/:threadId?agentId=agent&resourceId=local-user`
- `GET /api/memory/threads/:threadId/messages?agentId=agent&resourceId=local-user&perPage=40`
- `POST /api/agents/agent/stream` JSON `{ messages: text, memory: { thread, resource } }`，响应 `text/event-stream`，每帧是 `fullStream` chunk JSON。`[DONE]` 忽略。
- `POST /api/agents/agent/threads/abort` JSON `{ threadId, resourceId: 'local-user' }`
- `POST /api/agents/agent/approve-tool-call` 与 `decline-tool-call` JSON `{ runId, toolCallId }`，同样是 SSE

- [ ] **Step 1: Write the failing test**

```typescript
import { createMastraClient } from '../web/src/lib/mastra-client.ts';

test('client creates a thread and consumes an SSE text delta', async () => {
  let createdBody: { resourceId?: string; title?: string } | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/api/memory/threads?') && init?.method === 'POST') {
      createdBody = JSON.parse(String(init?.body)) as { resourceId?: string; title?: string };
      assert.match(url, /agentId=agent/);
      return new Response(JSON.stringify({
        id: 't1',
        title: '帮我看天气',
        resourceId: 'local-user',
        createdAt: '2026-09-28T03:12:38.000Z',
        updatedAt: '2026-09-28T03:12:38.000Z',
      }), { status: 200 });
    }
    if (url.endsWith('/api/agents/agent/stream')) {
      const body = new TextEncoder().encode('data: {"type":"text-delta","runId":"r1","payload":{"text":"你好"}}\n\n');
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(body); controller.close(); } }), { status: 200 });
    }
    return new Response('nope', { status: 500 });
  };
  const client = createMastraClient(fetchImpl);
  const thread = await client.createThread('帮我看天气');
  assert.equal(thread.id, 't1');
  assert.equal(createdBody?.resourceId, 'local-user');
  assert.equal(createdBody?.title, '帮我看天气');
  const turns: string[] = [];
  await client.streamMessage('t1', '帮我看天气', (turn) => turns.push(turn.text));
  assert.equal(turns.at(-1), '你好');
});

test('client throws when thread list is not ok', async () => {
  const client = createMastraClient(async () => new Response('down', { status: 503 }));
  await assert.rejects(() => client.listThreads(), /503/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/chat-shell.test.ts`

Expected: FAIL，`mastra-client.ts` 不存在。

- [ ] **Step 3: Write minimal implementation**

`web/src/lib/mastra-client.ts`：

```typescript
import { AGENT_ID, RESOURCE_ID } from '../constants';
import type { ThreadSummary } from './thread-label';
import { readSse } from './sse';
import { emptyTurn, reduceChunk, type AssistantTurn } from './stream-reducer';

export type FetchLike = typeof fetch;

type Chunk = { type: string; runId?: string; payload?: Record<string, unknown> };

function asThread(raw: Record<string, unknown>): ThreadSummary {
  return {
    id: String(raw.id),
    title: typeof raw.title === 'string' ? raw.title : undefined,
    createdAt: String(raw.createdAt),
    updatedAt: String(raw.updatedAt ?? raw.createdAt),
    metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata as Record<string, unknown> : undefined,
  };
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Mastra ${response.status}`);
  return response.json();
}

export function createMastraClient(fetchImpl: FetchLike = fetch) {
  const threadQuery = `agentId=${AGENT_ID}&resourceId=${RESOURCE_ID}`;

  async function consumeSse(response: Response, onTurn: (turn: AssistantTurn) => void): Promise<AssistantTurn> {
    if (!response.ok) throw new Error(`Mastra ${response.status}`);
    if (!response.body) throw new Error('Mastra 503');
    let turn = emptyTurn();
    await readSse(response.body, (data) => {
      if (data === '[DONE]') return;
      let chunk: Chunk;
      try {
        chunk = JSON.parse(data) as Chunk;
      } catch {
        return;
      }
      turn = reduceChunk(turn, chunk);
      onTurn(turn);
    });
    return turn;
  }

  return {
    async listThreads(): Promise<ThreadSummary[]> {
      const response = await fetchImpl(`/api/memory/threads?${threadQuery}&perPage=100&orderBy=updatedAt&sortDirection=DESC`);
      const body = await readJson(response) as { threads?: Record<string, unknown>[] };
      return (body.threads ?? []).map(asThread);
    },
    async createThread(title: string): Promise<ThreadSummary> {
      const response = await fetchImpl(`/api/memory/threads?agentId=${AGENT_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceId: RESOURCE_ID, title }),
      });
      return asThread(await readJson(response) as Record<string, unknown>);
    },
    async getThread(threadId: string): Promise<ThreadSummary> {
      const response = await fetchImpl(`/api/memory/threads/${threadId}?${threadQuery}`);
      return asThread(await readJson(response) as Record<string, unknown>);
    },
    async getMessages(threadId: string): Promise<unknown[]> {
      const response = await fetchImpl(`/api/memory/threads/${threadId}/messages?${threadQuery}&perPage=40`);
      const body = await readJson(response) as { messages?: unknown[] };
      return body.messages ?? [];
    },
    streamMessage(threadId: string, text: string, onTurn: (turn: AssistantTurn) => void, signal?: AbortSignal) {
      return fetchImpl('/api/agents/agent/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({ messages: text, memory: { thread: threadId, resource: RESOURCE_ID } }),
      }).then((response) => consumeSse(response, onTurn));
    },
    async abortThread(threadId: string): Promise<void> {
      const response = await fetchImpl('/api/agents/agent/threads/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, resourceId: RESOURCE_ID }),
      });
      if (!response.ok) throw new Error(`Mastra ${response.status}`);
    },
    approveTool(runId: string, toolCallId: string, onTurn: (turn: AssistantTurn) => void) {
      return fetchImpl('/api/agents/agent/approve-tool-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, toolCallId }),
      }).then((response) => consumeSse(response, onTurn));
    },
    declineTool(runId: string, toolCallId: string, onTurn: (turn: AssistantTurn) => void) {
      return fetchImpl('/api/agents/agent/decline-tool-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, toolCallId }),
      }).then((response) => consumeSse(response, onTurn));
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/chat-shell.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/mastra-client.ts tests/chat-shell.test.ts
git commit -m "feat: call Mastra thread and stream HTTP APIs from the chat shell"
```

---

### Task 5: 左栏、对话区与路由壳

**Files:**
- Create: `web/src/lib/messages.ts`
- Create: `web/src/components/LeftPanel.tsx`
- Create: `web/src/components/ChatView.tsx`
- Create: `web/src/pages/StudioPage.tsx`
- Create: `web/src/pages/ChatPage.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`
- Modify: `src/mastra/agents/agent.ts`（`generateTitle: false`）

**Interfaces:**
- Consumes: `threadTitle`、`threadSubtitle`、`MASTRA_ORIGIN`、`ToolCard`、`AssistantTurn`
- Produces: 路由 `/`、`/chat/new`、`/chat/:threadId`、`/studio`

`ChatPage` 在本任务用传入的可选 `client`。默认 `createMastraClient()`。行为在 Task 4 的方法上接线，本任务写完整交互，不另起假数据层。

`LeftPanel` props：

```typescript
{
  threads: ThreadSummary[];
  activeId?: string;
  collapsed: boolean;
  onToggle(): void;
  error?: string;
}
```

`ChatView` props：

```typescript
{
  mode: 'new' | 'thread';
  userMessages: Array<{ id: string; text: string }>;
  assistant: AssistantTurn | null;
  history: Array<{ id: string; role: 'user' | 'assistant'; text: string; reasoning?: string; tools?: ToolCard[] }>;
  pending: boolean;
  banner?: string;
  onSend(text: string): void;
  onStop(): void;
  onApprove(toolCallId: string): void;
  onDecline(toolCallId: string): void;
  onRetry(): void;
}
```

页面行为：

- `/` → `<Navigate to="/chat/new" replace />`
- `/studio`：`iframe` `src={MASTRA_ORIGIN}` `title="Mastra Studio"`，宽高 100%，无边框。外壳不再包左栏。
- `/chat/new` 与 `/chat/:threadId`：左栏 + `ChatView`。
- 启动 `listThreads`。失败时左栏显示「会话列表暂不可用」，右栏 `banner`「无法连接助手，请确认 npm run dev 已启动」并显示「重试」。
- `/chat/new` 发送：`createThread(text)` → `navigate('/chat/' + id, { replace: true })` → 把该 thread 插到列表顶部 → `streamMessage`。创建失败则右栏 banner，不跳转。stream 失败但 thread 已创建：留在该路由，banner「回复失败，可重新发送」。
- `/chat/:threadId`：`getThread` 404（客户端把非 2xx 抛错，`ChatPage` 捕获后 `navigate('/chat/new', { replace: true })`）。成功则 `getMessages`。消息里 `role === 'user'` 的文本拼进用户气泡；`role === 'assistant'` 的文本拼进历史助手气泡。字段兼容 `content` 为 string，或 `content` 为 `{ type: 'text', text }[]`，或 `parts` 同形。无法识别的内容跳过。
- 发送中按钮是「停止」，调用 `abortThread` 并 `AbortController.abort()`。已生成的 `assistant` 保留。
- `approval === 'pending'` 的工具卡显示「批准」「拒绝」，分别 `markApproval` 后调用 `approveTool` / `declineTool`，用返回流继续 `reduceChunk` 到同一个 assistant turn（在客户端回调里以当前 turn 为起点需要在 `approveTool` 里从 `emptyTurn` 再 reduce；页面把新 turn 的 text/reasoning/tools 追加到当前 turn，而不是替换掉已有正文）。具体追加：页面维护 `assistant`，审批回调里用一个从 `emptyTurn` 开始的临时 turn 接收增量，再把 `text`、`reasoning` 接到当前 turn，tools 按 `toolCallId` 合并。
- 欢迎文案固定：「想从哪里开始？」
- `generateTitle: false` 只改这一处 options，其他 agent 配置不动。

样式：左栏 280px，浅灰背景 `#f6f7f9`；折叠后宽度 0、溢出隐藏；当前会话底 `#e8eefc`；消息区可滚动；输入框贴底，多行，回车发送，Shift+回车换行；工具卡边框圆角，待审批时按钮可见。思考块默认收起，`<details>`。

- [ ] **Step 1: 先改 agent，避免自动标题**

`src/mastra/agents/agent.ts` 的 Memory options 里 `generateTitle: true` 改为 `generateTitle: false`。

- [ ] **Step 2: 先写消息解析的失败测试，再实现 `historyFromMessages`**

追加到 `tests/chat-shell.test.ts`：

```typescript
import { historyFromMessages } from '../web/src/lib/messages.ts';

test('historyFromMessages keeps user and assistant text parts', () => {
  const history = historyFromMessages([
    { id: '1', role: 'user', content: '帮我看天气' },
    { id: '2', role: 'assistant', content: [{ type: 'text', text: '今天晴' }] },
    { id: '3', role: 'system', content: '忽略' },
    { role: 'user', parts: [{ type: 'text', text: '' }] },
  ]);
  assert.deepEqual(history, [
    { id: '1', role: 'user', text: '帮我看天气' },
    { id: '2', role: 'assistant', text: '今天晴' },
  ]);
});
```

Run: `npx tsx --test tests/chat-shell.test.ts`  
Expected: FAIL，找不到 `messages.ts`。

然后创建 `web/src/lib/messages.ts`：

```typescript
export type HistoryItem = { id: string; role: 'user' | 'assistant'; text: string };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (!part || typeof part !== 'object') return '';
    const item = part as { type?: string; text?: string };
    return item.type === 'text' && typeof item.text === 'string' ? item.text : '';
  }).join('');
}

export function historyFromMessages(messages: unknown[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  messages.forEach((message, index) => {
    if (!message || typeof message !== 'object') return;
    const record = message as { id?: string; role?: string; content?: unknown; parts?: unknown };
    if (record.role !== 'user' && record.role !== 'assistant') return;
    const text = textOf(record.content) || textOf(record.parts);
    if (!text) return;
    items.push({ id: record.id || String(index), role: record.role, text });
  });
  return items;
}
```

再跑同一条测试，Expected: PASS。

- [ ] **Step 3: 实现组件与路由**

`web/src/App.tsx`：

```tsx
import { Navigate, Route, Routes } from 'react-router-dom';
import { ChatPage } from './pages/ChatPage';
import { StudioPage } from './pages/StudioPage';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/chat/new" replace />} />
      <Route path="/chat/new" element={<ChatPage />} />
      <Route path="/chat/:threadId" element={<ChatPage />} />
      <Route path="/studio" element={<StudioPage />} />
    </Routes>
  );
}
```

`StudioPage.tsx`：

```tsx
import { MASTRA_ORIGIN } from '../constants';

export function StudioPage() {
  return <iframe className="studio-frame" title="Mastra Studio" src={MASTRA_ORIGIN} />;
}
```

`LeftPanel` 顶部按钮文案「新对话」，`to="/chat/new"`。列表项用 `<Link to={'/chat/' + thread.id}>`，主标题 `threadTitle`，副标题 `threadSubtitle`，`title={threadTitle(thread)}`。

- [ ] **Step 4: 跑已有测试并做类型检查**

Run: `npx tsx --test tests/chat-shell.test.ts && npm run build --prefix web`

Expected: 测试 PASS；`web` 构建成功。若 Vite 6 与 React 19 类型报错，只改对应类型依赖版本，不改交互。

- [ ] **Step 5: 手工验收**

Run: `npm run dev`

打开 `http://127.0.0.1:5173/chat/new`。确认左栏有「新对话」、欢迎语、输入框。发送一句中文后地址变为 `/chat/<id>`，左栏出现以这句话为标题、带日期时间副标题的记录。刷新后仍在该会话。打开 `http://127.0.0.1:5173/studio` 能看到现有 Studio。若本机模型不可用，失败提示使用文案「回复失败，可重新发送」，不要求本步一定拿到模型正文。

- [ ] **Step 6: Commit**

```bash
git add web src/mastra/agents/agent.ts
git commit -m "feat: add Chinese chat layout with thread navigation"
```

---

### Task 6: 文档

**Files:**
- Modify: `README.md`（Get started 一节）

- [ ] **Step 1: 更新启动说明**

在 `npm run dev` 代码块后补两句：用户对话打开 `http://127.0.0.1:5173`；管理用的 Mastra Studio 打开 `http://127.0.0.1:5173/studio`（Studio 本体仍由 4111 提供）。保留原模型与 `TAVILY_API_KEY` 说明。

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: point local dev at the Chinese chat shell"
```

---

## Spec 覆盖检查

| Spec | Task |
|---|---|
| 自建中文对话 + 完整流式/工具/审批 | Task 3–5 |
| 左栏新对话、首问标题、时间副标题、首条后 replace 路由 | Task 2、5 |
| 一条 `npm run dev` | Task 1 |
| `/studio` 管理入口 | Task 5 `StudioPage` |
| 错误：代理失败、无效 thread、流中断、工具错误、审批拒绝、建会话后 stream 失败 | Task 4 抛错 + Task 5 页面分支 |
| 不做登录/附件/语音/搜索开关/汉化 Studio | 未列入任何任务 |
| `generateTitle` 不覆盖左栏规则 | Task 5 关闭该选项，创建时写入 title |

## 计划自检记录

- 无 TBD。审批增量合并写在 Task 5 行为列表里。
- `reduceChunk` / `createMastraClient` / `threadTitle` 名称在后续任务与测试中一致。
- Studio 不使用路径重写，避免与「前端一个入口、Studio 仍可用」冲突。
