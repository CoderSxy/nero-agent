# Playground-UI 组件复用 Agent 壳设计

日期：2026-09-28  
状态：待用户确认后进入实现计划  
关系：取代此前「自建极简对话页」方案（`2026-09-28-chinese-chat-shell-design.md`）中的 UI 实现路径；保留其路由、中文左栏规则、`npm run dev` 单入口与 `/studio` 管理入口约定。

## 背景

已有 `web/` 中文壳能打开，但：

1. 对话不可用：Agent 默认模型为 `openai/gpt-5.6-terra`，环境仅有 `DEEPSEEK_API_KEY`，流式请求因缺 `OPENAI_API_KEY` 失败。
2. 产品期望不是极简自建页，而是 **风格与业务逻辑沿用 4111 Studio Agent 页**，并坚持 **组件复用**（非 iframe）。

Studio 的可复用积木包是 `@mastra/playground-ui`（官方 Studio 亦基于此组装）。它提供 domains/components，不是单一「整页 Agent」导出；本仓库需在 `web/` 中拼装接近 Studio Agent 页的完整界面。

## 目标与非目标

### 目标

- 5173 用户入口：用 `@mastra/playground-ui` + `@mastra/client-js` / `@mastra/react` 复刻 Agent 页能力（对话、工具/审批、右侧 Config、Traces、Memory 相关展示）。
- 左栏历史中文化：新对话、首问标题（可后续改名）、日期时间副标题；Chat / Traces 可切换。
- `npm run dev` 同时启动 Mastra 与外壳；`/studio` 保留完整官方 Studio。
- 默认模型与现有密钥对齐，使对话真正可用。

### 非目标（本设计周期）

- iframe 嵌入 Studio
- 登录 / 多用户
- 汉化整个官方 Studio 静态站
- 修改 `@mastra/playground-ui` 上游包源码（除非本地薄包装）

## 方案选择

1. iframe 嵌 Studio — 快，但用户明确不选  
2. 自建聊天 UI — 已实现一版，样式/业务达不到 Studio，且当前不可对话  
3. **`@mastra/playground-ui` 组件复用（采用）** — 样式与逻辑同源，工期更长，分 M1–M3 交付  

## 架构

```text
Browser :5173
  ├─ /chat/*     → web/ 组装 playground-ui Agent 壳 + 中文左栏
  └─ /studio/*   → iframe 或直链说明指向 Mastra Studio :4111（现有管理入口保留）

Vite 代理 /api → Mastra :4111
@mastra/client-js / @mastra/react → Memory、Agent stream、审批、Traces API
```

依赖（peer 需对齐）：

- `@mastra/playground-ui`
- `@mastra/client-js`
- `@mastra/react`
- `@tanstack/react-query`
- `tailwindcss` v4
- `lucide-react`

后端仍为现有 `src/mastra/`；Agent id = `agent`，第一版 `resourceId = local-user`。

## 界面结构

对齐 Studio Agent 截图：

| 区域 | 内容 |
|---|---|
| 左栏 | 中文：新对话 + 历史（主标题/副标题规则见下）；Chat / Traces 切换 |
| 中栏 | playground-ui Agent 对话主区（欢迎语、建议 prompt、消息流、输入、工具卡、审批） |
| 右栏 | Config：Tools、Workspace Tools、Memory、System Prompt 等 |
| 顶栏 | Agents / Agent 风格面包屑（可简化文案，风格一致） |

### 左栏标题规则（沿用原产品约定）

- 主标题：`metadata.customTitle` → 否则 thread `title`（创建时用首条用户提问）→ 否则「新对话」
- 副标题：优先 `updatedAt`，否则 `createdAt`；格式如 `2026年9月28日 11:12:38`（月日不补零，时分秒两位）
- 列表按 `updatedAt` 倒序
- `/` → `/chat/new`；首条发送后 `replace` 到 `/chat/:threadId`

## 分阶段交付

### M1 — 能对话 + Studio 对话主区

- 安装并对齐 playground-ui 相关依赖与 Tailwind v4
- Agent 默认模型改为 `deepseek/deepseek-v4-flash`（与 `DEEPSEEK_API_KEY` 一致）；更新 `.env.example`
- 中栏替换为 playground-ui Agent Chat
- 左栏可暂留现有中文历史或先用包内 Thread 列表
- 验收：`npm run dev` 下 5173 可真实多轮对话

### M2 — 对齐截图布局

- 右侧 Config、顶栏壳体
- 左栏中文历史 + Chat/Traces 切换壳
- 验收：布局与 4111 Agent 页同构，中文历史可用

### M3 — Traces / Memory 完整

- Traces 列表与详情
- Memory 配置展示与 Studio 行为对齐
- 移除极简 `ChatView` / 自写 SSE 主路径
- 验收：Chat ↔ Traces；Config/Memory 可用

## 数据流

1. UI 经同源 `/api` 访问 Mastra。
2. 会话、消息、流式、审批、Traces 经 `@mastra/client-js`（及 playground-ui 内置用法）。
3. 新对话：创建 thread → 路由 `/chat/:threadId` → playground-ui 对话区发送。
4. Traces 与当前 thread/run 关联展示。

## 模型与密钥

- `src/mastra/agents/agent.ts`：`model` 改为 `deepseek/deepseek-v4-flash`
- Observational Memory 已用 DeepSeek，保持
- `.env.example`：文档化 `DEEPSEEK_API_KEY`；`OPENAI_API_KEY` 标为可选
- Config 若允许切模型：缺对应 key 时中文明确报错

## 错误处理

| 情况 | 处理 |
|---|---|
| Mastra 未就绪 | 壳体提示确认 `npm run dev` |
| 缺 API key / 鉴权失败 | 对话区提示缺失的环境变量 |
| 流中断 / 停止 | 保留已生成内容（playground-ui 行为；外层不二次清空） |
| 无效 thread | 回 `/chat/new` |
| Traces 失败 | 面板内错误态，Chat 可继续 |

## 测试

- M1：手工真实对话 + 代理/依赖冒烟
- M2–M3：路由与组装；保留可测纯函数；不做 Studio 全量 E2E
- 旧自写 SSE 测试在主路径退役后删除或改写

## 成功标准

1. 5173 上可稳定使用 DeepSeek 对话。
2. Agent 页观感与能力接近 4111（M3 完成后含 Traces/Config/Memory）。
3. 左栏中文历史规则满足产品约定。
4. `/studio` 与 `npm run dev` 单入口约定仍成立。

## 风险

- `playground-ui` 版本需与当前 `@mastra/core@1.71.0` / `mastra@1.31.3` 对齐；可能需锁定特定版本并跟随升级。
- 包导出的是积木而非整页，拼装成本集中在 M1–M2。
- Studio 上游变更可能导致 UI API 调整。

## 后续实现顺序

用户确认本 spec 后：先用 writing-plans 产出 **M1 实现计划** 并执行；M2、M3 各自单独出计划，避免单计划过大。
