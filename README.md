# nero-agent

基于 [Mastra](https://mastra.ai) 的本地智能体平台。智能体可搜索网络、处理工作区文件、执行经批准的命令，并创建周期性定时任务。

## 启动

在 `.env` 中配置模型供应商的 API Key 和 `TAVILY_API_KEY`，然后运行：

```sh
npm run dev
```

浏览器打开 [http://localhost:4111](http://localhost:4111)，进入「智能体」开始对话。界面常用文案由项目中间件汉化；尚未实现的 Workflows 导航入口已隐藏。Mastra Studio 是依赖包提供的界面，升级 Mastra 后可能需要补充或调整 [汉化映射](src/mastra/studio-zh.ts)。

可以尝试：

- 查询这个周末的天气。
- 制作一个日本樱花节活动页面。
- 查询 SPCX 股价，并设置定时提醒。

`web_search` 使用 Tavily 搜索，`web_fetch` 用于读取已知网址。智能体修改文件或运行命令前会请求批准。定时任务创建后会返回 ID，可使用该 ID 暂停任务。

## 工作区与存储

本地文件工具只在 `workspace/` 内操作。开发模式下，该目录位于 `src/mastra/public/workspace/`。命令也从这里启动，但 `LocalSandbox` 默认不提供操作系统级隔离；请审查命令批准请求，不要将此模板直接暴露为无认证的公网服务。

默认的 `file:./mastra.db` 保存会话记忆、任务及定时任务。可在 `.env` 中设置 `TURSO_DATABASE_URL` 和 `TURSO_AUTH_TOKEN` 使用 Turso。定时任务会持续消耗模型用量，直到暂停。

## 修改项目

- [智能体配置](src/mastra/agents/agent.ts)：模型、指令、记忆、工作区及工具。
- [Mastra 入口](src/mastra/index.ts)：注册智能体与工具，配置存储、可观测性和中间件。
- [Studio 汉化](src/mastra/studio-zh.ts)：界面文案与 Workflows 导航处理。
- [工具目录](src/mastra/tools/)：搜索与定时任务。

目前没有项目自定义的 workflows 目录，也没有注册 workflow。Mastra Studio 自带的 Workflows 页面属于上游依赖，项目通过汉化中间件隐藏其导航入口。
