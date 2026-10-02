# nero-agent

基于 [Mastra](https://mastra.ai) 的本地智能体平台。智能体可搜索网络、处理工作区文件、执行经批准的命令，并创建周期性定时任务。

## 启动

先启动本地 PostgreSQL，并执行用户表迁移：

```sh
npm run db:local:setup
```

首次本地设置会把数据库连接写入被 Git 忽略的 `.env`，容器凭据保存在 `.env.postgres`。本地容器使用 `postgres:16`，监听 `127.0.0.1:5433`；数据保存在 Docker 命名卷。上线时设置 `DATABASE_URL` 指向生产 PostgreSQL，并在发布应用前运行 `npm run db:migrate`。

在 `.env` 中配置模型供应商的 API Key 和 `TAVILY_API_KEY`，然后运行：

```sh
npm run dev
```

用户页面打开 [http://localhost:5173/agent/new](http://localhost:5173/agent/new)；原 Mastra Studio 保留在 [http://localhost:4111](http://localhost:4111)。Studio 界面常用文案由项目中间件汉化；尚未实现的 Workflows 导航入口已隐藏。Mastra Studio 是依赖包提供的界面，升级 Mastra 后可能需要补充或调整 [汉化映射](src/mastra/studio-zh.ts)。

用户页面需要登录。首次开发环境已创建管理员和普通用户测试账号，凭据只保存在 Git 忽略的 `.local-accounts` 文件中。新环境可通过 `NERO_USER_PASSWORD` 环境变量运行 `npm run user:create -- <邮箱> <显示名> <admin|user>` 创建首位管理员；之后管理员可调用 `POST /auth/users` 创建用户。当前不开放自助注册。登录会话在浏览器当前标签页保存，退出登录会撤销服务端会话。

若本地已有旧 LibSQL 会话，可在创建管理员并启动 Mastra 后执行 `npm run db:import:libsql -- <旧数据库路径> <管理员邮箱>`。导入脚本把旧会话、消息、观测记忆和线程状态归到指定管理员，重复执行不会复制已有记录；原 LibSQL 文件不会删除。

独立页面直接复用 `@mastra/playground-ui` 的会话、消息、Composer、工具批准和卡片组件，并使用 `@mastra/react` 的 `useChat` 管理流式回复。左侧底部的「设置」菜单可以为当前会话选择会话模型和记忆模型，也可以切换浅色、深色主题。模型选择保存在会话元数据中，刷新后仍然有效；主题选择保存在当前浏览器中。新会话会优先使用已连接的模型供应商，避免默认模型缺少 API Key 时直接报错。也可以在启动前通过 `VITE_AGENT_MODEL` 指定新会话偏好的模型，例如：

```sh
VITE_AGENT_MODEL=deepseek/deepseek-v4-flash npm run dev
```

这个变量只作用于独立页面的新会话默认值，Studio 的 Agent 配置不变。模型菜单里的选择从下一条消息开始生效。构建前端使用 `npm run build:web`，构建全部使用 `npm run build`。

可以尝试：

- 查询这个周末的天气。
- 制作一个日本樱花节活动页面。
- 查询 SPCX 股价，并设置定时提醒。

`web_search` 使用 Tavily 搜索，`web_fetch` 用于读取已知网址。普通用户目前只使用聊天和网络工具；工作区文件、命令、定时任务仅对管理员开放，后续需完成用户独立工作区和沙箱后再向普通用户开放。管理员修改文件或运行命令前会请求批准。

## 工作区与存储

管理员的本地文件工具只在 `workspace/` 内操作。开发模式下，该目录位于 `src/mastra/public/workspace/`。命令也从这里启动，但 `LocalSandbox` 默认不提供操作系统级隔离；生产环境应限制 Studio 入口，仅由可信管理员使用命令能力。

PostgreSQL 保存用户、角色、权限、登录会话，以及 Mastra 的会话记忆等数据。`app_permissions` 与 `app_role_permissions` 目前只建表，细粒度权限数据留待后续迭代。开发环境的可观测性仍使用 DuckDB；正式部署时应按流量改为 PostgreSQL 或 ClickHouse。定时任务会持续消耗模型用量，直到暂停。

## 修改项目

- [智能体配置](src/mastra/agents/agent.ts)：模型、指令、记忆、工作区及工具。
- [Mastra 入口](src/mastra/index.ts)：注册智能体与工具，配置存储、可观测性和中间件。
- [Studio 汉化](src/mastra/studio-zh.ts)：界面文案与 Workflows 导航处理。
- [工具目录](src/mastra/tools/)：搜索与定时任务。

目前没有项目自定义的 workflows 目录，也没有注册 workflow。Mastra Studio 自带的 Workflows 页面属于上游依赖，项目通过汉化中间件隐藏其导航入口。
