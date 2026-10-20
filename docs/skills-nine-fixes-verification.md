# Skill 九项审查问题修复记录

日期：2026-10-19。对应上一轮审查的九个问题；保留 Cursor 已实现的技能、会话、沙箱和移动端功能，不提交或推送。

## 修复与回归对应

| 问题 | 修复 | 回归证据 |
| --- | --- | --- |
| 权限编辑清空旧授权 | 管理详情回传真实 grants/audienceIds；权限组件用服务器 grants 初始化，支持显式新增/删除 | SkillPermissions/SkillsPage 组件测试；skills-review-fixes 的真实DB授权回读及分类更新 |
| GC 删除刚回滚/固定/引用的资源 | 应用读写操作持有共享存储 lease；GC取得跨实例排他 PostgreSQL advisory lease后重新扫描；不以旧inventory授权删除 | skills-gc-race：回滚、新pin、新引用；两个独立PG连接验证发布期间GC必须等待；storage-lock重入/异常释放；恢复读取与续期锁覆盖、续期失败释放及SQL范围约束 |
| pin 写失败仍成功 | 持久化成功后才更新上下文；采用数据库返回的实际pin，不覆盖同执行既有版本；失败返回不可用 | skills-review-fixes：注入pin写入错误，ctx保持空；同execution新ctx在v2发布后仍加载v1 |
| 后端类型检查失败 | skills导入改为项目现有的无扩展名形式；修正ZIP Entry判别、YAML参数、Processor返回类型；修正阻塞全量检查的附件/定时错误类型 | 根目录tsc --noEmit；附件与定时测试随全量回归运行 |
| 逐文件修改运行声明不生效 | 上传/删除skill-runtime.json同步draft JSONB；发布以真实资源重新解析并校验entrypoints，在指针事务写入最终声明 | skills-review-fixes：上传、非法JSON、删除、旧JSONB缓存、缺入口拒绝、发布后正确声明 |
| 自动技能在压缩后丢正文 | 记录真实成功load；恢复时从可信execution的pins与load事件恢复；重新鉴权并检查预算；搜索发现的pin不会变成指令激活 | skills-long-conversation真实Mastra+mock模型；skills-review-fixes在全新RequestContext恢复正文且不注入SEARCH_ONLY_MARKER |
| 第51项之后无法选择 | 完整分页目录成功后才判定撤权；分页失败保留选择，跨页标签正常 | SkillPicker：搜索第51项、快捷恢复、刷新和分页失败 |
| 缺存储配置静默写/tmp | 去掉fallback；enabled缺root明确失败；disabled入口不初始化runtime且不要求DB/root | skills-factory开关/配置/单例测试 |
| 在线上传绕过版本限制 | 技能行锁事务内校验完整集合：含SKILL.md的1000文件、200MiB、单文件、NFC/大小写碰撞；发布再次兜底 | skills-review-fixes：三个80MiB声明、1000资源、碰撞、失败事务保留原集合；不创建大文件消耗磁盘 |

## 实现说明与部署

- `src/mastra/skills/storage-lock.ts` 使用独立的协调连接池（每个应用Pool最多2条连接，allowExitOnIdle），避免锁等待者占满业务查询池导致自锁。AsyncLocalStorage使同一异步操作的嵌套服务/发布调用共享lease；禁止读锁升级。解锁失败时销毁连接。
- 共享lease覆盖资源写入或校验直到元数据提交；CLI导入和启动reconcile也参与协调。会话pin读取和续期整体持有同一共享lease；只续期本次读取到的有效pin，避免复活已过期且资源可能已被清理的其他pin。续期失败直接报错，不返回未获保护的恢复上下文。GC只在显式apply时删除，dry-run仍只预览。
- 正文恢复通过成功load审计记录区分“实际加载”与“搜索候选”。该恢复状态写入不能作为可丢弃遥测处理；写失败不返回加载成功。部分索引`013_skill_load_recovery_index.sql`支持恢复查询，部署执行`npm run db:migrate`；不修改已执行迁移。
- 普通用户仍不获得管理员Workspace；脚本网络仍关闭。没有开放Docker目录或网络，没有新增任意命令执行入口。
- 原有鉴权与版本语义保持：发布不会改变活动execution版本；禁用/撤权后恢复时拒绝正文；历史已返回内容无法撤回。

## 验证记录

以下结果随最终运行更新；未跑的真实模型/浏览器不能标为通过。

- 技能后端（含本地PostgreSQL）：125 tests，119 pass，0 fail，6项真实Docker默认跳过。
- 前端定向（技能、AgentChat、MessageList）：114 pass。
- 根目录TypeScript：检查通过，无诊断。
- 根目录全量：459 tests，373 pass，48 fail，38 skipped；48项仍是已记录的磁盘保护相关基线失败。
- 前端全量：最终单worker运行54 files / 382 pass / 0 fail。并行构建期间发生过5秒超时（一次中止、一次仅Mermaid超时）；停止资源竞争后重跑通过，未放宽测试超时。
- 前端 `npm run build:web`：通过（Vite含大chunk提示，无构建错误）。后端 `npm run build:mastra`：在/tmp源副本、Node22.22.0下通过。初轮依赖安装被网络限制阻断，后续允许访问锁定依赖后完成；临时目录已清理，用户运行中的Mastra输出不变。
- 真实Docker：7 pass / 0 fail / 0 skip。使用已存在镜像 `sha256:e4cbba692d0ee123704f9fb3ed9508fb9cecb66cfe5603890cc891096b13f937`、专用临时workspace/storage；测试进程单独设置磁盘阈值1以隔离宿主91%占用，不改变应用配置。覆盖只读挂载、产物、跨用户拒绝、无网、中止清理及共享命令队列。
- 真实模型、浏览器：本轮未重新验收；指令恢复的模型边界测试使用真实Mastra和mock provider，不能当成真实模型效果测量。
- 已在本地数据库通过项目 `npm run db:migrate` 应用013索引；生产环境仍需执行同一迁移。
