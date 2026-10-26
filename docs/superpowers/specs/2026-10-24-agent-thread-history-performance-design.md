# Agent Thread History Performance Design

## 1. 状态与实施入口

- 日期：2026-10-24。用户已确认“短会话全量显示，长会话展示最近若干完整轮次，上滑加载历史”的方向，要求提供 Cursor 可执行文档。本次仅交付文档。
- 配套计划：[2026-10-24-agent-thread-history-performance.md](../plans/2026-10-24-agent-thread-history-performance.md)。
- 调查依据：[长会话性能分析](../../deployment/thread-loading-performance-analysis-2026-10-24.md)。
- 以下 8 轮、200 条等参数为本设计确定的实施默认值，不冒称用户逐项指定；集中成常量，验证后可调整。
- 执行前读取根 `AGENTS.md` 和 `.claude/skills/mastra/SKILL.md`，以安装包文档、类型、源码确认 API。本文新增接口均为应用接口，不是声称 Mastra 已提供同名能力。
- 保留现有未提交改动。不得自动提交其他功能、部署 ECS、更改网关、升级 Node、修改模型记忆配置或数据库消息内容。

## 2. 目标、方案取舍

目标：打开长会话时先看到最新、足够理解的小段上下文；最后一条即使是“好的”“继续”或小提问，前面的对话仍可见。旧历史可逐步展开，不丢记录；滚动、搜索、审批、定时任务和产物行为保持正确。

| 方案 | 取舍 | 决定 |
| --- | --- | --- |
| 全量获取，仅加 loading / memo | 改动少，但串行请求和传输量仍随历史增长 | 不采用 |
| 固定最新 N 条消息 | 容易切断用户提问、工具调用与结果；消息条数也不等于对话轮数 | 不作为产品分页单位 |
| 最近若干轮 + 有界分段 + 缓存 + 按需渲染 | 首屏有上下文；需要处理长单轮、分页与实时数据合并 | 采用 |

不是只加载最后一个问答，也不是截掉模型上下文。UI 历史读取独立于服务端 memory / observation / reflection。当前 `@mastra/react` 发送入口使用本次 message、resourceId、threadId；实施时仍必须验证普通发送、signal fallback、审批恢复不会把 UI 占位内容当模型历史发送。

本轮范围包含：首屏窗口、历史分页、缓存/取消、尾部对账、搜索目标窗口、定时任务合并、历史重内容延迟渲染、本地产物请求循环修复、性能验证。不包含服务器扩容、全文搜索重建、消息存储格式迁移或新建持久化轮次索引表。

## 3. 已有链路与改动边界

| 位置 | 现状 | 设计要求 |
| --- | --- | --- |
| `web/src/agent/thread-scope.ts` | `loadScopedThread` 从最早开始串行拉完每页 100 条 | 保留供全文索引等既有调用；UI 打开走新 window client |
| `web/src/agent/AgentPage.tsx` | 全部加载完才挂载 AgentChat | 接入窗口控制器、缓存、错误与刷新状态 |
| `web/src/agent/AgentChat.tsx` | useChat 初始化、对账、滚动及 search target | 分离 loaded history 与 live tail，维持一份 ID 合并视图 |
| `use-reconciled-chat-messages.ts` | 结束后最多 3 次全量读取 | 改成当前运行尾部的有界对账；保留覆盖判断 |
| `use-scheduled-thread-updates.ts` | polling 回退读取全历史，某些合并只保留 user 消息 | 同样使用尾部窗口；不得覆盖已经加载的旧 assistant 记录 |
| `chat-message-reconciliation.ts` | settled 时每次 map 生成新数组 | 无内容变化时稳定引用；自定义 part/revision 合并不退化 |
| `use-turn-artifacts.ts` | effect 依赖 messages 引用，请求完成又更新 Map | 分开本地 part 合并、远端刷新；按稳定 key 去重 |
| `MessageList.tsx` | 全量遍历、推理默认展开、重详情立即构建 | 按轮组织、离屏仅保留壳、历史重详情按需挂载 |
| `markdown/{MermaidBlock,EChartsBlock}.tsx` | 挂载即渲染 | 由上层可见性门控；沿用当前解析及安全设置 |
| `use-history-search.ts` | 完整历史建立搜索索引 | 不得偷偷用窗口接口替代完整索引数据 |
| `src/mastra/index.ts` | 所有应用路由统一注册 | 注册新增 history routes |

## 4. 产品语义及参数

### 4.1 轮次

一轮从一条真实用户消息开始，包含其后所有 assistant、工具、推理、OM、应用 part，直到下一条真实用户消息之前。最后一轮可以仍在运行或暂停，不能假装已完成。

用户消息判定与 `pending-user-message.ts:isUserMessage` 保持一致：role=user；或 role=signal 且 metadata.signal.type（有值时优先）/message.type 为 user 或 user-message。其他通知 signal 不开新轮。相同文本的两条用户消息是两轮，不能按正文去重。工具审批、ask_user 恢复不新建轮。没有 user 起点的历史记录组成一个 legacy 轮，不丢弃。

服务端新建等价纯函数并以共享 fixture 测试与前端判定一致，不跨目录导入浏览器代码。

### 4.2 默认值

| 常量 | 默认值 | 含义 |
| --- | --- | --- |
| `HISTORY_TURNS` | 8 | 首屏及加载更多希望取得的完整轮数 |
| `HISTORY_MAX_MESSAGES` | 200 | 单次返回最多消息数，防单轮工具链无限增长 |
| `HISTORY_METADATA_BATCH` | 100 | 服务端逐批读取轻量 metadata；不是网络逐页请求 |
| `HISTORY_TARGET_BYTES` | 524288 | 每窗口原始 content 字节软预算；优先在轮边界截取 |
| `HISTORY_CACHE_TTL_MS` | 30000 | 缓存不阻塞显示的有效期；不是安全授权有效期 |
| `HISTORY_CACHE_MAX_THREADS` | 5 | 内存 LRU 最大会话数 |
| `HISTORY_CACHE_MAX_BYTES` | 10485760 | 全部缓存序列化估算最大字节，超过不缓存该项 |
| `HISTORY_VIEWPORT_MARGIN_PX` | 1000 | 离屏轮正文预挂载范围 |

短会话（不足 8 轮且在预算内）全部返回。最后一条小提问不会挤掉前面 7 轮。常规边界优先保留完整轮，字节预算不足时减少更早轮次，并返回实际轮数；尽可能保留至少最近 5 轮，但这是软目标，不能越过消息数限制。

### 4.3 超长单轮和异常单条

不能同时要求“任何单轮必须一次全部下载”与“每次响应有界”。本设计明确：完整轮是逻辑分组单位，超长轮允许连续分段装载，UI 必须显示 `本轮还有较早内容，点击加载`。`partialBefore` / `partialAfter` 表示缺的是哪一侧，不伪装完整。

- 返回最新连续片段，最多 200 条；续页优先补齐这个轮次，再继续更早轮次。
- 片段之间保留原 message ID 与顺序；未知轮起点使用下述 provisional turnId，找到起点后明确归并，不重复用户卡片。
- 缺少前段用户提问时返回单独的 `turnContext`（用户消息 ID + 最多 200 字摘要），用于上下文提示，不伪造 MastraDBMessage，不发送给模型。
- 512 KiB 是 content 软预算，不是 HTTP 响应硬限制；envelope/JSON 转义有额外开销。一条消息就大于预算时允许返回这一条，记录 `oversizedMessage=true`，避免空页和死循环。不得截断 JSON、工具参数或静默删除 reasoning/tool result。
- 超长正文先显示 12000 字符的预览与 `展开全文`，展开后完整保留原文；单个 Markdown 块超限时也先显示纯文本预览，不先解析完整块再用 CSS 隐藏。
- 单条巨型消息的网络传输仍可能慢，是本阶段明确的残余限制；不得宣称单条百 MiB 内容也有固定首屏时延。数据证明需要时另做消息 part 详情接口。

## 5. 服务端只读窗口 API

新目录 `src/mastra/history/`：`types.ts`、`turns.ts`、`cursor.ts`、`repository.ts`、`service.ts`、`routes.ts`。使用现有 PostgreSQL `getPool()`，read-only SELECT，无业务数据写入。兼容现有默认 schema；执行前核实实际 schema，不硬编码尚不存在的字段。

### 5.1 接口

`GET /agent-history/threads/:threadId/window`

- 无参数：latest。
- `before=<opaqueCursor>`：向前读取；不能与 around/after 同用。
- `around=<messageId>`：定位目标所属轮及相邻上下文，目标保证在返回片段内；长单轮从目标附近截取。
- `after=<opaqueCursor>`：向后补齐目标窗口与最新消息之间的间隙。
- 不接受客户端 userId/resourceId 扩权，不允许请求无限 limit。

```ts
type HistoryPoint = { createdAt: string; id: string }; // DB 精确时间，不经 JS Date 降精度
type HistoryCursor = string; // opaque base64url，客户端只原样保存
type HistoryTurn = {
  turnId: string; // 已知起点用用户 messageId；未知起点按下文 provisional 协议
  originMessageId: string | null;
  provisional: boolean;
  replacesTurnIds?: string[]; // 起点已找到时，返回被正式 turnId 替代的 provisional IDs
  messageIds: string[];
  partialBefore: boolean;
  partialAfter: boolean;
  turnContext?: { messageId: string; preview: string };
};
type HistoryWindow = {
  version: 1;
  thread: { id: string; resourceId: string; metadata?: unknown; updatedAt: string };
  messages: MastraDBMessage[]; // JSON 中 createdAt 为 ISO，客户端显式转换 Date
  turns: HistoryTurn[];
  previousCursor: HistoryCursor | null;
  nextCursor: HistoryCursor | null;
  snapshotUpper: HistoryCursor | null;
  oversizedMessage: boolean;
};
```

messages 总是按 DB `(createdAt,id)` ASC 返回，使用与当前存储一致的 createdAt 字段；createdAtZ 只按当前 normalizer 用途保留，不能混用两种时间字段排序。游标使用 DB 精度原值，参数化 tuple 比较，相同时间以 ID 确定顺序；ID 比较必须与 SQL ORDER BY 的 collation 一致。

游标携带 version、用户、thread、方向、边界 tuple、snapshotUpper，以及可选 openTurn（未闭合分组的 provisional ID）；最大 4096 字节，严格类型校验。游标是位置，不是授权令牌；每个请求重新鉴权和检查 thread/resource 归属，伪造游标不能扩大可读范围。无需新增密钥或持久会话。around 目标不存在/已删除返回明确 404；目标属于别的 thread 也不得透露其详情。

### 5.2 查询与一致性

1. `trustedAuth` + 现有 `assertThreadOwned`，包括管理员也按既有 owner 规则。失败用现有 401/403/404 语义。
2. latest 固定当前最大 tuple 为 snapshotUpper；around 固定请求时 upper。后续旧页沿用该 upper，新追加消息不会推动 OFFSET。
3. 用 keyset 查询轻量 ID、role、type、时间、content 字节数及 signal 所需最小标识，倒序扫描最多单次窗口所需 200 条加边界探针。不得先读取全部 content 再 slice，也不做全线程 COUNT、全表窗口函数或 OFFSET 扫描。
4. 选择最近轮边界；达到 8 轮或预算后停止。未找到起点的长轮使用 partial 与 continuation，不无限追溯。需要 turnContext 时做单独的有界起点定位；未找到可不返回摘要，不为摘要无限扫库。
5. 在选定 ID 范围读取完整 content，显式正规化旧字符串、format 2、signal、metadata、createdAt，保留工具状态及 data-nero/data-om part。参照当前 @mastra/pg normalizer，不能仅 JSON.parse 后丢字段。
6. 使用只读 REPEATABLE READ 事务保持同一响应内部一致；跨请求靠边界定位，不声称锁定多请求的内容快照。已有消息在原 ID 更新，需要第 7 节对账。
7. 删除游标锚点后仍按 tuple 查找，不要求锚点行存在；空页必须推进或结束，不能重复返回同游标。

### 5.3 未知起点的临时轮标识

200 条有界扫描可能找不到 500 条长轮的用户起点；不能声称此时知道用户 messageId，也不能为了固定 turnId 无限扫描。明确采用 provisional ID 协议：

- 首次遇到起点未知的连续片段，生成 `partial:<snapshotUpper.id>:<该片段最新messageId>`，originMessageId=null、provisional=true；将此 ID 带入同方向续页游标的 openTurn。
- 续页在遇到真实用户边界之前沿用该 ID。找到用户起点后改用其 messageId，并用 replacesTurnIds 通知前端归并；legacy 仅到达会话开头后才用 `legacy:<首条messageId>` 正式化。
- around 可能建立另一临时 ID。两窗口仅在消息 ID 重叠、或通过连续 cursor 衔接且中间无用户边界时归并；不能因摘要文本相同归并，不能跨 gap 猜测同轮。
- 前端维护 alias 映射，正式化时迁移展开状态、高度、焦点和 scroll anchor；message DOM key 始终用原 messageId，不能因 turnId 变化重建正在输入的审批表单。run/产物仍按服务端 runId，不使用临时轮 ID。
- openTurn 仅为分组提示，不用于授权或缩小查询 owner 条件；服务端对消息实际用户边界重新判定，畸形结构拒绝。

先核查现有 `(thread_id,createdAt)` 索引和 EXPLAIN。若为了同时间 ID 排序确需新索引，提交单独、可回滚 migration 并说明证据；不要启动时盲目创建索引。本方案默认无迁移。

## 6. 前端加载、缓存与搜索

新增 `history-window-client.ts`、`thread-history-cache.ts`、`use-thread-history.ts`、`history-window-state.ts`。网络使用已有 `apiFetch` 和 AbortSignal；不绕过认证。

缓存仅在内存，key=`userId:threadId`，保存消息、turns、双向 cursor、snapshotUpper、scroll anchor、fetch time。LRU 同时按 5 项/10 MiB 淘汰。登出、切换用户清空；删除会话清除对应项；403/404 清缓存且不继续展示；新增回复/定时任务更新使该项待刷新。不把 IndexedDB 搜索缓存当完整聊天缓存。

- 首次无缓存：只请求 latest，一个 window 响应后展示。错误提供 `加载失败，重试`，不能把所有网络失败误报“无权访问”。
- 已验证的同一登录用户缓存：立即展示，再后台验证最新窗口和权限；这是展示缓存，不给发送/审批授权。待验证时禁用发送与工具决策；401/403/404 后清屏。TTL 内也需后台验证，不能以缓存 TTL 替代鉴权。
- 切换 thread、owner 或 around 目标立即 abort 旧请求；generation 校验防止迟到结果覆盖。中止不显示错误。一个方向同时只允许一个 loadMore 请求。
- 历史加载按钮固定文案 `加载更早的对话`；滚动到顶部阈值触发同一函数。加载中显示局部状态；失败保留当前消息并显示重试；到底提示 `已加载全部历史`。
- prepend 前记录首个可见 message ID 与相对 viewport top；提交后恢复该锚点偏移。图片/图表变高由 resize 测量修正；用户在看历史时不自动跳到末尾。
- 新打开 latest 在首次布局后定位底部，后续只在用户原本接近底部时跟随新内容。不能每次加载更多都重新“首屏跳底”。
- 搜索 `targetMessageId` 进入时先请求 around；目标消息显示后定位/高亮。不得从最早逐页遍历找目标。显示 `回到最新消息`，点击重新 latest；如用户选择加载目标之后的内容，使用 nextCursor 填补间隙。窗口间有洞时显示提示，不能把两端拼成连续对话。
- 原 `loadScopedThread` 保留供全量历史搜索索引；本计划不让全文搜索只索引最近 8 轮。

## 7. 实时合并、对账与产物

Loaded history 由窗口控制器保存；useChat 负责当前 live tail。渲染视图用 message ID 合并，不把 prepend 当成发送新消息，不在每次分页时重置正在进行的 stream。`initialMessages` 更新会触发当前 @mastra/react 初始化逻辑，实施必须检查并通过测试后决定单独 displayHistory 或受控 setMessages；禁止假设传入新 initialMessages 永远无副作用。

对账 `reconcileThreadTail({threadId, userId, liveMessages, signal})`：从当前轮真实用户起点（优先稳定 ID，不用正文）定位 around/after 窗口，覆盖 live IDs；最长按 200 条片段推进当前轮，而不是扫描之前所有轮。仍保留最多 3 次、250/750ms 间隔，只有 historyCoversLive 成立才覆盖相应 live tail。未覆盖时保留 live，不覆盖旧已加载页。原 ID 更新的工具结果不在 after-createdAt 之后，所以不能仅依赖“更新时间新消息”增量。审批 suspended 保留交互，不作为任务终态；恢复同一 run 不重复卡片。

定时任务 subscription 和 polling 均经相同 ID/part 合并器，不能用仅保留 user 的策略替换整个已加载历史。轮询退避沿用原机制，本次只限定历史读取范围。

产物修复：

- reconciliation 对相同输入内容返回稳定结果，`withPendingUserMessages` 无 pending 时复用输入；UI 派生数据用 memo。
- `useTurnArtifacts` 本地 parts 合并与远端获取拆开。远端 key 是 thread + 排序去重后的所需 runIds + settledVersion/手动刷新版本，而非 messages 引用。
- 远端响应无实际 revision/状态/内容变化时返回原 Map；生成新 Map 不能单独触发远端刷新。每个 key 只保留一个 in-flight，切换 thread 取消，失败只在显式重试或新版本时重试。
- 初次取当前窗口所需产物，分页/搜索追加窗口仅补未缓存 run；不能每个 token 扫历史最多 20 页。
- 保留终态、revision 防回退、锚点与文件打开行为；修复请求循环不是删掉产物功能。

## 8. 渲染与交互

按 turnId 建立轻量壳，turn 内 message 保持原顺序。首屏最新窗口、当前 active/suspended 轮、搜索目标和焦点所在轮必须挂载。其他轮只在视口上下 1000 px 范围挂载正文，离屏保留测量高度占位；缺少 IntersectionObserver 时退回普通渲染，不隐藏历史。使用 ResizeObserver 缓存高度，宽度/字体主题改变后失效。退出视口前不能卸载有焦点、文本选择或未完成审批表单的轮。

历史已完成 reasoning 默认收起，真正点击展开才挂载 Markdown；当前运行 reasoning 沿用既有显示行为。工具详情同样按展开挂载，避免关闭的面板仍 stringify 大结果。旧消息正文 memo、Markdown block memo 保留，不把代码高亮或图表安全规则改掉。

图表通过上层挂载门控延迟初始化，离屏释放既有实例；返回视口恢复，不重复创建多个观察器。移动端、键盘/触屏、回复复制、附件、产物点击与 right panel 继续可用。复制回复使用完整正文，不复制 12000 字预览或 turnContext 提示。

## 9. 验证、性能目标及风险

自动化必须覆盖：8 轮小问题上下文；短会话全量；同时间消息稳定排序；超长一轮分段不丢消息；预算超单条仍推进；user/signal/legacy；旧格式；跨用户游标与 around 隔离；锚点删除；分页期间追加消息；已有 ID 工具结果更新；请求取消；缓存退出/切用户清除；搜索远历史；prepend 不跳底；运行/审批中加载历史；定时任务不删旧 assistant；产物 key 不随 token 改变；图表和详情未展开不初始化。

性能使用本地合成数据，不在生产生成 1000 条测试会话：20 条短消息、1000 条/100 轮、单轮 500 条工具消息、单条 2 MiB 正文、大量 Mermaid/ECharts 四类样本。固定浏览器、设备、网络条件，至少 5 次 cold/warm，报告 median/p95，不以 Vitest/jsdom 耗时冒充真实浏览器性能。

确定性验收：初次 UI 1 个 window 请求，不调用完整 loadScopedThread；单页 <=200 条（字节为软预算）；1000 条历史不全部下载；静止 5 秒产物请求不增长；上翻只有一条同方向 in-flight；远历史搜索不遍历中间页。

相同环境体验目标：1000 条普通历史的 cold 首个可见最新内容 median 相对旧方案降低 >=50%；warm 缓存先显示且后台验证；prepend 锚点稳定后偏移 <=4 px。若网络、巨型单条或设备导致目标未达，报告分阶段证据和剩余瓶颈，不修改采样口径宣称通过。

记录接口 TTFB/JSON 字节、首个最新内容可见时间、React commit、主线程长任务、挂载图表数及请求数。不打印真实正文、凭证、工具敏感输出。验证工件放 `docs/superpowers/verification/2026-10-24-agent-thread-history-performance.md`，只保存脱敏汇总与截图。

已知风险：窗口化的浏览器原生 Ctrl+F 只能搜索已挂载内容，产品完整搜索走已有历史搜索；单条巨大消息仍有网络成本；老系统消息格式可能需要适配。以上不通过删数据、清工作区或改模型记忆解决。

## 10. 发布与回退

本次 Cursor 执行只实现和本地验证，不自动部署。保留原全量函数作为显式诊断回退，不在错误分支静默退回全量下载。可用前端构建开关 `VITE_THREAD_HISTORY_WINDOW_ENABLED` 在构建时选择新/旧 UI 读取（默认 true）；false 用原链路，后端只读路由保持兼容。产物请求循环修复独立保留，不能随 UI 回退重新引入。

不改变原有消息/工具/记忆 API 的协议，不添加无证据的索引。需要上线时单独按项目现有发布流程构建前后端，并验证新旧页面与鉴权；回退使用原 release，不执行数据回滚。
