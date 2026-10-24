# 线上 PPT 技能加载排查（2026-10-24）

## 已取得的线上证据

目标会话：`8e34d9f9-c3af-4c71-998f-245a3b5ca4dd`。

- 技能激活记录显示 `ppt v1 0332be25` 加载成功。
- 后续模型调用 `skill_search`，查询为 `ppt pptx 演示文稿 presentation 幻灯片`，工具返回 `ok: true`、`hits: []`。
- 模型随后用 `pptx`、`powerpoint` 调用加载工具，返回 `SKILL_UNAVAILABLE`。这两个失败记录不能证明 `ppt` 加载失败，也不能直接推导出沙箱或 Docker 权限故障。
- 界面把 `skill_search` 标为“搜索网页”，实际调用的是技能内容检索。

## 已确认并修复的本地问题

`src/mastra/skills/service.ts` 原先对完整 query 做连续字符串匹配。多个同义词组成的查询，只有在文档中原样连续出现才命中。因此上述查询无法通过包含 PPT/PPTX 的技能文档发现 `ppt`。

修改为按空白拆分关键词，命中任一关键词即可返回；保持单关键词大小写不敏感和无命中行为，为完整短语增加相关性分数，摘要定位到实际命中的行。权限复核、发布版本固定、查询长度、摘要预算与结果数限制保持原逻辑。

工具说明明确提示返回正式技能名，应按返回的名称加载，不应猜测别名。前端为技能加载、检索、读取、资源准备和脚本执行提供明确标签。

## 验证

- 新增检索回归：修复前 2 项失败、2 项通过；修复后 4 项全部通过。覆盖线上查询、摘要行号、单词/无结果兼容、未授权/禁用账号隔离。
- 本地真实 PostgreSQL 与模拟模型请求边界：19 项通过，0 跳过。覆盖 selected 技能正文进入模型请求、未授权正文不泄漏、版本固定、审批恢复、长会话与工具加载恢复。
- `MessageList.test.tsx`：47 项通过，含“搜索技能”和“搜索网页”的区分。
- `npm run build --prefix web`：TypeScript 与 Vite 生产构建通过；存在包体积警告，不影响构建结果。

后端验证命令（只允许项目配置的本地 `127.0.0.1:5433/nero_agent` 测试库）：

```sh
node --env-file-if-exists=.env --import tsx --test tests/skills-agent.integration.test.ts tests/skills-runtime.test.ts tests/skills-search-discovery.test.ts tests/skills-long-conversation.test.ts tests/skills-factory.test.ts
npm run test --prefix web -- src/agent/MessageList.test.tsx
```

## 第一阶段线上工作受阻（历史记录，后续已恢复）

第一阶段尚未修改或重启 ECS 服务。后续实际部署及最终状态见本文末尾。

当前会话 Chrome 控制工具不可用；尝试使用现有 SSH 认证访问 ECS，返回 `Permission denied (publickey,password)`。需恢复原 Chrome Workbench 连接或可用的授权服务器连接后继续：

1. 确认 ECS 当前 release 与实际运行配置，不假定本地 `dist` 就是线上现状。
2. 检查该轮加载事件及最终发给模型的请求；诊断只记录技能标签、正文摘要哈希/字节数和工具 schema 字段，避免打印凭证或完整会话。
3. 确认模型为何在激活成功后仍未按技能正文执行。本地请求边界未复现正文丢失，现阶段不能把模型网关、压缩或注入链路认定为根因。
4. 将已验证的检索和标签修复部署到线上，保留旧 release 便于回滚，按正常发布流程重启并检查健康状态。
5. 在独立测试会话复测选择 `ppt`、读取参考、准备资源及输出 PPTX；不要以徽标成功替代执行验证。

在完成上述验证前，不能声称线上技能问题已全部修复。

## 2026-10-24 上午 ECS 磁盘告警补充

用户提供的事件：`Instance:StoragePerformanceReachLimit:Executed`，原因 `SysDiskBPS`，本地时间 2026-10-23 23:37:24。用户确认当时正在测试工作区生成 PPT。

重新接管 Chrome 后，通过已有 Workbench root 会话完成只读检查：

- ECS 仍运行 `/opt/nero-agent/releases/20261023T014926Z-sandbox-scope`，`nero-agent` 为 active。
- `/dev/vda3`：40G，使用 23G，剩余 16G，使用率 60%。`/data/mastra` 为 `/dev/loop0` 上的 8G XFS，使用 189M、3%，不是独立物理云盘。它的 I/O 仍落在系统盘上。
- 当前内存约 913 MiB 已用、827 MiB available，3 GiB Swap 当前使用 0。
- 云控制台：实例 `ecs.e-c1m1.large`，2 vCPU / 2 GiB；系统盘 `d-bp1224fuv8f6h2w0tb8j` 为 ESSD Entry 40 GiB，2120 IOPS，标称吞吐 106 MB/s。
- `sar -d -p -f /var/log/sysstat/sa23 -s 23:20:00 -e 23:50:00`：23:30:03 至下一采样点 23:47:25 的区间，vda 平均读 95693.21 KiB/s、写 114.97 KiB/s，平均 await 160.07 ms、队列 223.95、util 85.13%。这是区间平均，不能据此得出 23:37 的逐秒峰值。
- 同时段 `sar -u`：iowait 72.07%、user 3.49%、system 13.83%、idle 10.60%。内核日志该区间未返回记录。
- 云盘过去一天的图表也显示测试时段附近读吞吐与读延迟明显升高，已保存截图 `/private/tmp/ecs-disk-20261024.png`。图表聚合粒度与 sar 采样区间不同，数值不能直接逐点对齐。

结论：已确认读 I/O 压力和显著等待；没有容量耗尽证据。尚未获取具体进程/命令记录，不能归因于 PPTX 导出、技能解压或其他任务，也不能排除同机其他服务或后台任务。

之后 Workbench 连接延迟超过 20 秒，刷新重连时现有免密认证未能建立连接。自动 SSH 诊断提示未检测到实例内 SSH 问题，建议核查安全组/内网访问；这只是诊断提示，不代表已确认安全组缺失。VNC 已可连接但停在系统登录页；NERO AGENT 浏览器会话也已退出。已请用户在浏览器自行登录，未索取密码、未更改安全组或认证配置。

### Workbench 恢复后的进一步证据

用户恢复了 Workbench 登录，继续只读取证：

- 实际运行的 `@mastra/core` 版本为 1.71.0。
- `app_skill_events`：该轮执行 `295632cf-7914-410b-b557-ce74d669223b` 有 5 条 `load/ok`，时间为本地 23:31:54 至 23:32:07。后续的 `pptx`/`powerpoint` 名称猜测不能解释为技能包缺失。仍需检查最终模型请求和网关转换。
- 数据库会话记录：PPT 生成与检查的多次 `execute_bash` 已在本地 23:24 前完成；23:31 后持久化了 3 次多关键词搜索及 2 次别名加载失败。界面显示的末尾未完成命令尚未在本轮持久化消息中查到，下一步应查询对应模型/工具 span，而非猜测命令内容。
- 选用的 `deepseek-v4.1-flash` 公共模型通过 `https://api.nerosun.cn`，api mode 为 chat。服务器有同机 `workbuddy2api` 容器。需进一步验证该网关是否保留全部 system 消息与工具 schema；目前只是排查方向，未认定为根因。
- `losetup -l` 确认历史采样中另一个受影响的 loop4 是 `/var/lib/snapd/snaps/core24_2124.snap`，不是工作区卷。该事实不等于 snapd 是 I/O 的发起者。
- 当前 `iostat` 的短采样显示 vda 只有约 36 KiB/s 读取、util 0.20%，工作区卷无 I/O。当前压力已回落，不代表生成操作再次执行时不会复发。
- 安全组现有入方向规则已允许 TCP 22 从 `0.0.0.0/0` 访问；无需再新增 Workbench 来源规则，未修改任何规则。
- 后续原生 Chrome 键盘焦点排查明确返回 Mac 已锁屏、自动解锁失败。已请用户手动解锁，未尝试绕过锁屏。待解锁后继续读取 span/网关证据及部署已验证修复。


## 最终确认的主因与线上修复

2026-10-24 上午恢复 Workbench 后，已完成以下取证及修复。前文“待验证/未部署”均为当时的历史状态。

### 主因：网关覆盖客户端系统消息

公共模型 `deepseek-v4.1-flash` 通过同机 `workbuddy2api` 网关。运行配置的 `prompt.mode` 原为 `custom`；源码 `internal/server/handler.go` 与 `internal/prompt/prompt.go` 确认该模式先移除全部客户端 system/developer 消息，再插入网关自己的 prompt。被移除的消息包括 Nero Agent 注入的已选技能正文和其他运行指令。因此，技能加载事件虽然成功，模型实际拿不到技能指令。

使用 `scripts/probe-model-system-context.mjs` 发起只包含随机标记的合成请求；不传真实会话正文、不输出凭证：

| 探针 | 修复前 3 个标记 | 修复后 3 个标记 |
| --- | --- | --- |
| 多条 system | 全部缺失，UNKNOWN | 全部保留 |
| 合并为单条 system | 全部缺失，UNKNOWN | 全部保留 |
| user 消息对照 | 全部保留 | 全部保留 |

全部请求返回 HTTP 200。合并 system 并不能修复覆盖行为。

线上仅将 `/opt/workbuddy2api/config.json` 的 `prompt.mode` 从 `custom` 改为现有代码支持的 `append`，其他字段保持一致，保留网关自身 prompt，并重启 `workbuddy2api`。配置为 Docker 单文件 bind mount，因此在原 inode 写入，未以 rename 替换宿主文件。原配置备份为：

`/var/backups/nero-agent/gateway-prompt-20261024T011616Z/config.json`

备份目录 0700、文件 0600。配置及备份包含敏感信息，不应打印或提交 Git。该配置影响经过此共享网关的客户端；认证、网络隔离、上游降级/内容拦截逻辑未修改。上游触发既有降级时，网关仍可能改写 prompt，本次修复未移除该机制。

### 次因：检索不支持模型组合关键词

已将本地验证通过的检索函数及工具描述最小化移植到现有线上 bundle，未整包覆盖其他尚未发布的本地功能。

- 旧 release：`/opt/nero-agent/releases/20261023T014926Z-sandbox-scope`
- 新 release：`/opt/nero-agent/releases/20261024T012000Z-skill-search`
- 旧 `mastra/mastra.mjs` SHA256：`69d92addc3299eff58b79e886016abf35aaa9552e7d1f594e6c7b55e83f1c473`
- 新 SHA256：`754c86efadb5508971eb3ef3cf76a3ea210767ff0f756c714a275fc2cd6f74c2`

发布由 `scripts/patch-skill-search-release.mjs` 生成独立 release，校验替换锚点唯一、旧文件未改变、新 bundle `node --check` 通过后原子切换 current 并重启 nero-agent。没有数据库迁移，没有更新 Node、技能版本或权限。

前端“搜索技能”标签修复仅在本地完成并验证，**没有部署到线上**，以免连带发布工作区其他未上线改动。

回滚后端可以将 current 原子切回上述旧 release 并重启服务。网关备份是故障前配置，恢复它会重新引入系统消息覆盖问题；仅在明确需要恢复时使用，且应核对期间其他配置变更，保持 bind mount 原 inode。

### 最终状态与验证限制

最终 Workbench 检查：

- `nero-agent`: ActiveState=active、SubState=running、NRestarts=0。
- `current` 指向 `20261024T012000Z-skill-search`。
- `workbuddy2api`、`nero-agent-postgres`: healthy。
- `https://agent.nerosun.cn/`: HTTP 200。
- 技能列表接口未认证请求返回预期 401。
- 网关配置读取确认 `prompt.mode=append`，随机标记探针已全部通过。

NERO 浏览器页面仍为登录页，因此本轮尚未验证登录态下完整“选择技能 → 读取参考 → 生成 PPTX → 下载”流程。不得将网关探针或健康检查称为 PPT 端到端验证成功。当前阶段保留页面等待用户自行登录，不索取登录密码。

## 磁盘告警取证收尾

服务实际使用 `/var/lib/nero-agent/mastra.duckdb` 保存 observability 数据（约 591 MiB），不是 PostgreSQL 的 `mastra_ai_spans`。DuckDB 为追加事件表 `span_events`。没有通过复制整个库或绕过写锁读取。

使用 `scripts/inspect-skill-incident-traces.mjs` 在短暂停止服务后，以 READ_ONLY、单线程、128 MiB 内存上限、15 秒 timeout 查询该 thread 在 UTC 15:30–16:00 的 execute/bash/script span，结果 `matchedSpans=0`。首次使用 PostgreSQL 表名的查询报表不存在，改用安装包实际 schema；64 MiB 限额不足，调整为 128 MiB 后查询完成。每次均通过 shell EXIT trap 恢复服务，最终 active/running。

该结果只说明上述过滤范围未找到命令 span，不能证明当时没有执行命令，也不能排除子 span 缺少 threadId、未完成追踪未落盘等情况。未进一步放宽为全库输入扫描，避免无依据的大量 I/O 和读取无关会话。

目前可证实：告警时段发生系统盘读取瓶颈，sar 区间读约 93.5 MiB/s、iowait 72.07%；系统盘剩余 16G，没有容量耗尽证据。工作区 loop0 在对应采样区间无明显 I/O，而另有 Snap 镜像 loop 设备出现等待，仍不足以确定发起进程。不能将“当时在测 PPT”直接作为“PPTX 导出造成告警”的因果证据。

未变更付费实例/云盘规格，未添加安全组规则，未删除业务数据。若需要进一步归因，应在下一次受控复测时同步记录进程级 I/O，而非仅依赖分钟级云盘图表。
