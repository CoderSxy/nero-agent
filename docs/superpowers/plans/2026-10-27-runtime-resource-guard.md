# ECS 资源保护补齐实施计划

> 按已授权的三项 review 修复在当前工作区执行，不修改服务器。

**Goal:** 可靠停车、任务容器统一内核预算、Node 进程外残留回收。
**Architecture:** systemd 父子 slice + Docker 中央策略 + 独立 Python 守护 timer。

- [x] tests/runtime-resource-guard.test.ts：先复现监测失败不停车，再修复采样错误和信号停车；另覆盖停止失败时的明确紧急意图。
- [x] src/mastra/sandbox/workload-policy.ts：统一父 slice/owner 标记/宿主余量检查；docker/client.ts 接 create/start/exec；provider/network 处理旧策略复用；低内存与四类入口测试。
- [x] scripts/ops/runtime-guard.py：preflight、正常巡检、危急熔断、标签筛选和 Docker 不可用 cgroup.kill；用隔离 fixture/runner 验证，无生产连接。
- [x] deploy/systemd：父子 slice、独立 guard service/timer、主服务 preflight/StopPost/防 OOM 自动再启动；发布包断言包含这些文件。
- [x] 文档写明 PostgreSQL 内存设置/备份要求、既有工作容器处理、timer 安装、熔断恢复和 Linux 验收；不自动修改 PostgreSQL/启用生产。
- [x] targeted tests、全量 npm test、tsc、后端构建、Python/shell 语法、独立 review；明确未执行 Linux 实机验证。

## 实施与验证记录

- 新增 8 项针对性测试，覆盖监测指标错误停车、四类容器统一父组、旧 invocation 拒用、中央适配器 create/start/exec 接线、宿主与聚合预算拒绝、独立回收保留数据库、preflight 生效限额/数据库位置校验、停车失败的紧急意图、累计超时熔断（部分场景合并在一个测试内）。
- 复审发现并修复两项遗漏：普通 guard 不能代替明确 emergency 请求；每条命令成功也可能累计超过 systemd 超时，现有全局截止时间并提前熔断。最终独立复审无剩余阻塞问题。
- 最终 npm test：683 项，629 通过、54 跳过、0 失败。为隔离文件测试设置 WORKSPACE_DISK_BLOCK_RATIO=0.99，且允许代理测试本机回环网络；产品默认阈值未改变。受限网络下最初两个 proxy 测试失败，获得回环测试权限后完整重跑通过。
- TypeScript noEmit、npm run build:mastra、Python AST、shell 语法、git diff --check 通过。
- 修正 .dockerignore 对 deploy/systemd 的排除，新增保护模板才能进入 Linux 发布上下文；排除 Python __pycache__/pyc，发布脚本断言包含 guard/emergency、slice 和 timer。
- 未运行完整 Linux/amd64 发布归档构建；未操作 ECS、数据库限额、systemd 或线上工作区。真实 cgroup 生效、Docker driver、PPT 运行峰值、OOM 和异常退出回收需按恢复手册在部署阶段验证。
