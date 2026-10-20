# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

管理员开户的小范围用户：一位管理员负责创建账号、维护公共模型目录与部署环境，普通用户在日常工作场景中长时间打开浏览器使用。不是对外开放自助注册的多租户产品；接入靠管理员创建账号（`npm run user:create`、`POST /auth/users`）。

## Product Purpose

基于 Mastra 的自托管智能体平台。智能体可以搜索网络、读写工作区文件、在批准后执行命令，并创建周期性定时任务。成功意味着同一个会话能持续承担实际工作：产出文件落在工作区、按约定周期自动执行，而不是一次性的问答。

## Positioning

**工作区 + 定时任务的闭环**：在同一个会话里完成查找、编辑、落盘，并让任务按周期自己跑起来。通用聊天客户端做不到文件持续存在与无人值守执行；其他自托管智能体平台缺少这种会话级的文件与调度一体。

自托管模型目录（公共/私有模型、密钥服务端加密、OpenAI 兼容端点）是支撑条件而非卖点。

## Operating Context

- 用户页面在 `5173`，Mastra Studio 在 `4111`；两者同一账号体系，仅管理员可进 Studio。
- 登录会话保存在浏览器当前标签页，退出登录撤销服务端会话。
- 模型只支持 OpenAI 兼容聊天接口；管理员必须先配置至少一个启用的公共默认模型，否则聊天与 Studio 运行都会失败。
- 每个用户拥有独立工作区；文件按用户 + 会话落盘，右侧面板可浏览、刷新、下载、删除。
- 定时任务会持续消耗模型用量，直到被暂停。
- 生产形态是 ECS 单机：PostgreSQL、Docker 沙箱、Nginx Studio 网关；开发环境可观测性用 DuckDB。
- 界面以中文为主，英文只作为技术标识保留。

## Capabilities and Constraints

**已确认能力**
- 网络搜索（Tavily）、工作区 `glob` / `grep` / `read_file` / `edit` / `write_file`、附件读取、经批准的命令执行、周期性定时任务。
- 公共模型由管理员维护，所有登录用户可用；私有模型每人独立维护，仅本人可见、可选、可调用。
- 模型 API Key 以 AES-256-GCM 服务端加密保存；浏览器、会话元数据、列表接口都拿不到明文。
- `MODEL_ENDPOINT_ALLOWLIST` 限定 HTTPS 源，拒绝重定向，建立连接时检查全部 DNS 结果，拒绝环回、内网、链路本地与云元数据地址。
- `edit` 需要 `expectedEtag`，零次/多次匹配或版本冲突（`STALE_VERSION`）时拒绝写盘。

**约束与未决**
- 不开放自助注册。`app_permissions` 与 `app_role_permissions` 只建表，细粒度权限尚未启用。
- 沙箱能力默认关闭：`USER_FILES_ENABLED`、`SANDBOX_COMMANDS_ENABLED`、`SANDBOX_FILE_WRITE_ENABLED` 未完成宿主配额实测前不得打开。
- 没有自定义 Workflows；Studio 自带的 Workflows 导航由汉化中间件隐藏。
- 模型密钥不支持轮换；密钥丢失后已保存的 Key 无法解密，需重新录入。
- 是否面向外部多用户演进未确认。

## Brand Commitments

- 名称固定为 **nero-agent**。
- 中文优先：界面文案、错误提示、文档默认中文。
- 不虚构用户案例、客户、基准数据或价格。

## Evidence on Hand

- `README.md`：完整功能、部署与门禁说明。
- `docs/`：架构、部署、验证记录与截图（`docs/screenshots/`）。
- `tests/`：认证、工作区配额、附件、定时任务、Markdown 渲染等行为测试。
- 上游依赖提供 Studio 界面，项目只做汉化映射（`src/mastra/studio-zh.ts`）。
- 缺口：无真实客户证言、公开基准、定价素材；后续工作不得编造。

## Product Principles

1. **持续工作优先于单次问答。** 文件、记忆、调度留在原地，会话是可回来的工作台。
2. **权限默认关闭，显式开启。** 沙箱与写入只有通过验证的门禁才放行。
3. **凭据不出服务端。** Key 加密保存，任何前端载荷只出现模型标识。
4. **中文是默认语言。** 不是翻译层，是界面本身。
5. **写入必须可验证。** 版本化编辑、配额与审计优先于便利。
