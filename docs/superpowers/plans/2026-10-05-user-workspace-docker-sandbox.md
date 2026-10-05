# Mastra 用户工作区与 Docker 沙箱实施计划

> **For agentic workers:** 按任务顺序执行，每个任务使用 `- [ ]` 跟踪。若运行环境有 `superpowers:executing-plans`，可按其流程逐项执行；本文件本身已包含 Cursor 所需的文件、接口、测试和门禁。

**Goal:** 在现有 Mastra 项目中实现可信用户身份、Thread 上下文与工作目录、用户持久 Workspace、按需 Docker 沙箱、受控执行与资源保护。

**Architecture:** 保留 PostgreSQL session auth 和 Mastra Memory，使用当前 `@mastra/core` 的动态 Workspace filesystem/sandbox resolver。项目层处理所有权、文件 API、队列和 Docker 生命周期；一个用户一个容器，不把容器生命周期与用户文件绑定。

**Tech Stack:** TypeScript/Node ≥22.13、Mastra Core 1.71.0、Memory 1.32.1、PostgreSQL、Docker Engine、React/Vite。安装新依赖前核对当前锁定版本及类型。

**Spec:** [设计文档](../specs/2026-10-05-user-workspace-docker-sandbox-design.md)

## 全局约束与执行方法

- 开始前读取 `AGENTS.md`、本项目 `node_modules/mastra/dist/docs/SKILL.md` 与 `node_modules/@mastra/core/dist/docs/SKILL.md`；实现时查本机 `.d.ts`，不要凭记忆使用新版本 API。
- 所有 Agent、Tool、路由注册集中到 `src/mastra/index.ts`；开发和构建只用 `npm run dev`、`npm run build` 等 package scripts。
- 不改 Mastra Core、不 fork；不做一个 Thread 一个容器；不引入 Redis、MinIO、Kubernetes；不触碰 workflow 相关代码。
- V1 单 Mastra 进程；上线配置 2 vCPU/2 GiB/40GB；默认 0.5 CPU、384 MiB、128 PIDs、120 秒命令、2 个运行容器、2 个并发命令。
- 新功能默认关闭，逐阶段通过服务端开关上线；在身份/线程/硬配额门禁通过前，不给普通用户开放文件写入或命令。
- 每个任务按“先失败测试 → 最小实现 → 目标测试 → `npm test`/`npm run build` → 独立提交”执行。数据库集成测试用隔离测试库；Docker 安全测试只在具备 Docker 的测试环境运行。若 Git 当前有用户改动，勿覆盖。
- 每阶段完成后在 `README.md` 更新配置、手工回滚与验证命令；不要在日志和测试快照中写 token/API key。

## Review Focus

1. 空 `resourceId` 的旧线程：必须拒绝普通用户自动认领，迁移脚本另行处理（Task 2）。
2. symlink 替换/并发写：路径必须保持在用户根目录且写入不可越界（Task 3）。
3. Agent 原生命令工具带自定义 `cwd`：不能绕过 thread cwd 与超时（Task 6）。
4. 中断/审批恢复后队列锁泄漏：同一 Thread 后续任务仍能运行且不会重叠（Task 7）。
5. Docker 直接写满 bind mount：无宿主硬配额时必须 fail closed（Task 9）。

## Phase 0：现状审计与实施门禁

### Task 0：记录真实入口和基线

**Files:** ADD `docs/architecture/workspace-sandbox-audit.md`; MODIFY `README.md`（加入审计链接）。

**接口/产物:** 列出已安装包版本、所有可达 Memory/Agent/Workspace/Approval 路由、服务端身份来源、现有管理员文件位置、ECS 文件系统类型、Docker/系统账户权限、生产进程数。对照设计文档的假设；发现不一致先修订两份文档再继续。

- [x] 运行 `npm ls @mastra/core @mastra/memory @mastra/pg mastra`、`rg -n 'Workspace|LocalFilesystem|LocalSandbox|AgentController|Memory|resourceId|threadId|requestContext|executeCommand' src web/src`，写审计结果。
- [x] 对 HTTP 路由实际请求做匿名、普通用户 A、普通用户 B、管理员四组探针，覆盖线程 CRUD、消息、Agent stream、工具批准/恢复；记录状态码和是否可读/写对方数据。
- [x] 运行 `npm test`、`npm run build` 留基线结果；无 Docker/ECS 环境时将宿主配额与 Docker 验证标为“部署门禁未完成”，不虚报通过。
- [x] 提交审计文档。数据库变化：无。兼容风险：只读。回滚：删除审计文档即可。

## Phase 1：身份、Thread 所有权与 Memory

### Task 1：统一可信身份读取

**Files:** ADD `src/mastra/auth/auth-context.ts`, `tests/auth-context.test.ts`; MODIFY `src/mastra/models/resolver.ts`, `src/mastra/index.ts`。

**Interfaces:** `trustedAuth(requestContext: RequestContext): AuthContext`，`AuthContext = { userId: string; roles: AppRole[]; tenantId?: string }`；从 `mastra__user` 取已认证 `AuthUser`，校验 UUID，禁止自定义 requestContext 的 `userId`。`resourceIdFor(auth): string` 返回 `auth.userId`。模型 resolver 复用此函数，不引入第二套身份判断。

- [x] 写测试：缺少/伪造身份拒绝；带合法 `mastra__user` 返回真实 UUID；客户端自定义 key 无效。
- [x] 跑 `node --import tsx --test tests/auth-context.test.ts` 确认先失败。
- [x] 实现接口与 index 注册调整，保持现有登录、模型选择行为。
- [x] 跑目标测试、`npm test`、`npm run build`。数据库变化：无。兼容风险：非 UUID 历史身份要先审计；回滚：关闭新入口并恢复上一提交。

### Task 2：服务端线程归属和记忆范围

**Files:** ADD `src/mastra/auth/thread-guard.ts`, `src/mastra/auth/authorization.ts`, `tests/thread-ownership.test.ts`, `tests/memory-isolation.test.ts`; MODIFY `src/mastra/index.ts`, `src/mastra/agents/memory-model.ts`, `web/src/agent/thread-scope.ts`, `web/src/agent/use-thread-list.ts`。

**Interfaces:** `assertThreadOwned(auth: AuthContext, threadId: string): Promise<OwnedThread>`，使用 Mastra Memory 当前 storage API 读取线程并要求 `thread.resourceId === auth.userId`；`authorizeThreadRoute` 在原生端点之前执行或以受控路由替代。允许服务端派生 resourceId，不信任 body/query。Memory 配置显式 `observationalMemory.scope='thread'`、`retrieval.scope='thread'`；`semanticRecall` 继续关闭，`workingMemory` 暂不启用。

- [ ] 写真实 HTTP 负面测试：A 不能 get/list/update/delete B 线程、读 B 消息、向 B stream、批准/恢复 B run；伪造 body/query `resourceId` 无效；无归属线程拒绝。用审计所得实际路径，不猜路由。
- [ ] 写 Memory 双线程测试：A 线程记入测试值，B 线程不能从观察/检索接口直接得到；检查配置确实是 thread scope。
- [ ] 运行目标测试确认失败；实现服务端 gate，若 Mastra 原生路由无法可靠拦截，则逐个关闭后新增受控路由，前端切换到受控路由。
- [ ] 跑目标测试、`npm test`、`npm run build`。数据库变化：默认无；如审计证明必须建映射，先加 `app_thread_owners` 且为旧线程生成明确迁移报告。兼容风险：旧空 `resourceId` 线程会不可见；回滚：保留旧数据，恢复路由开关/上一版本，绝不自动认领。

## Phase 2：用户 Workspace 与路径

### Task 3：用户目录、官方 resolver 与安全路径

**Files:** ADD `src/mastra/workspace/{config,manager,resolver,path,storage}.ts`, `tests/workspace-isolation.test.ts`, `tests/workspace-path.test.ts`; MODIFY `src/mastra/agents/agent.ts`, `src/mastra/index.ts`; ADD `migrations/003_workspace_sandbox.sql`（先含 workspace 表）。

**Interfaces:** `workspaceRoot(userId: string): string`、`threadRoot(userId: string, threadId: string): string`、`ensureUserWorkspace(auth): Promise<string>`、`resolveUserFilesystem({requestContext}): Promise<LocalFilesystem>`。`WorkspaceStorage` 适配当前 Mastra `WorkspaceFilesystem` 的 read/write/list/stat/remove 能力，只保留业务确需方法；`LocalFilesystem({ basePath: root, contained: true })`，`allowedPaths=[]`。真实文件访问经路径策略；`Workspace` 可以是一个动态 resolver 实例，不能用静态共享 basePath。

- [ ] 写测试：用户 A/B 根目录不同；`../`、绝对路径、symlink、伪造 UUID、含 `/` 或 `.` 段的 threadId、创建时父目录 symlink 替换均拒绝；同一用户重复调用幂等。
- [ ] 跑目标测试确认失败；实现配置校验、路径解析、目录创建、数据库唯一 `user_id` 与查询约束。
- [ ] 将 Agent workspace resolver 接到可信身份，先在 feature flag 下仅管理员测试，暂不开放原生命令工具。保留旧 `workspace/` 为只读备份待迁移。
- [ ] 跑目标测试、`npm test`、`npm run build`。数据库变化：`app_workspaces`；兼容风险：管理员旧文件不在新目录；回滚：关功能开关、恢复旧 Workspace 配置，表保留不删。

### Task 4：认证文件 API 与文件服务

**Files:** ADD `src/mastra/files/{service,routes,policy}.ts`, `tests/file-routes.test.ts`; MODIFY `src/mastra/index.ts`, `src/mastra/agents/agent.ts`, `web/src/agent/client.ts`, `web/src/agent/AgentChat.tsx`, `README.md`。

**Interfaces:** `FileService.read/write/list/delete(auth, threadId, relativePath, ...)`；`POST /api/user-files/upload`、`GET /api/user-files/:threadId/*`、`GET /api/user-files/:threadId`（list）、`DELETE /api/user-files/:threadId/*`。每个路由先 `assertThreadOwned`，路径是相对 thread root；允许 user shared 文件的独立路由需显式定义，不让 `..` 兼任。下载返回流与安全响应头；上传先写 temp、校验大小、原子提交。禁用 Mastra 自动文件读写、编辑、复制、删除、list 工具，注册全部经 `FileService` 的受控文件工具并在 `src/mastra/index.ts` 注册。Agent 指令改为返回应用内认证文件路径，不输出宿主 `file:` URL。

- [ ] 写测试：匿名 401、B 读 A 404/403、伪造身份无效、非法路径拒绝、文件下载内容与 header 正确、上传中断无残片；原生文件工具不能绕过 `FileService`。
- [ ] 跑目标测试确认失败；实现服务和路由并在 index 注册，前端增加上传/下载入口或至少提供可用文件链接。
- [ ] 跑目标测试、`npm test`、`npm run build`。数据库变化：无；兼容风险：旧管理员 `file:` URL 不再生成；回滚：关新文件 API、恢复旧提示词，但不删除用户文件。

## Phase 3：Thread 工作目录

### Task 5：每线程目录与默认文件目标

**Files:** MODIFY `src/mastra/workspace/{manager,path}.ts`, `src/mastra/files/service.ts`; ADD `tests/thread-directory.test.ts`。

**Interfaces:** `ensureThreadDirectory(auth, threadId): Promise<{ hostPath: string; containerPath: string }>` 在所有权校验后创建 `input/output/tmp`；容器路径固定 `/workspace/threads/<threadId>`。Thread 删除不删除目录。

- [ ] 写测试：同用户两个 Thread 写同名 `analysis.py` 不相互覆盖；删 Thread 后文件仍保留；不允许传别人的 threadId。
- [ ] 跑目标测试确认失败；实现目录与 FileService 默认 scope。
- [ ] 跑目标测试、`npm test`、`npm run build`。数据库变化：无；兼容风险：已有文件在 workspace 根目录需迁移；回滚：保留新目录，关闭相关入口。

## Phase 4：Provider 抽象

### Task 6：受控执行接口与 Mastra 适配层

**Files:** ADD `src/mastra/sandbox/{types,provider,manager,tool}.ts`, `src/mastra/sandbox/docker/workspace-adapter.ts`, `tests/sandbox-manager.test.ts`; MODIFY `src/mastra/agents/agent.ts`, `src/mastra/index.ts`。

**Interfaces:** `SandboxOwner={ userId:string; sandboxId:string }`; `ExecutionRequest={ auth:AuthContext; threadId:string; command:string; args:string[]; abortSignal?:AbortSignal }`; `SandboxProvider.ensureRunning(owner, workspaceRoot)` / `.execute(owner, command, args, {cwd,timeoutMs,abortSignal})` / `.stop` / `.remove` / `.inspect`。`SandboxManager.execute(request)` 必须自己调用 `assertThreadOwned`、覆盖 cwd 与 timeout，不接受 Tool 参数中的 userId/cwd。先用 fake provider 验证；用当前 `WorkspaceSandbox` 类型定义编译 adapter。禁用 Mastra 自动命令、后台 spawn、包安装入口或证明都经过同一 manager。

- [ ] 写测试：任意 Tool 参数 userId/cwd 不改变身份与 thread cwd；无 threadId 拒绝；普通聊天不调用 provider；原生命令工具不出现在可用工具清单。
- [ ] 跑目标测试确认失败；实现接口和 manager；注册自定义受控工具，默认 feature flag 关闭。
- [ ] 跑目标测试、`npm test`、`npm run build`。数据库变化：无；兼容风险：管理员旧 LocalSandbox 命令消失；回滚：关闭新工具，管理员仅聊天，不能重新打开不安全生产命令。

## Phase 5：Docker Sandbox

### Task 7：Docker 创建、复用与安全配置

**Files:** ADD `src/mastra/sandbox/docker/{client,config,provider}.ts`, `src/mastra/sandbox/registry.ts`, `tests/docker-config.test.ts`, `tests/docker-sandbox.integration.test.ts`, `sandbox/Dockerfile`; MODIFY `migrations/003_workspace_sandbox.sql`, `package.json`, `package-lock.json`, `src/mastra/index.ts`。

**Interfaces:** `DockerSandboxProvider` 实现 Task 6 接口；`SandboxRegistry` 按 `user_id` 唯一注册/对账容器；Docker 镜像通过 `SANDBOX_IMAGE` 固定 digest；容器只 bind 该用户根到 `/workspace`。选择并锁定 Docker Engine Node 客户端版本，所有 create/start/exec/stop/remove 调用以该安装版本 API 与类型为准。`getOrCreate` 需要同 user 幂等互斥，启动时用 DB 记录 + Docker label 复核。

- [ ] 写配置测试断言 `User=10001:10001`、read-only root、network none、无 privileged/host PID/host network/socket、capDrop ALL、pids/memory/CPU/swap/tmpfs、仅一条用户 Workspace RW bind；错误配置启动失败。
- [ ] 写 Docker 集成测试：A 无法读取 B 目录或 Docker socket，无法联网；普通聊天不创建容器；首次执行创建，再次复用；进程重启后可对账；容器删除后文件保留并可恢复。
- [ ] 跑目标测试确认失败；实现 provider、registry、镜像与环境配置；服务端进程有 Docker 权限但用户容器绝无 socket。
- [ ] 跑目标测试、Docker 集成测试、`npm test`、`npm run build`。数据库变化：`app_sandbox_instances`；兼容风险：ECS Docker 权限、UID/GID 和镜像依赖；回滚：关沙箱开关、stop/remove 仅新标签容器，不动 Workspace。

## Phase 6：Execution Queue

### Task 8：Thread 队列与全局限流

**Files:** ADD `src/mastra/sandbox/execution-queue.ts`, `tests/execution-queue.test.ts`, `tests/agent-run-queue.integration.test.ts`; MODIFY `src/mastra/sandbox/manager.ts`, `src/mastra/sandbox/tool.ts`, `src/mastra/index.ts`。

**Interfaces:** `ExecutionQueue.run<T>(userId, threadId, task, abortSignal): Promise<T>`；同一 `${userId}:${threadId}` FIFO、不同 key 并行、全局命令 semaphore=2、排队取消可释放位置。Agent run 全生命周期串行要求另设 run gate，stream 结束/失败/取消才释放；审批挂起释放后，恢复时用同 key 重新入队并检查 run 归属。若原生 stream/approval 无法可靠包裹，保留仅命令级 queue 并不向用户承诺 Agent run 级隔离，相关开放门禁不通过。

- [ ] 写测试：同 thread 两次执行无重叠；两个 thread 可并行但第三个等待；取消、超时、抛错不漏锁；批准/恢复后第二 run 不与首 run 重叠。
- [ ] 跑目标测试确认失败；实现队列并接入所有可达命令入口，按真实端点验证 run gate。
- [ ] 跑目标测试、`npm test`、`npm run build`。数据库变化：无；兼容风险：多进程不共享队列；回滚：关闭命令工具，不能无队列开放执行。

## Phase 7：配额、资源限制与安全

### Task 9：API 配额、宿主硬配额和磁盘保护

**Files:** ADD `src/mastra/workspace/quota.ts`, `src/mastra/workspace/disk-protection.ts`, `tests/workspace-quota.test.ts`, `scripts/check-workspace-quota.mjs`; MODIFY `src/mastra/files/service.ts`, `src/mastra/sandbox/docker/config.ts`, `README.md`。

**Interfaces:** `WorkspaceQuota.reserve/commit/release` 用 DB 原子操作防并发上传；`reconcileUsage(userId)` 从磁盘重算；`DiskProtection.assertWritable(bytes)` 根据阈值拒绝。默认 500 MiB/用户、100 MiB/文件、5000 文件；>80% 大写入禁用，>90% 非必要写禁用。宿主 project quota 的设置、验证和开机自检脚本必须针对 ECS 实际文件系统；不支持则 `SANDBOX_FILE_WRITE_ENABLED=false`，普通用户命令不可用。

- [ ] 写测试：两个并发上传合计超额只成功一个；copy/write/output 达限拒绝；磁盘阈值边界正确；Docker 直接写超额被宿主拒绝或服务自检 fail closed。
- [ ] 跑目标测试确认失败；实现应用计数、定期重算、主机 quota 探测、配置校验、Docker log rotation 与 stdout 上限。
- [ ] 在 ECS staging 真测容器内 `dd` 写满配额和单文件上限；不满足则不开启命令写入。跑 `npm test`、`npm run build`。数据库变化：使用 Task 3 的 quota/used 字段；兼容风险：磁盘当前格式不支持 project quota；回滚：关文件/命令开关，保留数据和配额元数据。

## Phase 8：生命周期与清理

### Task 10：idle stop、remove、审计

**Files:** ADD `src/mastra/sandbox/cleaner.ts`, `src/mastra/sandbox/audit.ts`, `tests/sandbox-cleaner.test.ts`; MODIFY `src/mastra/sandbox/{manager,registry}.ts`, `src/mastra/index.ts`, `README.md`。

**Interfaces:** `SandboxCleaner.runOnce(now): Promise<CleanupReport>`；默认 idle 30 分钟 stop、stopped 24 小时 remove，配置 `SANDBOX_IDLE_STOP_MS`、`SANDBOX_REMOVE_AFTER_MS`；运行中的命令和队列中的用户不得清理。日志只存命令摘要、exit/timeout、时长、owner ID，不存完整 token/secret。

- [ ] 写 fake clock 测试：active 不清理、idle stop、长闲置 remove、再次执行重建，任何步骤不删 Workspace；并发清理与启动不冲突。
- [ ] 跑目标测试确认失败；实现定时 sweep 与启动时对账，失败标 ERROR 并重试，不无限快速循环。
- [ ] 跑目标测试、Docker 集成测试、`npm test`、`npm run build`。数据库变化：更新 `last_active_at/status`；兼容风险：错误识别 active 进程；回滚：关 cleaner，容器可手动 stop/remove，文件不受影响。

## Phase 9：全链路安全验收

### Task 11：覆盖方案的 14 个场景

**Files:** ADD `tests/multi-user-e2e.test.ts`, `tests/docker-limits.integration.test.ts`; MODIFY 相关单元测试、`README.md`。

- [ ] 建两个用户、各两个 Thread，运行设计文档验收项：用户间文件不可读、同名文件不覆盖、跨 Thread 记忆不泄露、伪造 userId 无效。
- [ ] 测 `../../`、绝对路径、symlink、无 Docker socket/网络、fork 进程、超内存、命令超时与取消。
- [ ] 测容器 remove 后文件保留和重建；同 Thread FIFO、不同 Thread 全局并发 2；上传/容器直接写超 quota 拒绝。
- [ ] 运行 `npm test`、`npm run test --prefix web`、`npm run build` 和 Docker 集成测试，保存命令、环境与通过输出。数据库变化：无；兼容风险：真实 Docker 测试需隔离宿主资源；回滚：仍保持普通用户新功能关闭。

## Phase 10：部署、迁移与灰度

### Task 12：ECS 发布与回滚演练

**Files:** ADD `docs/deployment/workspace-sandbox-ecs.md`, `scripts/migrate-admin-workspace.mjs`；MODIFY `README.md`, `compose.yaml`（只增加开发测试所需服务和资源说明，不把用户容器定义成常驻服务）。

- [ ] 记录 ECS 实际文件系统、Docker Engine、项目配额、磁盘监控、日志轮转、备份、Node 单进程、镜像 digest、UID/GID、`/data/mastra` 权限；先做备份和恢复演练。
- [ ] 运行 `npm run db:migrate`，预构建镜像，完成硬配额自检。管理员旧 workspace 先备份/列清单，按确认映射迁入管理员 UUID；旧 thread 无 owner 做单独报告，不自动认领。
- [ ] 仅管理员灰度文件读写与 Docker 命令，再开放测试普通用户；观察 CPU、RAM、磁盘、容器数量、拒绝率及审计。确认普通聊天不启容器。
- [ ] 回滚演练：关闭 feature flag，停止带本项目 label 的容器，回退应用版本；保留 DB 新表与 `/data/mastra/users`，不运行破坏性 down migration。再次跑 `npm test`、`npm run build` 和关键 HTTP/Docker 验证。

## 最终交付门禁

Cursor 只有在 Task 0–12 的对应验证有实际通过记录、ECS 宿主硬配额真测通过、原生命令/线程绕过路径已封闭后，才能启用普通用户文件与执行能力。任何一项未通过，保留聊天功能和 feature flag 关闭状态，并在交付报告写明具体未通过项、影响和下一步。实施时不要修改 workflow 目录或注册。
