# 定时任务与会话来源分类设计

日期：2026-10-15

## 目标与范围

将 Agent 左侧栏底部的“设置”改成可展开的“管理”，并在会话区加入“历史／调度”切换。管理菜单首批提供“定时任务”“外观”“退出登录”；后续菜单可在同一结构中增加。定时任务页参考 `tc-prime-ai-datax` 的卡片、编辑弹窗和执行日志布局，支持 Cron 任务的创建、编辑、启停、手动触发、删除与日志查看。每次触发创建一条独立会话，来源标为 `schedule`，并出现在“调度”列表；既有普通会话出现在“历史”。

首期只实现 Cron 触发。参考页面的“项目回调”“主动查询”、轻流审批、项目关联、外链等依赖另一平台的业务系统，不在本期复制。任务类型保留可扩展字段，但页面只显示已经实现的类型。每个用户只管理自己的任务和会话；沿用当前 Agent 仅向管理员提供定时任务工具的权限边界，管理页首期也仅向管理员开放。普通用户仍可查看自己的普通历史；若存在归属其名下的旧调度会话，则可在“调度”查看。扩大任务创建权限需单独评估后台工具权限。

## 代码现状与参考依据

- 本仓库 `web/src/agent/ThreadSidebar.tsx` 负责左侧会话列表，`ModelSettingsMenu.tsx` 负责底部设置，`AgentPage.tsx` 是聊天、会话列表与路由的交汇点，`web/src/App.tsx` 目前只有 `/agent/:threadId` 路由。
- `web/src/agent/thread-scope.ts` 逐页读取当前用户的 Mastra threads，既有数据没有来源分类；`use-thread-list.ts` 创建普通 thread 时写入模型 metadata。
- `src/mastra/tools/schedule-tools.ts` 已注册 `start_schedule` 和 `stop_schedule`，但前者将 schedule 绑定调用时所在 thread，没有任务管理、独立的每次执行会话或完整所有权检查。`src/mastra/index.ts` 注册工具、路由与 PostgreSQL Mastra storage；新增路由、工具或工作流仍在此注册。
- 参考项目 `tc-prime-ai-datax/apps/web/src/components/AppShell.tsx` 使用底部展开管理与“历史／调度”切换；其 `ScheduledTasksPage.tsx` 使用任务卡片、创建编辑弹窗、启停、触发与日志抽屉。
- 参考后端 `tc-prime-ai` 的 `DynamicTaskManager`、`DynamicTaskExecutor`、`CronSkillTaskHandler` 与 `HarnessChatBootstrapServiceImpl` 是数据库配置、定时触发、启动新会话、标记 `SCHEDULE` 来源、记录执行日志的链路。本项目复用行为，不移植 Java 调度器或其项目体系。
- 已读取本仓库 `.claude/skills/mastra/SKILL.md`，并核对安装版本 `@mastra/core@1.71.0` 的嵌入文档：`mastra.schedules` 可创建、列出、更新、暂停、恢复、立即运行、删除任务；`prepare` 可覆盖单次触发的 `threadId/resourceId/ifIdle`，`onFinish/onError/onAbort` 可处理结果。该 API 仍标注 Beta，实施时以安装包类型和验证结果为准。

## 方案选择

1. **推荐：Mastra schedules 负责触发，应用服务负责任务归属、会话创建和日志。** 与现有 PostgreSQL storage、Mastra Agent 和已注册工具一致，避免另建轮询进程。应用表保存面向用户的任务配置与执行记录，Mastra schedule ID 关联触发器。
2. 移植参考项目的数据库扫描和独立调度器。这能逐字模拟原后端，但会与本仓库已有的 Mastra scheduler 重叠，增加多实例锁、重启恢复和状态同步成本。
3. 让前端直接调用 Mastra 原生 schedule API。页面实现较快，但原生接口不提供本项目所需的任务归属、逐次新会话和执行审计边界，不能作为用户管理入口。

采用方案 1。服务器端 API 是唯一的任务管理入口；页面和 Agent 工具调用同一个应用服务。

## 数据模型与所有权

新增迁移，建立 `agent_scheduled_tasks` 与 `agent_scheduled_task_runs` 两张 PostgreSQL 表。任务表字段至少包括：`id`、`owner_user_id`、`mastra_schedule_id`（唯一）、`name`、`task_type`（本期固定 `cron`）、`cron`、`timezone`、`prompt`、`chat_model_ref`、`memory_model_ref`、`starts_at`、`ends_at`、`status`（`active/paused/deleted`）、`created_at`、`updated_at`。执行表字段至少包括：`id`、`task_id`、`owner_user_id`、`trigger_kind`（`cron/manual`）、`fired_at`、`thread_id`、`status`（`preparing/running/succeeded/failed/aborted/skipped`）、`run_id`、`error_summary`、`finished_at`。任务删除采用应用层软删除，同时删除 Mastra schedule；日志与已创建的会话保留。任务所有者及执行表关联不接受前端自报值。

普通 thread metadata 明确写入 `neroAgentSourceType: 'default'`；调度 thread 写入 `neroAgentSourceType: 'schedule'`、`neroAgentScheduleTaskId`、`neroAgentScheduleRunId`，并沿用 `neroAgentModels` 模型设置。没有来源字段的既有 thread 按 `default` 读取，不对所有旧会话做批量迁移。调度 thread 的 `resourceId` 始终是任务所有者的用户 UUID，标题为“定时任务：{任务名}”；页面与后端不得仅靠标题判断来源。执行日志中的 `thread_id` 供“打开会话”跳转。

## 后台触发与身份上下文

创建或编辑任务时，应用服务校验管理员身份、任务归属、Cron、IANA 时区、生效时间范围、非空提示词及当前用户可使用的模型。保存任务配置并创建或更新对应 Mastra schedule。Mastra 只保存触发需要的数据及稳定的任务 ID；应用表是页面配置的来源。更新任务时先校验新配置，再更新触发器与应用表；任何一侧失败要返回可重试错误并记录不一致状态，不能向用户宣称保存成功。启动时检查应用表与 Mastra schedule 的状态差异并修复或报告，避免停用状态漂移。

自动与手动触发共用执行链路。`prepare` 根据 schedule ID 查任务，确认仍启用、未删除且处于生效范围；超出范围返回 `null` 并记为 `skipped`。任务所有者必须在运行时从数据库重新读取，不能信任客户端提交的用户对象或可编辑 schedule metadata。用户不存在、权限已撤销或模型不可用时记录失败，不创建空会话。校验通过后创建本次专用 Mastra thread，写入来源、任务、运行标识与模型 metadata；返回新 `threadId/resourceId`、唤醒行为与经过服务端重建的 request context，使 `trustedUser` 和模型解析在后台运行时可用。应用服务不得把持久化的任意 JSON 直接作为 `mastra__user`。这部分要针对已安装 Mastra 版本做集成验证，因为当前 Agent 的模型、内存和工具解析均依赖 request context。

运行完成、失败或中止由 hooks 更新对应执行记录。`onFinish` 的 `delivered/persisted/discarded/skipped` 与 `succeeded` 语义不同：只有真正完成 Agent 运行才显示“成功”；尚未运行完成的状态不得提前计作成功。日志记录时间、触发类型、状态、耗时、会话链接和简短错误，不保存敏感 prompt、工具结果或密钥。任务可并发触发时每次运行有独立记录与 thread；重试同一次 scheduler trigger 不应重复创建会话，需以稳定触发标识或执行 claim 做幂等控制。默认不自动补跑停机期间错过的触发。

当前 `start_schedule` 和 `stop_schedule` 工具改为调用同一任务服务，并保持工具在 `src/mastra/index.ts` 注册。Agent 创建的任务因此能在管理页出现。既有工具直接创建的 Mastra schedule 不属于新表：迁移时按其 `resourceId` 和目标 thread 做归属核查，无法可靠归属的项目列入管理员迁移报告；不自动改写其触发目标或删除。已确认归属的旧任务可导入并明确标记旧执行模式，待用户编辑后切换到每次新会话模式。

## API 与访问控制

新增应用路由，例如 `GET/POST /api/agent-scheduled-tasks`、`GET/PATCH/DELETE /api/agent-scheduled-tasks/:id`、`POST /:id/pause`、`POST /:id/resume`、`POST /:id/run`、`GET /:id/runs`。列表支持分页与任务名查询；结果按最近更新排序，执行日志按触发时间倒序。所有接口从服务端认证上下文取用户 ID 与角色，按任务所有者过滤和校验；不存在与他人任务都返回不泄露详情的 404。写入接口限制请求大小、字段类型和分页上限。前端不直接调用 Mastra 原生 schedule CRUD；需在现有 server middleware 中拦截或加强 `/api/schedules` 的用户访问控制，避免绕过应用接口操作其他用户的 schedule。Studio 管理员通道与普通用户通道分别验证。

## 前端交互

左侧栏中，品牌与“新建会话”保留。历史区顶部显示“历史／调度”切换，切换仅改变列表数据视图，不删除当前会话；当前选中的 thread 若不属于所选来源，列表中不强行显示。搜索索引仅针对当前来源，切换时取消或忽略旧来源的在途搜索结果。列表仍可按时间分组或平铺，原有重命名、删除和空态保持。管理区固定在左侧栏底部，点击“管理”展开子菜单；当前子页面高亮，键盘可操作，展开状态在页面导航后保持。“外观”继续提供浅色/深色切换，“退出登录”沿用现有确认弹窗。

`/scheduled-tasks` 页面保留左侧栏与用户会话。顶部显示标题、任务数量、刷新和“新增任务”；正文有名称搜索、Cron 任务卡片、状态、生效范围、下次触发、上次触发与执行次数。卡片操作为编辑、启停、立即运行、查看日志、删除；编辑弹窗提供任务名、提示词、日/周/月/自定义 Cron、时区、生效范围和模型选择。页面直接复用本项目的样式、组件与登录态，不引入参考项目的 Ant Design 或业务 API 包。调度列表会话可像普通会话一样打开，但显示任务来源信息；后台尚在运行时列表刷新后能看到新 thread。

## 错误与一致性

- Cron 无效、时区无效、结束早于开始、提示词为空、模型无权限：保存前拒绝并指出字段。
- 后台缺少用户、用户已失权、模型被禁用、存储/调度器故障：执行日志记录失败或跳过，页面显示可理解状态；不重复创建空 thread。
- 手动触发采用 Mastra `schedules.run`，不改变 Cron 或启停状态；暂停任务是否允许手动触发由应用服务统一决定，本期为“不允许”，页面禁用触发按钮。
- 删除任务前给出确认；删除后未来不再触发，已生成的会话和日志可追溯。删除会话不删除任务；日志中对应会话若已删除，显示“会话已删除”而不是失效链接。
- 在实现时核对 Mastra hooks 的并发、幂等和最终状态语义；Beta API 行为与文档不一致时以安装包类型、源码和集成测试结果调整实现。

## 验收标准

1. 左侧“管理”可展开；“定时任务”“外观”“退出登录”可用，路由往返后选中状态正确。“历史／调度”只展示各自来源；旧无来源会话仍在历史。
2. 管理员能创建、编辑、暂停、恢复、手动触发和删除自己的 Cron 任务；页面展示下一次触发、执行次数和分页日志。普通用户不能打开任务管理接口或通过原生 Mastra schedule API 绕过限制。
3. 每次自动或手动触发都产生一条归属正确、来源为 `schedule` 的新会话；历史与调度搜索和列表不串类，日志能打开对应会话。
4. 后台运行使用任务所有者的真实身份与可用模型；用户失权或模型被禁用时任务失败可见，不能以其他身份运行。
5. 重启后有效任务仍执行，暂停/删除任务不再自动触发；多实例、并发和重试不会把同一次触发重复写成多条会话。
6. 项目已有测试、`npm test`、`npm run build` 与 `git diff --check` 通过；构建使用 `package.json` 脚本，不直接运行 `mastra build`。
