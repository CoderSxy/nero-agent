# A–C 实施验证记录

日期：2026-10-17。

- A：执行级时间基准、日期语义提示词、定时任务时区传递已接入。
- B：独立结构化日序列校验器已实现；未接入天气数据入口，D 暂缓。
- C：Tavily 相对/绝对发布时间过滤、检索深度、发布日期及获取时间已实现。
- 真实 Mastra Agent.generate / Agent.stream 的模拟 HTTP 供应商集成测试通过；未使用生产凭据做真实模型或 Tavily 在线效果评估。
- 独立审查发现并修复了恢复执行后定时任务时区丢失的问题；回归测试先复现错误，再验证修复，复审通过。

## 命令结果

- 定向测试：38 项，37 通过、1 项原有跳过、0 失败。

- `npm test`：333 项，266 通过、48 失败、19 跳过。48 项失败全部在修改前源码的临时副本中同名复现，集中于磁盘保护影响的文件写入/上传/配额测试；没有本次新增失败。原始基线副本另外两项因未复制前端资源而失败，不用于判定本次改动。
- `npx tsc --noEmit`：7 个错误，与修改前基线的文件及错误信息完全一致；没有新增诊断。涉及附件 processor 类型、附件路径联合类型、文件状态比较和已有调度错误回调类型。
- 当前目录 `npm run build`：被正在运行的 Mastra 开发服务保护机制阻止，未强制构建、未停止服务。
- 临时源码副本 `npm run build`：通过，包含 Mastra 和前端构建。最后的时区恢复修复另执行 `npm run build:mastra` 验证，也通过（退出码 0）。
- `git diff --check`：通过。

磁盘使用率约 91%，超过项目默认 90% 写保护阈值。验证期间没有修改生产磁盘保护参数。

## 全量测试失败名称

以下名称全部在原始源码基线复现：

- selecting the same workspace file twice is idempotent and does not copy or grow usage
- history listing keeps stored metadata after the original file is deleted or changed
- forged users, other threads, unknown ids and non-admin agent source are rejected
- stale unsent refs older than 24h are cleaned only after Mastra confirms no message
- refs younger than 24h are not cleaned even when Mastra reports no message
- lookup throw fails closed and does not clean stale refs
- cleanup only deletes expired rows in a clientMessageId group
- cleanup fails closed when renamed client-set message body holds attachment ids
- user B cannot read user A files and forged identity is ignored
- download returns the file bytes and safe headers
- thread upload maps quota failures to WORKSPACE_QUOTA_EXCEEDED JSON
- read_file accepts path and returns content with quoted SHA-256 etag and byte size
- file tool writes into the authenticated agent thread without a model-supplied threadId
- glob tool finds thread files via trusted auth and returns truncation metadata
- glob tool defaults to thread scope and accepts explicit workspace scope
- grep tool finds literal matches with etag matching read_file
- grep tool defaults to thread scope and searches exact workspace path when requested
- edit tool replaces once and returns applicationPath without host paths
- edit tool workspace scope uses encoded applicationPath and rejects stale etag
- end-to-end file flow: glob → grep → edit → re-read, then workspace upload search
- two users with two threads cannot read each other files or run as another identity
- two threads of the same user can keep the same filename without overwriting
- deleting a thread record does not delete its directory
- a larger edit respects the user workspace quota
- successful growing edit settles its quota reservation
- replaceWorkspaceText replaces exactly once and returns new etag/size
- replaceWorkspaceText allows empty newText
- replaceWorkspaceText rejects quota and disk protection without changing bytes or quota
- concurrent replaces sharing an etag yield exactly one success
- saveWorkspaceText and replaceWorkspaceText share the same path lock
- web personal-root and agent thread-root paths serialize on the same physical file
- conditional save edits only the owned workspace and returns a new ETag
- reads and saves a Unicode filename and UTF-8 content
- personal workspace upload uses unique safe paths and returns usage on list
- workspace upload rejects anonymous, other users, oversized files, quota and symlinks
- workspace upload maps quota failures to WORKSPACE_QUOTA_EXCEEDED
- FileService write over remaining quota fails
- deleting a file releases its workspace quota
- WorkspaceFileService batchDelete frees quota and rescan matches disk
- overwrite write reserves only max(0, new - old) and shrinking releases the difference
- overwriting a zero-byte file does not increment the file count
- uploading the same name twice stores distinct paths and does not overwrite
- Unicode and special-character names stay safe path segments
- uploads that exceed workspace quota return WORKSPACE_QUOTA_EXCEEDED
- a post-rename reconciliation failure keeps the persisted file charged
- a failed quota commit removes a newly persisted upload and releases its reserve
- list reconcile does not drop reserved-but-not-yet-on-disk quota
- personal usage ignores other users and does not follow symlinks

## 二次自检

按用户要求重新检查执行生命周期、时区恢复、校验器及搜索工具参数，没有发现新的业务代码缺陷。补充一项真实 Mastra 多步骤工具循环测试：模型调用实际注册的 web_search，模拟 Tavily 返回旧日期摘要，并在取数过程中跨过上海午夜。验证增强参数能进入工具请求、工具结果含日期元数据、下一轮模型请求刷新到新日期且只含一条时间基准。模型供应商及 Tavily HTTP 均为受控模拟，不代表真实模型已经通过天气问答评估。

- 定向测试：39 项，38 通过、1 项原有跳过、0 失败。
- 全量 npm test：334 项，267 通过、48 失败、19 跳过；失败名称集合与上一轮完全一致。
- TypeScript：原有 7 项诊断，无新增。
- git diff --check：通过。
- 本轮只增加测试及验证记录，业务代码未改动，无需重复构建。
