# Agent Skills Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline to implement this plan task-by-task. Cursor 若没有该技能，按下列 checkbox 顺序执行同样的实现、验证和记录流程；不因缺少执行器技能而绕过项目 AGENTS.md。

**Goal:** 为 nero-agent 交付与参考项目相当的 Skill 运行、资源执行、权限发布、会话选择和同步维护能力。

**Architecture:** 新增应用级 skills 领域模块，复用 Mastra 校验、工具与 Processor 生命周期，应用控制每次调用的权限和运行版本。本版应用提供 skill/skill_read/skill_search 工具，不同时开启原生自动技能工具；脚本通过只挂载单个技能版本的短生命周期容器执行。PostgreSQL存元数据，内容寻址目录存不可变资源。

**Tech Stack:** 当前安装的 Mastra 1.71.0、TypeScript、PostgreSQL/pg、Dockerode、React 19.1、Vitest、node:test；YAML直接依赖yaml@2.9.1。ZIP库在Task 1按流式解压约束选定并固定版本，不使用shell unzip。

**Spec:** [Agent Skills 能力设计](../specs/2026-10-19-agent-skills-design.md)

## Global Constraints

- 用户只要求编写文档；这份plan是后续Cursor的执行输入，不表示已授权本次会话开始实现。后续按用户给Cursor的实际执行指令推进。
- 实施前读取根AGENTS.md与`.claude/skills/mastra/SKILL.md`；接口按安装版本文档/类型/源码验证。本文新增接口是应用设计，不冒充Mastra已存在API。
- 所有新增应用工具在`src/mastra/index.ts`注册；路由、Processor接入现有Agent；不同时注册两套同名技能工具。
- 普通用户不获得管理员Workspace；可信身份只由服务端认证建立；selectedSkillIds是非可信意图。
- 阶段顺序A运行时→B资源执行→C管理发布→D会话同步；本plan中的D属于交付范围。
- 不开放Docker外网；不执行用户自定义镜像/宿主路径；不在运行时pip/npm install；不自动发布导入内容。
- 所有不可变资源、权限、版本、大小限制使用spec数值；默认开关关闭。
- 保留当前工作区中的天气、图表、流式和移动端改动；不做无关重构、不清理用户修改、不自动提交/推送。
- 测试、开发和构建走package.json scripts；Mastra dev占用输出目录时在临时源副本执行后端构建。
- 每个任务先写能够揭示契约缺失的测试、观察失败，再实现、验证；不以mock覆盖替代真实DB/Docker验收。

## Review Focus

1. 相同thread不同execution、暂停恢复、发布切换：只能沿服务端execution pin恢复，不能继承另一轮或另一用户版本（Task 5）。
2. 首次授权后撤权、管理员仅有维护权：目录、读取、搜索、下载和执行必须使用同一运行权限口径（Task 4/6/8）。
3. 资源部署成功但DB提交失败，或两个发布同时发生：旧指针继续可用，后续可清孤儿，不能出现半发布（Task 3/9）。
4. ZIP中的重复路径、大小写/Unicode混淆、链接及实际解压量超标：不得覆盖release或绕过包限额（Task 1/12）。
5. 技能chip、附件、模型与发送失败恢复，以及上下文压缩后加载：选择不等于加载成功，不丢草稿/附件，也不忘固定版本（Task 5/11/14）。

## 执行约定与阶段门禁

先完整阅读spec与plan。完成一步勾一步，任务末尾记命令、实际结果及未跑原因到`docs/agent-skills-verification.md`。发现本地接口和计划不符，先以安装源码验证最小适配并更新这两份文档；如果会改变权限、版本语义或交付范围，记录差异并向用户解释，不静默减功能。

A完成Task 0–5，B完成Task 6–7，C完成Task 8–10，D完成Task 11–14；Task 15做全范围发布验收。任务依赖由下文Interfaces确定。阶段可单独部署，未完成的按钮和工具不得暴露为可用；只开A不能声称脚本或管理已对齐。

## 文件边界

| 目录/文件 | 职责 |
| --- | --- |
| src/mastra/skills/types.ts、errors.ts、config.ts、validation.ts | DTO、错误码、开关、包与输入约束 |
| src/mastra/skills/package.ts、blob-store.ts、release-store.ts | 标准包、内容寻址存储、不可变release |
| src/mastra/skills/repository.ts、policy.ts、service.ts | SQL事务、权限、管理/运行服务；过长时按versions/sync拆分 |
| src/mastra/skills/execution-context.ts、processor.ts、tools.ts | 可信execution、目录/显式指令注入、三个读取工具 |
| src/mastra/skills/script-runner.ts、script-container.ts、runtime.ts | 解释器与依赖检查、隔离脚本容器 |
| src/mastra/skills/routes.ts、sync.ts、shortcuts.ts、reconcile.ts | API、同步事务、快捷参数、运维 |
| migrations/010_agent_skills.sql、011_agent_skill_run_pins.sql、012_agent_skill_experience.sql | 基础模型、执行pin、同步/快捷；遇编号占用整体顺延 |
| web/src/agent/skills/* | 新增页面、API、DTO、选择/版本/权限/文件/同步组件及同目录测试 |
| tests/skills-*.test.ts | 后端模块、真实HTTP、DB、Mastra边界、Docker验证 |
| scripts/skills-import.ts、skills-gc.ts | 管理员离线导入及默认dry-run维护入口 |
| docs/agent-skills-verification.md、docs/deployment/agent-skills.md | 每阶段证据和部署恢复说明 |

## Task 0：核实接口、基线和边界

**Files:** Read `src/mastra/agents/agent.ts`、`index.ts`、`auth/auth-context.ts`、`sandbox/{manager,provider,types}.ts`、`sandbox/docker/{config,provider}.ts`、`files/*`、`web/src/agent/{AgentChat,AgentComposer,MessageList,ConfigPanel,AgentShell}.tsx`、`migrations/`；Create `docs/agent-skills-verification.md`。

**Interfaces:** 输出安装版本接口证据表、当前迁移尾号、真实请求身份与execution/state作用域，以及本次测试基线；后续任务不依赖猜测的Mastra字段。

- [ ] 读取本地`docs-skills.md`、相关.d.ts和Processor实现，记录validateSkillContent/createSkill导出、processLLMRequest执行state、暂停恢复、runId来源、工具execute context中的真实thread/run字段。
- [ ] 为小型临时Agent编写一次provider HTTP mock探针，验证三个模型步骤共享同一execution、第二次用户执行不共享；核实暂停恢复的服务端run标识。探针加入Task 5最终回归，不把假定字段写进实现。
- [ ] 运行`npm test --prefix web -- --maxWorkers=2`及`npm test`，记录失败名称和原因；若耗时/环境不足，标记未完成，不沿用聊天里旧测试数。
- [ ] 对照spec逐项确认参考项目功能位置；记录本地无OA部门、无任意外网、无通用脚本依赖下载，采用授权组/兼容报告的替代设计。
- [ ] 验证记录明确区分已确认API、应用新增接口、待真实环境验证；没有写业务代码或启用生产开关。

## Task 1：标准内容、包校验和导入预览

**Files:** Create `src/mastra/skills/{types,errors,config,validation,package}.ts`；`tests/skills-package.test.ts`；Modify root `package.json/package-lock.json`。

**Interfaces:** `parseSkillPackage(files: AsyncIterable<{path:string;bytes:Uint8Array}>): Promise<ValidatedSkillPackage>`；结果包含canonicalName/sourceName/description/skillMd/resources/runtimeManifest/warnings。`previewSkillZip(stream: ReadableStream<Uint8Array>): Promise<SkillImportPreview>`；预览必须落受限临时区并由服务管理TTL。`validateSkillMd(text:string,directoryName:string)`返回errors/warnings，不在错误时继续导入。

- [ ] 测试`valid_standard_bundle`断言正文、references/scripts/assets、中文文件路径保留；`noncanonical_name_requires_acceptance`断言legacy_name不会静默变成legacy-name并覆盖已有技能。
- [ ] 测试spec所有字节/文件数边界的等于上限和超1；SKILL.md缺失/多个根、无description、YAML alias>20、未知schemaVersion、二进制误读、路径穿越、反斜线、symlink/hardlink、重复路径/Unicode规范化碰撞、ZIP实际展开超额均拒绝。
- [ ] 执行`node --import tsx --test tests/skills-package.test.ts`，记录RED。该直跑仅测试文件，不用于mastra dev/build。
- [ ] 固定yaml@2.9.1直接依赖；选择维护中的流式ZIP读取/写入库并固定解析版本、理由和许可证，API必须允许条目检查与逐块计数，不得用“解压后统计”。更新lock但不升级Mastra。
- [ ] 实现校验和规范名建议、外包目录剥离；调用真实安装版本校验器；CLI/HTTP以后共用，不各写一套。
- [ ] 重跑定向测试，断言错误不会在临时根外生成文件，失败清理临时区；记录GREEN。

## Task 2：SQL模型与权限仓储

**Files:** Create `migrations/010_agent_skills.sql`、`src/mastra/skills/repository.ts`、`tests/skills-repository.test.ts`。

**Interfaces:** `createSkillRepository(pool: Pool): SkillRepository`；方法`transaction(fn)`、`createDraft(input)`、`getSkill(id)`、`getVersion(id,version)`、`listAvailable(actor,page)`、`listManageable(actor,page)`、`updateDraft(input)`、`updateMetadata(input)`。类型集中types.ts，revision DTO用字符串。transaction回调传同一个连接，禁止事务内重新从pool查询。

- [ ] 写真实PostgreSQL测试：UUID外键、技能名/alias跨表冲突、每技能最多一个draft、version递增不复用已删编号、资源路径唯一、分类与授权组区分、软删过滤、revision CAS。
- [ ] 在专用测试数据库执行`npm run db:migrate`观察迁移缺失；测试不得连接未确认的生产DATABASE_URL，不重建用户已有库。
- [ ] 创建spec基础表，010包含除run_pins、shortcuts、sync_sessions外所有表；权限字段CHECK、FK、分页与查询索引完整；跨表命名冲突用事务级固定命名空间锁处理。
- [ ] 实现参数化SQL和事务；两个并发expectedRevision更新只允许一个成功，另一个返回冲突。更新与审计处于同一事务。
- [ ] 重跑真实DB测试，重复迁移不重复执行；若无测试DB标记BLOCKED_ENV并继续不依赖真实DB的测试，不能用内存repo宣称迁移通过。

## Task 3：内容寻址存储、发布与回滚

**Files:** Create `src/mastra/skills/{blob-store,release-store,versions}.ts`、`tests/skills-storage.test.ts`、`tests/skills-publish.test.ts`；Modify repository/types。

**Interfaces:** `BlobStore.put(stream,limit): Promise<{hash,size}>`、`openVerified(hash)`；`ReleaseStore.materialize(skillId,version,manifest): Promise<{manifestHash,releaseRoot}>`；`publishSkill(actor,{skillId,version,expectedRevision,remark?})`、`rollbackSkill(actor,{skillId,targetVersion,expectedRevision})`。releaseRoot仅内部使用，不能进入HTTP DTO/模型输出。

- [ ] 写故障注入测试：blob写到一半失败、release文件哈希错、rename前失败、release成功而DB失败、两个并发发布、发布期间读取、回滚到缺文件版本。
- [ ] 观察RED；实现临时文件→hash验证→原子rename，不可变release/staging；持有技能行锁完成指针事务，失败保留旧指针。不得先enabled再写文件。
- [ ] 实现草稿派生：已发布不可覆盖；新draft复制文件引用，首次发布不自动启用，既有enabled技能发布保持状态；发布remark≤500字符。
- [ ] 测试old_pin_files_unchanged、new_execution_sees_new_pointer、current_or_active_pin_version_cannot_delete；run pin相关测试在Task 5接入真实表后补齐。
- [ ] 运行`node --import tsx --test tests/skills-storage.test.ts tests/skills-publish.test.ts`；真实DB并发结果单独记录，模拟事务只算单测。

## Task 4：统一权限与运行服务

**Files:** Create `src/mastra/skills/{policy,service}.ts`、`tests/skills-policy.test.ts`、`tests/skills-runtime.test.ts`；Modify repository。

**Interfaces:** `SkillActor = AuthContext`，不接受客户端roles；`createSkillService(deps): SkillService`。运行方法：`listAvailable(actor,query)`、`load(ctx,name): Promise<SkillResult<SkillActivation>>`、`read(ctx,input): Promise<SkillResult<SkillText>>`、`search(ctx,input): Promise<SkillResult<SkillSearchPage>>`。管理方法：`createDraft(actor,input)`、`getManageDetail(actor,id)`、`saveDraft(actor,input)`、`saveFile(actor,input)`、`setMetadata(actor,input)`、`setEnabled(actor,input)`、`deleteSkill(actor,input)`、`listEvents(actor,input)`；调用versions服务前统一鉴权。

- [ ] 参数化权限矩阵覆盖owner/admin/use/edit/publish/global/授权组成员/未授权/停用用户。重点断言admin可维护private技能但不自动可运行，edit不能发布，use不能看草稿。
- [ ] 写运行用例：load→撤权→read/search/execute预检全部SKILL_UNAVAILABLE；禁用和软删同样；不可见搜索不泄漏名称或片段。
- [ ] 写资源用例：引用路径按虚拟baseUri解析，read默认200最多400行且64KiB、续读、二进制错误和topK/片段总长限制；alias精确匹配，搜索结果稳定排序。
- [ ] 观察RED后实现服务；可缓存不可变blob但权限每次查有效状态；当DB故障时拒绝读，不沿用过去授权。
- [ ] 运行`node --import tsx --test tests/skills-policy.test.ts tests/skills-runtime.test.ts`，全部通过后才接模型。

## Task 5：可信execution、工具与模型边界（A门禁）

**Files:** Create `migrations/011_agent_skill_run_pins.sql`、`src/mastra/skills/{execution-context,processor,tools}.ts`、`scripts/skills-import.ts`、`tests/skills-agent.integration.test.ts`、`tests/skills-run-pins.test.ts`；Modify `src/mastra/agents/agent.ts`、`src/mastra/index.ts`、必要的可信请求中间件及`src/mastra/scheduled-tasks/{types,validation,service,hooks}.ts`。

**Interfaces:** `resolveSkillExecution(context): Promise<SkillExecutionContext>`，使用Task 0验证过的服务端字段；`skillProcessor`用execution state去重/恢复；`createSkillTools(service)`返回`skill/skill_read/skill_search`；`selectedSkillIds`通过`nero-agent.selected-skill-ids`仅作为候选意图。普通请求/审批恢复/定时执行均走同一权限服务。

- [ ] 从Task 0探针扩展真实Mastra请求边界测试，断言模型收到目录而非全库正文、无授权技能不出现；模型mock只记录provider payload并返回预设tool calls。
- [ ] 测试`selected_skill_loaded_before_first_request`、`selected_failure_is_visible`、`second_step_reuses_pin`、`new_execution_refreshes_version`、`same_thread_does_not_share_pins`、`approval_resume_preserves_pin`、`forged_context_does_not_pin_version`。
- [ ] 测试上下文压缩后本执行实际已加载指令被重新注入、目录只一份、正文总预算128KiB超限有明确错误；撤权后不重注入。测试metadata读取/无身份时不泄漏目录。
- [ ] 实现持久pin、真实execution状态绑定、工具和processor；register到index并合并Agent既有tools/processors；不配置原生skills自动工具。工具产物仅结构化data/pin/error，不返回hostPath。显式加载通过实际Mastra流writer输出spec的`data-nero-skill-activation`，并经持久化hook保存assistant metadata `neroSkillActivations`；模型工具加载的结果也归一到同一摘要。测试流式看到一次loaded/failed、终态metadata保留、刷新历史能恢复。
- [ ] 新增管理员离线导入CLI，参数`--actor-user-id <uuid> --file <zip>`，复用service/policy，默认仅写草稿；额外显式`--publish --enable`才依次调用发布/启用服务，供A阶段尚无管理API时引导固定样例。该CLI是受宿主权限保护的管理员运维命令，不能作为HTTP接口按body传actor调用；验证用户确为有效admin。不自动导入开发工具技能。
- [ ] 定时任务新增可选selectedSkillIds；在011中追加`selected_skill_ids UUID[] NOT NULL DEFAULT '{}'`及cardinality≤5约束，同步修改scheduled-tasks/repository.ts的TaskRow/映射/写SQL，不改009。hooks重建身份，执行时解析当时发布版本；旧任务兼容。
- [ ] 运行`node --import tsx --test tests/skills-agent.integration.test.ts tests/skills-run-pins.test.ts tests/scheduled-tasks-*.test.ts`；检查无skill能力开关时既有聊天与工具不变。完成A证据，明确B尚不可用。

## Task 6：独立技能脚本容器与运行限制

**Files:** Create `src/mastra/skills/{script-container,script-runner,runtime}.ts`、`tests/skills-script-runner.test.ts`、`tests/skills-script-container.test.ts`；Modify skills/tools、index、必要的sandbox清理器；不放宽`src/mastra/sandbox/docker/config.ts`原有校验。

**Interfaces:** `SkillScriptRunner.execute(ctx,{skillName,path,args},signal?): Promise<SkillResult<SkillScriptOutput>>`；`createSkillScriptContainerOptions({workspaceRoot,releaseRoot,labels,imageDigest})`与`validateSkillScriptContainerOptions`是独立函数。`SkillScriptOutput`含exitCode/stdout/stderr/truncated/timedOut/产物相对路径，解释器来自服务端白名单。

- [ ] 写配置测试：仅单个release `/skill:ro`与本用户`/workspace:rw`；release属于已校验pin；nonroot/network none/只读root/capdrop及资源限制；禁止all-skills-root、其他user、docker.sock、未固定digest。
- [ ] 写服务测试：缺权限、撤权、无entrypoint、path不在scripts、绝对路径、shell注入args、超过64args/16KiB总量、取消、超时、stdout/stderr64KiB截断、非零退出、清理失败重试。
- [ ] 观察RED；复用现有线程归属、配额与commandQueue，在同一个排队作用域内完成容器创建/执行/销毁。用exec argv调用解释器；禁止组合shell字符串。
- [ ] 接入独立run_skill_script工具；仅总开关、脚本开关和既有sandbox开关均满足时暴露。将容器label纳入孤儿清理器，不能误删现有用户容器。
- [ ] 实现runtime兼容报告；缺requiredTools标missing-tools，纯外网requests脚本标network-unavailable，不尝试curl重试。保证未加载也需先load固定pin。
- [ ] 运行`node --import tsx --test tests/skills-script-runner.test.ts tests/skills-script-container.test.ts tests/sandbox-manager.test.ts`，原通用容器测试继续通过。

## Task 7：真实离线脚本与镜像验收（B门禁）

**Files:** Create `tests/skills-docker.integration.test.ts`、`tests/fixtures/skills/{reference-demo,script-demo}/`、`docs/deployment/agent-skills.md`；按现有Docker镜像构建文件位置修改，先用rg定位而非另起不被部署使用的Dockerfile。

**Interfaces:** 两个固定fixture：reference-demo读取references/checklist.md；script-demo通过python3读取`/skill/assets/data.json`，在当前线程cwd输出`result.csv`。runtime声明与镜像实际解释器一致。

- [ ] 写真实Docker测试并验证无Docker/digest时显式skip且说明环境，不转FakeProvider通过。开启测试必须显式指定专用workspace和镜像digest。
- [ ] 补镜像依赖清单与构建步骤，实际运行python3/node/bash版本检查；不对宿主执行技能脚本。
- [ ] 验证脚本产物经既有文件API读取，跨用户读取失败、release改写失败、外网不可达、stop/abort后无残留容器。
- [ ] 与普通execute_command并发验证commandQueue和取消信号仍有效，pin版本切换不改变当前容器读到的资源。
- [ ] 执行`node --import tsx --test tests/skills-docker.integration.test.ts`，记录镜像digest、命令、输出和容器清理证据。无环境时B不能标完全验收。

## Task 8：HTTP管理接口与身份负面测试

**Files:** Create `src/mastra/skills/routes.ts`、`tests/skills-routes.test.ts`、`tests/skills-http.integration.test.ts`；Modify `src/mastra/index.ts`、`web/vite.config.ts`和实际生产反代配置。

**Interfaces:** `createSkillRoutes(resolveService: (c: Context)=>SkillService)`，base `/agent-skills`，严格实现spec第9节的基础CRUD/资源/版本/发布/启停/组/审计接口。imports/sync/shortcuts预留在后续任务注册，不返回假的成功。

- [x] 先写真实HTTP用户A/B/admin/匿名矩阵，分别打available、管理详情、草稿、历史、files、download、export、发布与组成员接口；模型工具测试不能代替HTTP边界。
- [x] 断言伪造userId/roles/owner/RequestContext不改变身份；use-only不能读取草稿/历史，admin不能通过运行工具绕过use；静态路由不被/:id吞掉。
- [x] 实现stream body限流/字节限制、安全下载头、统一错误DTO/状态码，If-Match/expectedRevision解析一致；用户查询最少字段且限制q。
- [x] 注册路由、开发代理和生产转发；只有API返回权限允许才返回canEdit/canPublish/canManage，前端按钮不承担鉴权。
- [x] 运行`node --import tsx --test tests/skills-routes.test.ts tests/skills-http.integration.test.ts`，再验证旧auth/file/scheduled路由无回归。

## Task 9：版本维护、并发操作与分类/授权组API

**Files:** Modify service/versions/repository/routes；Create `tests/skills-management.test.ts`、`tests/skills-concurrency.test.ts`。

**Interfaces:** 完成spec表中版本创建/删除、启停、授权组成员变更、分类移动、事件分页。所有管理写操作都返回最新revision；授权变更事务更新revision和审计。

- [x] 写owner和edit两人同时保存冲突、publish与sync竞争、同名导入竞争、撤销edit后已打开编辑页保存失败测试。
- [x] 写启用未发布失败、删除被pin引用版本失败、删除分类前要求清空、组成员移除后下一次read失败、非admin设global失败。
- [x] 观察RED后完成接口；CAS失败保留服务器原内容，不自动重试覆盖；publish文件部署和指针一致性沿Task 3契约。
- [x] 运行`node --import tsx --test tests/skills-management.test.ts tests/skills-concurrency.test.ts`，真实DB并发至少覆盖双publish和授权变化。

## Task 10：Skill管理页面（C门禁）

**Files:** Create `web/src/agent/skills/{types,skills-api}.ts`、`SkillsPage.tsx`、`SkillEditor.tsx`、`SkillFiles.tsx`、`SkillVersions.tsx`、`SkillPermissions.tsx`与对应test；Modify `web/src/App.tsx`、`web/src/agent/AgentShell.tsx`、`web/src/styles.css`，必要时复用现有Monaco编辑器。

**Interfaces:** `/agent/skills`；API DTO与backend types语义对应但不将node服务端依赖打包进web。页面所有写操作携带revision；文本草稿与服务端对象分开保存。

- [ ] 测试列表/搜索/分页/分类、private创建、正文编辑、资源树、二进制上传下载、当前发布版与工作版区分、创建draft、发布/回滚/启停、权限按钮矩阵。
- [ ] 测试409保留未保存正文、撤权后禁保存、快速切技能旧请求不覆盖新编辑器、发布失败不假更新enabled/publishedVersion。
- [ ] 实现页面与导航，不把“保存”隐式等同发布；移动端使用现有布局入口，确保390px宽度无横向溢出。
- [ ] 执行`npm test --prefix web -- src/agent/skills --maxWorkers=2`及`npm run build:web`，浏览器实际验证创建→编辑→发布→启用→禁用→回滚。
- [ ] 记录C验收：非admin可维护自己的技能，admin可维护但运行权限不自动扩大；真实DB/部署未跑项独立标注。

## Task 11：会话选择、显式加载与历史展示

**Files:** Create `web/src/agent/skills/SkillPicker.tsx`、`SkillPicker.test.tsx`、`SkillExecutionBadge.tsx`；Modify `web/src/agent/{AgentChat,AgentComposer,ConfigPanel,MessageList}.tsx`、`message-parts.ts`及tests、`model-settings.ts`仅在实际需要合并requestContext时修改；Modify定时任务表单/API及tests。

**Interfaces:** `SkillPicker({value:string[],onChange,disabled})`；选择ID通过既有chat.sendMessage.requestContext合并传输，最多5个；定时任务selectedSkillIds同schema。SkillExecutionBadge读取真实skill工具结果、`data-nero-skill-activation`和终态metadata中的安全摘要，按executionId/skillId/version/status去重；不从chip推断成功。

- [ ] 测试`/`搜索、按钮选择、user-invocable=false隐藏、chip移除、最多5个、权限刷新自动移除、切线程清空旧选择、迟到目录请求不覆盖新线程。
- [ ] 测试附件+模型+正文+技能一起发送；失败恢复全部快照，成功清空本次技能；发送中不能重复提交。恢复时已撤权ID显示失效，不能静默替换成其他技能。
- [ ] 测试显式加载失败在界面显示且不冒充成功；历史name/version/hash前缀正确；Config的“可用目录”和“本轮加载”语义分开。
- [ ] 实现选择与状态；服务端仍独立校验；定时任务UI/API向后兼容无selectedSkillIds旧数据。
- [ ] 执行`npm test --prefix web -- src/agent/skills src/agent/AgentChat.test.tsx src/agent/MessageList.test.tsx --maxWorkers=2`，浏览器用无管理员Workspace账号实际选择fixture发送。

## Task 12：包导入、差异同步、导出与版本拉取

**Files:** Create `migrations/012_agent_skill_experience.sql`、`src/mastra/skills/sync.ts`、`tests/skills-sync.test.ts`、`tests/skills-import-http.test.ts`、`web/src/agent/skills/{SkillImportDialog,SkillSyncDialog}.tsx`及tests；Modify package/service/routes。

**Interfaces:** `previewImport(actor,stream)`→importId/report；`commitImport(actor,{importId,acceptedName,alias?,targetSkillId?,expectedRevision?})`；`previewSync(actor,{skillId,expectedRevision,stream})`→syncId/diff；`commitSync(actor,{skillId,syncId,expectedRevision,selectedPaths,includeDeletes})`。全部会话30分钟有效且绑定actor；同步目标为draft，不是release。

- [ ] 写add/modify/delete/unchanged hash对比测试、默认不选delete、只提交选中文件、预览后并发修改409、预览过期410、另一用户偷syncId404、撤权后提交失败。
- [ ] 加HTTP压缩包截断/错误CRC/超量/条目碰撞/别名冲突/已发布名称不可改/导出后再导入内容一致测试；包校验复用Task 1。
- [ ] 实现临时区与会话TTL，提交时再次验证文件hash和baseRevision，DB事务原子更新草稿；失败不出现半包。客户端所有路径选择在服务端验证属于diff。
- [ ] 实现导入报告、名称接受、文件diff预览、版本导出和拉取界面；拉取指定版本仅维护人员，use-only只能导出当前启用版本。正文引用改名风险明确呈现。
- [ ] 执行`node --import tsx --test tests/skills-sync.test.ts tests/skills-import-http.test.ts`和`npm test --prefix web -- src/agent/skills --maxWorkers=2`；用实际ZIP做一次导出→导入→编辑同步闭环。

## Task 13：快捷入口、参数表单与提示选项

**Files:** Create `src/mastra/skills/shortcuts.ts`、`tests/skills-shortcuts.test.ts`、`web/src/agent/skills/SkillShortcutForm.tsx`及test；Modify routes、SkillsPage/SkillEditor、AgentComposer。

**Interfaces:** `validateShortcut(input)`、`renderShortcutPrompt(template,values): string`（仅字面占位符）；GET shortcuts/available、PUT :id/shortcut与spec一致；数据表由012创建。

- [ ] 测试五种控件、10字段/20提示选项上限、必填/数值范围/select枚举、key/label长度、未知字段拒绝；`{{field}}`只替换字符串，`${...}`、HTML、函数文本不执行。
- [ ] 测试撤权/禁用后快捷入口消失、配置不能提升技能use权限、alias改名不丢skillId引用、编辑权限不自动维护他人快捷配置。
- [ ] 实现前后端同等校验；表单生成普通用户消息并选中skillId，不生成system权限文本。
- [ ] 运行`node --import tsx --test tests/skills-shortcuts.test.ts`及web/skills测试，实际点选快捷入口完成一次fixture任务。

## Task 14：运维恢复、清理与长会话回归（D门禁）

**Files:** Create `src/mastra/skills/reconcile.ts`、`scripts/skills-gc.ts`、`tests/skills-reconcile.test.ts`、`tests/skills-long-conversation.test.ts`；Modify index、deployment文档、verification文档。

**Interfaces:** `reconcileSkills({dryRun:boolean})`；GC命令默认dry-run，只有`--apply`才删除已满足7天宽限且无引用内容；audit运行事件90天，run pins结束后7天；活动执行续期不被误清。

- [ ] 测试release缺失可从受信blob重建、blob错则503不可用、不自动切版本；两实例reconcile不互相删staging或当前版本。
- [ ] 测试活动pin/当前发布版本/刚上传未提交blob不被GC，过期import/sync临时区清理，孤儿技能容器清理不触碰普通沙箱。
- [ ] 重跑真实Mastra边界测试：长会话压缩、审批挂起恢复、定时执行、禁用旧历史技能；检查上下文不重复、不丢正文、不换pin。
- [ ] 文档写明DB+blob+release备份一致性、恢复验证、镜像digest、开关灰度顺序、API代理、存储不足处理，以及网络/内部业务技能迁移限制。
- [ ] 运行`node --import tsx --test tests/skills-reconcile.test.ts tests/skills-long-conversation.test.ts`，记录D完成情况与尚未实际运行的恢复演练。

## Task 15：完整回归与真实效果验收

**Files:** Update `docs/agent-skills-verification.md`、`docs/deployment/agent-skills.md`、spec/plan的实际差异说明。

**Interfaces:** 交付V1–V12逐行证据与四阶段门禁结果；未运行项必须显示未验收，不能以checkbox全部勾选掩盖环境缺失。

- [ ] 运行`node --import tsx --test tests/skills-*.test.ts`、`npm test --prefix web -- src/agent/skills --maxWorkers=2`，修复本次引入失败后再跑全量`npm test`、`npm test --prefix web -- --maxWorkers=2`。
- [ ] 运行`npm run build:web`、`npm run build:mastra`；后端若dev正在运行，在临时源副本通过同一script构建，不终止用户进程或删除其.mastra输出。对比Task 0基线，列出新增/既有失败。
- [ ] 浏览器桌面和390px实测：创建/授权/选择/发送/资源/脚本产物/禁用/回滚/导入同步，以及图表和流式消息回归；保存结果但不保留临时测试页面。
- [ ] 以同一固定模型运行spec的6任务×3新会话，记录首选技能、pin、资源读取、脚本实际退出码、产物和完成情况；真实模型未配置或不可调用时明确记未验收，不捏造18次通过。
- [ ] 从参考项目人工选一个纯指令和一个离线脚本包迁移到测试环境，保留许可与来源；报告规范名映射、路径调整和依赖。任意外网/内部业务包另列未支持清单，不拿离线样例代表全部参考技能可用。
- [ ] 自查spec全部章节到Task映射；完成必要代码审查并修复实际问题，重新验证受影响部分；交付用户可复查的文件与测试结果，不自动merge/commit。

## Spec覆盖索引

| Spec要求 | 任务 |
| --- | --- |
| 内容格式、大小限制、名称迁移、ZIP安全 | 1、12 |
| PostgreSQL模型、不可变存储、原子发布回滚 | 2、3、9 |
| 统一use/edit/publish权限、授权组 | 4、8、9、10 |
| 自动发现、显式选择、版本固定、压缩恢复、定时任务 | 5、11、14 |
| 文档/资源读取、脚本容器、依赖与网络限制 | 4、6、7 |
| 全部HTTP接口与状态、管理页面 | 8、9、10、12、13 |
| 会话选择、快捷表单、同步拉取 | 11、12、13 |
| 开关、审计、备份、reconcile/GC | 1、2、4、8、14 |
| V1–V12、真实DB/Docker/模型/浏览器 | 各任务对应测试、15 |

## 执行记录模板

- Task：
- 实际改动文件：
- RED命令与失败原因：
- GREEN命令与结果：
- 真实环境验证（DB / Docker / browser / model）：
- 偏离设计及理由：
- 未完成与环境条件：
