# 中文对话外壳设计

日期：2026-09-28  
状态：已被后续方案取代（UI 路径）  
取代说明：产品改为 `@mastra/playground-ui` 组件复用，见 `2026-09-28-playground-ui-agent-shell-design.md`。本文仍保留路由、中文左栏规则与 `/studio` 约定供对照。

## 背景

`nero-agent` 是 Mastra Agent 项目，当前没有自建前端；`npm run dev` 打开的是英文 Mastra Studio（`http://localhost:4111`）。Studio 官方尚无可用的中文 i18n。

目标是做一个类似主流 AI 对话站的中文用户界面：左侧历史会话，右侧 Agent 对话；现有 Studio 保留为后续管理员入口。

## 目标与非目标

### 目标

- 自建中文对话页，通过 Mastra Agent / Memory API 完成完整 Agent 能力（流式回复、工具调用展示、审批）
- 左栏：「新对话」+ 可滚动历史；主标题为会话首条用户提问（可后续改名）；副标题为日期时间
- 新对话发出首条消息后：创建 thread、左栏新增记录、路由进入该 thread
- `npm run dev` 同时启动 Agent/Studio 与外壳；对外一个开发入口
- 用户对话与 Studio 分路由：对话为用户入口，Studio 挂在 `/studio` 供管理查看

### 非目标（第一版）

- 登录 / 多用户
- 附件、语音输入
- 独立「智能搜索 / 深度思考」开关（由 Agent 按需调工具）
- 汉化 Mastra Studio 自身 UI
- 用 iframe 嵌 Studio 对话区（已否决方案 1）

## 方案选择

曾比较三种做法：

1. 同源外壳 + iframe 嵌 Studio 对话区  
2. **自建对话页 + 复用 Agent API（采用）**  
3. 直接 patch Studio 打包产物  

采用方案 2：中文体验与路由可控；Studio 仅作管理端；代价是需在自建 UI 中实现消息流与工具/审批展示。

## 架构

```text
Browser
  ├─ /chat/*          → web/（Vite + React 中文外壳）
  └─ /studio/*        → Mastra Studio（现有）

npm run dev
  ├─ mastra dev       → Agent API + Studio + Memory/LibSQL
  └─ vite (web/)      → 外壳；代理 /api 与 /studio 到 Mastra
```

- `web/`：用户对话 UI  
- `src/mastra/`：Agent、工具、Memory、存储逻辑保持现有职责  
- 第一版固定本地 `resourceId = local-user`  
- Agent id 使用现有注册 id：`agent`

## 路由

| 路径 | 角色 | 行为 |
|---|---|---|
| `/` | 用户 | 重定向到 `/chat/new` 或最近会话（实现时可先固定到 `/chat/new`） |
| `/chat/new` | 用户 | 空会话：欢迎语 + 输入框；左栏「新对话」为当前态 |
| `/chat/:threadId` | 用户 | 加载并展示该 thread；继续对话 |
| `/studio/*` | 管理 | 现有 Mastra Studio，行为不改 |

## 界面

### 布局

- 左栏约 260–300px，可折叠  
- 右栏：欢迎区或消息流 + 底部输入区  
- 第一版仅浅色主题  

### 左栏 `LeftPanel`

- 顶部：「新对话」→ `/chat/new`  
- 中部：`ThreadList` 可滚动  
  - 主标题：自定义标题（若有）→ 否则首条用户提问（过长单行省略，hover 显示全文）→ 再否则「新对话」  
  - 副标题：优先 `updatedAt`，否则 `createdAt`；格式接近现有 Studio（例如 `2026年9月28日 11:12:38`）  
  - 当前会话高亮  
- 底部：不放账号；预留区域即可  
- 改名：第一版可只留菜单入口，实现可紧随小迭代  

说明：Agent 当前开启了 Memory `generateTitle`。左栏展示规则以上述优先级为准，不以自动生成标题覆盖「首条提问」展示；若自动标题与产品规则冲突，实现时优先保证左栏规则（必要时关闭或忽略 `generateTitle` 对左栏的影响）。

### 右栏对话区

- `/chat/new`：居中欢迎文案（例如「想从哪里开始？」）+ 输入框  
- `/chat/:threadId`：消息列表（用户/助手气泡风格固定一种）  
- 能力：  
  - 流式文本  
  - 可折叠推理/思考块  
  - 工具调用卡片（命令输出、搜索结果等）  
  - 需审批工具：内联「批准 / 拒绝」  
- 输入区：多行、发送、进行中可停止；无附件/语音  

## 数据流

### 线程列表

1. 启动与焦点刷新时调用 Memory/Thread 列表 API（`resourceId = local-user`）  
2. 按最近更新倒序  
3. 主/副标题按界面规则映射  

### 新对话首条消息

1. 用户在 `/chat/new` 发送  
2. `createThread`（或等价 API）得到 `threadId`  
3. `history.replace` 到 `/chat/:threadId`；左栏立即插入（主标题=本条提问，副标题=当前时间）  
4. 对该 thread 发起流式对话  

这样刷新与浏览器后退不会回到「未创建的空白新对话」。

### 已有会话

- 进入 `/chat/:threadId`：拉取历史消息并渲染  
- 发送：同一 Agent stream，携带 `threadId` + `resourceId`  
- 流式过程中更新文本/思考/工具卡片；结束后更新左栏副标题时间  

### 工具审批

- 流中出现需审批的 tool call → 卡片展示批准/拒绝  
- 调用 Mastra 审批 API 后继续或中止该轮  

### 持久化

- 会话与消息仍写入现有 LibSQL Memory；外壳不另建会话数据库  
- Vite 将 Agent API 与 `/studio` 代理到 Mastra 进程  

## 错误处理

| 情况 | 处理 |
|---|---|
| Mastra 未就绪 / 代理失败 | 右栏中文错误 + 重试；左栏可保留已加载列表 |
| 无效 `threadId` | 「会话不存在」，回到 `/chat/new` |
| 流中断（网络或用户停止） | 保留已生成内容；输入区可再次发送 |
| 工具失败 | 卡片内错误摘要，不整页崩溃 |
| 审批取消/超时 | 卡片标为已取消，用户可继续发消息 |
| 已创建 thread 但首条 stream 失败 | 左栏保留该会话，可进入重试 |

## 工程与开发体验

- 根 `package.json` 的 `dev`：并行启动 `mastra dev` 与 `web` 开发服务器（如 `concurrently`）  
- 对外一个端口由 Vite（或薄层代理）提供；文档写明用户入口与 `/studio` 管理入口  
- 环境变量：复用现有模型与 `TAVILY_API_KEY` 等；前端仅需 Mastra 基址（开发期走代理）  

## 测试

- 前端：新对话路由替换、左栏标题/副标题映射、列表排序等关键逻辑  
- 手工：`npm run dev` 一条命令；`/chat` 下对话与工具/审批；`/studio` 可打开原 Studio  
- 保留现有 `tests/*.test.ts`；第一版不做大型 E2E  

## 成功标准

1. 一条 `npm run dev` 可同时使用中文对话页与 Studio  
2. 左栏「新对话」与历史行为符合本文；首条消息后路由落到真实 `threadId`  
3. 右侧可完成流式对话，并展示工具调用与审批  
4. `/studio` 仍为完整 Studio，供后续管理使用  

## 后续可选

- Thread 改名、删除  
- 登录与多 `resourceId`  
- 附件 / 语音  
- 更精致的工具结果可视化  
- Studio 管理入口权限控制
)