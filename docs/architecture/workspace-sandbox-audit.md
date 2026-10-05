# 用户工作区与 Docker 沙箱现状审计

审计时间：2026-10-05。环境：开发机 macOS Darwin 25.6.0 arm64，Node v22.22.0。对照设计文档 `docs/superpowers/specs/2026-10-05-user-workspace-docker-sandbox-design.md`。本文不记录 token、密码或 API key。

## 结论摘要

设计文档对版本、身份来源、共享管理员 Workspace、前端非授权边界、无 AgentController、无 Docker provider 的描述与代码一致。本机 HTTP 探针表明：Mastra 原生 Memory 线程 CRUD 已按服务端 `resourceId` 拒绝跨用户读写；客户端伪造 body `resourceId` 创建线程时被覆盖为调用者 UUID。尚未证明工具批准/恢复会校验线程归属（假 runId 在到达归属检查前失败）。Docker 引擎可用，但无用户沙箱镜像、无 `/data/mastra`、无 ECS 宿主硬配额实测，**部署门禁未完成**。不得据此开放普通用户文件写入或命令。

## 已安装包版本

`npm ls @mastra/core @mastra/memory @mastra/pg mastra`（2026-10-05）：

| 包 | 实装版本 |
| --- | --- |
| `@mastra/core` | 1.71.0 |
| `@mastra/memory` | 1.32.1 |
| `@mastra/pg` | 1.28.0 |
| `mastra` CLI | 1.31.3 |
| `@mastra/server`（经 CLI/deployer） | 1.71.0 |
| `@mastra/duckdb` | 1.11.1 |
| `@mastra/observability` | 1.18.1 |
| `@mastra/client-js`（web） | 1.50.0 |
| `@mastra/react`（web） | 1.6.3 |

与设计文档第 2 节一致。

## 服务端身份来源

- HTTP API：`src/mastra/index.ts` 的 `authenticateToken` → `getUserByToken` 查 PostgreSQL `app_sessions`；`mapUserToResourceId: user => user.id`。
- `app_users.id` 为 UUID（`migrations/001_identity.sql`）。
- 模型选择：`src/mastra/models/resolver.ts` 只从 `mastra__user` 读 `AuthUser`，忽略客户端自定义 identity key。
- 缺口：`/auth/me` 读 `requestContext.get('user')`，与 `mastra__user` 不是同一入口；Task 1 需统一，避免第二套身份判断。
- Studio：`src/mastra/auth/studio.ts` 仅管理员，HttpOnly Cookie `nero_studio_session`；`mapUserToResourceId` 同样是 `user.id`。
- 前端 `thread-scope.ts` / `use-thread-list.ts` 会传并过滤 `resourceId`，**不是**服务端授权边界。

## 可达路由清单

项目自定义（`src/mastra/index.ts` `apiRoutes`）：

- `POST /auth/login`（无认证）、`GET /auth/me`、`POST /auth/logout`、`POST /auth/users`（管理员）
- `/model-catalog` 及公共/私有模型 CRUD、网关同步（见 `src/mastra/models/routes.ts`）
- 管理员 HTML：`/model-admin`

Mastra `@mastra/server` 1.71.0 内置（前缀 `/api`），与本计划相关的包括但不限于：

- Memory：`/api/memory/threads`、`/api/memory/threads/:threadId`、`.../messages`、`.../clone`、`.../transfer`、`.../working-memory`、`/api/memory/config`、`/api/memory/search`、`/api/memory/observational-memory`、`/api/memory/save-messages`
- Agent：`/api/agents`、`/api/agents/:agentId`、`.../stream`、`.../generate`、`.../approve-tool-call`、`.../decline-tool-call`、`.../resume-stream`、`.../send-tool-approval`、`.../tools/:toolId/execute`、`.../threads/abort`
- AgentController：`/api/agent-controller/...`（项目**未注册** Controller；探针 `GET /api/agent-controller` 返回空列表）
- Workspace 存储：`/api/stored/workspaces`（探针为空列表）
- 另有 workflow/agent-builder/A2A 等上游路由；项目未注册自定义 workflow。

## Memory / Agent / Workspace 现状

- 单一 Agent `agent`（`src/mastra/agents/agent.ts`）。
- Memory：按模型配置缓存的 `Memory` 实例；`observationalMemory` 已开，**未显式** `scope: 'thread'`；`semanticRecall` 未配置（config 接口返回 `semanticRecall: false`）；无 `workingMemory`。
- Workspace：管理员共享静态 `Workspace`，`LocalFilesystem({ basePath: 'workspace' })` + `LocalSandbox({ workingDirectory: 'workspace' })`。未设 `contained: true`，未用动态 resolver。开发目录为 `src/mastra/public/workspace/`（README）。
- 普通用户：`workspace` resolver 返回 `undefined`；工具仅 `ask_user`、`web_fetch`、`web_search`。管理员另有定时任务工具，并继承 Workspace 自动文件/命令工具。
- 指令会输出宿主 `file:` URL。
- 无项目级执行队列、配额、Docker sandbox provider。
- 代码检索：`src`/`web/src` 中无 `AgentController`、无 `executeCommand` 调用。

## HTTP 探针（本机已运行的 `mastra dev` :4111）

身份：匿名；普通用户 A；新建普通用户 B；管理员。不记录凭证。5173 前端代理存在，探针直打 4111。

| 操作 | 匿名 | 用户 A 对 B/管理员数据 | 用户 B 对 A | 备注 |
| --- | --- | --- | --- | --- |
| `/auth/me`、`/api/agents`、`/api/memory/threads`、stream/approve/resume | 401 | — | — | `Invalid or expired token` |
| 列出线程（带或不带 query `resourceId`） | 401 | 仅返回调用者自己的线程；伪造他人 `resourceId` 查询仍只见自己 | 同左 | 服务端 `mastra__resourceId` 覆盖 query |
| 创建线程并伪造 body `resourceId` 为他人 UUID | — | 200，落库 `resourceId` 为 A 自己的 UUID | — | 伪造无效，未写入他人名下 |
| 无 `resourceId` 创建 | — | 400 校验失败 | — | 当前无法经 API 新建空归属线程 |
| GET/PATCH/DELETE 他人线程、读他人消息、save-messages、working-memory、clone 他人线程 | — | 403 `thread belongs to a different resource` | 403 | 管理员 GET 用户 A 线程同样 403 |
| transfer 他人线程 | — | 403 需非 resource-scoped 特权上下文 | — | |
| stream 他人 `memory.thread` | — | 403 | 403 | 正确 body 为 `{ messages, memory: { thread, resource } }`；顶层 `threadId` 会被忽略并 500 |
| observational-memory 他人 threadId | — | 200 `{ record: null }`（该线程无观测记录） | — | query `resourceId` 可被忽略；未证明有数据时是否泄漏，Task 2 需带真实观测记录复测 |
| memory/search 他人 thread | — | 500 资源不匹配 | — | 失败而非 403 |
| approve-tool-call / resume-stream 假 runId | — | 500 找不到 suspended run | — | **未到达**线程归属断言；不能声称已封闭 |
| `POST /api/agents/agent/tools/web_search/execute` | 401 | 500（Tavily 400，说明已进入工具） | — | 无 thread 的直接工具执行仍可达 |
| 用户执行 `write_file` / `execute_command` | — | 404 Tool not found | — | 与普通用户无 Workspace 一致 |

探针副作用：本地库留下审计用线程与一个 `probe-b-*` 测试用户，需手工清理，不得用于生产。

## 基线测试与构建

| 命令 | 结果 |
| --- | --- |
| `npm test` | 44 项：37 pass，7 skip，0 fail（约 2.3s） |
| `npm run test --prefix web` | 13 文件 / 66 tests 全部通过 |
| `npm run build` | 通过（沙箱无外网时曾因 PostHog `ENOTFOUND us.posthog.com` 失败；完整权限下通过） |

## Docker / 宿主 / ECS

| 项 | 实测 |
| --- | --- |
| Docker CLI / Engine | Docker Desktop，Engine 27.4.0。本机 `nero-agent-postgres`（`postgres:16`）健康 |
| 用户沙箱镜像 / `SANDBOX_IMAGE` | 无 |
| `/data/mastra` | 不存在 |
| 宿主 project quota（XFS/ext4） | 本机为 APFS 开发盘，**未测**；标为部署门禁未完成 |
| ECS 文件系统、进程数、系统账户、生产 Docker socket 权限 | 仓库无声明，本机无法代替；**部署门禁未完成** |
| 本机 Mastra 进程 | 审计时 4111 上有 1 个 `mastra dev` Node 进程（符合 V1 单进程开发形态，不能代表 ECS） |

`compose.yaml` 只定义 PostgreSQL，没有用户容器常驻服务（与计划一致）。

## 与设计假设对照

| 设计假设 | 审计结果 |
| --- | --- |
| core 1.71.0 / memory 1.32.1 / pg 1.28.0 | 一致 |
| `mastra__user` + `resourceId = user.id` | 模型路径一致；`/auth/me` 用 `user` key |
| 前端过滤不是授权 | 一致；服务端线程 CRUD 已有归属拒绝 |
| 空 `resourceId` 线程可被认领 | 当前创建 API 拒绝缺省 resourceId；历史行未查库，Task 2 仍须 fail-closed、不自动认领 |
| 共享管理员 `workspace/` + LocalSandbox | 一致；且未设 `contained: true` |
| 无 AgentController | 代码一致；内置路由存在但无实例 |
| 无 Docker workspace provider | 一致 |
| observational 默认 thread scope | 配置未显式写出；接口返回的观测记录 `scope: thread`（本探针自己的线程） |
| retrieval 可能扩大到 resource | 未在本审计用检索工具打穿；按计划 Task 2 必须显式 thread scope |
| ECS 40GB / 2vCPU 生产形态 | **仓库与本机均无法证实** |

无需因此立刻改设计文档正文；实施时把「ECS 与硬配额」继续当作待落地部署门禁，把「原生线程 CRUD 已有 403」当作 Task 2 的起点（补齐观测/检索/批准/resume/工具 execute 的负面测试，而不是从零假设全部开放）。

## 回滚

删除本文件并去掉 README 中的审计链接即可。无数据库 schema 变化。
