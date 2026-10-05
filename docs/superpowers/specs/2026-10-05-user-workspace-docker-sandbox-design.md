# Mastra 用户工作区与 Docker 沙箱改造设计

> 状态：供 Cursor 实施的设计基线。审计基于 2026-10-05 本仓库代码、锁定依赖与 `node_modules` 类型定义。本文只设计 Agent、Memory、文件、沙箱及 HTTP 边界；不改造 workflow。

## 1. 当前项目架构分析

本仓库是单个 Mastra 服务加 Vite/React 前端，PostgreSQL 保存应用身份数据与 Mastra Memory，DuckDB 保存开发环境的观测数据。`src/mastra/index.ts` 注册一个 `agent`、三个自定义工具、认证/模型路由与中间件。没有 workspace package 或 monorepo 配置；根目录和 `web/` 各自有 `package.json` 与 lockfile。根脚本 `npm run dev`、`npm run build` 封装了 Mastra CLI。`compose.yaml` 只启动本地 PostgreSQL；生产 ECS 的进程管理、反向代理和 Docker 权限尚无仓库内声明，因此部署设计是待落地的配置，不应被当作现状。

当前调用链：浏览器 `web/src/App.tsx` 登录获得 bearer token → `web/src/agent/client.ts` 创建 MastraClient → 前端调用 Mastra Memory/Agent 原生端点 → `src/mastra/index.ts` 的 `authenticateToken` 查 `app_sessions`，`mapUserToResourceId` 返回用户 UUID → Agent 从受保护的 `mastra__user` 读取身份并选模型 → `memoryForRequest` 选择 Memory 实例 → Agent 工具及 Workspace。前端的 `thread-scope.ts` 会按 resourceId 过滤与预检线程，但它不是服务端授权边界。

| 能力 | 当前实现 | 目标实现 | 需改 | 主要风险 |
| --- | --- | --- | --- | --- |
| 用户身份 | PostgreSQL `app_users`、7 天 token session、服务端 `mastra__user` | 所有文件/执行入口只从已认证上下文取 UUID | 是 | 内置端点可被直接调用 |
| Thread | Mastra Memory 存线程与消息；前端传 `resourceId` | 服务端按真实 userId 校验线程归属 | 是 | 客户端预检可绕过 |
| Memory | `@mastra/memory` 动态实例；已启用 Observational Memory | 默认只跨当前 thread 检索/观察 | 是 | 记忆范围意外扩大 |
| Workspace | 仅管理员共享 `workspace/` | 每用户独立持久目录 | 是 | 历史管理员文件迁移 |
| 文件访问 | Mastra 文件工具，提示词返回本地 `file:` URL；无上传/下载 API | 带认证的用户文件 API 与工具 | 是 | 本地路径泄露、目录穿越 |
| 命令执行 | 管理员 Workspace 配 `LocalSandbox` | 按需复用用户 Docker 沙箱 | 是 | 主机执行与容器逃逸 |
| 队列 | 无项目级 thread 执行队列 | 同线程串行、全局限流 | 是 | 原生 Agent run 绕过队列 |
| 容量 | 无 Workspace quota | API 配额加生产宿主文件系统硬配额 | 是 | 容器直接写绕过应用计数 |
| 生命周期 | 无用户容器管理 | idle stop、长闲置 remove，文件保留 | 是 | 清理误删用户数据 |

没有项目自定义 Workflow，也未使用 `AgentController`。浏览器中的 `useChat` 是一次请求的运行状态，不是后端持久 Session；当前不引入 Controller 或额外 Session 表。现有 `schedule-tools.ts` 只面向管理员，保留其授权边界；任何未来定时触发的文件或命令能力仍须走同一身份和线程检查。

## 2. 当前 Mastra 版本及已核实 API

根目录实装：`@mastra/core 1.71.0`、`@mastra/memory 1.32.1`、`@mastra/pg 1.28.0`、CLI `mastra 1.31.3`。前端实装 `@mastra/core 1.71.0`、`@mastra/client-js 1.50.0`、`@mastra/react 1.6.3`。实施前再次运行 `npm ls` 核对 lockfile，改 API 时以当时安装包 `.d.ts` 与包内文档为准。

- `Agent.workspace` 在当前 `agent/types.d.ts` 是可接收 `({ requestContext }) => Workspace | undefined` 的动态参数；现有 Agent 已这样使用。
- `WorkspaceConfig.filesystem` 和 `sandbox` 均接受 resolver；`sandboxCacheKey` 可按可信 userId 缓存。`mounts` 是静态配置，不能与动态 sandbox resolver 组合。每用户 Workspace 可以采用官方动态 filesystem/sandbox resolver；无需 fork Core。
- `LocalFilesystem({ basePath, contained: true })` 默认限制 basePath，并校验 symlink escape。绝对路径保持绝对语义，越界会拒绝；`allowedPaths` 可放宽边界，本设计中用户 filesystem 必须留空。
- `WorkspaceSandbox.executeCommand(command, args?, options?)` 接受 `cwd`、`timeout`、`abortSignal` 等；Workspace 内置命令工具的输入也允许模型提供 `cwd`。因此仅设置默认 workingDirectory 不足以保证 thread cwd，必须在受控工具/适配层强制覆盖并验证。
- `observationalMemory` 文档说明默认 `scope: 'thread'`，而其 retrieval 工具默认可在 `resource` 范围浏览/搜索其他线程。必须显式配置 thread scope；`semanticRecall` 默认关闭，`workingMemory` 当前未配置。
- 安装的 `@mastra/server` 会优先使用服务端 `mastra__resourceId` 并在部分线程操作检查归属，但存在无 resourceId 的共享线程语义，且不同端点不能靠推断保证全部安全。所有本项目暴露的线程入口须逐一用攻击测试确认；不满足的端点由服务端中间件阻断或替换为受控路由。
- 当前仓库没有安装 Docker Workspace provider。Docker 可通过项目自有 `SandboxProvider` + `WorkspaceSandbox` 适配器实现；先用当前类型定义做编译验证，不凭最新官网示例猜签名。

参考：本地 `node_modules/@mastra/core/dist/docs/SKILL.md`、`dist/workspace/**.d.ts`、`dist/docs/references/docs-sandbox-{filesystem,overview}.md` 与官方 [Mastra 文档索引](https://mastra.ai/llms.txt)。

## 3. 推荐架构与边界

```text
Browser / Studio
    │ Bearer token
    ▼
Mastra HTTP auth ──> app_sessions / app_users
    │ trusted userId = UUID; resourceId = userId
    ▼
Thread gate ──> Mastra Memory thread.resourceId == userId
    │ threadId verified before any file/run operation
    ├──> Agent Memory (message / observation / retrieval: thread scope)
    ├──> Workspace resolver ──> /data/mastra/users/<UUID>/workspace
    │      └── FileService / LocalFilesystem / authenticated file API
    └──> ExecutionQueue(userId, threadId) + global semaphore
             └── SandboxManager(userId) ──> Docker container, lazy create/reuse
                    bind: only that user's workspace → /workspace
                    cwd: /workspace/threads/<threadId>
```

Workspace 是持久数据，Sandbox 是可删除运行环境，Thread 是持久对话及默认工作目录。一个用户默认一个 Docker 容器；不同用户绝不共享容器。`sandboxScope: 'user'` 作为配置与 provider key 的抽象；V1 不实现 thread scope。容器删除、线程删除与用户工作区删除是三个独立操作。线程删除默认**保留** `threads/<threadId>` 文件，直到显式清理策略经过单独授权，避免误丢文件。

**重要隔离边界：** 同用户多个 Thread 共用一个容器、一个可读写挂载。强制不同 cwd 与同线程串行只能防止默认路径碰撞，不能阻止用户自己执行 `../thread-B` 或读取同一用户其他线程文件。因此 V1 的 Thread 文件隔离是工作目录与任务互不覆盖，不是针对同一用户恶意代码的安全边界。若未来要求同用户线程之间互不读取，应切换 thread scope 容器或独立权限/挂载机制。

## 4. 身份、线程与运行入口

`AuthContext` 只由服务端认证结果构造：`{ userId: string /* UUID */, roles: AppRole[], tenantId?: string }`。保留现有 session token 机制，不引入 JWT 或 tenant 表。`resourceId` 永远等于 `auth.userId`。路径生成先校验用户 UUID；threadId 在所有权校验之外还需满足单段安全 ID 格式（字母、数字、下划线、连字符，1–128 字符），禁止 `/`、`.` 段和控制字符，再用 `path.resolve` 和真实路径校验。容器名称用 UUID 的标准小写形式加固定前缀，逻辑 `sandboxId = sb_<UUID>`。`workspaceId = ws_<UUID>` 是稳定逻辑标识，数据库以 `user_id` 唯一键确定归属。

`assertThreadOwned(userId, threadId)` 在服务端查询 Mastra Memory 线程，要求线程存在、`resourceId === userId`，空 resourceId 一律拒绝。创建 thread 时由服务端覆盖 resourceId，客户端传来的值只作兼容输入；对 list/get/update/delete/messages/agent stream/approval/resume 等实际可达原生路由建立端点清单与负面测试。无法证明原生路由归属的入口先封闭，再通过项目路由提供同等功能。Studio 仅管理员访问，但管理员默认也不得通过普通用户 API 越权代入身份。

同一线程的整个 Agent run 应进入队列，直到流结束、失败、取消或批准挂起。工具批准/恢复必须使用同一 thread key 并由持久 run 标识关联。若当前原生 streaming/approval 生命周期无法可靠接入 run 级队列，先只开放受控命令/文件执行接口，保持普通聊天原生路径；在通过集成测试之前不得声称完整 Agent run 串行。不同线程可并行但受全局命令并发上限 2 限制；容器创建另受运行容器上限 2 限制。进程内队列仅支持单 Mastra 进程，多进程部署为禁止项，直到换持久队列/锁。

## 5. Workspace 与文件服务

宿主根目录由 `WORKSPACE_ROOT=/data/mastra` 配置。结构：

```text
/data/mastra/users/<UUID>/workspace/
  shared/ uploads/ projects/ threads/<threadId>/{input,output,tmp}/
/data/mastra/shared/{skills,templates,knowledge}/   # 系统只读
/data/mastra/temp/
```

使用一个动态 `Workspace`（不是共享 basePath）：`filesystem` resolver 从可信上下文取用户，返回 `LocalFilesystem({ basePath: userRoot, contained: true })`。`WorkspaceManager` 负责幂等创建与目录属主；`WorkspaceStorage` 只作为业务文件服务的窄接口，底层当前适配 Mastra `WorkspaceFilesystem`，避免重复实现完整文件系统框架。`FileService` 负责服务端授权、路径、配额、审计和文件返回；前端只接收相对路径和认证下载 URL，不展示宿主 `file:` URL。新增上传 API 时采用流式写入临时文件、尺寸预检、写后核算、原子 rename；下载设置安全内容类型与 `Content-Disposition`。

用户路径仅允许相对路径，拒绝空字节、绝对路径、反斜杠变体和 `..` 段；对已存在路径使用 realpath 确认属于根目录，对创建路径确认最近已存在父目录真实路径，并使用 no-follow/独占创建规避 symlink 与 TOCTOU。文件路由及工具都走同一 `FileService` 策略。Mastra Workspace 自动生成的原生文件写/编辑/复制/删除工具可能绕过业务配额；V1 将这些工具禁用，并注册通过 `FileService` 的受控文件工具。原生读/list 工具也要审计其 thread scope，未证明安全前同样禁用。系统 `shared` 不进入用户可写 Workspace；V1 如要暴露 skills，Docker 另做只读 bind mount `/skills`，并在文件服务中单独提供只读入口。不得把 `/data/mastra/users` 整体挂进容器。

## 6. Docker Sandbox 与执行

`SandboxProvider` 定义 `ensureRunning(owner)`, `execute(owner, command, args, cwd, signal)`, `stop`, `remove`, `inspect`；`DockerSandboxProvider` 用 Docker Engine 客户端（建议 `dockerode` + 类型包，锁定版本时检查 API）实现。另做符合当前 `WorkspaceSandbox` 的轻适配器，供 Mastra Workspace 使用。所有用户可控命令经项目的受控 execute 工具执行；禁用 Mastra 自动提供的原生命令、后台 spawn、包安装等可能绕过队列/cwd/timeout 的工具，待逐一接入策略后才开放。`src/mastra/index.ts` 继续注册全部自定义工具和 Agent。

首次执行才创建容器；普通聊天、登录与创建 Thread 不启动 Docker。Registry 用 PostgreSQL 记录 owner、container ID、状态和 `last_active_at`；数据库和 Docker 标签（user UUID、workspace ID、版本）双向校验，进程重启后可重建缓存。创建加同用户互斥与 DB 唯一约束；跨实例未支持。状态 CREATING/RUNNING/IDLE/STOPPED/ERROR；idle 30 分钟 stop，stop 后 24 小时 remove，两个阈值由环境变量控制。任何清理都不删除 Workspace。

启动配置默认：0.5 CPU、384 MiB RAM、memory swap 不大于 memory、PIDs 128、命令超时 120 秒、最大运行容器 2、最大并发命令 2、`network=none`、非 root UID/GID 10001、`readOnlyRootfs=true`、`/tmp` tmpfs 256 MiB、`capDrop=ALL`、`no-new-privileges`、禁止 privileged/host network/host PID/Docker socket。仅绑定该用户 Workspace 到 `/workspace`。镜像 `mastra-agent-sandbox:1.0` 固定 digest，上线时预构建并含 bash、Python、Node；扩展包按实际需要添加。`process.env` 不整体传入；V1 `SANDBOX_ALLOWED_ENV_KEYS` 默认为空。限制 stdout/stderr 字节数与 Docker 日志轮转。Docker API 权限仅在服务端部署账户；这个账户等价宿主高权限，须隔离 Studio/公开入口并审计。

`execute` 必须传经过服务端校验的 threadId，固定 `cwd=/workspace/threads/<threadId>`；忽略模型提供的 cwd。执行前创建 thread 目录，容器中使用固定 uid，解决 bind mount 权限。超时或取消要终止命令及子进程，记录 exitCode/timedOut；对 `docker exec` 的进程清理做真实集成验证。审计记录 userId、threadId、sandboxId、命令摘要、cwd、起止时间、状态，命令全文默认不落库，避免泄漏秘密。

## 7. 配额与磁盘保护

默认单用户 500 MiB、单文件 100 MiB、5000 文件；`WORKSPACE_DEFAULT_QUOTA_BYTES`、`WORKSPACE_MAX_FILE_SIZE_BYTES`、`WORKSPACE_MAX_FILES` 配置。应用层对 upload/write/copy/输出登记进行预检与写后核算，计数从磁盘定期重算，数据库 `used_bytes` 只是缓存。>80% 禁大文件新写并告警，>90% 阻断非必要写；阈值可配。Docker 日志、镜像、构建缓存与数据库也纳入主机容量监控。

**不能把应用层计数当硬配额。** 容器中的 bash/Python 可直接写 bind mount，绕过 FileService。生产开放命令写入之前，ECS 数据盘必须启用并实测按用户目录的项目硬配额（例如支持 project quota 的 XFS/ext4 配置），或选用等效的受限持久卷实现；否则启动自检必须关闭普通用户命令/文件生成功能。部署文档给出文件系统探测、配额设定与超额测试，不假设现有 40GB 云盘已支持。单文件上限还需在容器进程级限制或写后清理，不能仅由上传 API 保证。

## 8. 数据模型与迁移

新增 `migrations/003_workspace_sandbox.sql`：`app_workspaces(id, user_id UNIQUE FK, root_path, quota_bytes, used_bytes, status, created_at, updated_at)`；`app_sandbox_instances(id, user_id UNIQUE FK, scope CHECK='user', scope_id, container_id UNIQUE NULL, status, last_active_at, created_at, updated_at)`。查询均用 `WHERE user_id = $authenticatedUserId`。Mastra 原生线程/消息表不重建；仅在必要时加项目映射表 `app_thread_owners(thread_id PRIMARY KEY, user_id FK)`，前提是审计证明 Mastra 当前接口不能可靠取 `resourceId`；优先不建。既有管理员 `workspace/` 先备份、列清单、经管理员确认归属后迁入其 UUID 目录；不能自动混进普通用户目录。历史 resourceId 为空或不匹配的线程默认拒绝，提供一次性管理员迁移脚本和审计报告，不在请求时自动认领。

## 9. 文件级改造清单

| 文件 | 操作 | 目的 |
| --- | --- | --- |
| `src/mastra/index.ts` | MODIFY | 注册受控工具、路由、中间件；保留现有 Agent 与存储注册 |
| `src/mastra/agents/agent.ts` | MODIFY | 动态用户 Workspace、禁不受控命令、更新文件提示 |
| `src/mastra/agents/memory-model.ts` | MODIFY | 显式 thread 记忆范围 |
| `src/mastra/models/resolver.ts` | KEEP | 复用可信 `mastra__user`，通用身份函数可提取但不改变模型策略 |
| `src/mastra/auth/{auth-context,authorization,thread-guard}.ts` | ADD | 可信身份、归属校验、原生端点防护 |
| `src/mastra/workspace/{config,manager,resolver,path,quota,storage}.ts` | ADD | 用户目录、官方 Workspace resolver 与窄存储适配 |
| `src/mastra/files/{service,routes,policy}.ts` | ADD | 认证文件 API、上传下载与审计 |
| `src/mastra/sandbox/{types,provider,manager,registry,cleaner,execution-queue,tool}.ts` | ADD | 用户沙箱、进程队列、受控执行 |
| `src/mastra/sandbox/docker/{client,provider,config,workspace-adapter}.ts` | ADD | Docker 实现与 Mastra 适配 |
| `migrations/003_workspace_sandbox.sql` | ADD | ownership、沙箱状态与索引 |
| `web/src/agent/{client,AgentChat,thread-scope,use-thread-list}.ts(x)` | MODIFY | 去信任客户端身份、文件入口和授权错误处理 |
| `README.md`, `compose.yaml`, `package.json` | MODIFY | 配置、部署、依赖、运行脚本说明 |
| `tests/*`, `web/src/agent/*.test.ts(x)` | ADD/MODIFY | 身份、路径、配额、记忆和 Docker 集成验证 |

## 10. 风险、决策与验收

关键设计决策已定：保留现有 PostgreSQL session auth 与 Mastra Memory；V1 单进程；Docker 与本地磁盘；默认关闭沙箱网络；文件 API 和命令工具只在服务端归属校验后开放。生产硬配额是否可在当前 ECS 数据盘启用是上线门槛，需要部署时实测，不是编码时猜测。Docker socket 不得挂给用户容器；服务端访问 Docker 的宿主权限是运营风险。Studio 的管理员原有 LocalSandbox 能力应随 Docker 切换下线，避免保留主机命令后门。

验收至少包括：A/B 用户文件互不可读；同用户两 Thread 默认目录与文件互不覆盖；跨 Thread 不召回对方内容；伪造 resourceId/userId 不越权；绝对路径、`..`、symlink 拒绝；容器仅有本用户挂载、无 Docker socket、无网络；PIDs/内存/CPU/超时生效；同 Thread 串行、不同 Thread 受全局限流；配额与磁盘保护生效；删除容器后 Workspace 完整且可复用；服务重启后 Registry 对账；上传/下载认证；未配置硬配额时普通用户命令写入保持关闭。

本文不修改产品代码。实施逐步门禁、测试与回滚见 [实施计划](../plans/2026-10-05-user-workspace-docker-sandbox.md)。
