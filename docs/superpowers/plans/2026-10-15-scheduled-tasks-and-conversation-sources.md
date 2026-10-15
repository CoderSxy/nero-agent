# 定时任务与会话来源分类 Implementation Plan

> **For Cursor:** 按任务顺序执行；每项先写能失败的测试，再实现、验证并提交。先读本计划的 Spec 与仓库 `AGENTS.md`、`.claude/skills/mastra/SKILL.md`。不要根据旧版 Mastra 记忆写 API；以本仓库 `node_modules/@mastra/*/dist/docs` 和类型为准。Cursor 可以在同一工作区逐项执行，无需创建子任务或改用其他执行器。

**Goal:** 把侧栏改为“历史／调度”会话切换和可展开“管理”，并交付由 Mastra schedules 驱动、每次运行生成独立调度会话的 Cron 任务管理功能。

**Architecture:** PostgreSQL 应用表保存任务所有权、页面配置与运行记录；Mastra schedules 负责持久化触发。服务端统一处理页面、Agent 工具、后台 hooks 的任务操作，`prepare` 为每次触发创建独立 thread，前端按 thread metadata 分类。

**Tech Stack:** TypeScript 6、Mastra `@mastra/core@1.71.0`、PostgreSQL、React 19、React Router 7、Node test runner、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-15-scheduled-tasks-and-conversation-sources-design.md`

## Global Constraints

- 所有新增 Mastra 工具、路由、agents、workflows、scorers 在 `src/mastra/index.ts` 注册；构建和开发用 `package.json` 的 `npm run build`、`npm run dev`，不能直接运行 `mastra build/dev`。
- 首期仅实现 Cron；不引入 Ant Design、`tc-prime-ai` 的 Java 调度器、项目回调、主动查询、轻流审批或参考项目业务包。
- 管理接口仅管理员可用且只能访问本人任务；无来源 metadata 的旧 thread 属于 `default`。旧原生 schedules 不自动删除或改写。
- 时区存 IANA 名称；手动触发不改变周期与启停状态；暂停任务不能手动触发；删除任务后保留日志与已生成会话。
- 调度运行时从数据库重新取得所有者和模型权限；不能信任页面或 schedule metadata 携带的完整用户身份。
- 最终运行 `npm test`、`npm test --prefix web`、`npm run build`、`git diff --check`，记录任何已有无关失败。

## Review Focus

1. 同时点击两次“立即运行”：同一任务只接受一次在途手动请求；测试放在任务服务 Task 2。
2. 同一 Cron 时段被多实例重复投递：执行 claim 唯一且只生成一个 thread；测试放在 hooks Task 3。
3. 模型在保存后被停用或所有者失去管理员角色：记录失败、不以旧身份运行；测试放在 hooks Task 3。
4. 切换“历史／调度”时旧搜索请求稍后返回：不得将旧来源结果显示到新来源；测试放在前端分类 Task 6。
5. 用户访问他人的任务 ID 或绕过应用 API 调用原生 `/api/schedules`：不能读取或修改；测试放在路由 Task 4。

## 文件职责图

| 文件 | 职责 |
| --- | --- |
| `migrations/009_agent_scheduled_tasks.sql` | 任务、运行记录、唯一 claim 与查询索引 |
| `src/mastra/scheduled-tasks/types.ts` | 服务端输入、DTO、状态类型 |
| `src/mastra/scheduled-tasks/repository.ts` | 参数化 SQL，仅操作应用表 |
| `src/mastra/scheduled-tasks/validation.ts` | Cron、时区、时间范围、模型校验 |
| `src/mastra/scheduled-tasks/service.ts` | 用户任务 CRUD、手动触发、同步 Mastra schedule |
| `src/mastra/scheduled-tasks/hooks.ts` | prepare、完成/错误/中止记录、每次新 thread |
| `src/mastra/scheduled-tasks/routes.ts` | 带身份与归属校验的管理 API |
| `src/mastra/scheduled-tasks/native-guard.ts` | 阻断普通用户直接操作原生 schedule API |
| `web/src/agent/thread-source.ts` | 从 metadata 读取来源并筛选 |
| `web/src/agent/scheduled-tasks-api.ts` | 页面 API 与安全 DTO |
| `web/src/agent/ScheduledTasksPage.tsx` | 任务列表、编辑、日志 UI |

## 执行规则

每完成一项，Cursor 提供测试命令及实际结果、提交 SHA、与 Spec 的偏差。若 Mastra 集成测试证明 `prepare`、`sendSignal` 或后台 request context 无法按本文方式运行，停止这条实现链路，记录安装版本的类型/源码证据，再调整本计划及 Spec；不要悄悄改成复用原聊天 thread 或前端定时器。不要做无关重构。

当前安装版本的 schedule hook 只收到 `trigger.kind/firedAt`，不直接收到 worker 的 `claimId/scheduledFireAt`；`firedAt` 是实际投递时间。Cron 同时段去重可用计划触发时段作为应用 claim，但跨越下一 Cron 时段的延迟重投无法仅由 hook 精确识别。Task 3 必须实测 Mastra 自身对同一 claim 的重投保障；若仍可能重复创建会话，暂停实施并提交可验证的 Mastra worker 扩展或设计修订，不能把近似时间窗去重说成严格幂等。

---

### Task 1：持久化结构与 Repository

**Files:** Create `migrations/009_agent_scheduled_tasks.sql`, `src/mastra/scheduled-tasks/types.ts`, `src/mastra/scheduled-tasks/repository.ts`, `tests/scheduled-tasks-repository.test.ts`。

**Interfaces:** `TaskInput = { name: string; cron: string; timezone: string; prompt: string; chatModelRef?: string; memoryModelRef?: string; startsAt?: string | null; endsAt?: string | null }`；`ScheduledTask` 在此基础上有 `id/ownerUserId/mastraScheduleId/status/createdAt/updatedAt`；`ScheduledTaskRun` 有 `id/taskId/ownerUserId/triggerKind/occurrenceKey/firedAt/threadId/status/runId/errorSummary/finishedAt`。对页面的 `TaskDto` 再加 `nextFireAt/lastFireAt/execCount`；`RunDto` 不返回原始 prompt 或内部错误栈。Repository 导出 `insertTask(ownerId, input, db?)`、`getTask(id, ownerId, db?)`、`listTasks(ownerId, query, db?)`、`updateTask(id, ownerId, patch, db?)`、`claimRun(taskId, kind, occurrenceKey, firedAt, db?)`、`finishRun(runId, patch, db?)`、`listRuns(taskId, ownerId, page, db?)`。可沿用 `models/repository.ts` 的 `Queryable` 写法。ID 用 UUID；运行 claim 对 `(task_id, trigger_kind, occurrence_key)` 唯一；`mastra_schedule_id` 唯一；owner 引用 `app_users(id)`。运行表保留已删除任务的外键记录。Cron 的 `occurrenceKey` 用时区与 Cron 计算出的计划触发时段，不能用 worker 的 `trigger.firedAt`（它是每次投递的实际时间）。手动触发用应用服务生成的请求 UUID，且同任务仅允许一个待执行手动请求。

- [ ] 写数据库测试：插入 A/B 用户任务，A 的列表不包含 B，A 读取 B 的 ID 返回空；同一 claim 第二次不新增运行；按页列运行记录，软删除后日志仍存在。
- [ ] 若本地尚无数据库，先运行 `npm run db:local:setup`；运行 `node --env-file-if-exists=.env --import tsx --test tests/scheduled-tasks-repository.test.ts`，确认新测试因缺少表/函数失败，而不是因 `DATABASE_URL` 缺失被跳过。
- [ ] 实现迁移、类型和参数化 SQL，运行 `npm run db:migrate` 应用迁移；DB 不可用时测试按既有 `DATABASE_URL` skip 约定，不能在 CI 中假装通过数据库断言。
- [ ] 重跑新测试、`npm run test:db` 与 `git diff --check`，均通过后提交 `feat: persist scheduled tasks and runs`。

### Task 2：输入校验与任务服务基础

**Files:** Create `src/mastra/scheduled-tasks/validation.ts`, `src/mastra/scheduled-tasks/service.ts`, `tests/scheduled-tasks-service.test.ts`；Modify `src/mastra/auth/service.ts` 添加 `getActiveUserById(id: string): Promise<AuthUser | null>`。

**Interfaces:** `validateTaskInput(input: unknown, owner: AuthUser): Promise<TaskInput>`；`ScheduleDriver = Pick<Mastra['schedules'], 'create' | 'get' | 'update' | 'pause' | 'resume' | 'run' | 'delete' | 'list'>`；`createScheduledTaskService(driver: ScheduleDriver)` 返回 `create(owner,input)`、`edit(owner,id,input)`、`pause(owner,id)`、`resume(owner,id)`、`run(owner,id)`、`remove(owner,id)`、`list(owner,query)`、`runs(owner,id,page)`。模型 ref 用现有 `findAuthorizedModel` 校验；缺省模型明确解析为当前公共默认模型并保存两个 ref。任务 ID 作为 Mastra schedule metadata 的 `appTaskId`，保存后记录返回的 schedule ID。

- [ ] 写纯单元测试：非管理员拒绝；空 prompt、非法 Cron/时区、反向时间范围、无权限模型拒绝；他人 ID 对所有动作返回同一种 404；两次同时手动运行仅一次调用 `driver.run`；暂停任务手动运行拒绝。
- [ ] 运行 `node --import tsx --test tests/scheduled-tasks-service.test.ts`，确认失败。
- [ ] 实现校验和服务；服务操作需可注入 driver/repository 以便测试。创建先写 `paused` 应用行，再创建 Mastra schedule，成功后激活应用行；失败补偿清理双方。编辑、启停、删除一侧失败时保持明确的待修复状态并报告错误，不返回成功。
- [ ] 重跑测试、`npm run build`，通过后提交 `feat: add scheduled task service`。

### Task 3：Mastra 单次调度运行与身份上下文

**Files:** Create `src/mastra/scheduled-tasks/hooks.ts`, `tests/scheduled-tasks-hooks.test.ts`；Modify `src/mastra/agents/memory-model.ts`, `src/mastra/index.ts`。

**Interfaces:** `createScheduledTaskHooks(): SchedulesConfig<Mastra>`，并在 `new Mastra({ schedules: createScheduledTaskHooks(), ... })` 注册。`prepare` 只处理带有效 `appTaskId` 且属于本应用的 agent schedules，其他原有 schedule 维持默认行为。`getActiveUserById` 再查真实用户及角色；用任务模型 ref 验证授权，创建 `title='定时任务：' + name` 的 thread，metadata 写 `neroAgentSourceType='schedule'`、`neroAgentScheduleTaskId`、`neroAgentScheduleRunId`、`neroAgentModels`。返回单次 `threadId/resourceId` 以及 `ifIdle: { behavior: 'wake', streamOptions: { requestContext: { mastra__user: resolvedUser, 'nero-agent.chat-model-ref': chatRef, 'nero-agent.memory-model-ref': memoryRef } } }`。这些值只由服务器重建。

- [ ] 写 hooks 测试：触发创建独立 thread 和运行记录；同一 claim 幂等；超出生效范围记 skipped；所有者失活/失去管理员角色或模型失效记 failed 且没有 thread；完成/失败/中止更新状态；旧无 `appTaskId` schedule 不受影响。
- [ ] 运行 `node --import tsx --test tests/scheduled-tasks-hooks.test.ts`，确认失败。
- [ ] 实现 hooks 与运行记录；特别核对 `node_modules/@mastra/core/dist/worker-*.js`：当前 worker 在 `sendSignal` 前先执行无 request context 的 `agent.getMemory()`。给 `memoryForRequest` 增加**仅针对缺失 request context 的只读 thread 存在性检查**所需的安全公共默认 memory 路径，正常请求仍必须经 `trustedUser` 校验；如库行为无法隔离此路径，停止并修订设计。
- [ ] 增加真实安装版本的集成测试：用 Mastra schedules 手动触发测试任务，断言 worker 走 `prepare` 后的新 thread、Agent 使用正确用户/模型上下文，且最终日志状态不早于实际运行结束。以 `node --env-file-if-exists=.env --import tsx --test tests/scheduled-tasks-hooks.test.ts` 运行；若需要真实模型，使用可控测试模型，不调用生产模型或外部网络。
- [ ] 测试、`npm run build:mastra` 通过后提交 `feat: run schedules in isolated owned threads`。

### Task 4：任务 API 与原生路由保护

**Files:** Create `src/mastra/scheduled-tasks/routes.ts`, `src/mastra/scheduled-tasks/native-guard.ts`, `tests/scheduled-tasks-routes.test.ts`；Modify `src/mastra/index.ts`。

**Interfaces:** 注册 `GET/POST /agent-scheduled-tasks`，`GET/PATCH/DELETE /agent-scheduled-tasks/:id`，`POST /:id/pause`、`/:id/resume`、`/:id/run`，`GET /:id/runs`。请求/响应 DTO 在 `types.ts` 固定；`GET` 支持 `page=1..`、`pageSize=1..50`、`q`；`runs` 同样分页。使用路由 `requestContext.get('user')` 取得身份，不接收 `ownerId`。原生 `/api/schedules` 的 CRUD 对普通应用请求返回 403，仅经过 Studio 管理员认证的请求按现有 Studio 规则放行；不得信任单独的 `x-mastra-client-type` 标头。

- [ ] 写 Hono 路由测试：未登录 401、普通用户 403、管理员 A/B 相互隔离、非法 body 400、过大 body 400、分页上限 400、他人 ID 404；直接访问原生 schedule 的 GET/POST/PATCH/DELETE/run/pause/resume 均被拦截，伪造 Studio 标头仍被拦截。
- [ ] 运行 `node --import tsx --test tests/scheduled-tasks-routes.test.ts`，确认失败。
- [ ] 实现路由和 middleware，放入 `src/mastra/index.ts` 的 `apiRoutes/middleware`；写操作只通过 Task 2 服务。确认路由顺序与 `/api` 前缀符合现有 Mastra 服务器。
- [ ] 重跑新测试、既有 `tests/model-routes.test.ts`、`npm run build`，通过后提交 `feat: expose owned scheduled task API`。

### Task 5：现有 Agent 工具与旧 schedule 兼容

**Files:** Modify `src/mastra/tools/schedule-tools.ts`, `src/mastra/index.ts`；Create `src/mastra/scheduled-tasks/legacy.ts`, `tests/schedule-tools.test.ts`, `tests/scheduled-tasks-legacy.test.ts`。

**Interfaces:** `start_schedule` 仍接收 `schedule/prompt`，可增加可选 `name/timezone`，返回应用任务 ID 与状态；`stop_schedule` 接受应用任务 ID，并可识别旧 Mastra schedule ID。工具从 Agent 的可信 request context 取所有者，经 Task 2 服务创建/暂停。`auditLegacySchedules(driver)` 只读列出无 `appTaskId` 的 agent schedules，按已有 `resourceId/threadId` 核对归属，返回可导入/不可确定清单；导入必须是显式管理步骤，不能修改旧执行目标。

- [ ] 写测试：工具创建的任务出现在服务列表；普通用户不能借工具绕过管理员限制；他人/未知 schedule ID 不能暂停；旧 schedule 审计不会删除或改写任何记录。
- [ ] 运行 `node --import tsx --test tests/schedule-tools.test.ts tests/scheduled-tasks-legacy.test.ts`，确认失败。
- [ ] 改工具调用统一服务并实现只读审计。若旧 schedule 没有可信归属信息，保留原状并在文档写明人工处理，不猜测用户。
- [ ] 测试、`npm run build` 通过后提交 `feat: unify agent schedule tools with task service`。

### Task 6：会话来源、筛选与搜索隔离

**Files:** Create `web/src/agent/thread-source.ts`, `web/src/agent/thread-source.test.ts`；Modify `web/src/agent/use-thread-list.ts`, `web/src/agent/thread-scope.ts`, `web/src/agent/use-history-search.ts`, `web/src/agent/ThreadSidebar.tsx` 及对应测试。

**Interfaces:** `type ThreadSource = 'default' | 'schedule'`；`sourceOfThread(metadata: unknown): ThreadSource`，缺失或未知值按 `default`；`filterThreadsBySource(threads: Thread[], source: ThreadSource): Thread[]`。`useThreadList.createThread` 写 `neroAgentSourceType='default'`。`ThreadSidebar` 新增 `source`、`onSourceChange`；当前来源的列表、时间分组、搜索与空态一致。调度执行期间通过现有 `refresh()` 或轻量刷新机制获取新 thread。

- [ ] 写测试：旧无标记 thread 属于历史；明确 `schedule` 的 thread 只在调度；普通新 thread 写 `default`；切换后旧搜索请求返回不会污染新来源结果；跨来源删除当前 thread 的导航不误跳到隐藏会话。
- [ ] 运行 `npm test --prefix web -- src/agent/thread-source.test.ts src/agent/ThreadSidebar.test.tsx src/agent/use-history-search.test.tsx`，确认新增断言失败。
- [ ] 实现来源读取、分类与搜索请求 generation 隔离；当前来源由 `AgentPage` 持有并传给侧栏，页面刷新后默认历史。
- [ ] 重跑相关测试和 `npm run build:web`，通过后提交 `feat: separate history and scheduled conversations`。

### Task 7：管理菜单、路由与共享侧栏

**Files:** Create `web/src/agent/AgentShell.tsx`（共享侧栏与 `Outlet`）、`web/src/agent/ManageMenu.tsx`；Modify `web/src/agent/AgentPage.tsx`, `web/src/agent/ModelSettingsMenu.tsx`, `web/src/App.tsx`, 相关 CSS 与测试。

**Interfaces:** `AgentShell` 作为 `/agent/:threadId` 和 `/scheduled-tasks` 的父路由，持有当前用户的 `useThreadList`、侧栏来源、主题与底部管理状态，通过 `Outlet context` 向 `AgentPage` 提供这些值；`AgentPage` 保留聊天/文件/模型逻辑，不再自行创建第二份会话列表。`AgentShell` 使用现有左右面板尺寸规则。`ManageMenu` 的 entries 为稳定数组，首期为 `/scheduled-tasks`、外观面板、退出登录。只允许管理员看到“定时任务”入口；对非管理员直接访问 `/scheduled-tasks` 展示无权限状态。页面切换保持管理展开状态（可由路由判定默认展开），当前子菜单高亮。现有直接渲染 `AgentPage` 的测试改为父路由包装，不加运行时的“无 context”兼容分支。

- [ ] 写组件/路由测试：点击“管理”展开/收起、键盘操作、外观和退出登录保留、管理员导航到任务页后侧栏仍在、普通用户看不到入口且直达受限、聊天页左右面板行为未退化。
- [ ] 运行 `npm test --prefix web -- src/agent/AgentPage.test.tsx src/agent/ModelSettingsMenu.test.tsx`，确认新增断言失败。
- [ ] 实现共享布局和菜单；不要为引入共享侧栏而重写 `AgentPage` 的聊天逻辑。CSS 延续当前项目的主题与响应式断点。
- [ ] 重跑测试和 `npm run build:web`，通过后提交 `feat: add expandable management navigation`。

### Task 8：定时任务页面与 API 客户端

**Files:** Create `web/src/agent/scheduled-tasks-api.ts`, `web/src/agent/ScheduledTasksPage.tsx`, `web/src/agent/ScheduledTasksPage.test.tsx`, `web/src/agent/task-cron.ts`, `web/src/agent/task-cron.test.ts`；Modify `web/src/App.tsx` 与样式文件。

**Interfaces:** `listTasks({page,pageSize,q})`、`createTask(input)`、`updateTask(id,input)`、`pauseTask(id)`、`resumeTask(id)`、`runTask(id)`、`deleteTask(id)`、`listTaskRuns(id,{page,pageSize})` 均通过 `apiFetch`。Cron 表单 `buildTaskCron(preset, timezone)` 与 `parseTaskCron(cron)` 支持日/周/月/自定义；自定义 Cron 无法解析为预设时原样显示。仅显示 Cron 标签。日志的 `threadId` 跳到 `/agent/:threadId`；缺失或已删除 thread 显示文字状态。

- [ ] 写 Cron 转换测试：日/周/月、边界日期、自定义、无效表达式、时区；写页面测试：加载/搜索/分页、创建/编辑/启停/手动触发/删除、日志与会话跳转、服务器错误、保存中防重复提交、非管理员禁用。
- [ ] 运行 `npm test --prefix web -- src/agent/task-cron.test.ts src/agent/ScheduledTasksPage.test.tsx`，确认失败。
- [ ] 实现 API 客户端和页面，借鉴参考项目的信息结构，但使用本项目组件与 CSS，不复制其业务字段、审批流或 Ant Design。
- [ ] 重跑测试与 `npm run build:web`，通过后提交 `feat: add scheduled tasks management page`。

### Task 9：一致性恢复、全链路验收与文档

**Files:** Create `src/mastra/scheduled-tasks/reconcile.ts`, `tests/scheduled-tasks-integration.test.ts`；Modify `src/mastra/index.ts` 与项目开发文档（若仓库有对应运行说明）。

**Interfaces:** `reconcileScheduledTasks(driver): Promise<{ repaired: number; failed: number }>` 比对应用表与 Mastra schedule：缺失触发器只重建有效任务，状态漂移以应用表为准修复；失败必须记录并继续处理下一项。启动阶段调用一次，不能阻塞无关路由无限期启动。旧无 `appTaskId` schedule 不进入自动修复。

- [ ] 写 DB/调度器集成测试：重启后 active 任务可触发，paused/deleted 不触发；断开后重试修复；重复 cron claim 仅一条运行和 thread；任务执行完成后日志能打开调度会话；删除会话后日志仍可读；旧 schedule 未改变。
- [ ] 运行 `node --env-file-if-exists=.env --import tsx --test tests/scheduled-tasks-integration.test.ts`，确认失败，然后实现恢复逻辑。
- [ ] 运行完整 `npm test`、`npm test --prefix web`、`npm run build`、`git diff --check`；对实际服务器做一次创建、立即运行、查看调度会话、暂停、恢复、删除的人工验收。记录测试环境、命令和结果；不能把缺少 `DATABASE_URL` 的 skip 当作数据库集成通过。
- [ ] 对照 Spec 的每项验收标准逐条勾验，修复遗漏；提交 `test: verify scheduled task lifecycle`。完成后向用户报告提交、测试、已知限制和旧任务审计结果。

## 可直接交给 Cursor 的执行提示

> 请在本仓库读取 `AGENTS.md`、`.claude/skills/mastra/SKILL.md`、`docs/superpowers/specs/2026-10-15-scheduled-tasks-and-conversation-sources-design.md` 和本计划。按 Task 1→9 顺序实施，每项先写失败测试、再实现、验证、提交；每项结束报告测试输出、提交 SHA 与偏差。遵守计划中的 Mastra 版本验证门槛和原生 schedule 权限边界。遇到已明确列出的库能力阻断时停下并给出源码/测试证据，不使用近似实现冒充通过。最后运行完整测试、构建和人工验收，逐条报告 Spec 验收结果。
