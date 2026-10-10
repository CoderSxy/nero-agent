# Agent Workspace Attachments and Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Cursor 若未安装这些 skill，按任务顺序执行每个测试、实现和验证步骤即可；不要跳过失败测试验证。

**Goal:** 打通工作区文件上传/选择/图片识别/消息引用，并提供准确容量显示与安全的单项、批量删除。

**Architecture:** 文件原件只保存在个人工作区，消息存服务端签发的引用记录；Agent 只能用当前线程的附件 ID 读取。个人配额由服务端统一执行，文件树返回目录递归大小，Composer 与右侧文件区共用文件元数据和选择规则。图片通过 Mastra 当前版本的多模态工具输出传给视觉模型，持久化记录只含元数据。

**Tech Stack:** TypeScript、React 19、Vite/Vitest、Mastra 1.71、Hono、PostgreSQL、Node `fs/promises`、现有 `@mastra/react` 和文件预览组件。

**Spec:** `docs/superpowers/specs/2026-10-09-agent-workspace-attachments-and-cleanup-design.md`

## Global Constraints

- 本轮不实现 `glob`、`grep`、`edit`，不加入参考项目的“上下文”模块、Ant Design、文件夹上传或文件夹消息附件。
- 新上传/新写入单文件上限 `10 * 1024 * 1024` 字节，个人工作区总上限 `500 * 1024 * 1024` 字节；既有大文件允许浏览/选择，但不得作为超过模型上限的图片输入。
- 个人工作区只存一份文件；选择已有文件、从 Composer 移除均不得复制或删除原件。
- `source=agent` 仅管理员可浏览/选择，本轮不可从右侧文件区删除或上传；个人容量只统计 `source=personal`。
- 所有 Mastra agent、tool、API route 在 `src/mastra/index.ts` 登记；先读 `.claude/skills/mastra/SKILL.md` 和已安装包文档。开发/构建使用根目录 `npm run dev`、`npm run build`。
- 图片需要模型识图；模型目录的 `supportsVision` 显式设置，既有模型默认 `false`，不得按模型名猜测。
- 消息、数据库和观测记录不能持久化原文件或大块 base64 图片；测试须检验这一点。

## Review Focus

- 两次并发上传分别小于剩余额度、合计超过 500 MiB：只能成功一个；数据库与磁盘计数一致（Task 1）。
- 文件名含中文、空格、`#`、`%` 或同名重传：路径安全且不会覆盖旧文件（Task 2）。
- 用户 B、另一线程或伪造的附件 ID：不能读取或删除用户 A 文件（Task 3、Task 4、Task 7）。
- 上传完成后删除原件，或发送期间原件变化：发送前校验并显示失效，不把旧内容当成新文件（Task 3、Task 6）。
- 批量勾选父文件夹和子文件且其中一项删除失败：预计释放量不重复，实际释放量和逐项结果正确（Task 7、Task 8）。

---

## File Map

- `src/mastra/workspace/{config,quota}.ts`、`src/mastra/files/{policy,service}.ts`：10 MiB/500 MiB 规则、覆盖写净增量、原子预留与对账。
- `src/mastra/files/workspace-service.ts`：个人工作区上传、递归目录大小、受保护路径与批量删除；不把业务规则塞进路由。
- `src/mastra/files/attachments.ts`、`migrations/005_agent_attachment_refs.sql`：引用签发、查询、授权、状态和未发送引用清理。
- `src/mastra/files/routes.ts`、`src/mastra/index.ts`：上传、列表/容量、引用、批量删除 API 注册。
- `src/mastra/files/tools.ts`、`src/mastra/agents/agent.ts`：`read_attached_file` 与 Agent 使用说明。
- `migrations/006_model_vision.sql`、`src/mastra/models/{types,repository,service,routes,admin-page}.ts`：视觉能力字段、校验和管理入口。
- `web/src/agent/{attachment-types,attachment-client}.ts`：统一客户端引用类型与 API。
- `web/src/agent/{AgentComposer,AgentChat,WorkspaceFilePicker,WorkspaceFileTree,AgentPage,MessageList}.tsx`：文件选择、卡片、拖入/粘贴、发送/历史和删除模式。
- `web/src/agent/client.ts`、`web/src/agent/model-catalog-client.ts`、`web/src/agent/pending-user-message.ts`、`web/src/styles.css`：已有客户端、模型能力、乐观消息及样式。
- `tests/*`、`web/src/agent/*.test.ts(x)`：每个边界的服务端和前端回归测试。

### Task 1: 统一 10 MiB 单文件限制和 500 MiB 计数

**Files:** Modify `src/mastra/files/policy.ts`, `src/mastra/files/service.ts`, `src/mastra/files/workspace-editor.ts`, `src/mastra/workspace/quota.ts`, `src/mastra/workspace/config.ts`; test `tests/workspace-quota.test.ts`, `tests/file-tools.test.ts`, `tests/workspace-editor.test.ts`.

**Interfaces:** `maxFileSizeBytes(): number` 默认返回 `10 * 1024 * 1024`；`WorkspaceQuota.reserve(userId, deltaBytes, deltaFiles)` 在 PostgreSQL 事务内原子判断/更新；`WorkspaceQuota.reconcileFromDisk(userId): Promise<QuotaState>` 扫描整个个人工作区并更新计数。`QuotaExceededError` 带稳定 code `WORKSPACE_QUOTA_EXCEEDED`，文件超限错误带 `FILE_TOO_LARGE`。

- [ ] **Step 1: Write failing tests.** 断言默认上限 10 MiB、恰好 10 MiB 成功/多 1 字节拒绝；覆盖写仅预留 `max(0,new-old)`，缩小文件释放差额；两个并发 `reserve` 合计超额时只有一个成功；直接写入工作区后的 `reconcileFromDisk` 得到准确字节/文件数。测试使用小配额覆盖环境变量，不实际写 500 MiB。
- [ ] **Step 2: Verify red.** Run `node --import tsx --test tests/workspace-quota.test.ts tests/file-tools.test.ts tests/workspace-editor.test.ts`; expected 新断言失败。
- [ ] **Step 3: Implement.** 去掉只对单进程有效的额度判断作为最终依据，数据库按用户行锁或条件更新做原子预留；保留无数据库测试模式。`FileService.write` 修正已有 0 字节文件与覆盖计数；在线编辑继续使用其 10 MiB 限制。磁盘扫描跳过符号链接，不跨出用户根目录。保留 `assertHostWritable`。
- [ ] **Step 4: Verify green.** 运行 Step 2 命令；expected 0 failures。随后在可用本地 PostgreSQL 下运行 `npm run test:db`，确认原子预留测试真实覆盖数据库事务。
- [ ] **Step 5: Commit.** `git add src/mastra/files src/mastra/workspace tests && git commit -m "fix: enforce workspace file and quota limits"`。

### Task 2: 安全上传、准确列表和用量 API

**Files:** Create `src/mastra/files/workspace-service.ts`, `tests/workspace-service.test.ts`; modify `src/mastra/files/routes.ts`, `tests/file-routes.test.ts`, `tests/workspace-file-routes.test.ts`, `web/src/agent/client.ts`.

**Interfaces:** `WorkspaceFileService.upload(auth, file, signal): Promise<WorkspaceFileEntry>` 生成 `uploads/<UUID>/<安全文件名>` 并返回 `{source:'personal',path,name,size,mimeType,etag}`；`WorkspaceFileService.list(auth): Promise<{files: UserFileEntry[]; usage: {usedBytes,quotaBytes,fileCount}}>` 返回目录递归大小。沿用 `POST /user-files/upload` 兼容旧线程路径，新增 `POST /current-workspace/upload` 用于新 Composer；两个入口均在解析完整请求前限制请求体，并复用 10 MiB 规则。`GET /current-workspace/files` 保持原 `files` 字段并新增 `usage`，目录 `size` 为所有后代普通文件字节数。

- [ ] **Step 1: Write failing tests.** 断言同名两次上传路径不同、Unicode/特殊字符文件名安全、超过 10 MiB 拒绝且无残留临时文件、超 500 MiB 返回 `WORKSPACE_QUOTA_EXCEEDED`、目录递归大小及 `usage` 正确、管理员旧 Agent 来源无个人容量、匿名/跨用户/符号链接拒绝。
- [ ] **Step 2: Verify red.** Run `node --import tsx --test tests/workspace-service.test.ts tests/file-routes.test.ts tests/workspace-file-routes.test.ts`; expected 新测试失败。
- [ ] **Step 3: Implement.** `WorkspaceFileService` 使用现有工作区真实路径、配额和磁盘保护；上传以临时文件原子落盘。Hono 路由先按 `Content-Length` 和实际流字节数限制，再解析 multipart，避免用巨大 `arrayBuffer()` 才发现超限；按错误 code 映射 413/明确 JSON。列表一次遍历计算目录大小与用量，并与配额记录对账。
- [ ] **Step 4: Verify green.** 运行 Step 2 命令；expected 0 failures。`npm run build` 确认 Mastra 路由注册与类型通过。
- [ ] **Step 5: Commit.** `git add src/mastra/files src/mastra/index.ts web/src/agent/client.ts tests && git commit -m "feat: upload and measure personal workspace files"`。

### Task 3: 按线程签发和持久化附件引用

**Files:** Create `migrations/005_agent_attachment_refs.sql`, `src/mastra/files/attachments.ts`, `tests/attachment-routes.test.ts`; modify `src/mastra/files/routes.ts`, `src/mastra/index.ts`.

**Interfaces:** `AttachmentService.prepare(auth,threadId,clientMessageId,items): Promise<AttachmentRef[]>`、`listForThread(auth,threadId): Promise<AttachmentRef[]>`、`readOwned(auth,threadId,attachmentId): Promise<{ref,data}>`。`AttachmentRef` 包含 `attachmentId,clientMessageId,source,path,name,size,mimeType,etag,status`；`status` 为 `available | changed | deleted`。API 为 `POST /current-workspace/attachments` 与 `GET /current-workspace/attachments?threadId=...`。同一 `(ownerId,threadId,clientMessageId,source,path)` 幂等，单条消息最多 10 个附件；超过 24 小时且经 Mastra 消息查询确认未持久化的待发送记录才可清理。

- [ ] **Step 1: Write failing tests.** 断言同一文件选择两次去重、选择不改变已用字节、历史查询保留元数据、删除/修改后状态、伪造用户/线程/ID 与 `source=agent` 非管理员均拒绝；空目录、`..`、符号链接和超过 10 个附件拒绝。
- [ ] **Step 2: Verify red.** Run `node --import tsx --test tests/attachment-routes.test.ts`; expected 新路由/服务缺失失败。
- [ ] **Step 3: Implement.** 迁移建引用表与 `(owner_id,thread_id,client_message_id)` 索引；复用 `assertThreadOwned`、工作区 `currentWorkspace` 来源规则及真实路径校验。`readOwned` 每次重新检查文件，ETag 变化返回 `changed`，缺失返回 `deleted`；清理只处理超过 24 小时且可证明 Mastra 未保存对应消息的记录，不删除原文件。
- [ ] **Step 4: Verify green.** 运行 Step 2 命令；在本地 PostgreSQL 执行 `npm run db:migrate` 和 `npm run test:db`，expected migration 应用、测试通过。
- [ ] **Step 5: Commit.** `git add migrations/005_agent_attachment_refs.sql src/mastra/files/attachments.ts src/mastra/files/routes.ts src/mastra/index.ts tests/attachment-routes.test.ts && git commit -m "feat: persist scoped workspace attachment references"`。

### Task 4: 模型视觉能力和 Agent 附件读取

**Files:** Create `migrations/006_model_vision.sql`, `tests/attached-file-tool.test.ts`; modify `src/mastra/models/{types,repository,service,routes,admin-page}.ts`, `src/mastra/files/tools.ts`, `src/mastra/agents/agent.ts`, `src/mastra/index.ts`, `web/src/agent/model-catalog-client.ts`, `web/src/agent/PrivateModelMenu.tsx`, `tests/model-catalog-db.test.ts`, `web/src/agent/PrivateModelMenu.test.tsx`.

**Interfaces:** `SafeModel.supportsVision: boolean`，公共/私人模型创建与修改接受该布尔字段，旧记录迁移后为 `false`。`read_attached_file({attachmentId})` 仅用可信用户和 `context.agent.threadId` 调用 Task 3 的 `readOwned`；文本只返回 UTF-8 且截断至 64 KiB，包含 `truncated` 标记；支持的图片在视觉模型下通过 `createTool({toModelOutput,transform})` 输出多模态 `image-data`，展示和 transcript 仅保留 ID、名称、状态。不能把其他二进制当文本；无视觉能力返回明确错误。

- [ ] **Step 1: Write failing tests.** 测公共/私人模型 `supportsVision` 读写及默认 false、普通用户不能修改公共模型、工具跨线程拒绝、文本截断、图片输出为模型可识别的内容 part、文本模型拒绝、工具显示/持久化结果不含 `data:` 或原图 base64。
- [ ] **Step 2: Verify red.** Run `node --import tsx --test tests/attached-file-tool.test.ts tests/model-catalog-db.test.ts` and `npm test --prefix web -- PrivateModelMenu.test.tsx`; expected 新断言失败。
- [ ] **Step 3: Implement.** 按已安装 `@mastra/core` 的 `createTool` 文档使用 `toModelOutput` 与 `transform.display/transcript`；在 `agent.ts` 指示 Agent 按附件 ID 调工具。模型支持能力由服务端可信目录记录核验，前端只是提前提示。公共模型管理页、私人模型表单均增加“支持图片”开关。用一次真实 Agent 运行检查视觉问答与 PostgreSQL 消息/观测表，若 transcript transform 仍保留图片字节，则改用当前 Mastra 输入/输出处理器在入库前替换为工作区引用，直到该验收通过。
- [ ] **Step 4: Verify green.** 运行 Step 2 命令、`npm run db:migrate`、`npm run build`；expected 0 failures，且数据库抽查无图片 base64 副本。
- [ ] **Step 5: Commit.** `git add migrations/006_model_vision.sql src/mastra/models src/mastra/files/tools.ts src/mastra/agents/agent.ts src/mastra/index.ts web/src/agent/model-catalog-client.ts web/src/agent/PrivateModelMenu.tsx tests web/src/agent/PrivateModelMenu.test.tsx && git commit -m "feat: read scoped attachments with vision capable models"`。

### Task 5: Composer 附件状态、文件选择与上传入口

**Files:** Create `web/src/agent/attachment-types.ts`, `web/src/agent/attachment-client.ts`, `web/src/agent/WorkspaceFilePicker.tsx`, `web/src/agent/WorkspaceFilePicker.test.tsx`; modify `web/src/agent/AgentComposer.tsx`, `web/src/agent/AgentComposer.test.tsx`, `web/src/agent/AgentChat.tsx`, `web/src/agent/AgentChat.test.tsx`, `web/src/styles.css`.

**Interfaces:** `ComposerAttachment` 为 `{key,source,path,name,size,mimeType,etag,state:'uploading'|'ready'|'failed',error?}`；`WorkspaceFilePicker({source,onConfirm,onClose})` 返回去重的普通文件路径数组。`uploadWorkspaceFile(file,onProgress?)` 使用 Task 2 API；`prepareAttachments(threadId,clientMessageId,items)` 使用 Task 3 API。Composer props 增加 `onChooseWorkspaceFiles`、`onUploadFiles`、`onRemoveAttachment`，文件/图片卡片与加号菜单由 Composer 渲染，上传/选择状态由 AgentChat 管理。

- [ ] **Step 1: Write failing tests.** 菜单恰有三个选项且无“上下文”；上传多文件/图片缩略图/预览/移除、重复选择去重、取消选择器不提交、搜索与目录展开、上传中/失败不能发送、失败重试、移除不调用删除 API；覆盖中文、空格、同名不同路径。
- [ ] **Step 2: Verify red.** Run `npm test --prefix web -- AgentComposer.test.tsx AgentChat.test.tsx WorkspaceFilePicker.test.tsx`; expected 新测试失败。
- [ ] **Step 3: Implement.** 复用 `listWorkspaceFiles` 和现有右侧树的排序/来源规则；将本地选择和图片选择导向 Task 2 上传接口。浏览器 10 MiB 预检只作反馈，服务端仍是权威；图片预览用已认证 Blob/objectURL 并在关闭或卸载时释放。上传完成自动加入本次消息；移除卡片只变更状态。
- [ ] **Step 4: Verify green.** 运行 Step 2 命令；expected 0 failures。
- [ ] **Step 5: Commit.** 提交本任务 Web 文件与测试，消息 `feat: compose workspace file and image attachments`。

### Task 6: 拖入/粘贴、真正发送附件与历史卡片

**Files:** Modify `web/src/agent/AgentComposer.tsx`, `web/src/agent/AgentChat.tsx`, `web/src/agent/MessageList.tsx`, `web/src/agent/AgentPage.tsx`, `web/src/agent/pending-user-message.ts`, `web/src/agent/message-parts.ts`, `web/src/agent/client.ts`, `web/src/styles.css`; test `web/src/agent/AgentChat.test.tsx`, `web/src/agent/AgentPage.test.tsx`, `web/src/agent/MessageList.test.tsx`.

**Interfaces:** 每次发送生成一个 `clientMessageId`，调用 Task 3 `prepareAttachments` 后再 `chat.sendMessage({message,clientMessageId,...})`。送给 Agent 的文字含服务端返回的附件 ID/名称/类型说明；用户气泡只显示用户输入与附件卡片，不显示内部协议标记。`GET /current-workspace/attachments?threadId=...` 的结果按 `clientMessageId` 关联历史和乐观消息。空文字但有 ready 附件时发送默认文字“请查看附件”。

- [ ] **Step 1: Write failing tests.** 验证拖入普通文件和图片、粘贴图片、拖入工作区内部项只引用不上传、`preventDefault` 只拦截有文件的拖放；发送前准备引用并携带同一消息 ID、无文字可发、视觉不支持时阻断、发送失败保留草稿、刷新后历史卡片、已更新/已删除状态及 objectURL 释放。断言附件 ID 确实在发给 Agent 的消息中，不只是 UI 显示。
- [ ] **Step 2: Verify red.** Run `npm test --prefix web -- AgentChat.test.tsx AgentPage.test.tsx MessageList.test.tsx`; expected 新测试失败。
- [ ] **Step 3: Implement.** 以 `nextPendingUserMessage` 的 ID 作为 `clientMessageId`；区分用于 Agent 的消息文本与用户可见文本，避免内部附件协议污染标题和气泡。发送前重新检查 Task 3 返回状态；只有所有附件 ready/available 且所选模型 `supportsVision` 满足图片时才发送。右侧“加入当前对话”由 `AgentPage` 传带递增 ID 的请求给当前 `AgentChat`，避免重复消费。历史引用随消息加载，缺失文件显示不可点击状态。
- [ ] **Step 4: Verify green.** 运行 Step 2 命令；expected 0 failures。运行一个真实会话：上传文本、发送、Agent 调 `read_attached_file` 回答内容；视觉模型发送图片并回答图中内容。
- [ ] **Step 5: Commit.** 提交本任务 Web 文件与测试，消息 `feat: send and render durable file references`。

### Task 7: 服务端安全批量删除与配额回收

**Files:** Modify `src/mastra/files/workspace-service.ts`, `src/mastra/files/routes.ts`, `src/mastra/index.ts`; create `tests/workspace-batch-delete.test.ts`; modify `tests/workspace-quota.test.ts`.

**Interfaces:** `WorkspaceFileService.batchDelete(auth,paths): Promise<{results:Array<{path,ok,errorCode?}>;deletedFiles:number;freedBytes:number;usage:QuotaState}>`；`POST /current-workspace/files/batch-delete` 输入 `{paths:string[]}`，仅个人来源。拒绝空数组和超过 100 个顶层路径；先标准化并折叠父子路径，再逐项校验；保护四个工作区顶层根目录与线程 `input/output/tmp` 根目录。单项删除传一个路径。

- [ ] **Step 1: Write failing tests.** 文件删除释放配额、目录递归释放、父子同时传入不重复计算、受保护目录/匿名/越权/符号链接/`..` 被拒、其中一项失败时其他项结果明确、磁盘与数据库真实用量一致；`source=agent` 删除始终拒绝。
- [ ] **Step 2: Verify red.** Run `node --import tsx --test tests/workspace-batch-delete.test.ts tests/workspace-quota.test.ts`; expected 新测试失败。
- [ ] **Step 3: Implement.** 复用 Task 1 原子计数/对账与 Task 2 个人工作区路径检查。逐项删除成功后按实际普通文件字节数释放；失败不释放，并返回部分结果。删除结束重扫并返回准确 `usage`，给历史引用 Task 3 的状态查询留下 `deleted` 结果。
- [ ] **Step 4: Verify green.** 运行 Step 2 命令；expected 0 failures。
- [ ] **Step 5: Commit.** 提交后端文件与测试，消息 `feat: safely delete workspace files in batches`。

### Task 8: 右侧工作区容量、大小和删除模式

**Files:** Modify `web/src/agent/client.ts`, `web/src/agent/WorkspaceFileTree.tsx`, `web/src/agent/AgentPage.tsx`, `web/src/agent/WorkspaceFileTree.test.tsx`, `web/src/agent/AgentPage.test.tsx`, `web/src/styles.css`.

**Interfaces:** `deleteWorkspaceFiles(paths): Promise<BatchDeleteResult>` 调 Task 7 API。`WorkspaceFileTree` 继续接受现有 `source/workspaceId/refreshVersion/onOpenFile`，新增 `onAttachFile(path,source)`；内部管理 `selectionMode` 与 `selectedPaths`，删除后调用 `onFilesChanged()` 刷新容量/目录。个人来源显示 `usedBytes/quotaBytes`，旧 Agent 来源只读且不显示个人容量/删除按钮。

- [ ] **Step 1: Write failing tests.** 容量 `X / 500 MiB`、常态单项删除、批量模式勾选文件/文件夹和递归大小、父子选中汇总去重、确认取消、不删受保护目录、部分失败反馈/刷新；预览点击在普通模式仍有效，`source=agent` 不出现删除入口。
- [ ] **Step 2: Verify red.** Run `npm test --prefix web -- WorkspaceFileTree.test.tsx AgentPage.test.tsx`; expected 新测试失败。
- [ ] **Step 3: Implement.** 使用服务端 `size` 与 `usage`，本地选择汇总折叠父子路径；删除确认写明数量和预计释放量，响应以服务端实际释放量为准。保留现有展开、刷新、预览功能；删除或上传后刷新右侧与 Composer 中失效引用状态。
- [ ] **Step 4: Verify green.** 运行 Step 2 命令；expected 0 failures。
- [ ] **Step 5: Commit.** 提交 Web 文件与测试，消息 `feat: manage workspace usage and batch deletion`。

### Task 9: 全链路验收与文档更新

**Files:** Modify `README.md`, `docs/deployment/workspace-sandbox-ecs.md` 与前述任务中实际发现问题的文件/测试；不新增本轮范围外工具。

**Interfaces:** 沿用 Task 1–8 的服务端和前端契约；无新增产品接口。

- [ ] **Step 1: Verify all automated checks.** Run `npm test && npm test --prefix web && npm run build && git diff --check`; expected 0 failures。具备本地 PostgreSQL 时另跑 `npm run db:migrate && npm run test:db`。
- [ ] **Step 2: Browser acceptance.** 用根目录 `npm run dev`，按设计文档 6 条验收标准走一遍：10 MiB 边界、上传/拖入/粘贴/选择、视觉模型识图、文本读取、历史卡片、批量删除、两用户隔离、亮暗主题和窄屏。记录截图或测试笔记；不能验证的外部模型/数据库条件明确列出。
- [ ] **Step 3: Storage audit.** 在真实图片消息后检查消息表、附件表、工具 transcript 与观测记录，确认只有路径/ID/元数据而无图片 base64；核对删除前后 `du`、API `usage` 和数据库配额，误差必须为 0。检查本机 40 GB 主机保护仍按配置生效。
- [ ] **Step 4: Update operations docs.** README 写 10 MiB、500 MiB、错误文案、删除行为和视觉模型开关；部署文档写 `npm run db:migrate`、配额对账及上线前主机容量检查。明确保留现有 `USER_FILES_ENABLED` 等部署门禁，不因本功能自动开启未验证的沙箱文件写入。
- [ ] **Step 5: Commit final fixes/docs.** `git add README.md docs/deployment/workspace-sandbox-ecs.md` 和实际修复文件，`git commit -m "docs: document workspace attachments and cleanup"`；如无变更不创建空提交。
