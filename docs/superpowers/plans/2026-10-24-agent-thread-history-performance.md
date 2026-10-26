# Agent Thread History Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Cursor 若没有该 skill，仍按本计划顺序完成测试、实现和验证。默认单个执行者串行推进，不自动派发子代理，不自动部署。

**Goal:** 短会话全部显示，长会话优先最近 8 轮上下文，上翻分页，快速切换和回复结束不反复下载全部历史；同步解除本地产物请求循环。

**Architecture:** 新增 owner-scoped、keyset、有界的只读历史窗口接口；前端窗口控制器维护 loaded history、live tail、缓存和双向位置。逻辑轮次与超长轮的物理片段分开，渲染按可见轮和详情展开状态挂载，不修改服务端模型记忆。

**Tech Stack:** TypeScript、Node >=22.13、Mastra core 1.71.0 / react 1.6.3（执行前核实 lockfile）、PostgreSQL/pg、Hono、React 19、Vite/Vitest、node:test/tsx、现有 Markdown/Mermaid/ECharts。

**Spec:** [2026-10-24-agent-thread-history-performance-design.md](../specs/2026-10-24-agent-thread-history-performance-design.md)。完整阅读；计划的类型简称均以设计为准。

## Global Constraints

- 参数：8 轮、200 消息、metadata batch 100、content 软预算 524288 B、缓存 TTL 30000 ms / 5 会话 / 10485760 B、视口预挂载 margin 1000 px、超长文本预览 12000 字符。
- 保留旧 `loadScopedThread` 给全量历史搜索；UI window 与模型 memory 是两条链路。
- 保留 user/signal/legacy、tool/OM/skill/task outcome/artifact metadata；owner 校验不能因缓存或游标消失。
- 只读历史查询；默认无 migration，不安装依赖或升级框架，不修改 node_modules。
- 阅读 `AGENTS.md`、`.claude/skills/mastra/SKILL.md`；新增路由注册到 `src/mastra/index.ts`。
- 使用 `package.json` 的 dev/build scripts；不直接运行 mastra build/dev。
- 不自动提交，不部署，不改 ECS 权限、环境或模型配置；不覆盖已存在的未提交修复。
- 新测试先失败再实现；数据库集成测试仅允许项目本地测试库，不把生产 URL 注入测试。

## Review Focus

1. 最后是“好的/继续”或重复文本小提问：保留前文且按 ID 识别轮次（Task 1、5）。
2. 单轮 500 条工具消息/单条 2 MiB：有界、可续页、不静默丢弃、不无限寻找轮起点（Task 1、2、7）。
3. 分页中 streaming、同 ID 工具落库更新、审批暂停：不重置或覆盖新状态（Task 5、6）。
4. A/B 用户或会话切换时迟到响应、缓存和伪造 cursor：不串数据（Task 2、3、4）。
5. 搜索跳很早历史、向前加载图表变高、用户正在输入审批：定位稳定、旧 assistant 保留、焦点不被卸载（Task 5、6、7）。

## 文件职责地图

新增：

- `src/mastra/history/{types,turns,cursor,repository,service,routes}.ts`：协议/判定、游标、轻量位置查询、窗口选择与正规化、鉴权路由。
- `web/src/agent/{history-window-client,history-window-state,thread-history-cache,use-thread-history}.ts`：HTTP、纯合并状态、内存 LRU、加载生命周期。
- `web/src/agent/history/{HistoryBoundary,HistoryTurnShell,DeferredHistoryText}.tsx`：分页与缺口提示、可见性壳、超长正文预览。
- 后端测试 `tests/history-{turns,repository,routes,memory-boundary}.test.ts`；前端按模块建同名 `.test.ts/.test.tsx`。
- 性能 fixture 与报告：`web/src/agent/history/performance-fixtures.ts`、`docs/superpowers/verification/2026-10-24-agent-thread-history-performance.md`。

修改：`src/mastra/index.ts`；前端 `AgentPage`、`AgentChat`、`MessageList`、`thread-scope`（仅兼容/文档）、`use-reconciled-chat-messages`、`chat-message-reconciliation`、`pending-user-message`、`use-scheduled-thread-updates`、`use-turn-artifacts`，及相应测试、现有 CSS 和 Vite env 类型声明。

---

### Task 1: 轮次与窗口选择的纯协议

**Files:** Create `src/mastra/history/{types,turns,cursor}.ts`、`tests/history-turns.test.ts`；参考 `pending-user-message.ts` 和安装包 message 类型。

**Interfaces:**

```ts
type HistoryMetadata = {
  id: string; createdAt: string; role: string; type?: string;
  signalType?: string; contentBytes: number;
};
isHistoryUserMessage(row: HistoryMetadata): boolean;
selectHistorySlice(rows: readonly HistoryMetadata[], mode: 'latest'|'before'|'around'|'after',
  targetId?: string): { ids: string[]; turns: HistoryTurn[]; hasBefore: boolean; hasAfter: boolean };
encodeHistoryCursor(value: HistoryCursorPayload): string;
decodeHistoryCursor(raw: string, scope: { userId: string; threadId: string }): HistoryCursorPayload;
```

`HistoryCursorPayload` 在 types 定义：version=1、userId、threadId、direction、boundary:HistoryPoint、snapshotUpper:HistoryPoint、可选 openTurn:{turnId:string}。常量及响应协议按设计。函数不自行查询数据库；rows 包含已读取的边界探针，消息元信息 ASC，预算计算用 contentBytes。含完整 payload 的 bytes 目标仍为软限制。

- [ ] 编写失败测试：10 轮每轮 2 条→选最近 8 轮；最后 3 轮全是“好的”仍算 3 轮；短 3 轮全部；signal 优先规则与 `isUserMessage` 对照 fixture；legacy；同时间不同 ID；预算不足不返回空页；单轮 500 条在已取 metadata 范围只返回最近 <=200 条并标 partialBefore。未知起点返回 provisional ID，续页沿用，找到起点返回 originMessageId/replacesTurnIds；legacy 到会话开头才正式化。
- [ ] 写 cursor 错误测试：超长 >4096、非 JSON/base64、错误 version、跨 owner/thread、空 ID、非法时间、方向不符；精确时间 roundtrip 不丢微秒。
- [ ] Run `node --import tsx --test tests/history-turns.test.ts`，确认因缺实现失败。
- [ ] 实现纯函数与类型；不要把反复扫描全历史包装成 selectHistorySlice。
- [ ] 重跑全绿；记录返回实际轮数和 partial 的精确断言。

### Task 2: PostgreSQL 有界窗口读取与正规化

**Files:** Create `src/mastra/history/{repository,service}.ts`、`tests/history-repository.test.ts`。

**Interfaces:**

```ts
createHistoryRepository(pool: Pool): HistoryRepository;
// Repository: getUpper(scope), readMetadata(scope, {before?,after?,upper,limit}),
// readMessages(scope, ids), findTarget(scope, messageId), findTurnContext(scope, point, scanLimit).
loadHistoryWindow(repo: HistoryRepository, scope: {userId:string;threadId:string},
  query: {before?:string;after?:string;around?:string}): Promise<HistoryWindowData>;
```

`HistoryWindowData=Omit<HistoryWindow,'thread'>`。pool 通过依赖注入；一轮请求所有 repository 操作共享只读事务 client，禁止各方法另开不一致事务。`readMetadata` 的轻量 signalType 提取与 contentBytes 必须和 Task 1 规则一致。

- [ ] 写 spy repository 测试：latest 不读全量、不 COUNT/OFFSET、不取未选择的 content；200 条上限；soft bytes 的 oversizedMessage；around 目标一定包含且有双向 cursor；分页缺边界不死循环；找摘要达到 scanLimit 就结束。
- [ ] 写本地 DB 集成测试 fixture：1000 条/100 轮，单轮 500 条，同 createdAt 多条，旧字符串与 format 2，signal/OM/skill/task-outcome/artifact metadata。验证全分页后的 ID 集合与原数据一致、无重复无遗漏。
- [ ] 用事务测试模拟后续请求前追加新消息、删除锚点和更新已有 ID；固定 upper 不被新增推移，删除锚点仍可按 tuple 继续，同 ID 新内容下次查询可见。
- [ ] Run `node --import tsx --test tests/history-repository.test.ts` 确认纯测试失败；DB 用项目已有本地库白名单保护，无本地库时明确 skip，不能视为集成通过。
- [ ] 实现参数化 SELECT 与 normalizer。仔细读安装包 `@mastra/pg` 的 parseRow/normalizeMessageRow，不依赖未导出的私有函数。查询边界与 ID tie-break 保持一致，避免 JS Date 精度游标。
- [ ] 在本地库 Run `node --env-file-if-exists=.env --import tsx --test tests/history-repository.test.ts`，必须确认 DB 子测试执行且通过。打印 EXPLAIN 摘要，不输出 content。
- [ ] 核对索引；无性能证据不加 migration。若需要迁移，先补设计、锁风险及回退说明再实施，不能混入启动代码。

### Task 3: 只读路由及模型记忆边界

**Files:** Create `src/mastra/history/routes.ts`、`tests/history-routes.test.ts`、`tests/history-memory-boundary.test.ts`；Modify `src/mastra/index.ts`。

**Interfaces:** `createHistoryRoutes({lookup?, repositoryFactory?} = {}): ApiRoute[]`；导出 `historyRoutes`。生产通过现有 getPool 获取 repository，测试注入；路径和参数见设计第 5 节。

- [ ] 参照 `tests/turn-artifacts-routes.test.ts` 建 Hono harness。写 401、403、404、本人 200、管理员不能跨 owner、伪造 resourceId/userId 无效、foreign target、cursor scope 不符、互斥 query=400、内部错误不输出 SQL/正文等测试。
- [ ] 编写 readonly spy：接口不调用 saveMessages/updateThread/agent.generate/stream，不更新 memory 配置。
- [ ] 读取当前 `@mastra/react` 发送入口与服务端 memory recall，写边界测试：UI 只有最近窗口时，新 user 消息仍绑定原 thread/resource；先前服务端历史仍存在且能被正常 memory 路径取到。覆盖普通发送和 signal fallback；不使用真实外部模型凭证。
- [ ] Run `node --import tsx --test tests/history-routes.test.ts tests/history-memory-boundary.test.ts` 确认红，再实现路由、owner 检查、Cache-Control:no-store、参数校验和统一注册。
- [ ] 重跑通过并运行 `tests/thread-ownership.test.ts tests/memory-isolation.test.ts`；有 DB 的子测试按原本地保护执行。

### Task 4: Window client、内存缓存与加载控制器

**Files:** Create `web/src/agent/{history-window-client,history-window-state,thread-history-cache,use-thread-history}.ts` 及四份同名测试。

**Interfaces:**

```ts
fetchHistoryWindow(threadId: string,
  options: {before?:string;after?:string;around?:string;signal?:AbortSignal}): Promise<HistoryWindow>;
createThreadHistoryCache(): ThreadHistoryCache; // get/put/invalidate/delete/clear，按 user/thread
mergeHistoryWindow(current: HistoryState, incoming: HistoryWindow,
  mode: 'replace'|'prepend'|'append'|'tail'): HistoryState;
useThreadHistory({userId,threadId,targetMessageId,cache}): {
  state: HistoryState; status:'loading'|'ready'|'error'; validating:boolean;
  loadingBefore:boolean; loadingAfter:boolean; error:string|null;
  loadBefore():Promise<void>; loadAfter():Promise<void>; goLatest():Promise<void>;
  retry():Promise<void>; mergeLive(messages:MastraDBMessage[]):void;
};
```

`HistoryState` 明确定义 thread、messages、turns、cursor、upper、mode(latest/around)、gap、scrollAnchor。由 state 模块导出，不能各组件另造不兼容副本。cache 由 AgentShell/auth 范围创建并在 logout/unmount 清空，不能模块全局泄露前一用户数据。mergeLive 不更新分页 upper。

- [ ] 先测 fetch URL 参数编码、Bearer 使用现有 apiFetch、AbortSignal、Date 转换、非 2xx/损坏响应校验，禁止直接信任 JSON 为消息数组。
- [ ] 缓存 fake timers 测 30s、5 项 LRU、10MiB、超大项不缓存、删除/退出/切用户清空、403/404 清除，stale 命中先显示同时 validating。
- [ ] 状态机测试：initial 仅 1 request；500/1000 条 fixture 首屏未下载全部；prepend/append ID 去重；临时轮找到起点后的 alias 归并、两个 around provisional ID 仅凭重叠或连续 cursor 归并、跨 gap 不误合并；不把 around 与 latest 跨洞直接拼接；并发 loadBefore 去重；旧 A 响应不覆盖 B；abort 不报错。
- [ ] `npm run test --prefix web -- src/agent/history-window-client.test.ts src/agent/history-window-state.test.ts src/agent/thread-history-cache.test.ts src/agent/use-thread-history.test.tsx` 确认红后实现，再全绿。

### Task 5: 会话页、滚动与搜索入口

**Files:** Modify `AgentPage.tsx`、`AgentChat.tsx`、`AgentShell.tsx`、`thread-scope.ts`、对应测试；Create `history/HistoryBoundary.tsx` 和测试；更新现有样式、Vite env 类型。

**Interfaces:** AgentPage 消费 Task 4 控制器，AgentChat 新增 `historyState`、`onLoadBefore/onLoadAfter/onGoLatest` 与 `historyValidating` props；原 initialMessages 仅用于初始化，不以分页 reset stream。HistoryBoundary 是纯展示组件，回调由控制器提供。

- [ ] 先读 useChat 对 initialMessages 引用变化的 effect；写集成测试锁定加载旧页时 stream、草稿、pending user 与审批不会重置。若需分离显示历史与 hook tail，在同一任务实现，不容许删除测试绕过。
- [ ] AgentPage 测：最后小提问仍显示之前 7 轮；3 轮短会话全显；加载失败保留局部 UI、重试不导航 new；403/404 正确清屏；缓存验证前禁发送/决策，成功解除。
- [ ] AgentChat 测 prepend 前后可见 message 偏移不变，不调用跳底；只有初入 latest 和原来跟随底部时自动下滚；手动读历史时新 token 不抢位置；partial 轮提示继续加载。
- [ ] 搜索测试：目标远于 1000 条首屏，1 次 around 请求即包含目标；延续旧高亮；nextCursor 缺口提示；goLatest 重取 latest。保留 `use-history-search` 的全量索引测试。
- [ ] `npm run test --prefix web -- src/agent/AgentPage.test.tsx src/agent/AgentChat.test.tsx src/agent/use-history-search.test.tsx src/agent/thread-scope.test.ts src/agent/history/HistoryBoundary.test.tsx` 红→实现→绿。
- [ ] 添加构建开关 `VITE_THREAD_HISTORY_WINDOW_ENABLED`（未设置时默认 true；仅显式 false 使用旧链路），测试 false 回退与普通错误不隐式全量回退。不得改变 prod env。

### Task 6: 尾部对账、定时任务与产物请求稳定性

**Files:** Modify `use-reconciled-chat-messages.ts`、`chat-message-reconciliation.ts`、`pending-user-message.ts`、`use-scheduled-thread-updates.ts`、`use-turn-artifacts.ts`、`AgentChat.tsx`、相应测试；Create `history-tail-client.ts` 及测试。

**Interfaces:** `reconcileThreadTail({threadId,userId,liveMessages,signal}):Promise<MastraDBMessage[]>` 在 history-tail-client 导出，基于 Task 4 window client 的 around/after 取当前轮覆盖消息；共享纯 ID/part 合并函数位于 history-window-state。不要把所有历史塞进 liveMessages 来寻找覆盖起点。

- [ ] 将已复现循环变成永久 regression：相同 history/live settled → 连续 render 5 秒远端产物请求数固定为 1；即使传入等值新 messages 数组也不能循环。旧实现应失败；测试 API 每次返回新对象，不能用稳定 mock 掩盖问题。
- [ ] 补测试：流式 100 次 token 不反复请求产物；run 集合改变只补缺项；settledVersion/手动刷新触发一次；请求乱序/revision 退回不覆盖新产物；失败不自己无限重试。
- [ ] 将 part 合并与远端 key 分开；相同 Map/state 返回旧引用；修复 reconciliation/pending 数组身份稳定性，但不能仅依靠 memo 避免所有网络重取。
- [ ] 尾部测试：长历史对账请求不触及旧页；同 ID call→result 更新被读取；未覆盖 live 时继续保留 live；最多 3 次重试；结束/切换 abort；审批 suspended 正常保留。
- [ ] 定时任务测试：加载 3 页旧 assistant 后新 stream/poll 不删除任何旧页；终态快照只合并尾部；不保留旧 call 覆盖新 result；原 polling 降级继续可用。
- [ ] `npm run test --prefix web -- src/agent/history-tail-client.test.ts src/agent/use-reconciled-chat-messages.test.tsx src/agent/chat-message-reconciliation.test.ts src/agent/use-scheduled-thread-updates.test.tsx src/agent/use-turn-artifacts.test.tsx src/agent/AgentChat.test.tsx` 红→实现→绿。

### Task 7: 按轮可见性与重内容延迟挂载

**Files:** Create `history/{HistoryTurnShell,DeferredHistoryText}.tsx` 及测试；Modify `MessageList.tsx`、对应测试、现有 CSS；参考 `markdown/{markdown-renderer,MermaidBlock,EChartsBlock}.tsx`。

**Interfaces:** `HistoryTurnShell({turnId,pinned,children,onHeightChange})` 保存占位高度，IntersectionObserver margin=1000px，pinned 不卸载；`DeferredHistoryText({text,renderFull})` 超过12000字符先纯文本预览，点击后 renderFull(text)。MessageList 可接收 turns / pinnedTurnIds，未提供时兼容原测试调用。

- [ ] Mock observer 写测试：离屏历史不调用 Markdown/图表初始化；进入视口挂载；离开清理；pinned active/suspended/target/focus 不卸载；Observer 缺失回退显示；尺寸改变更新占位。
- [ ] 旧历史 reasoning 和工具详情未展开不解析/stringify 大内容，点击才挂载；当前运行推理不改变；2MiB 单正文初始只渲染预览，复制仍为完整正文。
- [ ] 原有 MessageList 47+ 行为回归：审批/ask_user、观察标记、技能、回复操作、附件、产物定位与状态文案均不退化。审批表单焦点不得因虚拟化或 provisional turnId 正式化丢失；alias 迁移保持高度/展开状态，message key 不变化。
- [ ] memo rows、按 ID 预索引附件/产物锚点/模型名，避免每轮全列表重复遍历；保留已有 Markdown block memo。用 profiler 决定进一步优化，不重写解析器。
- [ ] `npm run test --prefix web -- src/agent/history/HistoryTurnShell.test.tsx src/agent/history/DeferredHistoryText.test.tsx src/agent/MessageList.test.tsx src/agent/markdown` 红→实现→绿。
- [ ] 浏览器验证真实滚动、图表 resize、图片迟到、移动端触屏、Tab 焦点；jsdom 不能替代 <=4px 的真实锚点测量。

### Task 8: 性能验证、完整回归与交付

**Files:** Create `web/src/agent/history/performance-fixtures.ts`、`docs/superpowers/verification/2026-10-24-agent-thread-history-performance.md`；按需扩展已有测试，不创建生产测试会话。

- [ ] fixture 纯函数按固定 seed 生成：20 条短消息、1000 条/100 轮、单轮 500 条、2MiB 单正文、图表/推理混合、signal/legacy。常规 fixture 不含真实用户数据。
- [ ] 单测锁定首屏一个窗口请求、<=200条、常规1000条不全量下载、静止产物请求不增长、请求取消和去重，不以任意毫秒 sleep 判断“快”。
- [ ] 本地真实 DB 集成执行完成，记录 pass/skip；安全保护拒绝生产 URL。权限测试、历史搜索、scheduled、memory 的既有行为回归。
- [ ] `npm run test --prefix web`；`npm test`（按现有环境确认 DB 子测试执行情况）；`npm run build`；`git diff --check`。记录具体通过数与构建警告，不能把 skip 记为 pass。
- [ ] 在本地正常启动方式 `npm run dev` 下，用浏览器 Performance/Network 与 React profiler 对同一 fixture 新旧开关 cold/warm 各至少5次测量。记录设备/网络、median/p95、接口数/字节/TTFB、首次可见内容、commit/long task、图表数。没有可用 profiling 工具时在报告明确该项未验证，不伪造数据。
- [ ] 对照设计目标：普通1000条 cold median 至少改善50%；prepend稳定偏移<=4px；手动回最新、搜索远历史、审批中加载、定时任务、产物打开right panel均实测。巨型单条网络限制独立报告。
- [ ] 自查没有读取生产凭证、清消息/文件、改模型上下文、更新依赖或部署。汇总剩余风险与可用构建回退开关。
- [ ] 输出修改文件、测试/性能结果、文档链接；等待用户自行审阅和决定发布，不自动执行服务器操作。

## 完成判定

每项行为由所属 Task 的测试或真实浏览器记录证明后勾选。只“接口分页返回”不足以完成：小提问上下文、搜索跳转、长单轮续页、实时对账、缓存隔离、滚动和产物循环全部属于同一交付范围。遇到安装框架 API 与本文假设不一致时，先读源码、补失败测试并在验证报告记录调整，不能为了通过构建删掉约束。
