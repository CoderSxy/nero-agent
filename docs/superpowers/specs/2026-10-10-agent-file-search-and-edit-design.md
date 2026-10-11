# Agent 文件搜索与精确编辑设计

日期：2026-10-10

## 目标与边界

在已有上传、工作区选择、附件引用与文件管理之上，给 Agent 补充 `glob`、`grep`、`edit` 三个文件工具。用户应能让 Agent 找到文件、定位少量相关文本并做一次安全的精确替换。工具默认操作当前会话目录；用户明确要求处理个人工作区文件时，Agent 才使用 `scope: "workspace"` 和工作区相对路径。保持现有 `read_file`、`write_file`、`list_files`、`delete_file` 的输入语义。上传附件仍可通过 `read_attached_file({attachmentId})` 读取；新工具不接受附件 ID，也不搜索旧版管理员 `source=agent` 工作区。

这次不添加前端按钮、HTTP 搜索端点、全文索引、文件创建/删除、批量替换、跨用户搜索、PDF/Office 解析或正则搜索。`grep` 第一版为字面文本搜索。以后如需正则，应选用有执行时间约束的引擎，不能直接对用户模式运行不受控的 JavaScript `RegExp`。

## 已有实现与必须补齐的接口

- `src/mastra/files/tools.ts` 的 `userFileTools` 已有 `read_file`、`write_file`、`list_files`、`delete_file`、`read_attached_file`，通过 `agent.ts` 提供给 Agent，`src/mastra/index.ts` 以 `...userFileTools` 注册。原有四个路径工具通过 `FileService` 操作 `threads/<当前线程 ID>/`。
- 右侧文件树和 Composer 使用整个个人工作区，上传文件位于 `uploads/<UUID>/<文件名>`；因此只扩充原有 `FileService.list()` 无法搜索上传文件。个人根目录还含 `shared/`、`projects/`、`threads/`。
- `relativeFilePath()` 禁绝绝对路径、反斜线、空段和 `..`。`ensureThreadDirectory()` 校验线程属主；`ensureUserWorkspace()` 确定登录用户自己的根目录。必须继续使用可信 `requestContext` 与 `context.agent.threadId`，不接受模型给出的 userId/threadId/root。
- `readWorkspaceVersion(bytes)` 已返回带引号的 SHA-256 ETag；`saveWorkspaceText()` 已做 UTF-8、版本与配额检查，并通过同进程队列序列化网页编辑。新工具应共享这个版本格式和编辑入口，而不是另写一个弱化的覆盖写路径。

## 路径范围和输出契约

新工具均接受 `scope?: "thread" | "workspace"`，默认 `thread`。`thread` 路径相对于当前会话目录；`workspace` 路径相对于当前用户个人工作区。`workspace` 仅在参数明确给出时可用；其中 `threads/` 只允许当前线程的子树，不能借工作区范围搜索或编辑别的会话。`glob`、`grep` 的 `basePath?` 默认为该 scope 的根目录，返回路径也相对该根目录；`edit.path` 必须是非空文件相对路径。模式、查询文本与路径分别校验，不能把用户输入拼进 shell 命令。服务端不接受宿主绝对路径、`file:` URL、`source=agent` 或另一个用户的根路径。

`glob` 输入 `{ pattern, scope?, basePath? }`。模式采用 POSIX `/` 分隔符，只支持 `*`、`?`、`**`；`*` 和 `?` 不越过 `/`，`**` 可跨目录。模式不可含绝对路径、`..`、反斜线、空段或 NUL。按路径字典序稳定返回普通文件 `{path,size}[]`，不返回目录。结果附 `{truncated,reason?,visitedEntries}`。匹配相对于 `basePath`，返回的 `path` 仍为 scope 根目录相对路径。符号链接既不跟随也不返回。

`grep` 输入 `{ query, scope?, basePath?, filePattern?, caseSensitive? }`。`query` 为非空字面文本，默认大小写敏感；`filePattern` 遵守 `glob` 的模式语法，默认 `**/*`。只扫描普通、无符号链接、有效 UTF-8 且不含 NUL 的文件。结果 `{matches:[{path,lineNumber,line,etag}], scannedFiles, skippedBinaryFiles, skippedLargeFiles, truncated, reason?}`；行号从 1 开始，`line` 最多保留 300 个 Unicode 字符并标明该行是否截断。一个匹配行返回一条记录，即使该行有多个命中也不重复。返回 ETag，便于后续 `edit`。查询最长 256 个 Unicode 字符。

搜索预算是服务端硬上限，不依赖模型自觉：两工具最多遍历 20,000 个目录条目；`glob` 最多返回 200 条且序列化结果不超过 32 KiB；`grep` 最多检查 500 个普通文件，每个文件最多 2 MiB、所有文件总共最多读取 20 MiB，最多返回 100 行，序列化结果不超过 32 KiB。超过单文件上限的文件直接跳过并计入 `skippedLargeFiles`；达到其他预算立刻停止并返回 `truncated: true` 与 `reason`，不能把不完整结果伪装成“没有匹配”。目录遍历采用稳定顺序；中途文件消失可跳过并记录，权限错误应明确失败。`abortSignal` 中断时停止扫描。

## 精确编辑与版本语义

`edit` 输入 `{ path, oldText, newText, expectedEtag, scope? }`。`oldText` 非空且最大 64 KiB UTF-8；`newText` 可为空，最大 64 KiB UTF-8；两者不得含 NUL。只允许已存在的普通 UTF-8 文本文件，最大 10 MiB。逐字区分大小写；旧文本在完整文件中**恰好出现一次**，包含重叠出现的情况也算多次。零次或多次均返回明确的 `NO_MATCH` / `AMBIGUOUS_MATCH`，文件保持原样。`expectedEtag` 必须符合现有 SHA-256 ETag 格式；与当前文件不一致返回 `STALE_VERSION`，提示重新读取或搜索，不能自行重试覆盖。成功返回 `{path,etag,size,applicationPath,replacements:1}`，路径为应用内可访问路径，不含宿主路径。

`read_file` 结果增加同格式 `etag` 和 `size`，保留原有 `content` 字段。`grep` 命中同一文件返回同一个 ETag。`edit` 复用/扩展 `saveWorkspaceText()` 的版本检查、同进程编辑队列、大小、配额与磁盘保护；将“读取当前字节 → 比对 ETag → 唯一匹配 → 生成新内容 → 写入”放在同一个受控操作中，避免先读后调通用 `write_file` 的竞争窗口。网页在线编辑也走相同操作入口，避免工具与网页互相绕过校验。写入采用同目录临时文件加重命名，失败清理临时文件并结清配额预留；成功后按实际字节增减更新个人工作区占用。不得创建目标文件或跟随路径中任意符号链接。若部署多个应用进程，编辑入口还必须取得跨进程的路径锁；仅靠当前 `pending` Map 不能声称跨进程互斥。没有该锁时应保留单实例部署限制，不宣称多实例安全。

## 授权、安全与错误

所有调用先校验已登录用户和当前线程归属。`thread` 使用 `ensureThreadDirectory`；`workspace` 使用 `ensureUserWorkspace`，根目录只由可信用户 ID 推导，并拒绝遍历 `threads/<其他线程 ID>`。扫描每一层使用 `lstat`，跳过符号链接；编辑逐段拒绝符号链接并确认最终路径仍在根目录内。扫描中不调用任意 shell，不读取非普通文件，不能穿越其他用户工作区。工具错误采用稳定 code 与中文提示：`INVALID_PATH`、`NOT_FOUND`、`BINARY_FILE`、`FILE_TOO_LARGE`、`STALE_VERSION`、`NO_MATCH`、`AMBIGUOUS_MATCH`、`SEARCH_LIMIT_REACHED`、`WORKSPACE_QUOTA_EXCEEDED`。检索被截断优先以成功结果加 `truncated/reason` 表达；权限或路径校验失败直接报错。

新工具须在 `src/mastra/index.ts` 注册，且只在现有 `USER_FILES_ENABLED` 门禁下加入 Agent 工具集合。Agent 指令应说明：先用 `glob` 找路径、用 `grep` 定位并取得版本，再用 `read_file` 或 `grep` 的 ETag 调 `edit`；遇到版本冲突重新读取；上传附件优先按 ID 使用 `read_attached_file`；不要猜测宿主路径。

## 验收标准

1. 当前线程 `reports/a.md` 可由默认 `glob` 找到，`grep` 返回行号和 ETag，`edit` 在版本匹配、旧文本唯一时只替换一次；网页下载与工作区用量反映新内容。
2. 显式 `scope: "workspace"` 能搜索 `uploads/<UUID>/note.txt`；默认 scope 搜不到该文件。路径输出可再传给同 scope 的工具。其他用户文件、其他线程的伪造路径、符号链接和越界路径不能绕过授权。
3. 旧文本不存在、重复、版本过期、二进制、超大文件、超配额及写入失败时不产生部分写入；正确区分错误。并发编辑同一个 ETag 至多一个成功。
4. `glob`/`grep` 的所有上限均返回可解释的截断信息；二进制、过大文件不被当作文本，搜索不把大文件正文送进模型上下文。
5. `npm test`、`npm test --prefix web`、`npm run build` 和 `git diff --check` 通过；无需新增数据库迁移。具备运行环境时用真实 Agent 会话验收“搜索 → 读取 → 编辑 → 再读取”。
