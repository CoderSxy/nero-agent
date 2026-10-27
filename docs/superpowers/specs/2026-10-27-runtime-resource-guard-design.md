# ECS 运行时资源保护补齐

承接 2026-10-26 存储恢复设计，本次按用户授权直接补齐 review 三项，不部署生产。

选择内核层级 cgroup 加独立看门狗。仅用 Node 内存计数器不能覆盖 Node OOM 后继续运行的 Docker 容器；单纯缩小各容器内存也不能约束叠加总量。

- Node 放入 nero-runtime.slice；所有普通沙箱、技能执行、readiness 探针、egress 容器统一 CgroupParent=nero-runtime-workloads.slice。父 slice MemoryMax=960M，任务子 slice=512M，Node 自身=512M；父级总和约束优先于子级。PostgreSQL 单独要求非零且不超过 384M 的实际容器上限，swap 等于 memory。该预算是当前小规格机起点，不能保证所有 PPT 在限额内完成。
- 应急 profile 显式打开 NERO_RESOURCE_GUARD_ENABLED，Docker 中央适配器在 create/start/exec 入口统一校验，避免漏掉探针。新容器携带 systemd InvocationID；复用容器必须匹配本次进程及父 slice。生产启动 preflight 清掉旧工作容器，再校验真实 cgroup v2、systemd driver、生效的父子内存上限、timer 和 PostgreSQL 限额，缺项拒绝启动。
- 新任务启动要求 MemAvailable 至少为 256M 留量加该容器预算，同时检查父/子组剩余额度。内核总上限是并发检查竞争时的最终约束，可能导致任务 OOM，但不会扩大工作负载的允许总量。普通沙箱空闲停止降至 60 秒。
- 独立 Python 标准库脚本由 root systemd timer 每 15 秒执行，放在应用 slice 外；服务非 active/activating、采样失败、内存低或旧 invocation 工作负载时回收四种应用容器。正常停服后也由 ExecStopPost 请求该独立单元运行。只选择应用专用标签，不删除 volume/工作区，不选择 PostgreSQL 或其它容器。
- 危急情况先写 /run 下熔断标记，阻止 Node 新建/使用任务；停止应用并回收容器。Docker 不可用时尝试固定任务子 slice 和应用 unit 的 cgroup.kill（不杀父 slice），避免依赖已死 Node 的 finally/定时器。熔断标记只能人工确认后移除；应急 profile 使用 Restart=no，不在 OOM 或其它失败后自动重启；保留手动启动频率限制。
- monitor.sh 指标命令失败、异常退出和信号都走停车路径；停车失败请求独立 emergency 单元，避免丢失紧急意图。guard 总采样预算 20 秒，紧急清理预算 12 秒，低于 systemd 45 秒硬超时；超时/终止也进入紧急路径。不能由 set -e 绕过停车。停止失败明确非零记录，并请求独立守护执行。资源保护未安装不允许当作已启用。

验证：先复现监测错误不停服；四类容器统一策略、旧容器拒绝、低可用内存拒绝；看门狗在 Node 停止/旧代容器/指标及 Docker 错误下回收，保留当前健康容器和数据库；打包/类型/回归。Linux slice 的真实限制、Docker driver 和 PPT 峰值仍在部署时受控实测，本机 macOS 不能替代。
