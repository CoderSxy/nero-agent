# Agent Turn Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. Cursor 若没有该 skill，仍按本计划的顺序逐项完成测试、实现和验证。默认单个执行者串行推进；不要自动派发子代理或自动部署。

**Goal:** 每轮回复终态在该轮末尾显示真实新增/修改的工作区产物；点击产物能打开右侧文件面板、展开并定位文件、使用现有组件预览。

**Architecture:** 服务端在受控文件操作边界内采集变化，按服务端 user/thread/run 合并并持久化。前端通过流式通知与鉴权历史接口恢复同一份清单，按回合渲染。统一文件打开请求驱动面板、目录树和预览，不让模型生成产物清单。

**Tech Stack:** TypeScript、Mastra `@mastra/core` 1.71.0（执行前核实实际 lockfile）、Node fs/crypto、PostgreSQL/pg、Hono、React 19、Vite/Vitest、现有 `@mastra/react`、motion/react。

**Spec:** [2026-10-23-agent-turn-artifacts-design.md](../specs/2026-10-23-agent-turn-artifacts-design.md)。必须完整阅读设计，本文没有取代其边界条件。

## Global Constraints

- 只在当前 `nero-agent` 项目实现；tc-prime-ai 为只读参考。不部署、不更改 ECS 权限/环境变量。
- 先读根 `AGENTS.md` 和 `.claude/skills/mastra/SKILL.md`；依照安装包 embedded docs、d.ts 和源码验证框架行为，不用记忆替代。
- 新增路由在 `src/mastra/index.ts` 注册；处理器挂到现有 Agent。开发和构建使用 package.json 的 `npm run dev` / `npm run build` 脚本。
- 不覆盖既有脏工作区，不 `git add .`。每个任务允许独立提交本任务文件，但不得顺带提交其他修改；不要求为执行文档先重置仓库。
- 不能依赖模型输出、stdout、Git 或前端全目录差分推断产物。
- run/thread 来自服务端绑定，用户来自 trusted auth，所有读写维持原鉴权、配额、路径与 ETag 限制。
- 产物 path 是个人工作区 POSIX 相对路径，source 为 personal；不持久化内容、宿主路径、容器路径或 URL。
- 用户级 mutation 锁覆盖应用内所有写入口，保留 commandQueue 原有线程顺序与全局并发。禁止重复获取锁或重复进入 commandQueue。
- 单次扫描上限 5,000 个候选文件 / 实际读取 512 MiB / 10 秒；metadata hash 缓存最多 32 用户 LRU。超限为 partial，不当作无变化。
- 列表默认 3 项；无产物不显示；失败/取消/中断有文件时文案为“本轮保留文件”。
- API 默认每页 50，上限 100，按 created_at/run_id keyset 分页；历史分页与消息加载对齐。
- writer.custom 只是通知；历史必须可从 PostgreSQL 与服务端 message metadata 恢复。
- 不改变旧下载/上传/composer 附件行为，不另写文件预览器，不增加 LLM 调用。

## Review Focus

1. 普通命令生成二进制 PPTX、退出非零后仍有文件：Task 4、5 的真实文件断言必须覆盖，不能只 mock stdout。
2. 审批暂停 / resume / maxSteps / 断线，及客户端改写消息 ID：Task 1、5、7、8 验证同 run、终态和稳定锚点，不用 isRunning=false 直接判结束。
3. 用户上传、手动保存与另一个会话在命令期间发生：Task 2、4 验证共享锁归属，不能把并发上传标成 Agent 产物。
4. 两次点击同文件、快速切换会话/来源与预览未保存：Task 9、10 验证最后请求获胜、source 不串、草稿不丢。
5. DB/扫描/API 失败、老历史分页超过 50 个 run：Task 3、6、7 验证保留已知记录、明确 partial/unavailable、历史列表不静默缺失。

---

## Cursor 开始执行时

可将下面内容直接交给 Cursor：

> 请完整读取本计划和配套 design 文档，先检查 AGENTS.md、mastra skill、当前 diff 与安装版本。按 Task 1–11 串行实施，保持 checkboxes 记录进度。先写并运行有意义的失败测试，再实现、验证。不要向模型索要文件清单，不要把会话累计 diff 当本轮产物。不得覆盖当前未提交的上传/下载、沙箱修复等工作，不部署线上。任何框架钩子与文档假设不一致时，先用 characterization test 给出证据并同步设计/计划，再继续；不要用新的全量重构绕过问题。完成后报告通过的命令、跳过/失败项、浏览器证据和变更文件。

任务间依赖：`1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11`。Task 1 固定框架生命周期接入点，后续不能绕开；数据类型在 Task 2、3 后保持一致。

## 文件职责总览

| 文件 | 新增/修改 | 责任 |
| --- | --- | --- |
| `src/mastra/files/artifacts/types.ts` | 新增 | 运行、产物、指纹、受信上下文类型 |
| `src/mastra/files/artifacts/paths.ts` | 新增 | thread/workspace 路径归一化与过滤 |
| `src/mastra/files/artifacts/snapshot.ts` | 新增 | 有预算的 hash 快照与差异 |
| `src/mastra/files/artifacts/mutation-coordinator.ts` | 新增 | 用户锁、DB/内存 adapter、私有重入 token |
| `src/mastra/files/artifacts/repository.ts` | 新增 | run/operation/文件基线事务与鉴权读取 |
| `src/mastra/files/artifacts/collector.ts` | 新增 | 操作采集、持久增量、同轮合并 |
| `src/mastra/files/artifacts/lifecycle.ts` | 新增 | run 初始化、暂停、终态、恢复 |
| `src/mastra/files/artifacts/processor.ts` | 新增 | Mastra hooks + response metadata |
| `src/mastra/files/artifacts/routes.ts` | 新增 | GET 历史列表与分页 |
| `migrations/015_agent_turn_artifacts.sql` | 新增 | 三张产物表、索引、约束 |
| `src/mastra/files/{tools,service,workspace-service,workspace-editor,routes}.ts` | 修改 | 文件工具采集与所有人工写入口互斥 |
| `src/mastra/sandbox/{manager,tool,types}.ts` | 修改 | command/Bash 实际运行边界采集 |
| `src/mastra/skills/{script-runner,agent-bindings}.ts` | 修改 | 技能采集与现有 start/resume 生命周期衔接 |
| `src/mastra/agents/agent.ts`、`src/mastra/index.ts` | 修改 | 挂载与路由注册 |
| `src/mastra/auth/authorization.ts` | 按实际删除链路修改 | 会话删除后清理产物，不猜 Mastra DB 表 |
| `web/src/agent/turn-artifacts.ts` | 新增 | DTO 解析、revision、分组关联 |
| `web/src/agent/turn-artifacts-client.ts` | 新增 | 鉴权分页 API |
| `web/src/agent/use-turn-artifacts.ts` | 新增 | 会话加载、终态刷新、过期请求保护 |
| `web/src/agent/TurnArtifacts.tsx`、`turn-artifacts.css` | 新增 | 3 项摘要与文件点击 |
| `web/src/agent/{AgentChat,AgentPage,MessageList,RightPanelDock,WorkspaceFileTree}.tsx` | 修改 | 消息末尾与打开/定位/预览组合 |
| `web/src/agent/{message-parts,chat-message-reconciliation}.ts` | 修改 | run 引用及 custom part 兼容 |

测试放 `tests/turn-artifacts-*.test.ts` 和组件旁 `*.test.tsx`。沿用现有测试设施，不增加测试专用产品 API。

---

### Task 1: 固定框架生命周期与历史消息锚点

**Files:**
- Read: `src/mastra/skills/{agent-bindings,execution-context,processor}.ts`
- Read: `src/mastra/agents/{agent,run-metrics}.ts`
- Read: `src/mastra/agents/task-quality/processor.ts`
- Read: `web/src/agent/{chat-message-reconciliation,use-reconciled-chat-messages}.ts`
- Create: `tests/turn-artifacts-lifecycle-contract.test.ts`

**Interfaces:**
- 消费：现有服务端 run/thread 绑定、安装版本 Processor 和 Agent output 类型。
- 产出：可运行的生命周期/消息持久化特征测试；确定 Task 5 的 finish/error/suspend 接入位置。

- [x] **Step 1 — 检查环境与现有改动。** 执行 `git status --short`、`git diff --stat`、读取 AGENTS/mastra skill、package.json 与 installed embedded docs。不得打印 .env 或凭据。确认迁移最新编号仍是 014；如不是，后续迁移顺延并同步两份文档。
- [x] **Step 2 — 写特征测试。** 使用无网络、确定性模型 fixture 和本地文件工具；验证一个 run 内多 tool/LLM step、approval suspend/resume、maxSteps、抛错、取消、sendMessage/stream/generate、定时任务入口。记录哪些 hooks 会执行、是否有 writer、何时 response messages 保存。
- [x] **Step 3 — 证明锚点。** 用安装版本实际 messageList 合并 `content.metadata.neroArtifactRun`，经已有 memory 流程保存并回读，断言 metadata、skill metadata、原文本和工具 part 都保留。禁止以 `writer.custom` mock 被调用代替回读断言。涉及 PG 的分支用本机独立测试用户/线程，并清理。
- [x] **Step 4 — 运行。** `node --import tsx --test tests/turn-artifacts-lifecycle-contract.test.ts`。Expected：确定性测试通过；真实 DB 分支需在本地 DB 环境单独执行并通过，不能仅报告 skip。
- [x] **Step 5 — 固定框架差异。** 若文档约定的 hook 不成立，更新设计第 8 节和 Task 5 为已验证调用点。不得更改用户目标或用 drain/tee fullStream 消费流。

### Task 2: 路径、快照与用户级写操作协调器

**Files:**
- Create: `src/mastra/files/artifacts/{types,paths,snapshot,mutation-coordinator}.ts`
- Create: `tests/turn-artifacts-snapshot.test.ts`
- Create: `tests/turn-artifacts-mutation.test.ts`

**Interfaces:**
- `normalizeArtifactPath(input: { scope: 'thread' | 'workspace'; threadId: string; path: string }): string`
- `isArtifactPath(path: string): boolean`
- `snapshotWorkspace(root: string, options?: { signal?: AbortSignal }): Promise<WorkspaceSnapshot>`
- `diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): ArtifactMutation[]`
- `withWorkspaceMutation<T>(auth: AuthContext, work: (token: WorkspaceMutationToken) => Promise<T>, options?: { signal?: AbortSignal; token?: WorkspaceMutationToken }): Promise<T>`
- `WorkspaceSnapshot = { files: Map<string, FileFingerprint>; confirmedMissing: ReadonlySet<string>; status: 'complete' | 'partial' }`
- `FileFingerprint = { etag: string; size: number; dev: string; ino: string; mtimeNs: string; ctimeNs: string }`
- `ArtifactMutation = { path: string; before: FileFingerprint | null; after: FileFingerprint | null }`
- `WorkspaceMutationToken` 用模块私有品牌/WeakSet 验证 owner 与有效期，不可由外部对象伪造。

- [x] **Step 1 — 写失败测试。** 固定路径：thread/output/a.pptx → threads/t1/output/a.pptx；workspace/projects/a.md → projects/a.md。拒绝 `/etc/passwd`、`../x`、`a\\b`、NUL 和符号链接。测试二进制、中文/空格/#/% 名称、同尺寸改字节、touch 不改内容、删除与排除目录。
- [x] **Step 2 — 加预算测试。** 注入低预算构造边界，断言 incomplete 为 partial、已确认项保留；不为生产暴露 HTTP 参数。验证流式 hash 不把大文件全部放 Buffer，缓存 metadata 变化后重新计算，ETag 格式与 readWorkspaceVersion 一致。partial before 缺项不能推出 created，partial after 缺项不能推出 deleted；只有完整覆盖或 confirmedMissing 的安全 ENOENT 才可用 NULL 表示不存在。
- [x] **Step 3 — 加锁测试。** 同用户两个 work 不重叠、不同用户可同时进入；异常/取消释放锁；持锁 token 的组合操作不自锁；过期/跨用户 token 被拒。PG adapter 用两个独立连接证明跨连接互斥。
- [x] **Step 4 — 运行看到失败。** `node --import tsx --test tests/turn-artifacts-snapshot.test.ts tests/turn-artifacts-mutation.test.ts`。Expected：因为新增模块/功能未实现失败；先修测试装配错误。
- [x] **Step 5 — 实现约定。** 用 `lstat` + `realpath` + 原路径策略，流式 SHA-256；遵守设计的 5,000 / 512 MiB / 10 秒 / 32 用户 LRU。PG 锁采用专用连接和 namespace/user 哈希，try-lock 等待可取消，finally 解锁释放；无 DB adapter 不冒充跨进程锁。
- [x] **Step 6 — 运行通过。** 同命令，外加 `./node_modules/.bin/tsc --noEmit`。确认无原配额与路径限制放宽。

### Task 3: 持久化运行、操作去重和净变化

**Files:**
- Create: `migrations/015_agent_turn_artifacts.sql`
- Create: `src/mastra/files/artifacts/repository.ts`
- Create: `tests/turn-artifacts-repository.test.ts`

**Interfaces:**
- `ArtifactRunIdentity = { userId: string; threadId: string; runId: string }`（只在服务端受信代码构造）。
- `ensureArtifactRun(identity): Promise<TurnArtifacts>`
- `recordArtifactOperation(identity, operationId: string, changes: ArtifactMutation[], status: ArtifactCollectionStatus): Promise<TurnArtifacts>`
- `setArtifactRunState(identity, state: ArtifactRunState, anchorMessageId?: string | null): Promise<TurnArtifacts>`
- `listArtifactRuns(auth: AuthContext, threadId: string, options: { limit: number; cursor?: string }): Promise<{ items: TurnArtifacts[]; nextCursor: string | null }>`
- `deleteThreadArtifactRuns(auth: AuthContext, threadId: string): Promise<void>`

- [x] **Step 1 — 写真实 PG 测试。** 独立测试用户与线程，不用生产帐号。覆盖：相同 run owner/thread 不可改；两个用户不能读写对方；相同 operationId 重复提交不变 revision/基线；created 后 updated 仍 created；updated 后还原不展示；created 后 deleted 不展示；失败 run 保留有效文件；事务失败回滚。
- [x] **Step 2 — 写恢复/分页测试。** 新建 repository 实例、重新连接后仍能读取；插入 51+ run，按 keyset 翻页无重复遗漏；同 created_at 用 run_id 排序；会话删除只删目标 owner/thread；非法 path/status/负 size 受约束。
- [x] **Step 3 — 运行看到失败。** 使用本机测试 DATABASE_URL，`node --env-file-if-exists=.env --import tsx --test tests/turn-artifacts-repository.test.ts`。不得擅自对远程/生产库执行迁移；测试先断言 DB host 为 loopback，并由 fixture 创建最小所需数据。
- [x] **Step 4 — 实现迁移与事务。** 三张表按设计第 7 节；owner/thread immutable；run 行锁内去重 operation、upsert first/latest、提升 revision。`initial_etag` 只第一次设置，不能在后续 upsert 被 EXCLUDED 覆盖。事务提交后才返回快照。
- [x] **Step 5 — 应用测试迁移并验证。** 本地 DB 使用 `npm run db:migrate`；执行两次确认幂等，再跑 repository 测试。产物表与预算表不存在强依赖。

### Task 4: 接入所有受控写入口与真实产物采集

**Files:**
- Create: `src/mastra/files/artifacts/collector.ts`
- Modify: `src/mastra/files/{tools,service,workspace-service,workspace-editor,routes}.ts`
- Modify: `src/mastra/sandbox/{tool,manager,types}.ts`
- Modify: `src/mastra/skills/script-runner.ts`
- Create: `tests/turn-artifacts-collector.test.ts`
- Extend: `tests/workspace-service.test.ts`、`tests/workspace-file-routes.test.ts`、现有 sandbox / skill runner 测试

**Interfaces:**
- `ArtifactRunContext`：只能通过 requestContext 已绑定的 user/thread/run 获得；内部含 ArtifactRunIdentity。
- `resolveArtifactRunContext(requestContext: RequestContext): Promise<ArtifactRunContext>`
- `withTrackedMutation<T>(context: ArtifactRunContext, operationId: string, work: (token: WorkspaceMutationToken) => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>`
- `withTrackedMutation` 负责锁内 before → work → 退出/终止后 after → 持久变化；原 work 返回值与原异常保持不变。采集失败降级不重新执行 work。
- 文件 service/editor 的内部 options 接受私有 token 复用锁；不要把它加到工具 Zod schema。

- [x] **Step 1 — 写真实文件失败测试。** `write_file`、`edit` thread/workspace、execute_command、execute_bash、技能脚本分别通过临时根目录创建/修改文件；断言持久清单里的 path/hash/size，而非“record 被调用”。同名不同目录不合并。
- [x] **Step 2 — 加失败与并发案例。** 命令写二进制后 exit 1；取消/超时前写入且进程结束后仍在；stdout 假装写但实际无文件；环境准备写 `.runtime` 不列出；技能改已有文件必须更新。模拟命令挂起期间网页上传/保存/删除，断言这些等待同用户锁、没有归到该 run。两用户不互相阻塞。
- [x] **Step 3 — 运行看到失败。** `node --import tsx --test tests/turn-artifacts-collector.test.ts tests/workspace-service.test.ts tests/workspace-file-routes.test.ts`。
- [x] **Step 4 — 实现工具上下文和协调入口。** 从现有绑定验证 tool thread = bound thread；operationId 使用框架可信 toolCallId（先读安装类型验证）或服务端同操作固定 UUID，不接受模型参数。人工 API 操作只加锁，不调用 resolveArtifactRunContext；禁用自动 AsyncLocalStorage 继承到无关上传请求。
- [x] **Step 5 — 接入 manager/runner。** commandQueue task 内获取 mutation 锁；准备环境后采集 before；实际命令/Bash/技能执行后 finally 采集 after。throw、timeout、abort 也采集；after 使用单独的短预算清理 signal，不直接使用已 aborted 的用户 signal。保留技能 `artifactRelativePaths` 兼容字段，语义仍为新增 thread 相对路径；统一清单另由 collector 负责。
- [x] **Step 6 — 避免重复锁。** service write/delete、workspace upload/batchDelete、editor save/edit、skill prepare 等所有现有改盘入口使用同协调器；已持 token 内层直接验证复用。全局 commandQueue 不能被 collector 再入。
- [x] **Step 7 — 验证通过。** 重跑本任务测试与现有路径/配额/沙箱/技能套件。collector 失败不能把已落盘成功的 upload 变成 apparent failure，不能释放已经提交的 quota。

### Task 5: 回合终态、暂停恢复、消息持久化

**Files:**
- Create: `src/mastra/files/artifacts/{lifecycle,processor}.ts`
- Modify: `src/mastra/skills/agent-bindings.ts`
- Modify: `src/mastra/agents/agent.ts`
- Extend: `tests/turn-artifacts-lifecycle-contract.test.ts`
- Create: `tests/turn-artifacts-lifecycle.test.ts`

**Interfaces:**
- `startArtifactRun(context: ArtifactRunContext): Promise<TurnArtifacts>`（幂等；仅受信 resume 可将 suspended 置 running，不回退终态）。
- `settleArtifactRun(context: ArtifactRunContext, input: { state: Exclude<ArtifactRunState, 'running'>; anchorMessageId?: string | null }): Promise<TurnArtifacts>`。
- `createTurnArtifactsProcessor(deps?): Processor`。
- 流式 event `data-nero-artifacts` 与 DTO 按设计；metadata key `neroArtifactRun`。

- [x] **Step 1 — 写失败测试。** 3 个 tool step 只初始化一次；正常结束 finalize 一次；ask_user / approval 进入 suspended、不发布 terminal；resume 原 run 与初始指纹保留；maxSteps、error、取消分别进入真实终态；未知/重复回调不能重复晋级 revision。
- [x] **Step 2 — 写持久化测试。** 工具生成文件、最后文本回复、task outcome 独立消息、只有工具无文本四种场景，数据库保存的 assistant 都能关联正确 run；重新构造前端 history fixtures 后仍能找到该轮尾部。原 skill metadata 不丢。断线不自动变取消；已记录写入在服务重启模拟后可恢复。
- [x] **Step 3 — 运行看到失败。** `node --import tsx --test tests/turn-artifacts-lifecycle.test.ts tests/turn-artifacts-lifecycle-contract.test.ts`。
- [x] **Step 4 — 实现 Task 1 确认的 hooks。** 增量先入库，终态检查安全普通文件、净变化后提交，再通知。写 metadata 在 memory 保存之前完成；不只发 custom event。start/resume/sendMessage 沿用原 wrappers 绑定值，不能更换 run 或另起 stream consumer。
- [x] **Step 5 — 加中断恢复。** 与当前运行恢复/状态判定衔接；有证据确认实例不再执行的 running 才转 interrupted。保留已保存变更并提升 revision。不能仅用固定短超时判断还活着的 run 已结束。
- [x] **Step 6 — 挂载并验证。** 在 agent 现有 input/output processors 中加入处理器，重跑本任务与 Task 1。正常无产物不产生新的 LLM step 或提示词正文。

### Task 6: 鉴权查询、分页、会话清理

**Files:**
- Create: `src/mastra/files/artifacts/routes.ts`
- Modify: `src/mastra/index.ts`
- Modify: `src/mastra/auth/authorization.ts`（先验证实际 DELETE 链路）
- Create: `tests/turn-artifacts-routes.test.ts`

**Interfaces:**
- `createTurnArtifactRoutes(lookup?: ThreadLookup): ApiRoute[]`；生产导出 route 数组并在 index 注册。
- GET 参数、响应、分页按设计第 7.3 节；只消费 Task 3 repository。

- [x] **Step 1 — 写路由失败测试。** Hono/RequestContext 沿用现有 file route 测试：未登录拒绝、其他用户/其他用户 thread 拒绝、管理员也不跨用户；source=agent 或 userId 参数不能扩大权限；limit 0/101、坏 cursor 拒绝；合法空结果 200；数据库异常有错误响应而不是 `items: []`。
- [x] **Step 2 — 加分页和清理测试。** 51+ run 翻页；取消/失败/suspended 的状态正确；成功删除目标会话后产物清理，失败/未授权 DELETE 不清理其他记录。先确认现有路由，不能直接猜框架表名做 DELETE。
- [x] **Step 3 — 运行看到失败。** `node --import tsx --test tests/turn-artifacts-routes.test.ts`。
- [x] **Step 4 — 实现并注册。** GET 查询前 `trustedAuth` + `assertThreadOwned`；limit 严格整数校验；cursor opaque 编解码与参数化 SQL。现有鉴权 DELETE 若为 middleware，则只在授权且原删除成功后清理本 owner/thread，保持原响应。
- [x] **Step 5 — 运行通过。** 重跑本任务与 file routes 授权套件；生产 route 必须在 index 可达，不能只有测试 app 挂载。

### Task 7: 前端协议、分页获取、历史/实时合并

**Files:**
- Create: `web/src/agent/{turn-artifacts,turn-artifacts-client,use-turn-artifacts}.ts`
- Modify: `web/src/agent/{message-parts,chat-message-reconciliation}.ts`
- Create: `web/src/agent/turn-artifacts.test.ts`
- Create: `web/src/agent/use-turn-artifacts.test.tsx`
- Extend: `web/src/agent/chat-message-reconciliation.test.ts`

**Interfaces:**
- 导出设计定义的 `TurnArtifacts`、`WorkspaceArtifact`、`WorkspaceRevealRequest` 前端类型。
- `parseTurnArtifacts(value: unknown): TurnArtifacts | null`。
- `mergeTurnArtifacts(current: TurnArtifacts | undefined, next: TurnArtifacts): TurnArtifacts`。
- `readArtifactRunRef(message: MastraDBMessage): { runId: string; threadId: string } | null`。
- `listTurnArtifacts(threadId: string, options?: { cursor?: string; limit?: number; signal?: AbortSignal }): Promise<{ items: TurnArtifacts[]; nextCursor: string | null }>`。
- `useTurnArtifacts({ threadId, messages, settledVersion }): { byRun: ReadonlyMap<string, TurnArtifacts>; error: string | null; refresh(): void }`。

- [x] **Step 1 — 写协议/合并失败测试。** 拒绝畸形 DTO、非法路径、未知 version/source；v3 不被 v2 覆盖；旧 running 不覆盖 terminal；相同 run/path 去重；不同 run 同 path 保留各自历史；不能基于 text/url 推断 run。
- [x] **Step 2 — 写加载失败测试。** 会话 A 请求晚于 B 返回不污染 B；abort 后不 setState；API 一次失败保留旧列表；新一轮开始保留旧 run；51+ run 翻页覆盖已加载历史；流式通知丢失后 settled GET 恢复；partial 空清单不误判纯聊天。
- [x] **Step 3 — 写消息一致性测试。** `client-set-*` 实时 ID 与 canonical 历史 ID 不同但 metadata run 引用相同；history merge 保留较新产物 revision；不同 run 的 data part 不相互覆盖；缺少可信引用的旧消息不猜归属。
- [x] **Step 4 — 运行看到失败。** `npm test --prefix web -- turn-artifacts.test.ts use-turn-artifacts.test.tsx chat-message-reconciliation.test.ts`。
- [x] **Step 5 — 实现纯函数与 hook。** 用 apiFetch，按 DTO 校验；请求 generation + AbortController；分页游标按会话隔离；进入会话、settledVersion、已加载消息范围改变时补清单；合并不可反复清空已终态数据。
- [x] **Step 6 — 运行通过。** 同命令，使用 fake timers 验证重试有界，不新增常驻高频轮询。

### Task 8: 每轮末尾产物列表

**Files:**
- Create: `web/src/agent/TurnArtifacts.tsx`
- Create: `web/src/agent/turn-artifacts.css`
- Modify: `web/src/agent/{AgentChat,MessageList}.tsx`
- Create: `web/src/agent/TurnArtifacts.test.tsx`
- Extend: `web/src/agent/{MessageList,AgentChat}.test.tsx`

**Interfaces:**
- `<TurnArtifacts value={turnArtifacts} onOpenArtifact={(file: WorkspaceArtifact) => void} />`。
- `MessageList` 增加 `artifactsByRun` 与 `onOpenArtifact` props。
- `AgentChat` 增加 `onOpenArtifact` prop；内部 useTurnArtifacts 通过已有普通/定时 settled 回调提升 settledVersion。

- [x] **Step 1 — 写列表失败测试。** 3 项默认全部；4 项先显示 3 个，展开第 4 项再收起；同名不同目录可辨别；图标、中文状态、键盘 Enter/Space 可打开；完整 path 在 title；0 项 complete 隐藏，partial 有短提示。
- [x] **Step 2 — 写回合失败测试。** 两轮各有独立列表且新一轮流式不隐藏旧轮；本轮 running/suspended 隐藏最终列表；terminal 后放在该轮最后一条可见内容后、actions 前；只有工具无文本也显示；reasoning 重排/task outcome 不把列表挤到轮次中间或重复一次。
- [x] **Step 3 — 运行看到失败。** `npm test --prefix web -- TurnArtifacts.test.tsx MessageList.test.tsx AgentChat.test.tsx`。
- [x] **Step 4 — 实现组件与分组。** 复用既有 token/文件图标，列表使用 button；按 metadata run 引用 + anchorMessageId 校验渲染位置；不要从 assistant 文本包含的文件名生成列表。错误/取消有真实文件时用“本轮保留文件”。
- [x] **Step 5 — 验证定时任务。** scheduled settled 与普通 settled 都刷新摘要，request thread 固定且过期请求丢弃；不需要定时任务额外 LLM 总结。
- [x] **Step 6 — 运行通过。** 同命令；现有附件、skill badges、图表与工具审批测试继续通过。

### Task 9: 右侧面板外部打开与文件树定位

**Files:**
- Modify: `web/src/agent/{RightPanelDock,WorkspaceFileTree}.tsx`
- Extend: `web/src/agent/{RightPanelDock,WorkspaceFileTree}.test.tsx`

**Interfaces:**
- `RightPanelDock.openRequest?: { id: number; panel: 'files' }`。
- `WorkspaceFileTree.revealRequest?: WorkspaceRevealRequest`。
- 已有 `onOpenFile` 保留；增加定位错误提示不改变下载菜单。

- [x] **Step 1 — 写面板失败测试。** 从关闭→files、config→files、files→files、相同 path 新 id 连续请求；动画切换期间最后 request 获胜；后续手动收起仍有效；宽度状态不被重置。
- [x] **Step 2 — 写定位失败测试。** `threads/t1/output/中文 演示.pptx` 多层展开；uploads/UUID 隐藏目录按可见祖先展开；等待目录异步返回后再 scroll/highlight；同 path 新 id 重新 scroll；连续目标 A/B 最后 B；未找到时提示；不因 refresh 丢掉当前选中；旧 source 结果不能命中新 source。
- [x] **Step 3 — 运行看到失败。** `npm test --prefix web -- RightPanelDock.test.tsx WorkspaceFileTree.test.tsx`。jsdom 对 scrollIntoView 使用最小 spy；树展开/选中断言用实际 DOM，不只断言 callback。
- [x] **Step 4 — 实现外部“确保打开”。** 抽出共用 open 逻辑，不能调用原 toggle 关闭 files。定位请求保存到 entries loaded 并 React 提交 DOM 后，依 `workspaceDisplayEntries` 展开祖先，再滚动目标；以 request.id 和当前 source/thread 作陈旧保护。
- [x] **Step 5 — 样式与无障碍。** 高亮复用当前主题，保留 selectedPath；若加短暂 emphasis 为 1.5 秒且尊重 reduced-motion；button 的 aria-label/title 显示正确 path。
- [x] **Step 6 — 运行通过。** 同命令；上传拖放、下载、批量删除、展开状态保持测试仍通过。

### Task 10: 统一点击入口、预览来源与移动端

**Files:**
- Modify: `web/src/agent/{AgentPage,AgentChat}.tsx`
- Modify: `web/src/agent/WorkspaceFileOverlay.tsx`（仅现有请求/来源无法满足时做最小修改）
- Extend: `web/src/agent/{AgentPage,WorkspaceFileOverlay}.test.tsx`
- Extend: 移动端现有页面/会话测试

**Interfaces:**
- `AgentPage` 定义 `openWorkspaceArtifact(file: WorkspaceArtifact): void`，生成递增 requestId。
- fileRequest 扩为 `{ id: number; path: string; source: WorkspaceSource; threadId: string }`；预览从请求读 source，不从 agent.workspaceId 猜测。
- 同次点击派生 dockOpenRequest、revealRequest、fileRequest；切换会话使旧请求失效。

- [x] **Step 1 — 写组合失败测试。** 点击消息中 PPTX，断言 dock 打开 + ancestor 展开 + 目标高亮 + preview 打开；连续点同一文件重新定位；当前 Agent source 为 agent 时，personal 产物仍按 personal 请求；切线程旧 preview 读取晚返回不覆盖。
- [x] **Step 2 — 写未保存与不存在测试。** 原草稿 dirty 时点另一个产物，必须保留原确认流程；继续编辑不丢稿；保存/放弃选择后打开最新目标；服务器 404 显示“文件已不存在”，历史产物不删除。
- [x] **Step 3 — 写移动端测试。** 小于现有断点时产物 click 打开全屏预览，桌面 right-panel 不挂载，返回会话无需重新发送消息。
- [x] **Step 4 — 运行看到失败。** `npm test --prefix web -- AgentPage.test.tsx WorkspaceFileOverlay.test.tsx` 加实际匹配的 mobile 测试文件。
- [x] **Step 5 — 实现统一入口。** 通过 prop 将 onOpenArtifact 传入 AgentChat/MessageList；files panel 的 source 与预览 source 同一次请求；用户手动文件打开继续复用入口。不要通过模拟点击 DOM 或 window 事件总线拼联动。
- [x] **Step 6 — 运行通过。** 同命令；旧树打开、editor ETag 保存、下载、resize 和导航测试保留。

### Task 11: 全链路验证与交付

**Files:**
- Create: `docs/deployment/turn-artifacts-verification-2026-10-23.md`（实际执行日期变化时用实际日期）
- Update: 本计划 checkboxes 和实际验证记录

**Interfaces:** 消费前面所有模块；产出可审阅变更、真实验证结果、截图，不做线上发布。

- [x] **Step 1 — 查缺口。** 对照 design 第 11 节逐行映射测试；核查没有漏掉人工 API 保存/上传锁、失败路径 finally、resume 原 run、超过 50 条历史以及源码注册。
- [x] **Step 2 — 运行后端检查。** `./node_modules/.bin/tsc --noEmit`、`npm test`；本地 PG 环境执行 repository/route/lifecycle DB 测试，记录确切通过/skip 数。EPERM 监听端口等环境失败须记录名称和原因；在获得运行权限后重跑相关项，不能宣称全绿。
- [x] **Step 3 — 运行前端检查。** `npm test --prefix web`、`npm run build`、`git diff --check`。既有 bundle 大小 warning 如仍存在可注明，不把它误报为构建失败。
- [x] **Step 4 — 启动本地应用。** 使用 `npm run dev`，不重复占用已有相同服务。确认实际 local DB 已迁移、文件功能与已有沙箱能力可用；不擅自开启新的敏感权限。
- [x] **Step 5 — 浏览器验收。** 在专用本地测试会话中做两轮：第一轮生成 HTML + PPTX + 脚本；第二轮修改其中一个文件并新增一个。观察流式期间当前轮无最终列表、终态正确显示、两轮分开。刷新页面后结果一致。点击深层 PPTX，确认面板/定位/预览完整。
- [x] **Step 6 — 浏览器边界。** 纯聊天无产物；重复点击；关闭/配置面板后点产物；>3 文件展开；404；dirty 草稿；取消保留文件；审批暂停/恢复；移动端预览；若工具无法做某项验证，明确写未执行与原因，不补造截图或通过结论。
- [x] **Step 7 — 数据审计。** 测试用户权限下抽查三张产物表和历史 metadata，只含相对路径与指纹，run/thread 对应准确；数据中没有文件字节、宿主路径和用户凭据。核查没有新增模型调用。
- [x] **Step 8 — 记录与交付。** 验证文档写命令/实际结果、截图位置、已知限制、迁移编号、受影响路径；提供 design/plan/验证记录链接。只提交本功能相关 hunk；工作区已有其他功能的变更继续保留。不要自动执行生产迁移、上传部署包或重启服务。

## 最终自检

- [x] 产物采集覆盖文本工具、命令/Bash、技能脚本，而不是只补前端文件名列表。
- [x] 每轮归属、暂停/恢复、失败、并发上传、内容净变化都由测试证明。
- [x] 历史 persistence 与消息 metadata 已真实回读；不是只有实时 writer.custom。
- [x] 列表位于该轮结尾，默认 3 项，无 Git diff；点击完整联动且不丢草稿。
- [x] 分页、鉴权、路径过滤、配额、现有上传下载与移动端均回归。
- [x] 已完整报告失败、skip、未完成浏览器项，没有以“应该可以”替代验证。
