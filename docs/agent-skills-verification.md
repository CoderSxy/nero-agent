# Agent Skills 验证记录

日期：2026-10-19（Task 0）。本文件只记录核实证据。上文各节是当时快照；**原始实现门禁见 §21，本轮九项修复补充见 §22**。生产开关默认仍关闭。

## 0. 分类图例

| 标签 | 含义 |
| --- | --- |
| **Confirmed Mastra API** | 已在本机 `@mastra/core@1.71.0` 的 docs/d.ts/运行探针中确认 |
| **App-new API** | 设计/plan 中的应用接口，尚未实现；不得冒充 Mastra 已存在 |
| **Pending real-env** | 需真实模型 / 真实 Docker / 浏览器 / 低磁盘占用环境再验收 |

---

## 1. 安装版本证据

| 项 | 证据 |
| --- | --- |
| `@mastra/core` | `package.json` dependencies = `1.71.0`；`node_modules/@mastra/core/package.json` → `version: 1.71.0` |
| Skills 子路径导出 | `exports["./skills"]` → `dist/skills/index.{js,cjs,d.ts}` |
| 嵌入文档 | `node_modules/@mastra/core/dist/docs/references/docs-skills.md`、`docs-sandbox-skills.md` 存在 |
| 前端 React | `web/package.json` → `react@19.1.0`（与 spec 基线一致） |

命令（Task 0）：

```bash
node -e "console.log(require('@mastra/core/package.json').version)"
# → 1.71.0
```

---

## 2. Confirmed Mastra APIs（skills / processor / run）

### 2.1 `@mastra/core/skills` 导出

来源：`dist/skills/index.d.ts` + 运行时 `import` 探针。

| 符号 | 类型 | 说明 |
| --- | --- | --- |
| `createSkill` | function | 创建 inline skill；metadata 校验失败则 throw |
| `isInlineSkill` | function | 类型守卫 |
| `validateSkillContent` | function | 校验原始 SKILL.md；返回 `{ valid, errors, warnings, metadata?, instructions? }`，不 throw |
| `validateSkillMetadata` | function | 校验已解析 frontmatter |
| `SKILL_LIMITS` | const | `MAX_INSTRUCTION_TOKENS:5000`, `MAX_INSTRUCTION_LINES:500`, `MAX_NAME_LENGTH:64`, `MAX_DESCRIPTION_LENGTH:1024`, `MAX_COMPATIBILITY_LENGTH:500` |
| `resolveAgentSkills` / `mergeWorkspaceSkills` | function | 原生 Agent/Workspace skills 解析（本版**不**配置原生自动工具） |
| 类型 | `Skill`, `InlineSkill`, `AgentSkillsInput`, … | 见 `dist/skills/types.d.ts` |

运行时核对（2026-10-19）：`typeof createSkill/validateSkillContent === 'function'`；合法 frontmatter `valid:true`；无 frontmatter `valid:false`。

**注意（Confirmed）：** Mastra `SKILL_LIMITS` 与应用 spec（128KiB / 64KiB 读等）是两套约束；应用 `skills/validation.ts`（App-new）须叠加自己的限额，并调用安装版 `validateSkillContent`。

### 2.2 `processLLMRequest` 与 execution `state`

来源：`dist/processors/index.d.ts`（`ProcessLLMRequestArgs`）+ 本仓库 `temporal/processor.ts` 注释 + Task 0 探针。

| 字段 | 确认 |
| --- | --- |
| `prompt` | `LanguageModelV2Prompt`，可返回改写后的 prompt |
| `model` | 当前语言模型 |
| `messageList?` | 可选 |
| `stepNumber` | 0-based，同一次 agent 循环内递增 |
| `steps` | 已完成 step 结果 |
| `state` | `Record<string, unknown>`：**同一请求/execution 内**跨 `processLLMRequest` / `processLLMResponse` / `processInput*` 持久；**不是** RequestContext |
| `requestContext?` | 可选；不可当作 execution 私有状态 |
| `retryCount` | processor 重试计数 |
| `writer?` | 流式自定义 chunk |

探针结论（`tests/skills-execution-probe.test.ts`，可复用于 Task 5）：

1. **三个模型步骤共享同一 `state` 对象与 nonce**（一次 `generate` 内 2 次 tool_calls + 1 次 stop）。
2. **第二次用户 `generate`（同一 `RequestContext`）不共享** `state` 引用/nonce；并得到不同 `runId`。
3. 因此 skill pin / 目录去重必须绑 **execution（run）**，不能绑 thread 或客户端伪造的 runId。

### 2.3 暂停恢复与 `runId`

| 项 | 确认 |
| --- | --- |
| `AgentExecutionOptions.runId?` | 可选；未传时由框架生成 UUID |
| `generate`/`stream` 结果 `.runId` | 服务端 execution 标识 |
| `finishReason: 'suspended'` + `suspendPayload` | 工具 `agent.suspend` 或审批暂停时出现 |
| `resumeGenerate(resumeData, { runId })` | 必须使用**同一** suspended `runId`；快照需 Mastra storage（探针用 `MockStore` + `new Mastra({ agents, storage })`） |
| `approveToolCall` / `listSuspendedRuns` | d.ts 确认接受 `runId`（真实审批路径 Pending：生产 Postgres 存储） |

探针：suspend 后 `resumeGenerate` **保留同一 `runId`**，`finishReason`→`stop`。

### 2.4 工具 `execute` context 真实字段

来源：`dist/tools/types.d.ts` `AgentToolExecutionContext` + 探针观测键名。

Agent 工具路径下可用（`ctx.agent`）：

- `agentId`, `toolCallId`, `messages`
- `suspend`, `resumeData`, `suspendPayload`, `suspendedToolRunId`
- `threadId?`, `resourceId?`（绑定 memory 时才有值；探针无 memory 时为 `undefined`）
- `outputWriter`, `flushMessages`

**没有** `ctx.agent.runId`。Workflow 工具才有 `ctx.workflow.runId`。

应用 skill pin 的 `serverExecutionId`（App-new）应对齐 **外层 `result.runId` / resume 入参 `runId`**，再经可信中间件写入 execution context；不可信任客户端 body 中的 runId/owner/roles。

---

## 3. 当前应用基线（读代码，未改业务）

| 项 | 状态 |
| --- | --- |
| 迁移尾号 | **`009_agent_scheduled_tasks.sql`**（下一 skills 迁移应从 **010** 起，若占用则顺延） |
| `src/mastra/agents/agent.ts` | **未**配置 `skills`；Workspace 仅 admin；`inputProcessors`: temporal + attachment |
| `src/mastra/skills/` | **不存在** |
| `AGENT_SKILLS_ENABLED` / `SKILL_SCRIPT_EXECUTION_ENABLED` | 仅出现在设计文档；**运行时未实现、未设为 true** |
| ConfigPanel Skills | 只读展示 `agent.skills`（当前为空 → None） |
| 可信身份 | `trustedAuth` / `trustedUser` 读 `mastra__user`；`AuthUser` 含 `id/email/displayName/roles`，**无 deptId** |
| Sandbox | Docker `NetworkMode: 'none'`；非 root 10001；无运行时 pip/npm 安装路径 |

---

## 4. App-new APIs（设计已定，Task 0 不实现）

下列为 spec/plan 应用契约，**不是** Mastra 内置导出：

- HTTP `/agent-skills/*`、`createSkillRoutes`
- 工具 `skill` / `skill_read` / `skill_search` / `run_skill_script`（应用注册，避免与原生同名并存）
- `SkillExecutionContext`、`app_skill_run_pins`、`serverExecutionId`
- 事件 `data-nero-skill-activation`、metadata `neroSkillActivations`
- 开关 `AGENT_SKILLS_ENABLED`、`SKILL_SCRIPT_EXECUTION_ENABLED`、`SKILLS_STORAGE_ROOT`
- 授权组 audiences（替代 OA 部门）

---

## 5. 参考项目对齐与本地替代（spec §1–2）

| 参考能力 | 本地替代 / 缺口 |
| --- | --- |
| OA 部门授权 | **无** `deptId`；用 `app_skill_audiences` / members / audience_grants（App-new） |
| 任意外网脚本 egress | **禁止**；sandbox `network none`；网络技能走服务端 tools 或标 `network-unavailable` |
| 运行时 pip/npm 下载依赖 | **禁止**；镜像预装 + `skill-runtime.json` **兼容报告** |
| LiteSkillPrompt 目录注入 | 应用 Processor（App-new），非原生 skills 自动注入 |
| SkillTool / Admin CRUD / Sync UI | 后续 Task 对应模块；本 Task 仅记录位置 |

参考根目录（本机）：`/Users/nerosun/裂缝中的阳光/sxy/工作/tc-yyxt/fontend/tc-prime-ai`（Task 0 按 spec 表核对意图，未复制代码）。

| 参考行为（相对参考根） | 本地文件（现状） |
| --- | --- |
| LiteSkillPromptMiddleware 目录注入 | 待 Task 5：`src/mastra/skills/processor.ts`；现无 |
| SkillTool 加载/读资源 | 待 Task 5：`src/mastra/skills/tools.ts`；现无 |
| SkillsController / SkillsServiceImpl 管理 | 待 Task 8–10：`src/mastra/skills/routes.ts` + `web/src/agent/skills/*`；现无 |
| SkillsEditorPane | Task 10：`web/src/agent/skills/SkillEditor.tsx` + `SkillsPage`（`/agent/skills`） |

| HarnessMessageInput 技能选择 | 待 Task 11：挂 `AgentComposer.tsx` / `AgentChat.tsx`；现仅附件/模型，无技能 chip |
| SkillSyncDialog | 待 Task 12：`web/src/agent/skills/SkillSyncDialog.tsx`；现无 |
| 可用技能只读展示 | `web/src/agent/ConfigPanel.tsx`（读 `agent.skills`，当前空） |
| 导航壳 / 消息列表 | `AgentShell.tsx`、`MessageList.tsx`（徽标待 Task 11） |
| 定时任务表单 | `ScheduledTasksPage.tsx`（`selectedSkillIds` 待 Task 5/11） |

---

## 6. Provider HTTP mock 探针

| 项 | 值 |
| --- | --- |
| 文件 | `tests/skills-execution-probe.test.ts` |
| 导出 | `runSkillsExecutionProbe()` — Task 5 回归可直接调用 |
| 命令 | `node --import tsx --test tests/skills-execution-probe.test.ts` |
| Task 0 结果 | **pass**（亦包含在完整 `npm test` 中 ok） |

发现摘要：同 execution 三步共享 processor state；次用户轮次不共享；suspend/resume 服务端标识为 `runId`。

---

## 7. 测试基线（本次实跑，非历史聊天数字）

环境备注：宿主盘约 **91%** 已用；`WORKSPACE_DISK_BLOCK_RATIO` 默认 **0.9**，大量写盘测试触发 `DiskProtectionError: 磁盘使用率过高，已禁止写入`。属环境基线，非 skills 功能回归。

### 7.1 `npm test`（root，`node --import tsx --test tests/*.test.ts`）

| 统计 | 值 |
| --- | --- |
| tests | 336 |
| pass | 269 |
| fail | **48** |
| skipped | 19 |
| duration | ~62s |

失败名称与原因（按错误归类）：

**A. DiskProtectionError「磁盘使用率过高，已禁止写入」（35）**

- selecting the same workspace file twice is idempotent and does not copy or grow usage
- history listing keeps stored metadata after the original file is deleted or changed
- forged users, other threads, unknown ids and non-admin agent source are rejected
- stale unsent refs older than 24h are cleaned only after Mastra confirms no message
- refs younger than 24h are not cleaned even when Mastra reports no message
- lookup throw fails closed and does not clean stale refs
- cleanup only deletes expired rows in a clientMessageId group
- cleanup fails closed when renamed client-set message body holds attachment ids
- user B cannot read user A files and forged identity is ignored
- download returns the file bytes and safe headers
- read_file accepts path and returns content with quoted SHA-256 etag and byte size
- file tool writes into the authenticated agent thread without a model-supplied threadId
- glob tool finds thread files via trusted auth and returns truncation metadata
- glob tool defaults to thread scope and accepts explicit workspace scope
- grep tool finds literal matches with etag matching read_file
- grep tool defaults to thread scope and searches exact workspace path when requested
- edit tool replaces once and returns applicationPath without host paths
- end-to-end file flow: glob → grep → edit → re-read, then workspace upload search
- two users with two threads cannot read each other files or run as another identity
- two threads of the same user can keep the same filename without overwriting
- deleting a thread record does not delete its directory
- successful growing edit settles its quota reservation
- replaceWorkspaceText replaces exactly once and returns new etag/size
- replaceWorkspaceText allows empty newText
- FileService write over remaining quota fails
- deleting a file releases its workspace quota
- WorkspaceFileService batchDelete frees quota and rescan matches disk
- overwrite write reserves only max(0, new - old) and shrinking releases the difference
- overwriting a zero-byte file does not increment the file count
- uploading the same name twice stores distinct paths and does not overwrite
- Unicode and special-character names stay safe path segments
- uploads that exceed workspace quota return WORKSPACE_QUOTA_EXCEEDED
- a post-rename reconciliation failure keeps the persisted file charged
- personal usage ignores other users and does not follow symlinks
- （另有 edit workspace scope 等包装为 `WorkspaceEditError` 但根因同为磁盘保护）

**B. 断言被磁盘保护污染（13，期望配额/HTTP 码，实得 409 或 DiskProtection）**

- thread upload maps quota failures to WORKSPACE_QUOTA_EXCEEDED JSON — Expected `409 !== 413`
- a larger edit respects the user workspace quota — 期望校验路径，收到磁盘保护
- replaceWorkspaceText rejects quota and disk protection without changing bytes or quota — 同上
- concurrent replaces sharing an etag yield exactly one success — `0 !== 1`
- saveWorkspaceText and replaceWorkspaceText share the same path lock — `0 !== 1`
- web personal-root and agent thread-root paths serialize on the same physical file — `0 !== 1`
- conditional save edits only the owned workspace and returns a new ETag — `409 !== 200`
- reads and saves a Unicode filename and UTF-8 content — `409 !== 200`
- personal workspace upload uses unique safe paths and returns usage on list — `409 !== 201`
- workspace upload rejects anonymous, other users, oversized files, quota and symlinks — `409 !== 201`
- workspace upload maps quota failures to WORKSPACE_QUOTA_EXCEEDED — `409 !== 413`
- a failed quota commit removes a newly persisted upload and releases its reserve — 正则 `/commit failed/` 未匹配 DiskProtection 信息
- list reconcile does not drop reserved-but-not-yet-on-disk quota — 期望 `QuotaExceededError`，收到 `DiskProtectionError`

**Incomplete / 环境：** 低磁盘占用下上述用例需重跑才能作为非磁盘基线；Task 0 **不**把它们记为 pass。

### 7.2 `npm test --prefix web -- --maxWorkers=2`

| 统计 | 值 |
| --- | --- |
| Test Files | 2 failed / 42 passed（44） |
| Tests | **3 failed** / 340 passed（343） |
| duration | ~126s |

失败：

1. `AgentPage.test.tsx` › types directly in the mobile composer without creating a thread until send — Unable to find role=`textbox` name=`已创建会话输入框`（与既有移动端/流式改动相关，非 skills）
2. `MessageList.test.tsx` › renders a completed JSON5 chart with a single series — **timeout 5000ms**
3. `MessageList.test.tsx` › renders a completed Mermaid fence as a diagram — **timeout 5000ms**

---

## 8. Pending real-env verification

- 真实 LLM 边界（目录 vs 全文、显式选择加载）— Task 5+
- 真实 Docker 技能脚本容器 — Task 6–7
- `listSuspendedRuns` / 多实例 resume + Postgres 快照 — 生产路径
- 浏览器 Skills UI / 同步 — Task 11–14
- 磁盘 &lt; block ratio 时重跑 §7.1 写盘失败集

---

## 9. Task 0 自检

- [x] 无 `src/mastra/skills` 业务模块
- [x] 未设置 `AGENT_SKILLS_ENABLED=true` / 未启用脚本执行生产开关
- [x] 未 git commit / push
- [x] 仅新增验证文档 + 探针测试；未改无关 dirty 文件
- [x] Confirmed / App-new / Pending 已分区记录

---

## 10. Task 1：标准内容、包校验和导入预览（2026-10-19）

本段只追加 Task 1 证据；不改写上文 Task 0 结论。Task 1 **仅**落地包校验层（types/errors/config/validation/package + 定向测试），**未**实现 repository/HTTP/UI/runtime tools，**未**启用 `AGENT_SKILLS_ENABLED`。

### 10.1 依赖固定（未升级 Mastra）

| 包 | 固定版本 | 许可证 | 选择理由 |
| --- | --- | --- | --- |
| `yaml` | **2.9.1**（直接依赖） | ISC | Spec 要求；`maxAliasCount:20`、禁止自定义 tag；frontmatter 解析 |
| `@zip.js/zip.js` | **2.24.0**（直接依赖） | **BSD-3-Clause** | 维护中；`ZipReader.getEntries` 可先检查条目（symlink/`uncompressedSize`/路径）；`getData(WritableStream)` 可逐块计数并在超限时中止；`ZipWriter` 供测试构造；**不是**“解压后再统计” |
| `@mastra/core` | **1.71.0**（未变） | Apache-2.0 | 继续调用真实 `validateSkillContent` |

安装核对：

```text
@mastra/core@1.71.0
yaml@2.9.1
@zip.js/zip.js@2.24.0
```

### 10.2 App-new 模块（校验层）

| 文件 | 职责 |
| --- | --- |
| `src/mastra/skills/types.ts` | `ValidatedSkillPackage` / `SkillImportPreview` / runtime manifest 类型 |
| `src/mastra/skills/errors.ts` | `SkillPackageError` + 稳定 `code` |
| `src/mastra/skills/config.ts` | `SKILLS_IMPORT_TEMP_ROOT`（必填）、TTL 默认 30min |
| `src/mastra/skills/validation.ts` | Spec 限额常量、路径/别名/YAML、`validateSkillMd`（调用 Mastra） |
| `src/mastra/skills/package.ts` | `parseSkillPackage` / `previewSkillZip`（外包目录剥离、临时区落盘） |

### 10.3 TDD RED

命令：`node --import tsx --test tests/skills-package.test.ts`

| 阶段 | 结果摘要 |
| --- | --- |
| 测试已写、依赖未装 | `ERR_MODULE_NOT_FOUND: Cannot find package '@zip.js/zip.js'` → fail 1 |
| 依赖已装、实现未写 | `ERR_MODULE_NOT_FOUND: .../src/mastra/skills/package.ts` → fail 1 |

### 10.4 TDD GREEN

同一命令重跑（实现后）：

```text
# tests 20
# pass 20
# fail 0
# duration_ms ~2300
```

覆盖要点：`valid_standard_bundle`（中文路径）、`noncanonical_name_requires_acceptance`（不静默改写）、字节/文件数边界、路径穿越/碰撞、YAML alias>20、runtime schema、ZIP 流式超额、symlink/hardlink 标记/设备文件、失败清理临时区且不写出 temp root。

### 10.5 Task 1 自检

- [x] 调用安装版 `validateSkillContent`（非自造 parse API）
- [x] 限额常量集中在 `skills/validation.ts`
- [x] 未升级 Mastra；yaml / zip.js 已固定版本并记许可证
- [x] 无 git commit / push
- [x] 未实现 HTTP/repository/UI/runtime tools；未开生产开关

---

## 11. Task 2：SQL 模型与权限仓储（2026-10-19）

本段只追加 Task 2 证据；不改写上文 Task 0/1 结论。Task 2 落地 `migrations/010_agent_skills.sql` + `skills/repository.ts` + 真实 PostgreSQL 测试；**未**实现 publish/blob/HTTP/UI；**未**启用 `AGENT_SKILLS_ENABLED`；**无** git commit/push。

### 11.1 安全测试库门禁

| 项 | 值 |
| --- | --- |
| 允许连接 | 仅 `DATABASE_URL` → `127.0.0.1\|localhost:5433/nero_agent`（`db:local:setup` 本地容器） |
| 拒绝 | 其他 host/port/dbname，或缺失 URL → 测试 skip / 记录 `BLOCKED_ENV:...` |
| 本次环境 | 已确认本地 loopback:5433/`nero_agent`；**未**对未核实生产 URL 跑测试；**未** drop/recreate 用户库 |

### 11.2 迁移

| 文件 | 表（010，不含 run_pins/shortcuts/sync_sessions） |
| --- | --- |
| `migrations/010_agent_skills.sql` | `app_skill_groups`, `app_skill_audiences`, `app_skills`（含 `version_seq` 高水位）, `app_skill_aliases`, `app_skill_versions`（部分唯一：每技能最多一个 draft）, `app_skill_files`, `app_skill_grants`, `app_skill_audience_members`, `app_skill_audience_grants`, `app_skill_events` |

命令：

```bash
npm run db:migrate   # Applied 010_agent_skills.sql
npm run db:migrate   # 幂等：无再次 Applied（exit 0）
```

### 11.3 Repository 接口

`createSkillRepository(pool)` → `SkillRepository`：

- `transaction(fn)`：回调拿到**同一** `PoolClient` 绑定的 repo；写路径不在回调内重新 `pool.connect`
- `createDraft` / `getSkill` / `getVersion` / `listAvailable` / `listManageable` / `updateDraft` / `updateMetadata`
- 额外：`createWorkingDraft` + `allocateNextVersion`（`version_seq` 单调递增，删除版本不复用编号）
- `revision` DTO 为十进制**字符串**；CAS 冲突 → `SkillRepositoryError('REVISION_CONFLICT')`
- 跨表名唯一：事务内 `pg_advisory_xact_lock(hashtext('app_skill_name_namespace'))`

### 11.4 测试

```bash
node --env-file-if-exists=.env --import tsx --test tests/skills-repository.test.ts
```

```text
# tests 2
# pass 2
# fail 0
```

覆盖：UUID FK、canonical/alias 跨表冲突、单 draft、version_seq 不复用已删编号、资源路径唯一、分类组 vs 授权组、软删过滤、并发 revision CAS、admin 可管理≠可运行、audience use 路径。

回归：`node --import tsx --test tests/skills-package.test.ts` → pass 20/20。

### 11.5 Task 2 自检

- [x] 010 不含 run_pins / shortcuts / sync_sessions
- [x] 真实 PG 迁移 + 测试；非内存 fake 宣称迁移通过
- [x] 仅安全本地 DB；无生产 URL；无重建用户库
- [x] 无 git commit / push；未开生产开关
- [x] 未改无关 dirty 文件（仅 skills 相关 + verification + report）

---

## 12. Task 3：内容寻址存储、发布与回滚（2026-10-19）

本段只追加 Task 3 证据；不改写上文结论。Task 3 落地 blob/release/versions；**未**实现 HTTP/policy/UI；**未**启用 `AGENT_SKILLS_ENABLED`；**无** git commit/push。

### 12.1 App-new 模块

| 文件 | 职责 |
| --- | --- |
| `src/mastra/skills/blob-store.ts` | 流式 temp→SHA-256→原子 rename；`openVerified` fail-closed |
| `src/mastra/skills/release-store.ts` | staging→逐文件校验→原子 rename；`releaseRoot` 仅内部 |
| `src/mastra/skills/versions.ts` | `publishSkill` / `rollbackSkill` / `deriveWorkingDraft` / `deleteSkillVersion` |
| `src/mastra/skills/config.ts` | `getSkillsStorageRoot()`（`SKILLS_STORAGE_ROOT` 必填） |
| `src/mastra/skills/repository.ts` | `listFiles` / `applyPublishPointer` / `applyRollbackPointer` / `deleteVersion` |

### 12.2 语义核对

| 契约 | 证据 |
| --- | --- |
| 首次发布 `enabled=false` | publish 集成测试断言 |
| 已启用技能再发布保持 `enabled=true` | 同上 |
| 中途失败旧指针不变 | release 成功 + injected DB fail → `published_version` 仍 null；版本仍 draft |
| 并发双发布 | 真实 DB：`CONCURRENT_PUBLISH: winner=1 loser=VERSION_NOT_DRAFT` |
| `releaseRoot` 不进 DTO | `SkillPublishResult` 无该字段；测试 `assertNoReleaseRootInDto` |
| 哈希错误 fail closed | blob 篡改 / release 缺 blob / verifyRelease 篡改 → `BLOB_HASH_MISMATCH` / `RELEASE_HASH_MISMATCH` |
| 草稿派生复制引用 | `deriveWorkingDraft` 复制 `blob_hash`，不复制字节 |
| remark ≤500 | 501 字符 → `INVALID_INPUT` |
| pin 删除拒绝 | `current_or_active_pin_version_cannot_delete`：当前指针 → `VERSION_IN_USE`；活动 pin 表待 Task 5 |

### 12.3 测试

```bash
node --env-file-if-exists=.env --import tsx --test tests/skills-storage.test.ts tests/skills-publish.test.ts
```

```text
# tests 12
# pass 12
# fail 0
```

| 分类 | 覆盖 |
| --- | --- |
| 存储单测 | blob 半写失败、超限、rename 前失败、哈希篡改、release 错哈希、rename 前失败、幂等 materialize |
| 发布集成（安全 DB） | 启停语义、派生草稿、old_pin_files_unchanged、new_execution_sees_new_pointer、回滚缺文件、DB fail 后指针、并发发布、发布期间读旧指针 |
| 模拟事务 | `SIMULATED_TX: release ok + pointer fail → old pointer retained (unit)`（不计为真实并发） |

安全 DB 门禁同 Task 2：仅 `127.0.0.1|localhost:5433/nero_agent`；否则 `BLOCKED_ENV` + skip。

回归：`tests/skills-package.test.ts` + `tests/skills-repository.test.ts` → pass 22/22。

### 12.4 Task 3 自检

- [x] 原子 blob/release；DB 指针 CAS + 行锁；失败保留旧指针
- [x] 不得先 enabled 再写文件；首次发布不自动启用
- [x] `releaseRoot` 不出现在 HTTP/DTO 模型
- [x] 无 git commit / push；未开生产开关
- [x] 活动 run pin 真实表接入留给 Task 5

---

## 13. Task 4：统一权限与运行服务（2026-10-19）

本段只追加 Task 4 证据；不改写上文结论。Task 4 落地 `skills/policy.ts` + `skills/service.ts`；`publishSkill`/`rollbackSkill` 前统一鉴权；**未**实现 HTTP/tools/processor；**未**启用 `AGENT_SKILLS_ENABLED`；**无** git commit/push。

### 13.1 接口

| 项 | 说明 |
| --- | --- |
| `SkillActor` | `= AuthContext`（`trustedAuth`）；不接受 body 伪造 roles |
| `evaluateSkillPermissions` | §6 矩阵；admin 可维护 ≠ 自动 canUse；edit 不含 publish；use 不可看草稿 |
| `createSkillService(deps)` | 运行：`listAvailable` / `load` / `read` / `search`；管理：`createDraft` / `getManageDetail` / `saveDraft` / `saveFile` / `setMetadata` / `setEnabled` / `deleteSkill` / `listEvents` / `publish` / `rollback` |
| Repository 扩展 | `resolveByName` / `getAccessSnapshot` / `getDraftVersion` / `getFile` / `upsertDraftFile` / `listEvents` |

### 13.2 语义核对

| 契约 | 证据 |
| --- | --- |
| admin 可管理 private 但不可运行 | policy 矩阵 + runtime：admin load → `SKILL_UNAVAILABLE` |
| edit 不能发布 | runtime：editor → `publishSkill` → `FORBIDDEN` |
| use 不能看草稿 | runtime：`getManageDetail` → `FORBIDDEN` |
| 撤权/禁用/软删后 load/read/search | 一律 `SKILL_UNAVAILABLE`；搜索不泄漏名称/片段 |
| 权限每次重查 | `getAccessSnapshot` 每次调用；blob 仅按 hash 缓存 |
| DB 故障 fail-closed | 注入 `getAccessSnapshot` throw → load `SKILL_UNAVAILABLE` |
| alias 精确匹配 / baseUri 解析 / 读写限制 | runtime 集成断言 |

### 13.3 测试

```bash
node --env-file-if-exists=.env --import tsx --test tests/skills-policy.test.ts tests/skills-runtime.test.ts
```

```text
# tests 18
# pass 18
# fail 0
```

安全 DB 门禁同 Task 2：仅 `127.0.0.1|localhost:5433/nero_agent`。

回归：`tests/skills-publish.test.ts` → pass 3/3（含 publish 鉴权后 owner 路径）。

### 13.4 Task 4 自检

- [x] policy 矩阵覆盖 owner/admin/use/edit/publish/global/audience/未授权/停用
- [x] versions publish/rollback 前鉴权
- [x] 无 git commit / push；未开生产开关
- [x] execution pin / tools / HTTP 留给 Task 5+

---

## 14. Task 5：可信 execution、工具与模型边界（A 门禁）（2026-10-19）

本段只追加 Task 5 证据；不改写上文结论。Task 5 落地运行时 pin / processor / 三工具 / 离线导入 CLI / 定时任务 selectedSkillIds；**未**实现脚本执行（B）、HTTP 管理 API、UI；**未**启用生产 `AGENT_SKILLS_ENABLED`（默认仍 false）；**无** git commit/push。

### 14.1 迁移与模块

| 文件 | 职责 |
| --- | --- |
| `migrations/011_agent_skill_run_pins.sql` | `app_skill_run_pins`；`agent_scheduled_tasks.selected_skill_ids UUID[]` + cardinality≤5 |
| `skills/execution-context.ts` | `resolveSkillExecution` / `bindSkillServerExecutionId`；`nero-agent.selected-skill-ids` 仅 UUID 意图 |
| `skills/processor.ts` | 目录 `<nero_available_skills>`、显式加载、128KiB 预算、`data-nero-skill-activation`、metadata `neroSkillActivations` |
| `skills/tools.ts` | 应用侧 `skill` / `skill_read` / `skill_search`（无 hostPath） |
| `skills/factory.ts` | Agent 惰性接入；开关关闭时工具为空、processor no-op |
| `scripts/skills-import.ts` | 管理员离线 CLI：`--actor-user-id --file`；默认草稿；`--publish --enable` 显式 |

命令：`npm run db:migrate` → `Applied 011_agent_skill_run_pins.sql`（幂等再跑无重复 Applied）。

### 14.2 Confirmed：runId 钉定方式（相对 Task 0）

| 项 | 证据 |
| --- | --- |
| `ctx.agent.runId` | 仍不存在（Task 0 探针） |
| `processInputStep.runId` | **本机 `@mastra/core@1.71.0` 常为 `undefined`**，即使 `generate({ runId })` 已传入且 `result.runId` 匹配 |
| 应用钉定 | `bindSkillServerExecutionId(requestContext[, id])` 写入 `nero-agent.server-execution-id`，并与 `generate({ runId })` / `resumeGenerate(..., { runId })` 使用同一 UUID；pin 表绑定该 id + 真实 userId/threadId |
| processor state | 同一次 generate 内共享（Task 0 探针复用 `runSkillsExecutionProbe` 仍 pass） |

### 14.3 A 门禁语义核对

| 契约 | 证据 |
| --- | --- |
| 开关默认 off | `isAgentSkillsEnabled()` false；`listAgentToolIds` 无 skill*；聊天既有工具保留 |
| 目录非全库正文 | 集成测试：provider payload 含 `<nero_available_skills>` + 授权名；无授权技能名/正文不出现 |
| 显式选择首请求前加载 | selected UUID → `loadById`；失败出现在 `nero_skill_activation_errors` / activation failed |
| pin 复用 / 新执行刷新 | `second_step_reuses_pin`（同 runId 保持 v1）；`new_execution_refreshes_version`（新 runId 取 v2） |
| 同 thread 不共享 pin | `listRunPins` 按 server_execution_id；新 execution 空 |
| 审批恢复保 pin | suspend/resume 同一 bound runId；pin version 不变 |
| 伪造 context 不钉版本 | 客户端 `runId` / 假 pins 不作为权威；resolve 只用服务端传入的 serverExecutionId |
| 活动 pin 拒删版本 | `hasActiveRunPin` + `deleteVersion` → `VERSION_IN_USE` |
| 128KiB 预算 | 两枚大技能显式选择 → 模型上下文见 `SKILL_CONTEXT_LIMIT` |
| 撤权后不重注 | disable 后 load → `SKILL_UNAVAILABLE` |
| 无原生 skills 自动工具 | `agent.ts` 未配置 `skills:`；仅合并应用三工具 |
| B 尚不可用 | 无 `run_skill_script`；`SKILL_SCRIPT_EXECUTION_ENABLED` 未接线 |

### 14.4 测试

```bash
node --env-file-if-exists=.env --import tsx --test \
  tests/skills-agent.integration.test.ts tests/skills-run-pins.test.ts
# tests 7 / pass 7 / fail 0

node --env-file-if-exists=.env --import tsx --test tests/scheduled-tasks-*.test.ts
# tests 36 / pass 36 / fail 0
```

安全 DB 门禁同 Task 2：仅 `127.0.0.1|localhost:5433/nero_agent`。

### 14.5 Task 5 自检

- [x] A 运行时协议落地；B 脚本执行明确未验收 / 不可用
- [x] 既有 agent 工具未丢失；无原生 Agent.skills 自动工具并存
- [x] `AGENT_SKILLS_ENABLED` 默认 false
- [x] 无 git commit / push
- [x] 未改无关 dirty 文件意图（仅 skills/agent/scheduled-tasks/index/migrations/docs/tests/scripts）

### 14.6 A-gate review fix（Critical/Important）（2026-10-19）

本小节只追加评审修复证据；不改写上文结论。

| 项 | 修复 |
| --- | --- |
| P0 pin 权威 | WeakMap `bindSkillServerExecutionId` / `bindSkillThreadId`；processor **不**信任 `nero-agent.server-execution-id` string；无 bind 时 fail closed（无 `randomUUID()` pin） |
| P0 生产路径 | `installSkillExecutionBindings(agent)`（chat/stream/resume）；`runScheduledAgent` 绑定并传入同一 `runId` |
| P0 负向 | 伪造 requestContext execution id **不会**成为 pin key |
| P1 activation | writer 捕获 `data-nero-skill-activation`；`neroSkillActivations` metadata；tools `onActivation`→`noteToolActivation` |
| P1 scheduled edit | `service.edit` 持久化 `selectedSkillIds` |
| P1 threadId | 禁止 `'no-thread'` pin；缺 thread fail closed |

```bash
node --env-file-if-exists=.env --import tsx --test \
  tests/skills-agent.integration.test.ts tests/skills-run-pins.test.ts
# pass（含 forged execution id 负向 + activation/metadata）

node --env-file-if-exists=.env --import tsx --test tests/scheduled-tasks-*.test.ts
# tests 37 / pass 37 / fail 0（含 edit persists selectedSkillIds）
```

报告：`.superpowers/sdd/task-5-report.md`（A-gate review fix evidence）。

---

## 15. Task 6：独立技能脚本容器与运行限制（2026-10-19）

本段只追加 Task 6 证据；不改写上文结论。落地短生命周期技能脚本容器、`run_skill_script` 门控、runtime 兼容报告与孤儿清理；**未**放宽 `docker/config.ts` 通用单挂载校验；**未**跑真实 Docker（Task 7）；**默认开关仍关闭**；**无** git commit/push。

### 15.1 模块

| 文件 | 职责 |
| --- | --- |
| `skills/script-container.ts` | 独立 `createSkillScriptContainerOptions` / `validateSkillScriptContainerOptions`；`/skill:ro`+`/workspace:rw`；`nero.skill-run=1` |
| `skills/script-runner.ts` | `SkillScriptRunner.execute`：线程归属/配额/`commandQueue`；argv 解释器；销毁重试 |
| `skills/runtime.ts` | `reportSkillRuntimeCompatibility` → missing-tools / network-unavailable / ready |
| `skills/script-resolve.ts` | load 固定 pin → verifyRelease |
| `skills/tools.ts` / `factory.ts` / `config.ts` | `run_skill_script` 仅总开关+脚本开关+sandbox 全开时暴露 |
| `sandbox/cleaner.ts` / `factory.ts` | 孤儿 `nero.skill-run=1` 清理，不碰 `nero.sandbox=1` |

### 15.2 契约核对

| 契约 | 证据 |
| --- | --- |
| 不放宽通用校验 | 技能双挂载故意无法通过 `validateDockerCreateConfig` |
| network none / nonroot / cap-drop / digest | container 单测 |
| 无 hostPath API | 工具 schema 仅 skillName/path/args；输出 strip |
| argv 非 shell | runner 单测 `python3` + `/skill/scripts/...` |
| 销毁后清理 | created==1 removed==1；remove 失败重试 |
| 工具门控 | `isSkillScriptExecutionEnabled()` |
| B 真实 Docker | **Pending** Task 7 |

### 15.3 测试

```bash
node --import tsx --test \
  tests/skills-script-runner.test.ts \
  tests/skills-script-container.test.ts \
  tests/sandbox-manager.test.ts
# tests 17 / pass 17 / fail 0
```

### 15.4 Task 6 自检

- [x] 独立技能容器配置与校验（未改通用 docker 校验语义）
- [x] runner 权限/路径/args/超时/截断/清理
- [x] runtime 兼容报告
- [x] `run_skill_script` 开关门控
- [x] 孤儿 label 清理不误删用户沙箱
- [x] 无 git commit / push；默认开关关闭
- [x] 真实 Docker 脚本验收 → Task 7（见 §16）

---

## 16. Task 7：真实离线脚本与镜像验收（B门禁）（2026-10-19）

本段只追加 Task 7 / B 门禁证据；不改写上文结论。使用真实 Docker Engine + 固定 digest；**未**使用 FakeProvider；默认生产开关仍关闭；**无** git commit/push。

### 16.1 交付物

| 路径 | 说明 |
| --- | --- |
| `tests/skills-docker.integration.test.ts` | 真实 Docker 集成；缺环境显式 skip |
| `tests/fixtures/skills/reference-demo/` | 纯指令 + `references/checklist.md` |
| `tests/fixtures/skills/script-demo/` | python3：`/skill/assets/data.json` → `result.csv` |
| `sandbox/Dockerfile` | 既有构建文件：预装 python3/node/bash、UID 10001 |
| `docs/deployment/agent-skills.md` | 镜像依赖、digest、开关、备份 |
| `src/mastra/sandbox/docker/client.ts` | 本地 `name@sha256:<imageId>` → `sha256:<id>` 解析 |

### 16.2 镜像与解释器（容器内实测）

| 项 | 值 |
| --- | --- |
| Image pin | `mastra-agent-sandbox:1.0@sha256:e4cbba692d0ee123704f9fb3ed9508fb9cecb66cfe5603890cc891096b13f937` |
| python3 | Python 3.13.7 |
| node | v22.23.1 |
| bash | GNU bash 5.2.37(1)-release (aarch64-unknown-linux-gnu) |

### 16.3 契约核对（V8 / V9）

| 契约 | 结果 |
| --- | --- |
| script-demo 产物 `result.csv` 经 `FileService.read` | pass |
| 跨用户读取失败 | pass |
| `/skill` 只读（改写失败） | pass |
| `network none` 外网不可达 | pass |
| abort 后无 `nero.skill-run=1` 残留 | pass |
| pin 切换不改变当前容器读到的 v1 资源 | pass |
| 与 `execute_command` 共用 `commandQueue` + cancel | pass |
| 无 FakeProvider | pass |
| 无门禁 env 时显式 skip | pass（6 skip / 1 pass — reference-demo 离线断言） |

### 16.4 测试命令与结果

```bash
WS=$(mktemp -d); ST=$(mktemp -d)
IMG_ID=$(docker inspect --format='{{.Id}}' mastra-agent-sandbox:1.0)
PIN="mastra-agent-sandbox:1.0@sha256:${IMG_ID#sha256:}"

SKILLS_DOCKER_INTEGRATION=true \
SANDBOX_IMAGE="$PIN" \
WORKSPACE_ROOT="$WS" \
SKILLS_STORAGE_ROOT="$ST" \
node --import tsx --test tests/skills-docker.integration.test.ts
# tests 7 / pass 7 / fail 0 / skipped 0
# duration ~15s
```

未设置 `SKILLS_DOCKER_INTEGRATION=true`：

```bash
node --import tsx --test tests/skills-docker.integration.test.ts
# skip（显式原因）+ reference-demo fixture 仍可断言；fail 0
```

容器清理：用例结束 `engine.remove`；abort 后 `findLabeled(nero.skill-run=1)` 长度为 0。

### 16.5 B 门禁自检

- [x] 真实 Docker；缺 Docker/digest/专用 root 时 skip 并说明，不用 FakeProvider
- [x] fixture reference-demo + script-demo；runtime 与镜像 python3 一致
- [x] 镜像依赖与 digest 写入 `docs/deployment/agent-skills.md`
- [x] 产物文件 API / 跨用户 / release 只读 / 外网 / abort 清理 / queue+cancel / pin 稳定
- [x] 无 git commit / push
- [x] B 门禁在本机 Docker Desktop 上 **已跑通**（digest 见上）；ECS 生产 digest 需按同一 Dockerfile 重建后替换

---

## 17. Task 8：HTTP管理接口与身份负面测试（2026-10-19）

本段只追加 Task 8 证据；不改写上文结论。落地 `createSkillRoutes` base `/agent-skills`；**未**注册 imports/sync/shortcuts（后续任务）；默认 `AGENT_SKILLS_ENABLED` 仍 false；**无** git commit/push。

### 17.1 交付物

| 路径 | 说明 |
| --- | --- |
| `src/mastra/skills/routes.ts` | `createSkillRoutes` + `skillRoutes`；统一 `{error:{code,message}}` |
| `src/mastra/skills/{service,repository,types,validation}.ts` | HTTP 所需管理/组/授权组/导出等方法 |
| `src/mastra/index.ts` | 注册 `skillRoutes` |
| `web/vite.config.ts` | 开发代理 `/agent-skills` |
| `docs/deployment/agent-skills.md` §1.1、`ecs-release-from-local-build.md` | 生产 Nginx 需加 `agent-skills` |
| `tests/skills-routes.test.ts` | 路由契约 + 伪造身份/限流/下载头/If-Match |
| `tests/skills-http.integration.test.ts` | 真实 DB 身份矩阵 A/B/admin/anon |

### 17.2 契约核对

| 契约 | 结果 |
| --- | --- |
| trustedAuth only；伪造 userId/roles/owner 无效 | pass |
| use-only 不可读草稿/历史/versions/events；可 download/export 当前启用发布版 | pass |
| admin 可管理详情但不自动出现在 `/available`（无 use） | pass |
| 静态 `/available` `/groups` 先于 `/:id`；UUID 严格 | pass |
| 流式 JSON/文件字节限流；Content-Disposition `filename*`；If-Match↔expectedRevision | pass |
| `AGENT_SKILLS_ENABLED=false` → 503 `SKILLS_DISABLED` | pass |
| imports/sync/shortcuts 未注册（不假成功） | pass |
| canEdit/canPublish/canManage 仅 API 返回 | pass |

### 17.3 测试命令与结果

```bash
node --env-file-if-exists=.env --import tsx --test \
  tests/skills-routes.test.ts tests/skills-http.integration.test.ts
# tests 6 / pass 6 / fail 0
```

回归：`tests/scheduled-tasks-routes.test.ts` → 3/3 pass。`tests/file-routes.test.ts` / `attachment-routes.test.ts` 仍有既有失败（假 UUID 写 `app_workspaces` FK、DiskProtection 409≠413），与 Task 8 无关（Task 0 基线同类）。

### 17.4 自检

- [x] 真实 HTTP 身份矩阵（非模型工具替代）
- [x] 注册路由 + Vite 代理 + 生产反代文档说明
- [x] 无 git commit / push；默认开关关闭
- [x] imports/sync/shortcuts 留给 Task 12/13

## 18. Task 9：版本维护、并发操作与分类/授权组 API（2026-10-19）

本段只追加 Task 9 证据。复用 Task 8 已注册的管理 API；修正 `updateMetadata` 在启停时写入 `enable`/`disable` 审计事件（此前误记为 `edit`）。

| 场景 | 结果 |
| --- | --- |
| 启用未发布 → `INVALID_INPUT` 400；CAS 失败不改内容 | pass |
| 当前指针 / 活动 pin 版本删除 → `VERSION_IN_USE`；过期 pin 后可删 | pass |
| 分类删除前须移出技能；`groupId` 移动返回新 revision | pass |
| 授权组成员移除后下一次 `read` → `SKILL_UNAVAILABLE` | pass |
| 非 admin 设 `global` → `FORBIDDEN` | pass |
| events 分页 pageSize=2 稳定翻页 | pass |
| owner+edit 同 revision 并发 `saveDraft` → 一胜一 `REVISION_CONFLICT` | pass（真实 DB） |
| 双 publish → 一胜；败者 `REVISION_CONFLICT`/`VERSION_NOT_DRAFT`/release 冲突码 | pass（真实 DB） |
| publish vs sync stub（`saveDraft` 占位 Task 12）→ CAS 互斥 | pass |
| 同名并发 `createDraft` → `NAME_CONFLICT`；撤 edit 后保存 `FORBIDDEN` | pass |

```bash
node --env-file-if-exists=.env --import tsx --test \
  tests/skills-management.test.ts tests/skills-concurrency.test.ts
# tests 4 / pass 4 / fail 0
```

报告：`.superpowers/sdd/task-9-report.md`。

## 19. Task 10：Skill管理页面（C门禁 UI）（2026-10-19）

落地 `/agent/skills`：`web/src/agent/skills/{types,skills-api,SkillsPage,SkillEditor,SkillFiles,SkillVersions,SkillPermissions}` + Vitest；导航挂 ManageMenu（全用户）与 MobileInbox；保存≠发布；写操作带 revision；409 保留本地正文。

```bash
npm test --prefix web -- src/agent/skills --maxWorkers=2   # 6 files / 16 pass
npm run build:web                                          # pass
```

| 项 | 状态 |
| --- | --- |
| Vitest 列表/409/竞态/权限按钮/发布失败不假更新 | pass |
| 浏览器 E2E 创建→发布→启停→回滚 | **Pending**（本机未跑浏览器） |
| 真实 DB/部署联调管理页 | **Pending**（API 已由 Task 8/9 覆盖） |
| C：非 admin 可维护自己的技能；admin 维护≠自动运行权限 | UI 按 API `canEdit/canPublish/canManage`；运行口径仍服务端 |

报告：`.superpowers/sdd/task-10-report.md`。

## 20. Task 14：运维恢复、清理与长会话回归（D 门禁）（2026-10-19）

| 项 | 结果 |
| --- | --- |
| 缺失 release 从受信 blob 重建；坏 blob 503；不改发布指针 | pass（`tests/skills-reconcile.test.ts`） |
| 两实例 reconcile 不删对方 staging / 当前版本 | pass |
| GC 默认 dry-run；`--apply` 才删满 7 天且无引用内容 | pass |
| 活动 pin、当前发布、刚上传 blob 不 GC；过期 import/sync 与旧 staging 在宽限后可删 | pass |
| 运行审计 90 天；run pin 结束后再留 7 天；续期 pin 不删 | pass |
| 孤儿 `nero.skill-run` 容器可清；`nero.sandbox` 不碰 | pass |
| 长会话压缩、审批恢复、定时执行、禁用技能不丢正文、不换 pin | pass（`tests/skills-long-conversation.test.ts`，复用 Task 5 probe；模型 HTTP mock） |
| 真实备份恢复演练 | **未运行** |
| 真实模型长会话 | **未验收**（本任务用 provider mock） |

```bash
node --import tsx --test tests/skills-reconcile.test.ts tests/skills-long-conversation.test.ts
# tests 13 / pass 13 / fail 0（含 import 进来的 Task 5 probe 1 条）
```

报告：`.superpowers/sdd/task-14-report.md`。

## 21. Task 15：完整回归与真实效果验收（2026-10-19）

本段是当前门禁。未跑的浏览器、真实模型和备份恢复记为**未验收**。没有 18 次模型会话记录。

### 21.1 命令

| 命令 | 结果 |
| --- | --- |
| `node --env-file-if-exists=.env --import tsx --test tests/skills-*.test.ts` | **112 tests / pass 106 / fail 0 / skipped 6**（约 23s）。6 条 skip 是未设 `SKILLS_DOCKER_INTEGRATION` 的真实 Docker 用例 |
| 同上 Docker 门禁另跑（`SKILLS_DOCKER_INTEGRATION=true`，`SANDBOX_IMAGE=mastra-agent-sandbox:1.0@sha256:e4cbba692d0ee123704f9fb3ed9508fb9cecb66cfe5603890cc891096b13f937`，独立临时 `WORKSPACE_ROOT`/`SKILLS_STORAGE_ROOT`） | **7 / pass 7 / fail 0 / skipped 0**（约 12s） |
| `npm test --prefix web -- src/agent/skills --maxWorkers=2` | **10 files / 27 pass** |
| `npm test --prefix web -- --maxWorkers=2`（修复 AgentPage mock 之后） | **54 files / 378 pass / 0 fail** |
| `npm test`（无 `--env-file`） | **448 tests / pass 365 / fail 48 / skipped 35**。相对 Task 0（336/269/48/19）：失败数仍是 48，新增的是 skills 用例（+96 pass、+16 skip）。失败仍是磁盘保护（宿主约 91% > `WORKSPACE_DISK_BLOCK_RATIO` 0.9）。名单与 Task 0 同一类；其中 `edit tool workspace scope uses encoded applicationPath and rejects stale etag` 在 Task 0 已归入该类 |
| `npm run build:web` | **exit 0**（tsc + vite） |
| `npm run build:mastra` | dev 正在跑，未在仓库内构建。临时副本 `/tmp/nero-mastra-build-*` 执行同一 script：**Build successful**，`LIVE_MASTRA_STILL_PRESENT`，随后删除临时目录 |

### 21.2 本次为让回归命令通过而改的点

| 问题 | 处理 |
| --- | --- |
| `skills-script-runner` 在带 `.env` 时用假用户写入 `app_workspaces` / `app_sandbox_instances` | 该文件是 FakeEngine 单测，模块内删除 `DATABASE_URL`，避免打进本地库 |
| `skills-runtime`：无授权时 `getManageDetail` 返回 `SKILL_UNAVAILABLE`（避免枚举）；cleanup 未删 run pin | 断言改为无授权=`SKILL_UNAVAILABLE`、授予 use 后看草稿=`FORBIDDEN`；删除 pin/shortcut/sync 后再删技能 |
| `build:web`：`AgentChat.test.tsx` 的 `useState` 把模型 ref 收成字面量 | 改为 `useState<ModelRef>` |
| 全量 Vitest：`AgentPage` 调用 `listAvailableSkills().then`，mock 的 `vi.fn()` 返回 undefined | mock 改为直接 `Promise.resolve` |

### 21.3 V1–V12

| 编号 | 本次证据 | 结论 |
| --- | --- | --- |
| V1 | 集成测试：普通身份可加载已授权指令；admin 无 use 时 load=`SKILL_UNAVAILABLE`。Docker：跨用户读产物失败。未给普通用户开管理员 Workspace | **自动化通过**。浏览器里用无管理员 Workspace 的账号操作：**未验收** |
| V2 | `skills-http` 身份矩阵；伪造 execution id 不成为 pin。未登录/猜 ID 由 HTTP 测试覆盖 | **自动化通过** |
| V3 | provider mock：目录注入、显式选择在请求前加载、未授权正文不出现 | **自动化通过**（模型 HTTP 为 mock）。真实模型是否选对技能：**未验收** |
| V4 | 同 run pin v1、新 run 取 v2；suspend/resume 保持 pin；Docker 挂载在指针切到 v2 时仍读 v1 | **自动化通过** |
| V5 | runtime：禁用/撤权/删除后 load/read/search=`SKILL_UNAVAILABLE`。Vitest：撤权后入口/保存态 | **自动化通过**。页面刷新后入口消失：**未验收** |
| V6 | publish/storage：中途失败旧指针不变；并发发布一胜 | **自动化通过**（本地 PostgreSQL `127.0.0.1:5433/nero_agent`） |
| V7 | package：路径穿越、symlink、ZIP 超额、大小写/NFC 碰撞在写入前拒绝 | **自动化通过** |
| V8 | Docker：`result.csv` 可读、`/skill` 只读、abort 后无 `nero.skill-run=1`、非零/超时/截断在 FakeEngine 单测 | **真实 Docker 覆盖产物、只读、中止、清理**。超时与非零退出码的真实容器：**未单独再跑**（单测为 FakeEngine） |
| V9 | runtime 报告：缺工具=`missing-tools`，requests/curl=`network-unavailable`。Docker：`network none` 外网不可达 | **自动化通过**。未在无网容器里用重试伪装成功 |
| V10 | concurrency：保存/发布 CAS；sync：未选 delete 不删、撤权后不能提交、409/410 | **自动化通过** |
| V11 | long-conversation（mock）：压缩不丢正文、不换 pin；禁用后不注入 | **自动化通过**。真实模型长会话、浏览器重开历史：**未验收** |
| V12 | Vitest：选择、发送失败恢复、附件与技能同发；全量 Vitest 中图表与 Mermaid 用例通过 | **组件测试通过**。桌面与 390px 浏览器：**未验收** |

### 21.4 四阶段门禁

| 门禁 | 自动化 | 真实环境 |
| --- | --- | --- |
| A 运行时（Task 0–5） | skills 集成 / pin / processor mock 通过；默认 `AGENT_SKILLS_ENABLED` 仍关闭 | 真实模型 6×3 会话：**未验收** |
| B 脚本（Task 6–7） | 容器策略单测 + 本次 Docker 7/7 | 镜像 digest 见上。参考项目里的网络/内部业务包：**未支持**，不能用 script-demo 代替 |
| C 管理（Task 8–10） | HTTP 身份矩阵、管理/并发、管理页 Vitest、`build:web` | 浏览器创建/发布/启停/回滚：**未验收** |
| D 会话与同步（Task 11–14） | picker/shortcut/sync Vitest；reconcile/GC/长会话 mock | 浏览器同步与窄屏、真实模型长会话、备份恢复演练：**未验收** |

不能宣称 A–D 已全部按设计对齐：浏览器、真实模型评估、备份恢复都未跑。

### 21.5 参考包与模型评估

| 项 | 状态 |
| --- | --- |
| 6 任务 × 3 次新会话（固定模型） | **未验收**。未调用真实模型，无 18 条记录 |
| 从 `tc-prime-ai` 迁移一个纯指令包和一个离线脚本包 | **未验收**。仓库内只有 `tests/fixtures/skills/reference-demo` 与 `script-demo`，不是参考项目业务包 |
| 外网 / 内部业务技能 | **未支持**。不开放容器网络，不注入用户令牌，不在对话中 pip/npm |

### 21.6 与设计的差异（实现相对 spec）

| 点 | 说明 |
| --- | --- |
| 执行钉定 | 本机 Mastra 1.71.0 没有 `ctx.agent.runId`；`processInputStep.runId` 常为 undefined。应用用 WeakMap `bindSkillServerExecutionId`，并与 `generate`/`resumeGenerate` 的 `runId` 对齐 |
| `user-invocable` | `listAvailable` 目前固定 `userInvocable: true`，没有读 frontmatter。前端会隐藏 `false`，但接口还不会发出 `false` |
| 无授权看管理详情 | 返回 `SKILL_UNAVAILABLE`，避免把私有技能是否存在告诉陌生人。已有 use、不能看草稿时才是 `FORBIDDEN` |
| 快捷接口 | 增加 `GET /:id/shortcut` 供编辑回读。012 对已存在表补了 `skill_id` 唯一索引 |
| ZIP | 打开 `checkSignature`，错误 CRC 为 422 `ZIP_INVALID` |
| 镜像引用 | 本地 `name@sha256:<imageId>` 会解析成 `sha256:<id>`，避免误 pull。生产仍应使用 registry digest |
| 组织授权 | 无 `deptId`，用授权组。未对接 OA |
| 原生 skills 工具 | 未配置 `Agent.skills` 自动工具 |
| 沙箱注册表 | `SandboxRegistry.upsert` 的 INSERT 仍未写 `scope_id`。带 `DATABASE_URL` 的真实沙箱登记会违反非空约束。本次只让技能脚本单测不再误入该路径，**没有**改注册表 |

### 21.7 自检

- [x] 未 git commit / push / merge
- [x] 未把未跑项勾成通过
- [x] 未终止 `npm run dev`，未删除其 `.mastra`
- [ ] 浏览器桌面 / 390px
- [ ] 真实模型 18 次
- [ ] 备份恢复演练
- [ ] 参考项目技能包迁移


## 22. 审查九项问题修复（2026-10-19）

详细实现与证据见 [Skill 九项审查问题修复记录](skills-nine-fixes-verification.md)。本轮补齐授权回读、GC跨实例协调与新快照、pin失败关闭、类型检查、资源运行声明、自动加载恢复、完整分页核权、显式存储配置和锁内版本限额。

- 技能后端：125 tests / 119 pass / 0 fail / 6默认Docker skip；真实Docker另外7/7通过。
- 前端全量：54 files / 382 pass；此前资源竞争导致的Mermaid超时已在无构建竞争的单worker重跑中消失，未增加超时。
- 根目录全量：459 tests / 373 pass / 48 fail / 38 skip，48项为既有磁盘保护相关失败。
- 根目录 `tsc --noEmit`：无诊断。前端构建、隔离后端构建均通过。
- 新增013恢复查询索引，部署需 `npm run db:migrate`；本地已应用。
- 仍未执行真实模型18次评估和浏览器全流程；不能据本轮修复宣称原设计所有真实环境门禁已全部验收。
