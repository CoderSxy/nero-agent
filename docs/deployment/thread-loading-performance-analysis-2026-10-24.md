# 长会话加载性能分析（2026-10-24）

范围：分析现有实现和线上可见渲染规模；本轮没有修改业务实现、重启服务或发布。以下区分已确认的行为、局部复现与尚未测量的耗时。

## 已确认的加载路径

`AgentPage` → `loadScopedThread` → 获取 thread 并检查 owner → 从最早到最新按每页 100 条串行读取全部消息 → 返回完整数组 → `setMessages` / 关闭 loading → 挂载 `AgentChat` → 渲染完整 `MessageList`。

位置：

- `web/src/agent/thread-scope.ts:104`：while/await 逐页全量读取，无 UI 分页、请求中止或会话快照缓存。
- `web/src/agent/AgentPage.tsx:194`：清空现有消息，等待完整 loadScopedThread 返回才结束 loading。effect 清理仅忽略旧结果，不取消旧请求，因此快速切换会话后旧分页仍可能继续占用资源。
- `web/src/agent/MessageList.tsx:239`：遍历全部消息解析 parts，随后再次遍历创建全部消息组件，未使用虚拟列表；推理 details 默认 open。
- `web/src/agent/markdown/markdown-renderer.tsx:49`：正文和 Markdown block 已有 memo，不能笼统称作每次重新解析全部正文；但首次挂载依然需要解析所有历史内容，MessageList 外层计算也没有被这些 memo 消除。
- Mermaid/ECharts 组件在挂载后启动渲染，未按滚动可见性延迟初始化。仅模块动态 import 不等于图表按需挂载。

例如 1000 条消息正常需要 1 次 thread 请求和 10 次串行消息请求。等待时间包含每页网络往返、服务处理、JSON 处理的累计，而不是最新一页的耗时。少于 100 条时不应把多页串行认定为主导因素。

## 线上样本

通过当前 PPT 会话页面只读 DOM 统计：11 个 data-message-id 节点，1733 个 DOM 节点，main 内约 23837 字符，19 个推理块且全部展开，29 个 mastra-markdown 容器，0 个图表。以上是当前 DOM 的统计，不是接口消息条数、传输字节数或浏览器 CPU 时间。

该样本说明单条持久化消息可能包含多个推理、文本和工具 part，不能只按消息条数判断渲染负担。尚未取得浏览器分阶段时间，不能据此声称 1733 个节点本身导致几秒卡顿。

## 回复结束后的重复读取

`use-reconciled-chat-messages.ts:17` 在运行结束或发现重复工具 ID 后调用同一个全量加载函数。历史尚未覆盖 live 内容时最多重试 3 次（首次、250 ms 后、再 750 ms 后）。这是持久化对账逻辑，不会无条件在每次初次打开会话运行，但长会话回复结束时可能反复读取全部历史。

`MessageList` 每次渲染还会重新解析消息、遍历附件与技能标记；本地产物逻辑存在逐行查找后续相同 run 的处理。其实际成本需 profiler，不能把所有操作一概写成必然 O(n²)。

## 本地新增产物功能中的独立请求循环

这部分前端尚未随上一轮最小后端修复上线，不能用它解释当前线上故障。

当历史快照覆盖 live 且 settled 时，`reconcileChatMessages` 每次调用 history.map 并返回新数组。`AgentChat` 把它传入 `useTurnArtifacts`，后者的 effect 直接依赖 input.messages 引用；请求成功 setByRun 总会生成新 Map → 组件重渲染 → 又得到新数组 → effect 重新请求。

已用临时 Vitest 探针复现真实 reconciliation 与 artifact hook 的组合，API 使用 mock，保持消息内容不变：

- 稳定 messages 数组引用：1 次请求。
- settled reconciliation 每次生成数组：连续 6 次请求；第 6 次由 mock 保持 pending 主动截住循环。

两个探针均通过，连同原有 thread-scope 12 项共 14 项通过。此数字是可重复的 mock 请求次数，不是线上抓包数据。临时探针已清理，未改变业务代码。

稳定引用与基于内容/版本的请求去重需要同时考虑；仅增加普通缓存或把错误吞掉不能解除该反馈循环。流式消息引用变化也会触发重新取产物列表，需要让远端刷新依赖稳定 run 集合或明确的完成/刷新事件，流式 part 合并独立处理。

## 数据库与环境的判断边界

安装的 @mastra/pg 实现已有 thread_id/createdAt 索引定义；listMessages 按 LIMIT/OFFSET 读取，默认包含 COUNT 子查询，之后还会 JSON 解析、MessageList 转换、排序。不应未经线上 EXPLAIN 就建议盲目新增相同索引。includeTotal=false 在存储层有实现，但是否可经当前 HTTP/client 版本透传需另行核对。

本轮 Workbench 连接已断开，未取得新的线上 EXPLAIN 或消息大小统计，也未执行原计划的数据库查询。当前不能断定数据库查询是主瓶颈。

上一轮确认的系统盘读吞吐告警可能在发生时放大服务延迟，但不能据此解释所有长会话的稳定变慢。升级 Node 或实例不是优先修复方向。

## 优化顺序建议

1. 修复本地新增产物请求循环，避免发布后扩大网络和后端负载。
2. 改变首屏读取策略：优先最新一段完整对话，向上滚动再读取旧历史；保留 owner 检查。页边界需要照顾用户轮次、工具调用/结果及审批状态，避免机械截断导致显示不一致。历史搜索 targetMessageId 需要能单独加载目标周围窗口。
3. 增加按 user/thread 隔离、具备失效规则的会话缓存；快速切换时取消旧请求；回复结束按尾部或变更消息进行对账，保留已有 ID、最终文本和工具状态覆盖条件。
4. 控制首次挂载规模：历史推理/工具详情按需挂载，长列表窗口化，图表进入视口后再初始化。仅将 details 设为关闭仍可能保留其子组件解析开销，不能作为完整优化。
5. 采集同一长短会话的消息接口请求数、TTFB/响应字节、首次可见内容时间、React commit 与 layout 时间，确认以上调整的收益后再决定数据库或规格调整。

UI 历史分页与模型记忆读取是不同链路；优化界面首屏不能直接缩减模型的持久化上下文，也不能删除历史数据。搜索缓存与选中会话缓存当前用途不同，不能假定已有 IndexedDB 搜索缓存就能复用会话打开结果。
