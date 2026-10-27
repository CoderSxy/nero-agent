# Agent 存储恢复实施计划

> 按用户授权在当前工作区直接实施。设计见 ../specs/2026-10-26-agent-storage-recovery-design.md。不得在本次实现中自动操作 ECS。

## 1. 观测链路

- 新增 src/mastra/observability/runtime.ts：解析 off/postgres 配置，拒绝缺 URL、同业务库、非法采样/保留期；构造明确拥有连接生命周期的存储和观测配置。
- off 为默认值，移除入口 DuckDB 引用；显式等待初始化后再启动后台对账。
- 可选独立 PostgreSQL，已结束 span 硬缓存/单批写入、超额丢弃、采样、裁剪/脱敏和按日分区维护脚本。
- 先写配置和载荷测试，确认失败，再实现；检查安装版本类型并运行编译。

## 2. 迁移与启动

- 抽取 src/mastra/storage/migrations.ts，保留现有 SQL；增加事务锁、超时和 --check。
- src/mastra/storage/readiness.ts 检查 015 和三表，入口调用，失败不启动 reconcile。
- 用可控 SQL client 测回滚、锁和检查，不访问生产；专用临时 PostgreSQL 中补充真实集成验证，环境不可用须明确记录。

## 3. 备份与保护

- scripts/ops/backup.sh：停服门禁、私有新目录、PG 自定义备份及目录校验、DuckDB 主库/WAL 原样成对复制、hash、完成标记。
- deploy/systemd/nero-agent.service.d/99-resource-protection.conf：宿主内存/CPU/I/O、OOM、启动超时、重启熔断、启动前迁移检查；不自动安装/enable。
- commandQueue 使用已有 SANDBOX_MAX_CONCURRENT，应急 profile=1；测试不同会话遵守全局限制。
- 备份拒绝/成功/部分失败用临时文件和隔离命令桩测试，不写宿主服务配置。

## 4. 发布与受控验收

- Dockerfile.mastra-build 交付新的迁移依赖、maintenance.mjs 和 ops 文件；构建脚本确认必需文件存在。保留现有平台依赖校验。
- 增补恢复 runbook，明确备份→恢复演练→迁移→check→安装保护→一次启动→分阶段测试→人工恢复自启的顺序。
- 提供资源采样与异常即停的验证脚本；默认只监测已手动启动服务，不执行聊天、start 或 enable。
- 更新 .env.example 与原发布文档，普通发布也必须运行 --check。

## 5. 验证完成标准

- 新增回归先失败后通过；npm test；npm run build:mastra；TypeScript 检查区分已有失败。
- bash/sh 语法、git diff --check，核对产物包含运行门禁和维护工具。
- 不把本地单测当成 ECS 已恢复；明确未执行的生产备份、迁移和受控 PPT 验收。

## 2026-10-26 本地实施与验证记录

已完成上述代码、部署脚本、systemd 模板和恢复手册。恢复手册：../../deployment/agent-storage-recovery.md。

- 新增 12 个回归检查：停服/失败备份、目录权限/主库 WAL 配对/hash、不覆盖、备份失败阻止迁移、就绪响应校验、无 DuckDB 入口、观测配置/同库拒绝、载荷裁剪、迁移只读检查/事务回滚、共享队列并发、慢存储准入上限。
- 回归过程中先观察到缺功能失败；慢数据库复现依赖 exporter 同时积压 20 个写入，修复后最多一个写入、128 个保留记录。独立代码评审后复核无阻塞发现。
- 最终 npm test：675 个检查，621 通过、54 跳过、0 失败。执行时仅在测试进程设置 WORKSPACE_DISK_BLOCK_RATIO=0.99，并允许代理测试使用本机回环网络。本机磁盘使用率已达约 90%，原样运行会触发产品默认磁盘保护；未调整产品默认阈值。两个旧磁盘保护测试原来未恢复环境变量，已修复隔离。
- TypeScript noEmit、npm run build:mastra、shell 语法、git diff --check 通过。最终构建依赖没有 DuckDB。两个运维 TypeScript 入口已用与 Dockerfile 相同 esbuild 参数打包检查。
- 本机新建临时 PostgreSQL 14 集群，仅监听临时 Unix socket；真实集成验证从空库/缺 015 快照补迁移、重复 init、通过新 exporter 写入独立观测库、保留维护和 close。不是连接开发或生产数据库。
- 对临时业务库实际 pg_dump/pg_restore 到第三个全新库，并从 /tmp 运行打包 migrate.mjs --check，通过。
- 完整构建后端在临时数据库、独立工作区、技能/沙箱关闭条件下冷启动，/auth/me 返回 JSON 401；SIGTERM 后 exit=0。冷启动还捕获并修正了空 exporter 命名实例被 Mastra 拒绝的问题，现在 off 模式不注册观测实例。
- 未执行 ECS 备份、生产迁移、systemd 安装/重启/自启、真实 PPT 负载；未构建完整 Linux/amd64 发布归档。下次发布使用 scripts/build-release-macos.sh，按恢复手册逐阶段验收。Mac 本机 .mastra/output 不可上传替代 Linux 发布包。
