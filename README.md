# nero-agent

基于 [Mastra](https://mastra.ai) 的本地智能体平台。智能体可搜索网络、处理工作区文件、执行经批准的命令，并创建周期性定时任务。

## 启动

先启动本地 PostgreSQL，并执行用户表迁移：

```sh
npm run db:local:setup
```

首次本地设置会把数据库连接写入被 Git 忽略的 `.env`，容器凭据保存在 `.env.postgres`。本地容器使用 `postgres:16`，监听 `127.0.0.1:5433`；数据保存在 Docker 命名卷。上线时设置 `DATABASE_URL` 指向生产 PostgreSQL，并在发布应用前运行 `npm run db:migrate`。

在 `.env` 中配置 `TAVILY_API_KEY`、`MODEL_CONFIG_ENCRYPTION_KEY` 和 `MODEL_ENDPOINT_ALLOWLIST`（见下文「模型目录」），然后运行：

```sh
npm run dev
```

用户页面打开 [http://localhost:5173/agent/new](http://localhost:5173/agent/new)；Mastra Studio 位于 [http://localhost:4111](http://localhost:4111)，使用与用户页面相同的邮箱和密码登录，仅管理员账号可进入。Studio 登录不开放注册，通过仅供 Studio 使用的 HttpOnly 会话 Cookie 保持登录；普通用户仍可登录 5173 页面。Studio 界面常用文案由项目中间件汉化；尚未实现的 Workflows 导航入口已隐藏。Mastra Studio 是依赖包提供的界面，升级 Mastra 后可能需要补充或调整 [汉化映射](src/mastra/studio-zh.ts)。

ECS 生产环境没有 Mastra EE 授权时，Studio 使用官方 `SimpleAuth` 加服务器端 Nginx 网关。管理员仍用原账号登录用户页面；进入 Studio 前，应用签发同域 HttpOnly Cookie，Nginx 用它验证现有管理员会话，并在内部转发时加入 `.env` 中的 `STUDIO_PROXY_KEY`。浏览器不会收到该密钥。ECS 需同时配置 `STUDIO_PROXY_KEY`、`STUDIO_ADMIN_USER_ID`，并在 HTTPS 站点中包含 [Studio 网关配置](deploy/nginx-studio-gateway.conf)。

用户页面需要登录。首次开发环境已创建管理员和普通用户测试账号，凭据只保存在 Git 忽略的 `.local-accounts` 文件中。新环境可通过 `NERO_USER_PASSWORD` 环境变量运行 `npm run user:create -- <邮箱> <显示名> <admin|user>` 创建首位管理员；之后管理员可调用 `POST /auth/users` 创建用户。当前不开放自助注册。登录会话在浏览器当前标签页保存，退出登录会撤销服务端会话。

若本地已有旧 LibSQL 会话，可在创建管理员并启动 Mastra 后执行 `npm run db:import:libsql -- <旧数据库路径> <管理员邮箱>`。导入脚本把旧会话、消息、观测记忆和线程状态归到指定管理员，重复执行不会复制已有记录；原 LibSQL 文件不会删除。

独立页面使用 `@mastra/playground-ui` 的会话、消息、Composer、工具批准和卡片组件，并使用 `@mastra/react` 的 `useChat` 管理流式回复。Composer 左下角提供可搜索的模型列表，按公共模型和个人模型分组；模型选择保存在会话元数据中，刷新后仍然有效。新会话使用公共默认模型，管理员必须配置一个启用的公共默认模型。主题选择保存在当前浏览器中。可选模型全部来自服务端模型目录（`GET /model-catalog`）。构建前端使用 `npm run build:web`，构建全部使用 `npm run build`。

## 模型目录

模型分为两类，均只支持 OpenAI 兼容的聊天接口，API Key 在服务端以 AES-256-GCM 加密保存，浏览器、会话元数据和列表接口都拿不到明文：

- **公共模型**：由管理员维护，所有登录用户可选。
- **私有模型**：每个用户在独立页面维护，仅本人可见、可选、可调用。

### 配置

| 环境变量 | 说明 |
| --- | --- |
| `MODEL_CONFIG_ENCRYPTION_KEY` | 必填。32 字节密钥的 Base64 编码，例如 `openssl rand -base64 32`。数据库备份不含该密钥；密钥丢失后已保存的模型 Key 无法解密，需重新录入。本版不提供密钥轮换。 |
| `MODEL_ENDPOINT_ALLOWLIST` | 必填。逗号分隔的 HTTPS 源（origin），例如 `https://api.deepseek.com,https://api.openai.com`。唯一可用的 HTTP 例外是完整 Base URL `http://101.37.135.116:7864/v1`，也必须逐字加入此列表；其他 HTTP 地址仍被拒绝。模型请求限制在所选 Base URL 下，拒绝重定向；建立连接时检查全部 DNS 解析结果，拒绝环回、内网、链路本地和云元数据地址。HTTP 连接中的 API Key 和请求内容不受传输加密保护。 |

### 迁移与首次启用

1. 运行 `npm run db:migrate`，创建 `app_public_models` 和 `app_private_models`（可重复执行）。
2. 先创建管理员（见上文 `npm run user:create`），再启动服务。
3. **在使用 Studio 或让用户聊天之前，管理员必须先创建至少一个公共模型并设为默认。** 原 `.env` 中的供应商 Key 不会自动导入，也不再被使用；没有公共模型时，Studio 中运行 Agent 会提示「请先配置公共模型」，但用户仍可在独立页面使用自己的私有模型。

### 管理入口

- 公共模型：[http://localhost:4111/model-admin](http://localhost:4111/model-admin)，也可从 Studio「设置」中的「公共模型管理」进入。该页面需要管理员用 `/auth/login` 单独登录一次，令牌只保存在当前标签页。
- WorkBuddy 国内版模型同步：先在公共模型管理中手动配置一个 Base URL 为 `http://101.37.135.116:7864/v1`、带有效网关 API Key 的公共模型，并将该完整 URL 加入 `MODEL_ENDPOINT_ALLOWLIST`。再到 WorkBuddy「设置 → 访问令牌」创建只读管理 API Token（`wbt_` 开头），在同步区临时输入。预览和确认分别读取 `GET /api/model-catalog?realm=cn&force=false`，仅使用模型中心国内版目录，管理员可勾选新增模型并修改显示名称。管理 Token 只在当前页面内存中保留至同步完成，不写入数据库或浏览器存储；新模型复用已配置模型的加密网关 Key。已有及仅本地存在的模型不会被覆盖或删除。当前同步地址固定为 HTTP，管理 Token 传输未经 TLS 保护；公网使用前需把同步端点及允许列表一同改为 HTTPS 地址。
- 私有模型：独立页面左下角「设置 → API Key 管理」，可添加、编辑、替换 Key、停用和删除本人模型。编辑时留空 Key 表示保留原 Key。

### 旧会话

旧会话元数据中保存的是 `provider/model` 字符串。读取时只有恰好一个启用的公共模型的 `providerId/modelId` 与之相同才会自动转换为新的模型引用；没有匹配、有多个匹配、或匹配的是私有模型时，历史消息仍可查看，但输入框会提示「该会话使用的模型已不可用」，需要在「设置」中重新选择会话模型和记忆模型后才能继续发送。删除或停用当前会话正在使用的模型同理。新接口不再接受 `provider/model` 字符串作为模型引用。

可以尝试：

- 查询这个周末的天气。
- 制作一个日本樱花节活动页面。
- 查询 SPCX 股价，并设置定时提醒。

`web_search` 使用 Tavily 搜索，`web_fetch` 用于读取已知网址。普通用户默认仍只有聊天和网络工具。用户文件 API、每用户工作区和 `execute_command` 均有独立开关，默认关闭。管理员修改文件或运行命令前会请求批准。

## 工作区与存储

每用户工作区根目录为 `$WORKSPACE_ROOT/users/<UUID>/workspace`（默认 `WORKSPACE_ROOT=/data/mastra`），线程文件在 `threads/<threadId>/{input,output,tmp}`。`WORKSPACE_RESOLVER_ENABLED=true` 时，管理员 Workspace 使用该用户目录上的 `LocalFilesystem({ contained: true })`。Mastra 原生命令与文件系统工具已关闭；受控文件工具走 `FileService`。

### 容量与附件

- **新上传单文件上限**：`10 MiB`（`10 × 1024 × 1024` 字节）。前后端均校验；超限错误码 `FILE_TOO_LARGE`，前端预检文案为「文件超过 10 MiB 上限：文件名」，服务端常见响应为「文件过大」。
- **个人工作区上限**：每位用户整个个人工作区 `500 MiB`（`500 × 1024 × 1024` 字节）。超额错误码 `WORKSPACE_QUOTA_EXCEEDED`，默认文案「工作区配额已满」。容量以服务端扫描/对账为准；`source=agent` 旧工作区不计入个人配额。
- **Composer 附件**：加号支持「上传文件」「选择工作区文件」「添加图片」；拖入/粘贴图片会先上传再加入本次消息。选择已有工作区文件只登记引用、不复制。从本次消息移除卡片**不删除**工作区原件。每条消息最多 10 个附件。
- **删除**：右侧工作区支持单项与批量删除（仅个人来源）。确认后不可恢复；父子路径会折叠去重。工作区根及 `shared/`、`uploads/`、`projects/`、`threads/` 与线程 `input/`、`output/`、`tmp/` 目录本身受保护，不可删。历史消息仍显示当时的名称/大小；原件删除后显示「文件已删除」。
- **视觉模型**：公共/私人模型目录有显式布尔字段 `supportsVision`（迁移后既有模型默认 `false`，不可按模型名猜测）。发送含图片附件时，Composer 在所选模型未开启视觉时阻断并提示「当前模型不支持图片，请切换支持图片的模型」；服务端 `read_attached_file` 同样核验该字段。管理员在公共模型管理、用户在私有模型设置中勾选「支持图片」。
- **消息持久化**：消息与工具 transcript 只保存附件 ID/路径/元数据，不保存图片 base64。

启用前先运行 `npm run db:migrate`（含 `app_workspaces`、附件引用表与 `supports_vision` 等）。列表/删除后服务端会扫描磁盘对账配额；上线前还需按部署文档检查宿主磁盘与 project quota，主机磁盘保护（使用率告警/阻断）独立于个人 500 MiB，不能绕过。

### 文件 API 与部署门禁

认证文件 API（`USER_FILES_ENABLED=true`）提供：

- `POST /user-files/upload`（multipart：`threadId`、`path`、`file`）— 兼容旧线程路径
- `POST /current-workspace/upload` — Composer 个人工作区上传（`uploads/<UUID>/<安全文件名>`）
- `GET /user-files/:threadId` 列出当前会话文件；`GET|DELETE /user-files/:threadId/*`
- `GET /current-workspace/files`（含目录递归大小与个人 `usage`）、附件准备/列表、`POST /current-workspace/files/batch-delete`

路径经服务端校验线程归属与路径安全。独立页面可在对话区上传、引用并下载。智能体应返回 `/user-files/...` 或附件 ID，不再生成宿主 `file:` URL。

**部署门禁不变**：本功能不自动开启未验证的沙箱文件写入。`USER_FILES_ENABLED`、`SANDBOX_COMMANDS_ENABLED`、`SANDBOX_FILE_WRITE_ENABLED` 仍须按 [ECS 工作区与沙箱发布](docs/deployment/workspace-sandbox-ecs.md) 完成宿主配额实测后再打开。`execute_command` 需 `SANDBOX_COMMANDS_ENABLED=true`；Docker 实现还需 `SANDBOX_PROVIDER=docker` 与 digest 固定的 `SANDBOX_IMAGE`。宿主项目配额未实测前保持 `SANDBOX_FILE_WRITE_ENABLED=false`。基线审计见 [工作区沙箱审计](docs/architecture/workspace-sandbox-audit.md)。

独立页面右侧“工作区”展示当前 Agent 实际使用的工作区目录树，包含所有层级的目录和文件，并可刷新、下载、删除。个人工作区使用 `GET /current-workspace/files` 和 `GET /current-workspace/files/*`；本地回退的 `agent-workspace` 使用相同路径加 `?source=agent`，仅管理员可访问（只读文件管理，不可批量删除）。文件列表是整个工作区的内容，不局限于当前会话。启用个人工作区时应将 `WORKSPACE_ROOT` 指向服务进程可写的持久目录。

本地开发要让 Agent 实际保存文件，可在被 Git 忽略的 `.env` 中设置 `WORKSPACE_ROOT=<项目绝对路径>/.local-workspaces`、`WORKSPACE_RESOLVER_ENABLED=true` 和 `USER_FILES_ENABLED=true`，然后重启 `npm run dev`。`write_file` 只需要相对路径和内容；会话 ID 从 Agent 运行上下文获取，文件保存到当前用户当前会话目录。部署环境应使用独立的持久化目录，并按 [ECS 工作区与沙箱发布](docs/deployment/workspace-sandbox-ecs.md) 完成门禁后再启用。

PostgreSQL 保存用户、角色、权限、登录会话，以及 Mastra 的会话记忆等数据。`app_permissions` 与 `app_role_permissions` 目前只建表，细粒度权限数据留待后续迭代。开发环境的可观测性仍使用 DuckDB；正式部署时应按流量改为 PostgreSQL 或 ClickHouse。定时任务会持续消耗模型用量，直到暂停。

## 修改项目

- [智能体配置](src/mastra/agents/agent.ts)：模型、指令、记忆、工作区及工具。
- [Mastra 入口](src/mastra/index.ts)：注册智能体与工具，配置存储、可观测性和中间件。
- [Studio 汉化](src/mastra/studio-zh.ts)：界面文案与 Workflows 导航处理。
- [工具目录](src/mastra/tools/)：搜索与定时任务。

目前没有项目自定义的 workflows 目录，也没有注册 workflow。Mastra Studio 自带的 Workflows 页面属于上游依赖，项目通过汉化中间件隐藏其导航入口。
