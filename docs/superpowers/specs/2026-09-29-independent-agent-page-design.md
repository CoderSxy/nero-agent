# 独立 Agent 页面设计

日期：2026-09-29  
状态：已由用户确认

## 目标与现状

在当前 `dev_sxy1` 分支新增面向普通用户的独立 Agent 页面，同时保留现有 Mastra Studio 页面及其行为。当前仓库只有 Mastra 后端、Studio 汉化中间件和一个通用 Agent；没有受版本控制的业务前端源码。此前在临时目录验证过 `@mastra/playground-ui@59.0.0` 的 Composer、ThreadList、ChatShell、Message、MarkdownRenderer 和 SectionCard 可以在独立 React 页面打包及渲染，模拟文本也能逐步显示。该验证不等于真实 Agent 流式对话已通过。

普通用户的首要任务是发起并继续对话、理解 Agent 的执行过程、批准需要确认的工具操作。页面应保留 Studio Agent 页受欢迎的视觉与交互基础，同时独立控制布局和后续产品导航。

## 范围

- 用户路由：`/agent/new` 和 `/agent/:threadId`。根路径可跳转 `/agent/new`，不接管 Studio 的 `/agents` 路由。
- 左侧：新建会话、会话列表、当前会话、列表加载和错误状态。
- 中间：欢迎态、消息、流式文本、工具调用、待批准操作、Composer、发送、停止和错误反馈。
- 右侧：只读 Config，展示 Agent 概要、模型、工具、工作区、记忆和说明；支持展开或收起。只呈现服务端确实返回的信息。
- Studio 仍由现有 Mastra 服务提供，现有汉化中间件不因新页面而改变。

第一版不实现登录、多用户隔离、Agent 配置编辑、模型切换、追踪面板或评分器入口。因此第一版仅适合当前本地单用户用法；公开给多用户前必须另行设计身份认证、会话所有权和工作区隔离。

## 架构与边界

新建 `web/` React + Vite 前端。开发模式使用独立端口提供 `/agent/*`，将 `/api/*` 代理到现有 Mastra 服务；Studio 继续在现有端口和路由运行。项目根 `dev` 与 `build` 脚本可编排两个子项目，但不得改变 Studio 的 HTML、导航和 API 行为。生产环境若采用同一域名，则由部署层分别路由 `/agent/*`、静态资源和 Mastra `/api/*`；本设计不要求立即部署。

复用粒度严格为“组件 + Hook”：

| 区域 | 复用 | 本项目负责 |
| --- | --- | --- |
| Composer | `@mastra/playground-ui/components/Composer` | 草稿、提交、禁用与停止操作 |
| 会话列表 | `@mastra/playground-ui/components/ThreadList` | 查询、创建、选择、排序及路由 |
| 会话区域 | `ChatShell`、`Message`、`MarkdownRenderer`、公开的工具与批准组件 | 消息分组、各类消息部件、流式状态和异常状态 |
| 对话逻辑 | `@mastra/react` 的 `useChat` | 绑定 agent、resource、thread 与页面状态 |
| Config | `SectionCard`、`SettingsRow` 等基础组件 | 从 Agent 详情组装只读面板及折叠交互 |

不导入 Studio 的打包资源作为业务组件，不使用 iframe，不复制 Studio 内部未公开组件源码。`@mastra/playground-ui` 没有公开完整 Agent 页面或完整 Config 面板，因此不能承诺像素级和交互细节完全一致。

## 数据流

1. 前端通过同源 `/api` 建立 Mastra Client 和 `MastraReactProvider`；固定使用当前注册的 agent id `agent`。
2. 实施前对照当前 Studio 请求，确认 `resourceId` 与 thread 规则。独立页必须按同一作用域查询，不能在未核实前硬编码 `local-user`；是否能与 Studio 显示同一批会话，以实际 API 结果验收。
3. 会话列表由 Client SDK 查询；新建后进入 `/agent/:threadId`。打开已有会话时加载其消息，失效的 thread 返回新建页并给出可理解的提示。
4. `useChat` 以当前 `agentId`、`resourceId`、`threadId` 运行。发送使用 stream 模式；运行中消息随 Hook 更新，不由 UI 再实现一套 SSE 解析器。
5. 工具部件按公开的消息类型解析，用同源组件显示；批准、拒绝和停止操作调用 `useChat` 提供的方法，并将失败反馈留在当前会话。
6. Config 使用 Client SDK 的 Agent 详情和记忆配置接口获取数据；缺失字段显示“未提供”，不从前端猜测系统配置。

## 错误与安全边界

- API 不可用、缺模型密钥或流中断时，保留已显示的用户消息和已收到的部分回复，提供重试或继续操作；不得将错误伪装为完成的回答。
- 工具批准需要明确展示工具名称和操作；批准/拒绝按钮在提交期间禁用，避免重复请求。
- 新页面不暴露可修改模型、提示词或任意工具配置的入口。Config 只读不等于后端安全控制；多用户前必须补上 API 权限。
- 当前 Agent 使用本地共享工作区和 LocalSandbox。本设计不改变其执行边界，也不把页面作为公网可用产品的安全保证。

## 验收

1. `npm run dev` 后，独立页面和现有 Studio 都可打开；Studio 的 Agent、工具和观测页面行为保持原样。
2. `/agent/new` 可以创建真实会话、发送消息并跳转到会话路由；刷新后会话列表与消息可恢复。
3. 使用可用模型密钥验证真实流式回答：文本逐步出现，停止与流中断行为可辨认，重新打开会话后的消息一致。
4. 至少完成一条真实需批准的工具调用，验证批准和拒绝均能更新消息状态；测试不得实际执行危险命令。
5. Config 面板数据显示与 Mastra Agent 详情一致；缺少字段时不会出现虚构配置。
6. 保持当前分支原有测试通过，并通过前端构建与针对会话、流式状态、批准状态的必要测试。

## 实施顺序与风险

按“入口和依赖 → 会话数据 → 真实对话与 Composer → 工具及消息部件 → Config → 双页面回归”逐步交付，每一步都保持可运行。当前 Agent 默认模型为 `openai/gpt-5.6-terra`；真实流式验收需要对应密钥或明确授权切换模型，不能把先前模拟流式结果算作真实验收。

`playground-ui` 的组件接口会随 Mastra 版本变化；前端依赖需与当前 `@mastra/core@1.71.0`、`mastra@1.31.3` 锁定兼容版本。升级时重点回归 Composer、消息部件、工具批准和 Config 布局。
