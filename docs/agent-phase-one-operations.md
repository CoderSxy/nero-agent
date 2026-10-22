# 第一阶段任务质量运行说明

本文说明 Skill 存储、模型探针、任务预算和 observe / enforce 切换。回滚只改变新预算是否拦截，不删除解析器、诊断或用户数据。

## 配置

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `AGENT_TASK_QUALITY_MODE` | `observe` | `observe` 超限仍继续，并记下将要停止。`enforce` 拒绝超出本轮额度的主模型请求和工具调用。未设置或其他值会在读取时报配置错误。 |
| `MODEL_CAPABILITY_PROBE_ENABLED` | 关闭 | 只有值为 `true` 时，管理员或模型所有者在模型菜单里主动检测才会发探针。启动和普通聊天不会自动检测，也不会因此扣费。 |

代码里的预算上限：

| 档位 | 主请求 | 修正 | 工具 | 活跃时间 |
| --- | --- | --- | --- | --- |
| simple-chart | 8 | 1 | 12 | 180 秒 |
| general | 20 | 1 | 30 | 300 秒 |
| complex | 40 | 1 | 60 | 900 秒 |
| 管理员上限 | 100 | 1 | 100 | 1800 秒 |

`resolveTaskBudget` 只接受不超过上表管理员上限的正整数。当前版本没有单独的预算环境变量；改额度要改调用处传入的覆盖值，不能靠空配置变成无限。

原有图表步数和错误次数限制仍然有效。格式修正和完成修正合计最多一次，不会为了补一句话重新跑完整 Agent。

## Skill 存储

存储根目录是 `SKILLS_STORAGE_ROOT`。不要把用户工作区或 `/tmp` 当作长期目录。

只读检查：

```sh
npm run skills:doctor
```

退出码：0 表示 healthy 或 repairable，2 表示 unavailable，1 表示存储基础设施错误。诊断不返回宿主路径、凭证或无权限资源。

恢复时只操作临时目录或已确认的存储根，不清理开发库或生产聊天。

1. 完整备份恢复：复制整个存储根（含 blob 和发布树），再在副本上运行 doctor。副本 healthy 后才能替换。不要只复制发布树。
2. blob 缺失：doctor 或检查结果为 `BLOB_MISSING` / unavailable。空目录或重启不会补回内容。这种状态不能当已恢复。
3. 发布树缺失但 blob 完整：检查结果为 repairable。可以用原 blob 重建发布树。重建前确认 manifest hash 没变。

## 模型探针

探针默认关闭。开启 `MODEL_CAPABILITY_PROBE_ENABLED=true` 后，仍只有主动检测才发请求。缓存按连接指纹和凭证修订失效。检测失败不会自动换成另一个模型。

## observe 与 enforce

先保持 `observe`。这时新预算和覆盖判断会留下记录，执行仍受旧限制约束。不要把缺字段的天气图标成已核对完成。

测试环境把 `AGENT_TASK_QUALITY_MODE=enforce` 配好，并用已授权模型跑过完整天气、只看温度、湿度、数据不足和文件请求之后，才在部署配置里显式改为 enforce。

回滚到 observe：

- 把 `AGENT_TASK_QUALITY_MODE` 改回 `observe` 并重启进程。
- 不删除 `014` 迁移、运行记录、Skill 诊断或模型检测记录。
- 不删除 V2 天气图解析，旧图和新图都要能读。
- 不关闭文件权限、ETag、Skill pin、配额、出口校验或取消。
- 关闭探针只停止新的主动检测，不删除已有诊断。


## 2026-10-22 审查修复后的评测入口

固定评测现在经过实际 Mastra Agent、SDK、取数适配器、提交 Schema、来源校验、绘图与完成判断。fixture 只替换外部模型/API 响应，不直接注入 coverage 或 fileVerified；fixture 报告中的 modelCalls / fixture-provider-attempts 是本地模拟请求次数，paidModelCalls=0；toolCalls 记录实际经过 Agent 的模拟工具执行次数。

真实评测使用已有模型目录和明确指定的测试用户，不使用任意 EVAL_LIVE_API_KEY，也不会自动选择其他账号或模型：

```sh
EVAL_LIVE_USER_ID=<测试用户UUID> EVAL_LIVE_MODEL_REFS=public:<模型UUID> npm run eval:task-quality:live -- --live
```

需要已配置数据库、模型密钥及运行环境。最多两个模型，套件最多 60 次主回答请求（含修正）；运行时强制 enforce。缺凭证或无法完成的情况返回 blocked，CLI 退出 2，不能当成验收通过。失败退出 1，全部通过退出 0。

五项包含完整天气、温度限定、湿度、过期/不足用户数据和实际 CSV 写入。负向项明确使用过期用户测试数据、不授权联网补齐；验证 Agent 不把缺失数据报告为完成。测试线程及文件保留供审计，报告包含本次创建的线程标识；清理时只处理这些明确标识，不删除其他会话。

预算在主回答模型 transport 和最终工具集合上执行，记忆/标题模型不接主回答预算。生产配置仍默认 observe；要启用强制限制，显式设置 AGENT_TASK_QUALITY_MODE=enforce。Skill 健康检查和既有安全边界不依赖该开关。
