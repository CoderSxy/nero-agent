# History performance review fixes

日期：2026-10-24。当前工作区原地修复；保留 Cursor 的已有未提交实现，不自动提交、不部署。

## 执行记录

- 使用同日 design / plan 与 review 作为范围，按 TDD 修复。新测试实际经历 red → green。
- Ruling: 复用当前工作区而不创建空的新 worktree，避免漏掉待修复的 Cursor 未提交文件；不触碰无关功能。
- Ruling: 历史窗口 content 是软预算。普通消息片段受 512 KiB 预算约束；一个自身超大的消息可例外保留，其余内容仍受预算限制，不截断协议/JSON。巨型单条的网络成本仍未消除。
- Ruling: 服务端位置查询使用 PostgreSQL 16（项目 compose/setup 固定版本）的 IS JSON 判断，旧非 JSON 文本不直接 cast；仅 signal 小字段及长度传回应用，摘要找到目标后限长提取。无迁移。

## 已修复

1. after 保留边界后连续前缀；around 保护目标；长单轮按消息数和字节分段；before continuation 归到边界相邻轮；legacy 到达起点时提供替代标记。
2. metadata/context 不再传输候选完整正文；around 复用准确 signal metadata，不提前读取目标正文两次。
3. 401/403/404 重验证终止并清除缓存/显示；取消及 generation 覆盖全部分页请求；同线程刷新/搜索不因 loading 重挂载聊天。
4. canonical history 与实际 live 更新分离；未更新 seed 不覆盖刷新内容，已更新 seed 在运行结束后保留直到 canonical 覆盖。
5. 搜索 forward/latest 按钮、分页 loading/error/retry 接入；顶部滚动触发加载；锚点仅在对应 history 消息提交后消耗，resize 按阅读锚点补偿。
6. 实际 MessageList 接通按轮可见性壳，历史 reasoning 收起时不挂载 Markdown，超长正文先显示纯文本预览；复制仍使用原文。工具详情延迟 stringify；运行、审批、目标及焦点轮保留挂载。
7. 定时任务不再调用全量 loadScopedThread；订阅与有界尾部 snapshot 按 ID 合并，不丢旧 assistant；对账可 after 续页覆盖长当前轮，不要求单窗口覆盖全部 seed。
8. 产物以已加载展示窗口的 run 集合恢复；保留 stable remote key 去重，避免 token 改变导致请求循环。
9. 修复两个 ShellContext fixture 的类型错误；补启用 window flag 的 AgentPage 测试。

## 验证进度

临时诊断测试已转为正式回归，不保留生产 mock/诊断入口。

最终回归：

| 验证 | 结果 |
| --- | --- |
| `npm run test --prefix web` | 74 个文件、508 项通过，无 unhandled error |
| `npm test`（允许本地监听的环境） | 599 项通过、0 失败、51 项按原有 DB/Docker/live 开关跳过 |
| 本地 PostgreSQL history repository | 6 项通过、0 跳过；真实 before/after 遍历、signal 轮次，fixture 清理完成 |
| `npm run build` | 完整命令通过；Mastra telemetry DNS 与 Vite 大包警告不阻断构建 |
| 最后两项前端时序修复后的 `npm run build --prefix web` | 通过；TypeScript + Vite，45.54 秒，大包警告仍存在 |
| `git diff --check` | 通过 |

全量测试首次发现原有下载测试在恢复 URL mock 后才执行 revoke 定时器，产生 unhandled error。仅修正测试：等待资源回收完成后再恢复 mock，下载实现未改变。

独立复核提出的 3 项问题（超长单轮字节预算、中途打开运行的最终文本、legacy alias）均新增红→绿回归；补充正文早于产物 marker 持久化、StrictMode 重放取消请求、断线定时任务按已加载边界续页回归。

最后一轮前端代码确认后，508 项全量测试通过。原历史搜索全量索引函数继续保留，聊天与定时任务读取已分离为窗口/尾部路径。

## 限制

未修改模型 memory、网关、Node、ECS 权限或线上环境。未执行真实浏览器 cold/warm 五次基准，不宣称 50% 提升。自动化 DOM 锚点回归不能代替真实浏览器中图片、图表、字体变化的最终体验验证。
