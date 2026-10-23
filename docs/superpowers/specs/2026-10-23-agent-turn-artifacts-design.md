# Agent Turn Artifacts Design

## 1. 文档状态与实施入口

- 日期：2026-10-23。
- 用户已确认交互与功能方案，并要求提供供 Cursor 执行的设计和计划。本次交付仅新增文档，没有实现本功能。
- 配套计划：[2026-10-23-agent-turn-artifacts.md](../plans/2026-10-23-agent-turn-artifacts.md)。
- 项目：`nero-agent`；参考项目：`/Users/nerosun/裂缝中的阳光/sxy/工作/tc-yyxt/fontend/tc-prime-ai`。
- 执行前必须读根目录 `AGENTS.md`、`.claude/skills/mastra/SKILL.md`，并查当前安装版本的 Mastra 文档、类型与源码。本文的新增接口是实施约定，不代表已有框架 API。
- 按现有产品、CSS 与组件扩展，不重新设计页面。不得顺手提交、覆盖其他未提交改动，也不自动部署线上。

## 2. 目标与范围

每轮 Agent 回复结束后，若这一轮真实新增或修改了个人工作区普通文件，在该轮末尾展示紧凑的“本轮产物”列表。点击列表中的文件时，打开右侧文件面板、展开所有父目录、滚动并高亮目标文件，同时使用现有预览组件打开文件。

必须覆盖：

1. `write_file` 写文本、`edit` 修改已有文件。
2. `execute_command`、`execute_bash` 生成或更新二进制与文本文件。
3. 技能脚本执行产生的文件。
4. 普通聊天、定时任务，以及工具暂停后恢复执行。
5. 历史会话、页面刷新、断线后重新进入。

不在范围内：Git diff、行数统计、版本回滚、历史文件副本、模型补写文件总结、给旧会话猜测并回填产物、自动下载、改变沙箱权限或部署配置。文件列表中已有的下载、删除、上传和 composer 附件功能继续保留。

## 3. 当前实现与差距

| 现有位置 | 已确认行为 | 本次影响 |
| --- | --- | --- |
| `web/src/agent/AgentChat.tsx` | `isRunning` 从真变假时刷新文件与附件；定时任务有独立 settled 回调 | 补充产物加载与真正回合终态判定；不能把审批暂停当完成 |
| `web/src/agent/MessageList.tsx` | 按消息展示文本、工具、推理等 parts，没有回合产物区域 | 按 run 分组，在该轮尾部展示独立组件 |
| `web/src/agent/message-parts.ts` | 解析已有 `data-nero-*` 与工具 parts | 增加产物协议解析和 run 引用读取 |
| `web/src/agent/RightPanelDock.tsx` | 面板开关状态在组件内部，只能点击切换 | 增加外部打开请求，保持手动切换与动画 |
| `web/src/agent/WorkspaceFileTree.tsx` | 保存展开目录，无外部定位请求 | 增加展开、定位、高亮 |
| `web/src/agent/WorkspaceFileOverlay.tsx` | 已支持预览、编辑、下载及未保存确认 | 复用，不另造 PPTX/HTML 预览器 |
| `src/mastra/files/tools.ts` | `write_file` 有任务质量证据登记；`edit` 没有统一产物登记 | 接入统一采集器，不替换质量证据机制 |
| `src/mastra/sandbox/manager.ts` | 命令结果只有退出码、stdout/stderr、超时标记 | 执行边界补文件快照和变更采集 |
| `src/mastra/skills/script-runner.ts` | `artifactRelativePaths` 只识别会话目录新增路径 | 复用统一指纹采集，识别修改；兼容旧字段 |
| `src/mastra/skills/execution-context.ts` | 已有服务端绑定 run/thread 的 WeakMap | 复用身份来源，不信任客户端传入 runId |
| `web/src/agent/chat-message-reconciliation.ts` | 合并实时与落库历史，已有 custom part 去重 | 补产物 revision 合并，防历史结果覆盖新状态 |

参考项目的 `HarnessChatMessageList.vue`、`MessageDiffSummary.vue` 展示的是会话累计变更；`ChatNext.vue` 有打开源文件入口，`FileTreePanel.vue` 有 `revealFile()`。这里只借鉴紧凑列表、展开更多、源文件定位；不复制累计统计和 Diff 逻辑。

## 4. 用户体验约定

### 4.1 产物列表

- 标题：`本轮产物 · N 个文件`。
- 每行：文件类型图标、文件名、`新增` 或 `更新`。
- 文件名相同时增加父目录提示；完整工作区相对路径放在 title/可访问说明中。
- 默认展示 3 项；超过 3 项提供 `展开其余 N 个`，展开后可 `收起`。
- 放在该轮所有工具/文本/结果状态之后、回复操作按钮之前；不得插在过程工具中间，也不能只放在整个会话最底部。
- 多轮分别展示；新一轮流式执行时不隐藏旧轮列表。
- 纯聊天、只读工具、没有内容变化的写入、仅删除文件，不显示产物列表。
- 不按扩展名过滤实际文件，`.pptx`、`.html`、`.png`、`.py`、无扩展名文件都可以是产物。
- 产物记录仅证明文件实际存在和被修改，不表示 PPTX 内容正确或整个任务成功。

### 4.2 点击与历史语义

一次点击必须完成：打开 files 面板 → 加载/刷新目录 → 展开祖先 → 滚动居中并高亮 → 打开现有预览。

- 相同文件重复点击也重新定位；用递增 request id，而非只监听 path 变化。
- 用户在配置面板时，切换到 files；已经打开 files 时保持打开，不能 toggle 关闭。
- 文件树按实际显示祖先展开，兼容隐藏 uploads UUID 中间目录的现有规则。
- 文件加载期间保留定位请求；数据到达后再定位，不能先判定不存在。
- 以最新点击为准，旧目录请求、旧预览响应不能覆盖新点击。
- 已有未保存编辑时，继续走 `WorkspaceFileOverlay` 的保存/放弃/继续编辑确认。文件树可先定位，但不能偷偷丢弃草稿。
- 历史记录打开当前文件版本，不保留历史字节；后来删除的文件提示 `文件已不存在`，原历史卡片保留。
- 不在点击时执行产物、启动模型或自动下载。

### 4.3 终态与移动端

- `running`、`suspended` 时不展示当前轮最终列表。工具审批、ask_user、网络重连造成的暂停不算结束。
- `completed`、`failed`、`cancelled`、`interrupted` 都是终态。非成功状态如有有效文件，显示 `本轮保留文件 · N 个文件`，避免暗示全部成功。
- 新一轮不覆盖上一轮；恢复同一服务端 run 使用原记录和递增 revision。
- 移动端没有桌面 right-panel：产物仍可点击，在当前会话使用已有全屏预览，不增加桌面面板；桌面完成完整树定位。

## 5. 端到端架构

```text
服务端绑定 user/thread/run
        ↓
受控文件操作 / 沙箱命令 / 技能脚本
        ↓
用户工作区写操作互斥 → 操作前后指纹 → 本操作变化
        ↓
按 run + workspace-relative-path 合并 → 每次变更增量持久化
        ↓
真实回合终态确认 → 核实文件存在 → 保存 terminal revision
        ↓
可选流式通知 + 鉴权历史查询接口（持久记录为事实来源）
        ↓
前端按 run 关联消息 → 每轮末尾列表
        ↓
统一 openWorkspaceArtifact(request) → files 面板 + 树定位 + 预览
```

事实来源是服务端真实文件变化和持久记录。禁止解析 stdout、模型 Markdown、文件链接或提示词来推断产物。禁止在浏览器全工作区 list 前后做差并归属到某一轮。

## 6. 路径、指纹与归属

### 6.1 统一路径

产物 `path` 始终是当前用户个人工作区根下的 POSIX 相对路径。例如：

| 来源 | 原始路径 | 产物 path |
| --- | --- | --- |
| thread 文本工具 | `output/deck.pptx` | `threads/<threadId>/output/deck.pptx` |
| workspace 编辑工具 | `projects/report.md` | `projects/report.md` |
| 沙箱 | `/workspace/threads/<threadId>/deck.pptx` | `threads/<threadId>/deck.pptx` |
| 工具返回链接 | `/user-files/<threadId>/deck.pptx` | 不把 URL 当路径，使用受信文件操作的实际路径 |

- `source` 固定 `personal`；保留协议字段以便前端复用，不把旧 Agent 共享工作区混入个人产物。
- user 来自 trusted auth；run/thread 来自服务端绑定，并执行 `assertThreadOwned`。
- 工具参数 threadId 必须与绑定执行 thread 一致；不能因为同属一个用户就把别的会话的文件记到当前 run。
- 不存宿主绝对路径、容器绝对路径、下载 URL、文件内容或凭据。
- 拒绝绝对路径、NUL、反斜线、`.`/`..` 段、符号链接及越界 realpath；复用既有策略。

### 6.2 指纹采集

新增 `src/mastra/files/artifacts/snapshot.ts`，流式读取普通文件计算 SHA-256，结合 `dev/ino/size/mtimeNs/ctimeNs` 缓存已核实的 hash。内容相同的 touch/同字节覆盖不计更新；同体积内容替换必须识别。读取前后 fstat 发生变化的文件不作为已确认结果。

- 扫描当前用户 workspace，在可信的实际操作边界内采集，而不是整个模型思考期间。
- 沙箱运行环境准备、技能资源准备完成后，再开始用户命令的 before 快照；finally 中收集 after，必须等待进程已经退出或终止。
- 允许记录命令对工作区共享目录的真实写入；不能扫描其他用户根目录。
- 排除任意层级的 `.runtime`、`.git`、`.venv`、`node_modules`、`node_modules.incompatible-*`、`__pycache__`，以及 `threads/<id>/tmp/**` 和平台 `.UUID.tmp` 暂存文件。
- `input` 目录不是全局排除项：Agent 确实写入的普通文件可以记录；用户浏览器上传本身不是 Agent 产物。
- 预算：单次扫描最多 5,000 个候选文件、最多实际读取 512 MiB、最多 10 秒；每次扫描独立计数。超限不伪装成空列表，标记 `collectionStatus: partial`，已确认条目仍可展示，附短提示 `部分文件未完成采集`。
- 重用 metadata 未变的 hash，避免每条只读命令都重读整个 500 MiB 工作区；缓存按用户隔离、最多保留 32 个用户，按 LRU 淘汰。缓存是加速手段，不是持久清单。
- hash 对外表示复用现有文件 ETag 的带引号 SHA-256 格式，避免同一文件两套格式导致永远判为修改。
- partial 快照中“没有某路径”代表未知，不能推断原先不存在/后来删除。只有完整快照缺失，或操作前/后针对该路径的安全读取明确得到 ENOENT，才能写 NULL 指纹；无法证明的条目不分类为 created/deleted，保留 partial 提示。

### 6.3 并发与写入互斥

单纯前后快照无法区分“命令生成文件”和“同一时间浏览器上传”。必须增加用户级工作区 mutation coordinator，供所有应用内写操作共用：

- 原有 `commandQueue` 继续负责同线程执行顺序和全局并发数；在已进入队列的实际操作内部，获取用户级 mutation 锁。
- 文本写/改/删、网页上传/保存/批量删除、沙箱命令、技能执行/资源准备均经过同一协调器。
- 普通 API 上传只参与互斥，不登记当前 Agent run；手工编辑同理。
- 不能在持有 commandQueue 槽位时再次调用 commandQueue，也不能重复获取同一用户锁。内部组合操作通过服务端私有 token 复用持锁上下文，不能把 token 暴露为工具参数或 JSON。
- 有数据库时使用独立连接上的 PostgreSQL advisory lock，按 namespace + userId 哈希键隔离；连接获取/锁等待必须支持取消与超时，finally 释放锁及连接。无数据库单测使用同语义的进程内 adapter。
- 锁住文件操作与 before/after 采集，不锁住整个模型回合。不同用户仍可并发。
- 外部 SSH、宿主人工直接改盘、逃逸到不受控的后台写进程不属于应用内来源证明；不能承诺区分这些写入。部署仍须保持现有隔离，不为采集扩大 Docker 权限。

### 6.4 同轮合并规则

对每个 `(runId, path)` 保留首次触及前的内容指纹或不存在标记，以及最后一次操作后的指纹：

- 首次不存在，末次存在：`created`。
- 首次存在，末次内容不同：`updated`。
- 首次、末次内容相同：从最终列表移除，包括改动后恢复原文。
- 新增后多次改写：仍为一条 `created`。
- 创建后删除，或最终不存在：不展示可打开条目。
- 删除后原路径重建：按首次和末次指纹决定 created/updated/无净变化。
- 重命名：旧路径不展示，新路径显示 created；不做重命名推断。
- 终态检查只核实路径仍存在、普通文件及安全性，不把未经过本轮操作的其他文件纳入。

首次指纹与变化记录在每次操作后持久保存，不能只留 WeakMap，否则暂停恢复和进程重启后会丢失合并基线。

## 7. 新增契约

### 7.1 服务端 / 前端共享概念

```ts
type ArtifactRunState = 'running' | 'suspended' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
type ArtifactCollectionStatus = 'complete' | 'partial';
type WorkspaceArtifact = {
  path: string;              // 用户工作区相对路径
  source: 'personal';
  name: string;
  change: 'created' | 'updated';
  size: number;
  etag: string;              // 本轮最后确认版本；不代表预览永远返回这个版本
};
type TurnArtifacts = {
  version: 1;
  runId: string;
  threadId: string;
  revision: number;
  state: ArtifactRunState;
  collectionStatus: ArtifactCollectionStatus;
  anchorMessageId: string | null;
  artifacts: WorkspaceArtifact[];
};
```

`anchorMessageId` 是服务端确认的该轮最后一条 assistant 消息 ID。前端还通过消息中服务端写入的 `content.metadata.neroArtifactRun = { version: 1, runId, threadId }` 关联；不能只靠前端消息 ID，因为实时消息可能被 `@mastra/react` 改为 `client-set-*`。

### 7.2 存储

新增迁移 `015_agent_turn_artifacts.sql`。执行时若 015 已被其他功能占用，使用下一个编号，并同步本文和计划。

- `app_agent_artifact_runs`：`run_id TEXT PRIMARY KEY`、`user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE`、`thread_id TEXT NOT NULL`、`state`、`revision BIGINT DEFAULT 1`、`collection_status`、`anchor_message_id TEXT NULL`、`created_at`、`updated_at`、`finished_at NULL`。
- `app_agent_run_artifacts`：`run_id` 外键级联、`path TEXT`、`initial_etag TEXT NULL`、`latest_etag TEXT NULL`、`size BIGINT`、`last_operation_id TEXT`、`updated_at`，主键 `(run_id, path)`。NULL initial 表示首次不存在，NULL latest 表示末次不存在。
- `app_agent_artifact_operations`：`run_id` 外键级联、`operation_id TEXT`、`completed_at`，主键 `(run_id, operation_id)`，与变化 upsert 同事务，防重复落库颠倒合并状态。
- 对 `(user_id, thread_id, created_at, run_id)` 建索引；检查 size >= 0、revision >= 1、合法 state/status。
- owner/thread 创建后不可更改。runId 冲突时必须验证 owner 和 thread 一致，不能仅 `ON CONFLICT UPDATE`。
- 不依赖 `app_agent_run_controls` 存在对应行；该表用于预算，产物功能不能因质量模式或预算设置不同而失效。
- 生产数据库持久化；无 DB 的 unit test adapter 可内存实现，但不能描述为支持重启恢复。
- 会话删除复用现有删除链路清理产物 run；使用应用层操作，不给 Mastra 内部表新增猜测的外键。用户删除由外键级联。

### 7.3 查询与流式协议

新增鉴权接口：`GET /current-workspace/turn-artifacts?threadId=<id>&cursor=<opaque>&limit=50`。

- 默认 limit 50，允许 1–100。按 `(created_at DESC, run_id DESC)` keyset 分页；返回 `{ items: TurnArtifacts[], nextCursor: string | null }`。
- 校验登录、USER_FILES_ENABLED、thread 归属。userId 不能通过 query 指定，管理员也不能旁路读取其他用户。
- 返回该会话 run，包括运行态记录；前端只对终态展示最终摘要。
- 列表按消息所属 run 查询完整分页，直到覆盖已加载消息；不因为只取前 50 个就让老消息清单消失。滚动加载历史时继续加载相关分页。
- 无产物、complete 的空 run 允许服务端省略；partial 的空 run仍返回，便于显示采集不完整提示。
- 回合完成前先提交数据库，再可选推送 `{ type: 'data-nero-artifacts', data: TurnArtifacts }`；通知丢失后通过 GET 恢复。
- writer.custom 不等于消息持久化。显式把 run 引用 metadata 合并进该轮 response 的 assistant 消息，并用数据库回读测试证明保留；custom part 不持久化时不阻碍历史 GET 恢复。
- 合并以 runId + revision 为准，只接受更高 revision；相同 revision 内容不应变化。终态允许补充锚点/采集状态时提升 revision，不以旧 running 通知回退新终态。
- 鉴权/落库失败不伪造成功结果；文件操作已成功而产物落库失败时保留原操作结果，记录结构化错误，并标注可见的采集不完整状态（若通知和 DB 都不可用，前端显示本次摘要暂不可用，不伪造“无变化”）。不重执行写命令来补记录。

## 8. 回合生命周期与 Mastra 接入

新增 `artifacts/processor.ts`、`artifacts/lifecycle.ts`，复用服务端绑定，不修改 skill runId 生成规则。

1. 首次 input step 幂等初始化 run；同一输入流程后续 LLM step 不重置清单。
2. 对本轮 assistant response 的 metadata 合并 run 引用，保留 skill、模型、usage 等已有字段。
3. 每个工具操作后持久增量，正常结束时 finalize 并刷新最终清单。
4. 正常结束、maxSteps/预算停止、模型错误、取消、工具暂停分别判断。`processOutputStep` 每个模型 step 都可能执行，不能每个 step 都 finalize。
5. **已验证（Mastra `@mastra/core` 1.71.0，见 `tests/turn-artifacts-lifecycle-contract.test.ts`）：**
   - 同 run 多 tool/LLM step：`processInput` 一次；`processInputStep` / `processOutputStep` 每模型 step 各一次；`processOutputResult` 终态一次；writer 在 output hooks 可用。
   - 工具 suspend：不调用 `processOutputResult`；`resumeGenerate` 保留同一 `runId`，恢复后再调用一次 `processOutputResult`。
   - maxSteps 停止仍调用一次 `processOutputResult`。
   - provider 抛错：仍调用 `processOutputResult`，且 `result.finishReason === 'error'`（空 text）；不能把每次 `processOutputResult` 都当成 `completed`。
   - 工具执行中 abort：可能不抛错而 resolve，`result.finishReason === 'aborted'`，并仍调用一次 `processOutputResult`；结算为 `cancelled`。
   - `processOutputResult` 内合并 `content.metadata.neroArtifactRun` 可经 Memory + MockStore 保存并回读，且保留文本、工具 part 与既有 skill metadata。
   - 相同 run 的 finalize 必须幂等。禁止另起消费者 drain/tee `fullStream`。
6. 外围接入复用 `skills/agent-bindings.ts` 现有 start/resume/sendMessage 包装（内部调用 `prepareSkillRunOptions`）；不能再次给同一个入口绑定新 run，也不能另起消费者 drain fullStream，或延迟用户收到每个 token。
7. 工具暂停记录 suspended，resume 使用同 run 累积记录，受信 resume 入口将 suspended 转回 running；禁止任何迟到的普通通知把终态退回 running。真正结束后才展示。非预期进程中断：保存过的操作变化不能丢，按已有运行恢复机制确认不再执行后标为 interrupted。不能按任意短超时把正在运行的长任务宣判完成。
8. 输入/输出处理器在 `agents/agent.ts` 挂载；如新增 route，在 `src/mastra/index.ts` 注册。新增 agent/tool/workflow/scorer 若确有需要必须在 index 注册；本功能不需要新 LLM 工具。
9. 定时任务调用同一个 Agent，使用同一采集和终态接口；前端在 scheduled settled 后刷新摘要，不能只有手工聊天有产物。

## 9. 前端组合方式

建议新增：

- `turn-artifacts.ts`：协议校验、终态判断、revision 合并、run 与可见消息关联纯函数。
- `turn-artifacts-client.ts`：鉴权分页请求，复用 `apiFetch`。
- `use-turn-artifacts.ts`：进入/切换会话、回合终态、定时任务 settled 时加载。维护 generation + AbortController；旧会话结果不能污染新会话；瞬时错误保留已加载历史摘要。
- `TurnArtifacts.tsx`：紧凑列表和展开，唯一输出是 `onOpenArtifact(artifact)`。

`MessageList` 先用 run 引用形成回合分组，再决定每组最后一个可见 assistant 行。不要把 parts 里的产物直接原位渲染，否则会回到流式过程中显示的问题。工具多步 assistant、独立 task outcome 或 reasoning-only 重排都不能造成列表提前、重复或消失。

空文本/仅工具结果的终态也要有列表。没有可见 assistant 时，允许在有服务端 run 引用的该轮用户消息之后放独立摘要行，不伪造 assistant 文本。完全没有可靠 run 锚点的旧消息不猜测归属。

`AgentPage` 提供统一接口：

```ts
type WorkspaceRevealRequest = {
  id: number;
  path: string;
  source: 'personal' | 'agent';
  threadId: string;  // 发起点击所在会话，用于切换会话失效处理
};
// openWorkspaceArtifact(artifact) 由 AgentPage 生成递增 id，并派发两个消费请求。
```

- `RightPanelDock` 新增 `openRequest?: { id: number; panel: 'files' }`，接收新 id 时以“确保打开”设置 active/desired，保留已有动画与尺寸状态。
- `WorkspaceFileTree` 新增 `revealRequest?: WorkspaceRevealRequest`。refresh 完成后验证目标存在，展开 `workspaceDisplayEntries` 的真实可见祖先，DOM 提交后 `scrollIntoView({ block: 'center' })`，设置持久 selectedPath；临时强调可 1.5 秒结束，选中状态保留。
- 预览请求显式带 source。`AgentPage` 不能继续用当前 agent.workspaceId 推导所有点击源；历史个人产物始终读 personal。切换 source、刷新、打开预览按同一次 request 的 source 执行。
- 从文件树手动打开文件继续走相同预览入口，保留旧行为。

## 10. 文件布局

新增后端目录 `src/mastra/files/artifacts/`，按 `types / paths / snapshot / mutation-coordinator / repository / collector / lifecycle / processor / routes` 拆分。明确职责，不把整套逻辑塞进 files/tools 或 AgentChat。

修改现有文件：

- `src/mastra/files/{tools,service,workspace-service,workspace-editor,routes}.ts`
- `src/mastra/sandbox/{tool,manager,types}.ts`
- `src/mastra/skills/{script-runner,agent-bindings}.ts`
- `src/mastra/agents/agent.ts`、`src/mastra/index.ts`
- 实际现有会话删除入口（执行前用 rg 确认调用链）
- `web/src/agent/{AgentChat,AgentPage,MessageList,RightPanelDock,WorkspaceFileTree}.tsx`
- `web/src/agent/{message-parts,chat-message-reconciliation}.ts`
- `web/src/agent/turn-artifacts.css`（新增，沿用现有 token）

保持上一轮上传、下载改动及其他用户未提交改动。不得为本功能重构模型目录、附件协议或预算系统。

## 11. 验收标准

| 场景 | 预期 |
| --- | --- |
| 普通问答、list/read/glob/grep | 无产物列表 |
| 本轮生成 HTML、PPTX、Python | 终态列表含 3 个真实文件 |
| 命令 stdout 声称写文件，实际没写 | 不出现伪造产物 |
| 已有文件等体积改内容 | 一条更新 |
| 同轮反复写、新建后改、改后恢复 | 去重，保持首次语义，恢复原文不显示 |
| 新增后删 / 仅删除 | 不出现不存在的可点击产物 |
| 命令退出非零 / 取消前已落文件 | 核实后以“本轮保留文件”展示，不宣称成功 |
| 审批暂停、恢复、多步模型 | 暂停不结束；同 run 恢复后只展示一次 |
| 新一轮开始、历史刷新、断线重连 | 老轮次清单保留、归属不串轮、revision 不倒退 |
| 浏览器上传与命令同时发生 | 上传等待同用户写锁，不被计入 Agent 产物 |
| 两用户、两会话、共享目录并发写 | user/thread/run 归属正确；不同用户不串数据 |
| 产物后续删除或改版 | 删除提示不存在；改版打开当前版本 |
| 点击深层/中文/空格/百分号文件 | 面板打开、所有可见祖先展开、高亮、正确预览 |
| 同路径重复点击、快速点击不同文件 | 每次可定位，最后点击获胜 |
| 已有未保存草稿 | 原确认弹窗生效，不静默丢修改 |
| 移动端点击 | 打开全屏预览，不渲染桌面面板 |
| 采集预算超限/DB 或 API 错误 | 保留已知结果，明确 partial/unavailable，不阻断正常聊天 |

必须执行 unit、真实 PostgreSQL repository/route、Mastra 生命周期/持久化 characterization、前端交互与浏览器检查。检查清单和命令详见配套计划。
