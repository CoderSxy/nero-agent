# Agent Skills 能力设计

日期：2026-10-19。状态：供 Cursor 实施的设计；本文不表示功能已经实现。

## 1. 目标、范围与成功标准

为 nero-agent 补齐 tc-prime-ai 的 Skill 使用与维护能力：模型能发现、加载并遵循技能，能读取配套资源、执行受支持的脚本；用户能选择技能，维护人员能编辑、发布、禁用、回滚和同步技能包。

按 A 运行时 → B 资源与执行 → C 管理发布 → D 会话与同步体验实施。这是用户要求的完整范围，D 也包含在内；此前天气优化中“D 暂不实施”的决定不适用于本文。每阶段可独立验收，但只有 A–D 全部通过才能声明对齐本设计。

验收必须区分：目录可见、指令已加载、资源可读、脚本可运行、任务成功。前端“可用技能”不得命名为“本轮已加载”，模型选择技能的效果不能用 mock 测试代替。

不在本设计内：复制 Spring/Go/Vue 架构、接入参考项目内部 Hive/OA 服务、技能商店与自动 Git 更新、允许任意外网请求、自动安装脚本依赖、AI 自动发布技能。参考项目业务技能所需的专有服务必须逐个配置适配器，不能因包导入成功而宣称可执行。

## 2. 已核实基线与参考位置

当前项目：`@mastra/core 1.71.0`、React 19.1、PostgreSQL、Docker Sandbox。`src/mastra/agents/agent.ts` 未配置 skills；Workspace 仅向管理员提供；`web/src/agent/ConfigPanel.tsx` 只有 Skills 只读展示。`.claude/skills` 属于开发工具，禁止自动作为产品技能发布。

本机参考根目录：`/Users/nerosun/裂缝中的阳光/sxy/工作/tc-yyxt/fontend/tc-prime-ai`。

| 参考代码（相对参考根目录） | 需要对齐的行为 |
| --- | --- |
| primeai-harness-agent/src/main/java/com/ly/travel/primeai/agent/middleware/LiteSkillPromptMiddleware.java | 按身份注入名称/描述，按需加载，去除重复目录 |
| primeai-harness-agent/src/main/java/com/ly/travel/primeai/agent/tool/SkillTool.java | 加载正文、资源根目录、文件列表，加载前校验权限 |
| primeai-admin/src/main/java/com/ly/travel/primeai/controller/SkillsController.java | CRUD、多文件、发布回滚、历史、同步和下载 |
| primeai-admin/src/main/java/com/ly/travel/primeai/service/admin/impl/SkillsServiceImpl.java | 工作版本与发布版本分离、部署、二进制与哈希校验 |
| primeai-opencode/internal/deploy.go | 版本目录和当前生效入口、启动恢复 |
| primeai-web/src/views/next/components/skill/SkillsEditorPane.vue | 编辑、分组、附带文件、版本维护 |
| primeai-web/src/views/next/components/chat/HarnessMessageInput.vue | 技能选择、快捷入口、提示选项 |
| primeai-web/src/views/next/components/skill/SkillSyncDialog.vue | 文件差异、同步与拉取 |
| primeai-harness-agent/src/main/java/com/ly/travel/primeai/agent/compaction/ToolResultEvictionConfig.java | 长会话中降低技能指令丢失风险 |

框架接口以本地 `node_modules/@mastra/core/dist/docs/references/docs-skills.md`、`docs-sandbox-skills.md`、`dist/skills/*.d.ts` 为准。当前版本支持 Agent 动态 skills、createSkill、skill/skill_read/skill_search，以及标准内容校验。执行前必须加载 `.claude/skills/mastra/SKILL.md` 并再次检查安装版本。

## 3. 架构决策

### 3.1 职责与 Mastra 复用边界

新增 `src/mastra/skills/` 领域模块，负责仓库、权限、版本、资源、运行上下文和 HTTP API。沿用现有 PostgreSQL 连接、鉴权、线程归属、配额和命令队列基础设施。

复用 Mastra 的工具/Processor 生命周期和 `@mastra/core/skills` 的 `validateSkillContent`、`createSkill` 等经本机验证可导出的标准原语。**本版由应用提供并注册 skill、skill_read、skill_search 三个工具，不同时配置原生 Agent.skills/Workspace.skills 自动工具**。原因：原生动态解析按 RequestContext 缓存，直接返回文件路径不足以满足每次读取重新鉴权、运行版本固定、下载审计和禁用即时生效。不能让两个同名工具并存或依赖覆盖顺序。

应用维护轻量目录注入 Processor；不复制原生索引系统，首版搜索使用 PostgreSQL/应用侧大小受限的关键词匹配，按分数降序、名称升序稳定排序。未来只有证明原生适配器能满足全部权限与版本契约，才可替换这些封装。ConfigPanel 从应用可用目录读取，不依赖原生 agent.skills 字段。

普通用户使用技能不要求获得管理员 Workspace。不得为接入 Skill 放开管理员文件工具、宿主路径或原生命令工具。

### 3.2 数据流

1. 已认证请求携带用户自然语言和可选的 selectedSkillIds；它们只是意图，不是权限凭证。
2. 服务端从可信身份生成执行上下文，校验线程归属，查询已启用且已发布且获授权的目录。
3. Processor 注入目录摘要；显式选择的技能由服务端加载指令，确保用户选择不只是一句提示词。普通自动匹配由模型调用 skill。
4. 第一次加载时为当前 execution 固定 version/hash；随后 skill_read、skill_search 和 run_skill_script 使用该固定版本，并重新检查当前权限/禁用状态。
5. 输出标准工具结果，包含 skillId/name/version/hash、结果或错误码；模型和 UI 显示真实加载状态。
6. 下一次新的用户执行重新选择当前发布版本；同一执行的多步、工具恢复保持原固定版本。

### 3.3 版本固定与撤权语义

发布新版本不改变正在执行的版本；回滚只改变未来执行的发布指针。禁用、删除、取消使用授权立即阻止后续目录、加载、读取和执行调用，返回 SKILL_UNAVAILABLE；已返回给模型的文本无法撤回，不承诺抹除历史。已启动的脚本允许结束或被用户中止，撤权不会伪装成能回收已经输出的字节。

执行上下文不能靠 threadId 或客户端传入 runId 识别。实现须验证本版本 Mastra execution/state 的实际作用域；持久化 `app_skill_run_pins` 支持暂停后恢复，绑定真实 userId/threadId/serverExecutionId。HTTP body 中的 owner、roles、version、宿主路径和“已授权”字段均不得成为可信上下文。

## 4. 内容格式、限制与兼容

包结构：根目录 `SKILL.md`；可选 `references/`、`scripts/`、`assets/` 及其他资源子目录；可选 `skill-runtime.json`。正文采用标准 YAML frontmatter（name、description、license、compatibility、metadata、user-invocable），不要求把正文重复存成两份编辑源。

内部 canonicalName：1–64 字符，小写字母、数字和单连字符，不以连字符开头/结尾，不含连续连字符；description 1–1024 字符。保存前用安装版本的校验器核实；不能调用不存在的解析 API。YAML 使用直接依赖 `yaml@2.9.1`，禁用自定义 tag，别名展开数量上限 20。

导入参考项目名称含大写、下划线或点时：生成规范名称建议和冲突报告，由导入确认显式接受；保留 sourceName/alias 的一对一映射供加载查询。alias最长64字符，仅允许ASCII字母数字、点、下划线和连字符，拒绝单独的点/双点；不合法sourceName只作来源记录，不自动创建alias。canonicalName 和 alias 都全局唯一，不能静默覆盖；不自动改写脚本和正文中的任意字符串。名称一旦发布不可改，未发布草稿可重命名并更新 alias 校验。自动迁移不能保证所有跨技能引用正确，需在预览中列出引用检查结果。

约束常量统一在 `skills/validation.ts`：SKILL.md ≤128 KiB；可供模型直接读取的文本单次 ≤64 KiB、最多400行（默认200）；单文件 ≤100 MiB；单版本文件总量 ≤200 MiB；最多1000文件；上传 ZIP ≤100 MiB；解压后同样受200 MiB/1000文件限制；请求 JSON ≤256 KiB；分页默认20、最大50。二进制不能按 UTF-8 读取，使用下载/产物流程。

文件路径采用 POSIX 相对路径，允许中文文件名；拒绝绝对路径、盘符、NUL、反斜线、空/点/父级段、符号链接、硬链接、设备文件及规范化后重复路径。路径校验先做Unicode NFC，再以case-fold键检查碰撞（拒绝A.txt与a.txt同时存在），实际保留规范化后的大小写路径；查询须精确匹配manifest。路径长度≤512字符。ZIP 在写入前检查条目、流式统计解压总量和实际长度，不能先解压再检查；禁止 ZIP slip、同名覆盖和解压炸弹。允许一层外包目录，剥离后须恰有一个根 SKILL.md。只接受上传文件，首版不从任意 URL/Git 下载。

## 5. 数据模型、存储和发布一致性

使用现有 `getPool()`，迁移顺序从现有009之后追加；实施前若编号已被占用，整体顺延并同步 plan。不修改已经执行的迁移。

| 表 | 关键字段与约束 |
| --- | --- |
| app_skills | id UUID、canonical_name UNIQUE、owner_user_id FK app_users、group_id、visibility private/global/restricted、enabled=false、published_version nullable、revision bigint、deleted_at、timestamps |
| app_skill_aliases | alias UNIQUE、skill_id FK；与 canonicalName 跨表冲突必须在同一命名空间锁内校验 |
| app_skill_versions | skill_id/version 联合主键、state draft/published、description、skill_md、manifest_hash、runtime_manifest JSONB、created_by、published_by/at/remark、revision；每技能最多一个 draft（部分唯一索引） |
| app_skill_files | skill_id/version/path 联合主键、blob_hash、size、mime_type、is_text；SKILL.md 由 versions 持有，导出时生成该条目 |
| app_skill_groups | id、name UNIQUE、sort；仅用于内容分类，不授予权限 |
| app_skill_grants | skill_id/user_id/permission(use/edit/publish) 联合唯一 |
| app_skill_audiences / app_skill_audience_members | 管理员维护的授权组及用户成员；与分类组不同，不构建 OA 部门系统 |
| app_skill_audience_grants | skill_id/audience_id；只授予 use，编辑/发布须显式用户授权 |
| app_skill_events | id、skill_id、version、actor_user_id、event、server_execution_id、result/error_code、safe_metadata、created_at |
| app_skill_run_pins | server_execution_id/skill_id 联合主键、user_id/thread_id、version、manifest_hash、expires_at；执行完成后保留7天用于恢复/诊断，活动执行须续期 |
| app_skill_shortcuts | id、skill_id、label、sort、enabled、fields JSONB、prompts JSONB、revision |
| app_skill_sync_sessions | id、skill_id、base_revision、version、actor_user_id、diff JSONB、expires_at、status；30分钟过期 |

blob 内容存于 `SKILLS_STORAGE_ROOT/blobs/<sha256>`；不可变发布目录存于 `.../releases/<skillId>/<version>/<manifestHash>/`。数据库和内容目录必须共同备份。该根目录是管理员配置、禁止指向用户工作区，运行用户可读而普通沙箱不可见。多实例部署要求该路径为共享持久卷；首版不新增 S3。缺失或哈希错误时 fail closed，不从其他版本悄悄补文件。

写入：流式落临时文件并校验 → 原子 rename 到不可变 blob → 数据库事务更新引用及事件。DB失败遗留未引用 blob 由 GC 回收。发布：锁 skill 行并校验 expectedRevision → 生成排序后的 manifest SHA-256 → staging 写入并逐个验证 → 原子 rename release → 事务设置版本为 published、更新发布指针、revision 和事件。中途失败旧指针不变；manifestHash 与DB不一致则拒绝加载。首次发布保持 enabled=false，需显式启用；已有启用技能发布新版本保持启用。

已发布版本不可编辑；编辑须创建新 draft，从当前发布版本复制引用，不复制大文件字节。回滚仅能指向已发布、文件完整版本。删除为软删，立即从运行目录消失；不允许删除发布指针指向、活动 pin 引用的版本。GC默认dry-run；真实GC保留7天未引用宽限期，活动pin和当前发布版本永不回收。禁用/权限更改不等待GC。

并发更新统一传 expectedRevision/If-Match；不匹配返回409，不做最后写入覆盖。revision 用十进制字符串传给前端，避免 JS bigint 精度问题。

## 6. 权限与身份

| 操作 | 权限 |
| --- | --- |
| 看运行目录、加载、读资源、搜索、执行 | 当前有效用户；enabled且published；owner或global或显式use或授权组成员 |
| 查看草稿/版本详情 | owner、admin、edit或publish；仅use用户只能读被允许的已发布内容 |
| 创建 | 任意已认证有效用户；默认private/disabled，仅创建者可使用和维护 |
| 编辑正文和资源、创建草稿、同步 | owner、admin、edit |
| 发布/回滚 | owner、admin、publish；edit不隐含publish |
| 启用/禁用、删除、授权、修改可见范围 | owner或admin；非admin不能设global |
| 维护分类组、授权组成员、全局快捷配置 | admin |
| 管理自己的技能快捷配置 | owner；他人的由admin维护 |

admin管理权不自动绕过运行期use检查；可管理和可使用是不同口径。未登录401、已知且不可管理403；运行资源不可见统一404/SKILL_UNAVAILABLE避免目录枚举。列表、详情、文件、搜索、导出、同步、版本接口都必须在服务端鉴权。撤销编辑权后未完成同步会话不得提交。用户身份取 `trustedAuth`/可信认证用户，不信任任意 requestContext 的同名对象。

现有用户没有deptId；授权组是本地替代方案，不宣称已对接组织架构。未来接OA只替换组成员来源，不改运行权限契约。

## 7. A：运行时协议与上下文

新增 `skills/types.ts`、`validation.ts`、`repository.ts`、`policy.ts`、`service.ts`、`execution-context.ts`、`processor.ts`、`tools.ts`。工具在 `src/mastra/index.ts` 显式注册，Agent工具列表与现有文件/财经工具合并，禁止丢失既有工具。

统一类型：

```ts
type SkillPin = { skillId: string; name: string; version: number; manifestHash: string };
type SkillExecutionContext = {
  serverExecutionId: string; auth: AuthContext; threadId: string;
  pins: Map<string, SkillPin>;
};
type SkillSummary = { id: string; name: string; description: string; version: number;
  userInvocable: boolean; availability: 'instructions-only' | 'ready' | 'missing-runtime' | 'missing-tools' | 'network-unavailable' };
type SkillResult<T> = { ok: true; skill: SkillPin; data: T } |
  { ok: false; code: string; message: string };
```

- `skill({name})`：canonicalName或alias精确匹配；返回指令、版本、虚拟baseUri `skill://<id>/<version>/`、资源路径/类型摘要（前50，附hasMore），不返回宿主绝对路径。资源分组包含references/scripts/assets/other。
- `skill_read({skillName,path,startLine?,endLine?})`：仅已固定版本；若未加载先执行同一服务的load并固定版本。返回文本、行号、截断/续读信息；二进制返回RESOURCE_BINARY和授权下载API相对地址，不返回对象存储公开URL。
- `skill_search({query,skillNames?,topK?})`：query 1–512字符，topK默认5最大20。只搜索已获权限的发布正文与文本资源；未固定的技能先按当前指针固定后搜索。每条片段≤2000字符，全部≤16KiB，包含pin/path/lineRange。
- `run_skill_script` 在B接入，未启用时不向模型暴露执行工具；加载结果说明缺失能力。

Processor使用明确边界 `<nero_available_skills>` 替换自己的旧目录，不删用户文本或其他system块。只注入名称/描述/availability，目录最多100项、32KiB；超过时提示使用skill_search发现更多，HTTP目录支持分页。显式选择最多5个；前端请求字段为 `nero-agent.selected-skill-ids`，服务端只接收UUID数组，禁止客户端传正文/版本/宿主路径。user-invocable=false不出现在手动选择器，仍可由模型自动调用。

显式选择在首个模型请求前加载、固定并注入正文；加载失败必须在UI和模型上下文中可见，不能静默忽略。声明选择不代表实际成功加载。加载事件去重键为 executionId/skillId/version/action；后续轮次不会无限重复注入全文。对当前执行实际已加载指令，在上下文压缩/审批恢复后按固定版本重新注入必要正文，合计正文预算128KiB；超限返回SKILL_CONTEXT_LIMIT，不静默截去操作步骤。每次重新注入检查权限。

流式状态统一使用应用事件 `data-nero-skill-activation`，payload为 `{serverExecutionId,skillId,name,version?,manifestHash?,status:"loaded"|"failed",errorCode?}`。仅服务端发出；处理同一事件幂等，不由客户端事件构造pin。将同样的安全摘要持久化到本轮assistant消息metadata的 `neroSkillActivations`，刷新历史能恢复徽标；不能仅靠瞬时onChunk本地state。需要核实当前Mastra writer与消息持久化hook后适配，使用实际模型边界测试验证，而不是只写一个未接入的事件函数。

定时任务沿用服务端重建身份；011迁移为agent_scheduled_tasks增加 `selected_skill_ids UUID[] NOT NULL DEFAULT '{}'`，CHECK cardinality≤5；任务配置增加可选 selectedSkillIds（最多5个），新执行使用当时发布版本，不保存用户可伪造的pin。UI与API保持向后兼容，不强制旧任务选择技能。

## 8. B：资源与脚本运行

不能把所有技能目录挂进现有按用户复用的容器，也不能把资源复制到可由用户任意改写的位置后作为可信发布版本执行。

采用独立短生命周期容器：`SkillScriptRunner` 复用 SandboxManager 的线程归属校验、配额保护、commandQueue；创建容器时只挂当前选定release到 `/skill:ro`，及当前用户workspace到 `/workspace:rw`，cwd为当前线程目录。完成/失败/中止后销毁容器；清理器回收带 `nero.skill-run=1` 标签的超时孤儿。**原有 dockerSandboxCreateOptions 和仅允许单一工作区挂载的校验保持原职责，新增单独的技能容器配置与校验，禁止放宽现有通用校验。**

保持非root UID10001、无特权、cap-drop、只读根文件系统、network none、资源/超时限制及现有sandbox开关。技能执行仅在现有sandboxTools所有开关满足时可用；UI可显示指令可用但执行不可用。按serverExecutionId+skillId定位发布资源，输入中没有hostPath/cwd/image/command任意字段。

`skill-runtime.json` 可声明：schemaVersion=1、runtimes（python3/node/bash）、entrypoints（scripts/下相对文件）、requiredTools（已注册应用工具ID）、network=none|server-tools。它是部署兼容声明，不会注册新工具、开放权限或赋予shell外网。

```ts
run_skill_script({ skillName: string, path: string, args?: string[] })
// path必须位于scripts/且在entrypoints白名单；args最多64个，每个≤4096字符，总计≤16KiB。
// 后端选解释器并通过argv传参；不拼接sh -c；不得允许上传自定义解释器路径。
```

默认超时60秒、最大120秒，stdout/stderr各截断64KiB并标记truncated。错误区分RUNTIME_UNAVAILABLE、DEPENDENCY_MISSING、SCRIPT_NOT_ALLOWED、TIMEOUT、ABORTED、EXECUTION_FAILED。运行依赖在digest固定的沙箱镜像构建时预装，并记录实际版本；不在对话中联网pip/npm install。脚本明确用 `/skill` 读资源，把输出写到线程cwd；成功后用现有文件接口返回产物链接，产物不写回发布目录。任意宿主工作目录和其他用户目录不出现在返回值。

网络型技能通过现有web_search/web_fetch/finance等服务端工具完成实时访问；network=server-tools且缺requiredTools时显示missing-tools。需要任意requests/curl外网的原技能标记network-unavailable，给出迁移说明，不悄悄开放Docker网络。业务技能调用内部服务要单独实现鉴权工具，不直接注入用户token到脚本环境。

## 9. HTTP API 契约

新增 `createSkillRoutes(resolveService)`，统一base `/agent-skills`；在index注册，在web/vite.config.ts加代理，并核实生产静态资源代理。成功JSON直接返回DTO；失败 `{error:{code,message}}`。400输入、401未认证、403管理禁权、404不可见、409版本冲突、413超限、422包/运行依赖不兼容、503存储不可用。所有下载鉴权且Content-Disposition安全编码，不生成公开下载URL。

| 方法/路径（相对base） | 请求/行为 |
| --- | --- |
| GET /available?page=&pageSize=&q= | 仅运行可用目录，返回items,total；availability说明执行缺失能力 |
| GET /?page=&pageSize=&q=&groupId= | 当前用户可管理的技能，返回canEdit/canPublish/canManage及revision |
| POST / | {name,description}，创建private草稿，201 |
| GET /:id | 管理详情、草稿与当前发布版本摘要；不能向use-only暴露草稿 |
| PATCH /:id | {expectedRevision,visibility?,groupId?,grants?,audienceIds?} |
| DELETE /:id | If-Match revision，软删 |
| PUT /:id/draft | {expectedRevision,skillMd}，已发布则先POST drafts |
| POST /:id/drafts | {expectedRevision,fromVersion?}，创建工作副本；已有draft返回409 |
| GET /:id/files?version= | 版本文件树，runtime用户只能读获授权已发布版本且不能枚举历史 |
| PUT /:id/draft/files?path= | raw bytes；If-Match skill revision；流式限制，不用base64 JSON |
| DELETE /:id/draft/files?path= | If-Match revision，删资源，不通过此接口删SKILL.md |
| GET /:id/files/content?version=&path= | 管理人员读取版本资源；runtime读取由工具服务处理，不向客户端开放任意历史版本 |
| GET /:id/files/download?version=&path= | 同上鉴权；use-only仅当前已启用发布版可下载 |
| GET /:id/versions | 管理版本列表 |
| POST /:id/publish | {expectedRevision,version,remark?}，校验、部署、切指针 |
| POST /:id/rollback | {expectedRevision,targetVersion} |
| POST /:id/enable 或 /disable | {expectedRevision}；未发布不能启用 |
| DELETE /:id/versions/:version | If-Match；拒绝当前指针/活动pin版本 |
| GET /:id/events?page=&pageSize= | 管理可见审计；不包含脚本全文、密钥或完整敏感输出 |
| GET /groups；POST/PATCH/DELETE /groups[/:id] | 分类维护，变更仅admin；删除前移出所属技能 |
| GET /audiences；POST/PATCH/DELETE /audiences[/:id] | 授权组与成员维护，仅admin |
| GET /users?q= | 管理页面用户选择，限admin或技能owner查询有效用户，最少字段id/displayName |
| POST /imports/preview | 上传ZIP，返回临时importId、规范名建议、校验与兼容报告，30分钟有效 |
| POST /imports/:importId/commit | {acceptedName,alias?,targetSkillId?,expectedRevision?}，只创建/更新草稿 |
| GET /:id/export?version= | 管理导出指定版本ZIP；use-only仅可导出当前启用版本 |
| POST /:id/sync/preview | multipart ZIP + expectedRevision，返回syncId和逐文件add/modify/delete/unchanged及hash |
| POST /:id/sync/:syncId/commit | {expectedRevision,selectedPaths,includeDeletes}，复查身份、hash、revision，原子更新草稿 |
| GET /shortcuts/available | 按运行权限过滤的快捷入口与提示选项 |
| PUT /:id/shortcut | {expectedRevision,label,enabled,sort,fields,prompts}，owner/admin |

静态/groups、/available、/imports等路由须先于/:id注册，UUID参数严格校验。资源内容与下载不得使用catch-all宿主路径。新增统一用户选择查询应限流且限制q长度，不返回邮箱/角色/密码字段。

## 10. C/D：管理与会话界面

新增 `web/src/agent/skills/`：SkillsPage、SkillEditor、SkillVersions、SkillFiles、SkillPermissions、SkillImportDialog、SkillSyncDialog、SkillPicker、SkillShortcutForm、skills-api及types。挂载 `/agent/skills`，沿用AgentShell导航和移动布局；普通用户只看自己的/获维护授权技能；admin可管理全局。

编辑页：左侧列表/分组/搜索；正文与资源树；文本编辑预览；二进制上传下载；显示工作版本/当前发布版本；编辑、发布、启用是分开的动作。409保留本地内容并提供重新加载/差异查看，不自动覆盖。发布/回滚/删除前显示明确目标及影响，复用应用现有确认方式，不增加模型权限弹窗。

会话输入框：`/`搜索与按钮选择两种入口；展示可移除chip，最多5个；无数据空态、加载、错误重试、权限变更移除。发送快照包含选中ID，与附件/模型/输入文字一起在发送失败时恢复；发送成功后清空本次选择。实际加载/失败由工具结果或执行事件显示，不能用chip数量当加载成功数量。历史可展示name/version/hash前缀与结果，不展示宿主路径。

快捷表单支持text/textarea/select/number/boolean五种控件，≤10字段；字段key为安全标识符、label≤80字符、提示选项≤20个。模板使用字面 `{{field}}` 替换，不运行JS或服务端模板表达式；用户参数仍是用户输入，不转成system身份。必填/数值上下限/select枚举前后端均校验。快捷配置引用技能ID而非可变名称；禁用/撤权后入口消失。

同步：本地目录先由客户端转文件集合或ZIP上传，服务端预览比较草稿hash；delete默认不选，用户勾选后才删除。提交必须匹配预览base revision，不把半个包写进草稿；预览过期410、并发409。拉取/导出支持保留层级，版本选择只给维护人员。导入只保存草稿，不自动发布或启用。

## 11. 失败处理、开关与运维

开关：AGENT_SKILLS_ENABLED默认false；SKILL_SCRIPT_EXECUTION_ENABLED默认false且依赖现有sandbox开关；SKILLS_STORAGE_ROOT必须显式配置。开启A先检查DB迁移和存储可用；关总开关时API返回503 SKILLS_DISABLED（关闭时前端隐藏入口；直接请求仍明确报错）、工具不暴露、Agent不注入目录，聊天原功能继续工作。

审计事件至少create/edit/import/sync/publish/rollback/enable/disable/grant/delete/load/read/search/execute；记录用户、技能、版本、执行、耗时和结果。资源read/search事件按一次调用记录，不逐行写日志；不存正文、token、完整命令输出。事件可后台分页查询，运行事件默认保留90天；删除技能仍保留审计。导出、GC与备份都不绕过原权限。

新增启动reconcile：验证当前发布目录与hash；缺失时从受信任blob重建并验证，不完整则标记不可用并告警；不自动切版本。GC及孤儿容器清理支持dry-run；多实例release目录操作加数据库锁，活动版本/pin先检查再删除。管理员备份恢复说明包括DB、blob、release、固定镜像digest，不备份用户令牌。

## 12. 验收矩阵与交付边界

| 编号 | 场景 | 必须结果 |
| --- | --- | --- |
| V1 | 普通用户无管理员Workspace | 能加载授权指令技能，不能读取其他用户或宿主文件 |
| V2 | 未登录/猜ID/伪造requestContext | 目录、加载、资源、搜索、下载、脚本和发布均不越权 |
| V3 | 自动匹配/显式选择/未选择 | 自动有工具可用；显式在模型请求前加载；未选择不加载全库正文 |
| V4 | 发布v2、执行中仍pin v1 | 当前执行保持v1，新执行使用v2；恢复审批后仍v1 |
| V5 | 禁用/撤权/删除 | 后续调用立即失败；UI入口刷新消失，不承诺删除历史文本 |
| V6 | 原子部署中途失败/DB事务失败 | 旧发布版持续可用，无半成品版本进入目录 |
| V7 | 路径穿越、symlink、ZIP炸弹、重复路径 | 写入/解压前拒绝，存储与用户文件不被覆盖 |
| V8 | 脚本产物、超时、中止、非零退出 | 只读版本不变、输出可取、容器清理、错误可区分 |
| V9 | 网络型/依赖缺失型包 | 兼容报告准确，不在无网容器里反复重试伪装成功 |
| V10 | 同时编辑/发布/同步 | revision冲突可恢复；未选delete不删文件；撤权后不能提交 |
| V11 | 上下文压缩/重新打开历史 | 固定版本指令恢复，不从旧对话残留注入已禁用目录 |
| V12 | 桌面/390px窄屏/附件与技能同发 | 选择、失败恢复、源码/产物链接正常，原图表/流式不回退 |

自动化：node:test覆盖服务、真实HTTP身份边界、PostgreSQL并发/迁移、真实Mastra模型请求边界（模型HTTP可mock）；Vitest覆盖UI状态；真实Docker测试单列环境条件，不能用FakeProvider冒充通过。

模型评估：至少6个固定任务（纯流程、参考文档、脚本产物、显式选择、无关任务不加载、无权限技能），每个3次新会话；记录是否选择正确、加载版本、任务完成与失败解释。指令已送达和模型确实遵循分别记录。参考技能包至少迁移一个纯指令和一个离线脚本包；网络/内部业务包分别列出未满足依赖。固定测试数据，不访问真实业务写接口。

交付：设计与plan、迁移、代码、测试、镜像依赖清单、部署/备份/回滚说明、`docs/agent-skills-verification.md`。真实模型、真实Docker、浏览器未执行项必须标记未验收。使用npm脚本构建；有Mastra dev运行时在临时副本构建后端，不能清其输出。既有失败单列，不把历史测试数字当本次基线。
