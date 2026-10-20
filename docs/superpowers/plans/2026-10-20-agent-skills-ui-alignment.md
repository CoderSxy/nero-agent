# Agent Skills UI Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Cursor 如果没有该技能，直接按本文步骤执行，不安装无关插件、不以技能缺失跳过项目 AGENTS.md。

**Goal:** 交付 datax 风格的 `/` 技能选择与技能卡片管理页，并完成当前项目本地基础技能启用和真实调用验收。

**Architecture:** 复用现有 Skill API、权限、execution pin、选择与快捷机制，抽取 slash 纯函数和错误展示转换；输入框控制光标与键盘，选择器控制目录和请求。管理首页改为分组卡片，原详情维护逻辑移入编辑面板；只新增管理列表 description 字段，不增加新的 Skill 子系统。

**Tech Stack:** 当前 React 19.1、TypeScript、Vitest 3.2、Testing Library、lucide-react、现有 CSS 变量；后端 Mastra 1.71.0、pg、node:test。以执行时 package.json 和已安装类型为准，不升级依赖。

**Spec:** [Agent Skills 输入交互与管理页对齐设计](../specs/2026-10-20-agent-skills-ui-alignment-design.md)。先完整阅读 spec 与本计划。

## Global Constraints

- 最初只交付文档；现用户已授权Cursor实现及Codex复核补齐。实际执行结果以验收记录为准，不将计划文字视为通过证据。
- 读取根 AGENTS.md；Mastra 相关修改前加载 `.claude/skills/mastra/SKILL.md`，查已安装文档/源码，不凭旧API印象编写。
- 不修改 datax 参考项目，不引入 Ant Design，不改变当前最多5个技能及UUID意图语义，不改权限和execution pin机制。
- 保留所有现存未提交/未跟踪改动，尤其九项修复、天气、图表、流式、附件和移动端。不 git reset/clean，不自动commit/push。
- 仓库默认总开关false不变；本地明确配置后才开启基础技能；脚本开关和Docker网络保持原门控。
- 不把enabled、已选、已加载当同一状态，不伪造“已加载”tab，不将管理员维护权视为运行使用权。
- 搜索明确为名称检索；卡片描述取已发布版本优先，草稿描述须canViewDraft；不在列表API泄露正文或grants。
- 保留5项上限、完整分页后才核权、preserveMissing、scopeKey隔离、If-Match及409处理。
- 所有命令从仓库根执行。开发/构建使用package.json scripts；后端构建若与运行中的dev共用输出目录，在临时源副本构建。
- 不给通过数设硬编码目标；记录实际结果，未跑/环境受阻与通过分列。不要放宽测试超时或关闭应用磁盘保护以制造通过。

## Review Focus

1. 中文输入法Enter与面板Enter相遇：组合输入不触发选择或发送（Task 3测试）。
2. 光标处于正文中间、路径URL或编辑旧token：只替换当前合法token，其他内容逐字保留（Task 1/3测试）。
3. 搜索关闭、会话切换或网络响应倒序：旧响应不能回填新会话或错误清空选择（Task 2/3测试）。
4. 管理列表可见但无草稿读取权：description和预览不能泄露草稿，409不能覆盖本地修改（Task 4/5/6测试）。
5. 小屏软键盘、长技能名、分组元数据失败：弹层仍可选，状态不误标，未保存编辑离开有保护（Task 5/6/7测试）。

## 执行输入与证据位置

工作目录：`/Users/nerosun/裂缝中的阳光/sxy/日常/code/nerosun-harness/nero-agent`。
只读参考：`/Users/nerosun/裂缝中的阳光/sxy/工作/tc-yyxt/tc-prime-ai-datax`。

按 Task 0→1→2→3→4→5→6→7 执行，保持每个任务可单独验证。Task 4服务契约独立于输入框改造，但不要同时启动多套重构或重型测试争用资源。每个任务完成后审查实际diff，填写 `docs/agent-skills-ui-verification.md`，再勾选完成。

文件职责与API约束以spec §8为准。本计划中的新函数/props是应用设计，不能误认为Mastra已内建。

## Task 0：核实基线与实际依赖

**Files:** Read `AGENTS.md`、`.claude/skills/mastra/SKILL.md`、`package.json`、`web/package.json`、`web/src/agent/{AgentComposer,AgentChat,AgentPage}.tsx`、`web/src/agent/skills/*`、`src/mastra/skills/{config,routes,service,policy,types}.ts`、`docs/skills-nine-fixes-verification.md`；Create `docs/agent-skills-ui-verification.md`。

**Interfaces:** 输入现有组件和API；输出实际版本、关键接口、变更基线、服务配置来源和测试结果，供后续任务引用。

- [x] 保存 `git status --short` 摘要，识别现有修改；记录哪些文件原本未跟踪，不把全部工作区提交当本任务交付。
- [x] 只读 datax 的 `ChatComposer.tsx`、`ComposerSkillPicker.tsx`、`SkillsPage.tsx` 和 `pages/skill-editor/*`；记录借鉴点，不复制其鉴权、状态枚举或依赖。
- [x] 查看已安装 `@mastra/playground-ui` 的 ComposerInput 类型/实现，确认ref、onSelect、composition及onKeyDown透传。ref若非textarea，采用组件支持的inputRef/事件currentTarget最小适配，不用未验证的强制类型转换。
- [x] 确认main.tsx的BrowserRouter与测试MemoryRouter。编辑关闭/切技能使用组件守卫，刷新关闭用beforeunload，不在此任务升级全站数据路由。
- [x] 基线运行 `npm test --prefix web -- --maxWorkers=1 src/agent/skills src/agent/AgentChat.test.tsx src/agent/AgentPage.test.tsx`，记录真实结果。
- [x] 运行 `./node_modules/.bin/tsc --noEmit`，记录诊断；检查实际服务的技能关闭错误，但不打印完整.env或请求凭据。
- [x] 建立验证记录章节：基线、Task证据、真实服务、桌面/390px截图、未跑项、回滚。此阶段不修改产品代码或开启服务。

## Task 1：Slash 解析与错误状态纯函数

**Files:** Create `web/src/agent/skills/{skill-slash.ts,skill-slash.test.ts,skill-ui-state.ts,skill-ui-state.test.ts}`；Read `skills-api.ts`。

**Interfaces:**

```ts
export type SkillSlashMatch = { start: number; end: number; query: string };
export function resolveSkillSlash(text: string, selectionStart: number, selectionEnd: number): SkillSlashMatch | null;
export function replaceSkillSlash(text: string, match: SkillSlashMatch): { text: string; caret: number };
export type SkillUiState = { kind: 'disabled' | 'unauthenticated' | 'forbidden' | 'error'; message: string; retryable: boolean };
export function toSkillUiState(error: unknown): SkillUiState;
```

- [x] 写参数化失败测试：`('/',1,1)`→`{start:0,end:1,query:''}`；`('请 /天气 分析',5,5)`→`{start:2,end:5,query:'天气'}`；光标在`天气`中间时query只取光标之前、end仍指向token结尾。
- [x] 写排除测试：URL、`/usr/bin`、`a/b`、空白后的非slash、非折叠选区、越界index、token之前光标→null；emoji前缀验证UTF-16 offset与textarea一致。
- [x] 写替换测试：仅删完整token，保留前后所有空白与正文；输入`请 /天气 分析`得到`请  分析`，caret为2。纯函数不修改标签和附件。
- [x] 写错误映射测试：`SkillApiError(503,'SKILLS_DISABLED',英文)`得到spec中文且retryable=false；401/403独立；普通Error/网络错误得到通用失败且retryable=true；保留底层异常结构不改写API解析。
- [x] 运行 `npm test --prefix web -- src/agent/skills/skill-slash.test.ts src/agent/skills/skill-ui-state.test.ts`，确认失败来自新契约缺失。
- [x] 实现spec §4.2与§5的纯函数，再运行同一命令至通过；审查不可将路径URL错误识别成技能。

## Task 2：选择器改为受控面板，保留目录安全语义

**Files:** Modify `web/src/agent/skills/{SkillPicker.tsx,SkillPicker.test.tsx,skills-api.ts,skills-api.test.ts}`；Create `SkillSelectionChips.tsx`；复用Task 1状态映射。

**Interfaces:** 将Picker改为`forwardRef`面板，props保留value/onChange/disabled/scopeKey/preserveMissing，新增：

```ts
open: boolean;
query: string;
onQueryChange: (query: string) => void; // 鼠标入口使用面板搜索
onRequestClose: () => void;
onPicked: (id: string) => void;
onCatalogChange: (items: SkillSummary[]) => void; // 已选标签解析；仅完整成功目录
onPhaseChange: (phase: 'loading' | 'ready' | 'error') => void; // 标签仅ready且完整目录时判失效
inputMode: 'slash' | 'search';
export type SkillPickerHandle = { handleKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean };
```

`handleKeyDown`返回true表示已经消费；不持有外部draft，不负责发送。关闭面板时返回false。chips组件消费`value/catalog/disabled/preserveMissing/phase/onRemove`，保持现有失效标签口径，不能独立请求/清除选择。具体type导出保持前后任务一致。

- [x] 先补测试：无open不渲染旧toolbar；open显示名称描述和aria-selected；已选项不可重复添加、5项上限、加载/错误/搜索空不同状态。
- [x] 补请求隔离测试：第51项仍可选择；第一页/搜索结果不清除选择；搜索A→清空query→A返回不覆盖全目录；scope切换后旧成功/失败都不落地；目录失败和SKILLS_DISABLED保留value。
- [x] 补键盘测试：上下循环、跳过禁用项、Enter消费但无结果不选择、Shift+Enter不消费、Esc只关闭；状态切换后高亮有效，不访问越界选项。
- [x] 运行 `npm test --prefix web -- src/agent/skills/SkillPicker.test.tsx src/agent/skills/skills-api.test.ts`，确认新断言失败。
- [x] 实现受控open/query、高亮和ref键盘接口；保持完整分页收集和权限定论时点。slash模式不另建抢焦点搜索框；search模式允许面板搜索且使用同一过滤/请求逻辑。
- [x] 搜索关闭、query变化、scope变化均使旧序列失效并取消请求；保留现有错误不清选择规则。列表API按需增加可选AbortSignal，不改URL/错误结构。
- [x] 拆出标签渲染；通过onCatalogChange只传完整成功目录，数据未就绪显示临时名称但不误判失效。用户主动移除才变更对应UUID。
- [x] 复跑同一测试，保留旧分页/失效/保留用例，不能通过删旧断言完成迁移。

## Task 3：接入光标、键盘、浮层与快捷入口

**Files:** Modify `web/src/agent/AgentComposer.tsx`、`web/src/agent/skills/{SkillShortcutForm.tsx,SkillShortcutForm.test.tsx}`、`web/src/agent/AgentChat.test.tsx`、`web/src/styles.css`、`web/src/agent/mobile/mobile.css`；Create `web/src/agent/AgentComposer.test.tsx`。

**Interfaces:** 消费Task 1纯函数和Task 2 `SkillPickerHandle`；保持AgentComposer外部props以及AgentChat发送RequestContext格式不变。composer持有match、dismissedToken、inputMode、open和selection；chips目录由onCatalogChange更新、目录状态由onPhaseChange同步。

- [x] 直接组件测试先失败：正文中间`/`开启并选择后只删token；在光标之前/之后的正文和附件不变；标签UUID保留并去重；显式“技能”按钮可开search模式。
- [x] 测试Enter打开面板只选择、不发送；loading/empty/error时Enter不发送；Esc关闭后不立即重开，修改token后可重新打开；面板关闭Enter恢复原发送；Shift+Enter换行。
- [x] 测试compositionstart→Enter→compositionend不误选/发送；选中后焦点和caret恢复；Tab与点击外部关闭；running/scope切换关闭面板，旧选择回调无效。
- [x] 先运行 `npm test --prefix web -- --maxWorkers=1 src/agent/AgentComposer.test.tsx src/agent/AgentChat.test.tsx src/agent/skills/SkillShortcutForm.test.tsx`，确认新增契约失败。
- [x] 将Picker/标签放进输入框布局，去掉`draft.startsWith('/')`和清空整个草稿回调。keydown先判断IME、Shift+Enter，再交给面板，最后保留既有发送逻辑。
- [x] 关闭后用token位置和当前文本记录dismissedToken，草稿/光标改变再计算；不能用每次render的match自动覆盖用户关闭意图。
- [x] 实现浮层位置和outside click；视口变化调整定位，关闭卸载清理监听。页面原有模型/附件弹层与技能弹层同时只开一个；禁止点击面板抢走输入焦点后丢失插入位置。
- [x] 快捷入口不再常驻“刷新快捷入口”按钮；有效入口照常显示，刷新放按需菜单。禁用错误中文化且不在两个区域重复显示。保留快捷字段与模板应用逻辑及单独选项修订保护。
- [x] 样式使用现有CSS变量，覆盖320px列表高度、视口8px边距、描述截行、长标签截断、390px和明暗主题；不对全局button/textarea设置宽泛规则。
- [x] 复跑上述测试及 `npm test --prefix web -- --maxWorkers=1 src/agent/AgentPage.test.tsx src/agent/skills`；审查发送失败时draft/attachments/preserveMissing未回归。

## Task 4：管理卡片需要的描述字段

**Files:** Modify `src/mastra/skills/{types.ts,service.ts}`、`web/src/agent/skills/types.ts`、`tests/skills-management.test.ts`、`web/src/agent/skills/SkillsPage.test.tsx`的fixtures；必要时更新 `tests/skills-routes.test.ts`。

**Interfaces:** `SkillManageListItem = SkillRecord & { description: string; canEdit: boolean; canPublish: boolean; canManage: boolean }`；GET `/agent-skills` URL、分页、q名称搜索、groupId与权限不变。

- [x] 写后端失败测试：有published取published.description；无published且canViewDraft取draft.description；不能读draft时空串；缺版本空串；列表不增加skillMd/grants/audienceIds字段。
- [x] 用现有安全DB门禁运行 `node --env-file-if-exists=.env --import tsx --test tests/skills-management.test.ts tests/skills-routes.test.ts`；缺DB时标阻塞，不能当真实DB通过。
- [x] 读取loadCaps返回结构和policy，复用已有授权读取后增加description；前后端DTO同步并更新fixtures。若需版本读取，使用repository既有getVersion/listVersions方法，不为此建新HTTP端点或SQL字段。
- [x] 保持服务的共享lease，不绕开service直接在路由查询资源；仅有publish能力不自动拥有草稿正文/描述读取权限。
- [x] 复跑后端测试与 `./node_modules/.bin/tsc --noEmit`；确认列表total与分页没有因描述补齐发生改变。

## Task 5：卡片与编辑工作区组件

**Files:** Create `web/src/agent/skills/{SkillCard.tsx,SkillCard.test.tsx,SkillEditorPanel.tsx,SkillEditorPanel.test.tsx}`；从 `SkillsPage.tsx`抽取；沿用 `SkillEditor/SkillFiles/SkillVersions/SkillPermissions/SkillShortcutEditor/SkillSyncDialog`。

**Interfaces:**

- `SkillCard`消费item、groupLabel、expanded、preview、previewLoading、previewError、busy、onToggle/onEdit/onPublish/onEnable/onDisable/onOpenVersions/onOpenPermissions。所有动作回调只交给拥有该能力的用户。
- `SkillEditorPanel`消费`skillId: string | null; onRequestClose: () => void; onChanged: (skillId: string) => void`；持有详情、draft、本地dirty、tab及原有修订/上传/权限动作；`onRequestClose`只在无dirty或确认放弃之后触发。
- 预览缓存由页面持有，以id+revision作key。预览内容使用已有详情API，卡片不自行预取所有正文。

- [x] 卡片失败测试：描述为空兜底、未发布/停用/已发布状态区分、不能显示虚假已加载、按钮权限、按钮点击不展开、加载/失败/Markdown预览。
- [x] 编辑面板失败测试：旧五页签仍在；草稿保存成功刷新；dirty关闭“保留/放弃”；切skill不能丢本地修改；409保留文本；权限保存保留已有grants；只读用户看不到可写控件。
- [x] 运行 `npm test --prefix web -- src/agent/skills/SkillCard.test.tsx src/agent/skills/SkillEditorPanel.test.tsx`，确认失败。
- [x] 最小抽取现有详情控制逻辑，不重写版本/授权/同步规则；关闭和切换的dirty保护均通过同一守卫，挂beforeunload并在clean/卸载时清理。
- [x] 编辑关闭和切技能走统一dirty守卫；beforeunload仅在dirty时挂载。当前BrowserRouter不调用useBlocker、不重建全站router；浏览器内部后退及绕开面板的站内导航不承诺拦截，在验证记录列为限制。
- [x] 样式桌面右侧面板、390px全屏；操作区可见、内部纵向滚动；长代码/文件名只在内容区域横向滚动，不撑开页面。
- [x] 复跑组件及原有 `SkillPermissions/SkillVersions/SkillFiles/SkillEditor` 测试，保留撤权、草稿冲突与授权回读测试。

## Task 6：管理首页组装、分页与动作刷新

**Files:** Modify `web/src/agent/skills/{SkillsPage.tsx,SkillsPage.test.tsx,skills-api.ts}`、`web/src/styles.css`、`web/src/agent/mobile/mobile.css`；必要时修改管理导航所有者 `web/src/agent/ManageMenu.tsx`。

**Interfaces:** 消费Task 4 description、Task 5卡片和编辑面板；页面保留20条分页、q、groupId、selectedId、单卡展开ID、预览缓存。原有create/import/sync入口继续调用现有组件。

- [x] 写失败测试：顶栏新建/导入/刷新；名称搜索、分组筛选回第1页；分页不丢total；分组数量标注“本页”；groups失败不把有groupId技能错标未分组。
- [x] 写倒序响应测试：q旧请求晚于新请求返回不能覆盖；切页或关闭预览后旧详情不能回填；最多展开一张；动作后revision更新使旧缓存失效。
- [x] 写权限动作回归：启停/发布失败保留卡片；发布成功刷新卡片和编辑详情；按钮禁止双提交；“编辑/版本/权限”打开正确技能；dirty时切换编辑目标先确认，停留在当前卡片展开预览不丢编辑文本。
- [x] 运行 `npm test --prefix web -- src/agent/skills/SkillsPage.test.tsx`，确认失败。
- [x] 将原左窄列表重构为主列表卡片视图，顶栏粘性布局；维护范围文案明确“你有维护权限的技能”，不增加“已加载”tab或假全局数量。
- [x] 管理列表请求增加AbortSignal/序列号保护；过滤项改变清页码，动作刷新保持条件；删除/撤权造成当前页空且page>1时退一页重新加载，禁止无限重试。
- [x] 预览只请求用户当前允许看的版本；read-only正文按既有API权限；以revision缓存，错误可重试，不在打开页面时对每卡片HTTP请求详情。
- [x] 连接编辑面板、创建、导入和同步完成回调；dirty保护覆盖面板关闭、返回按钮与编辑目标切换；其他站内跳转及浏览器内部后退限制按Task 5记录，不伪称全站导航已阻断。
- [x] 复跑 `npm test --prefix web -- --maxWorkers=1 src/agent/skills src/agent/AgentPage.test.tsx src/App.test.tsx`，记录差异和通过数。

## Task 7：配置启用、完整回归与真实验收

**Files:** Modify `.env.example`、`docs/deployment/agent-skills.md`；Update `docs/agent-skills-ui-verification.md`；仅在执行授权覆盖的本地环境精确修改被gitignore的.env配置。

**Interfaces:** 基础技能运行须 `AGENT_SKILLS_ENABLED=true`、显式两个存储目录、DB迁移和服务重启；脚本执行维持独立开关。只有本任务真实验收后才报告“本地已启用并可调用”。

- [x] 补.env.example注释，使用spec §7的关闭默认值与路径示例；不写真实绝对路径或密钥进公共模板。更新部署文档，明确关闭/空目录/无权/错误区别及需要重启。
- [x] 对执行环境核对配置注入来源和管理员持久目录，避开用户workspace与/tmp；若已有目录不覆盖已有资源。只修改指定键，不重写.env、不输出全部环境变量。
- [x] 运行 `npm run db:migrate`；确认010–013状态，已应用的迁移不修改。只在明确本地目标DB运行，不对未知生产连接执行迁移。
- [x] 本地设好SKILLS_STORAGE_ROOT和SKILLS_IMPORT_TEMP_ROOT，开基础总开关；不改脚本、Docker、配额和磁盘保护设置。使用 `npm run dev:mastra` 或实际现有进程管理方式重启服务，避免占用端口时重复启动。
- [x] 单独运行 `./node_modules/.bin/tsc --noEmit`；`npm test --prefix web -- --maxWorkers=1`；`node --env-file-if-exists=.env --import tsx --test tests/skills-*.test.ts`。分批运行避免机器资源竞争，记录默认Docker跳过项。
- [x] 运行 `npm test` 记录根全量结果，失败逐项与Task 0/历史线索比对。若与本次改动有关必须修复；不直接把所有失败归为磁盘基线。
- [x] 运行 `npm run build:web` 和 `npm run build:mastra`；若dev正在运行，后端在临时源副本用同一Node22运行npm脚本，保存日志并清理自己创建的临时目录，不动live输出。
- [x] 真实浏览器桌面和390px：按照spec §9走选择/搜索/IME/标签上限/快捷/管理/文件/版本/权限/导入入口；检查暗色、滚动定位与焦点。记录截图路径和浏览器环境，不用jsdom宣称视觉通过；手机软键盘无真实设备时明确未验证。
- [x] 真实登录创建唯一验收技能（例如附当前时间后缀），正文包含可辨认的行为要求；验证草稿不可调用，发布并启用后进入可用列表；通过`/`选中、发消息，检查实际skill工具/Processor加载事件与模型响应。无模型凭据时记录阻塞，不能以mock替代。
- [x] 验证一次撤权/停用后选择不可成功使用，以及失败后草稿/附件仍能恢复；正常消息、模型切换、附件发送均无回归。验收技能结束后停用，不直接删生产表或用户资源。
- [x] `git diff --check`，审查本次新增文件/实际diff，补最终证据表，未完成项留空；只报告实际完成范围，不自动commit/push。

## Cursor 可直接使用的执行提示

```text
请先完整阅读以下两份文档，再从 Task 0 开始按顺序实施：
1. docs/superpowers/specs/2026-10-20-agent-skills-ui-alignment-design.md
2. docs/superpowers/plans/2026-10-20-agent-skills-ui-alignment.md

执行已确认的 slash 技能选择、datax风格管理卡片与本地基础技能启用。
遵守根AGENTS.md，Mastra工作先加载本地mastra技能；保留全部现有未提交修改。
每任务先补关键行为失败测试、确认失败，再最小实现与复跑；完成一项勾一项。
不要引入Ant Design、改变5技能上限、改写服务端权限/pin、开启脚本或Docker外网。
按计划只补管理description，不新增已加载tab或市场；不要把enabled冒充已加载。
本地配置修改不得泄露密钥；生产部署不在范围。不要自动commit/push。
所有实际测试、浏览器截图、真实模型调用和阻塞写入 docs/agent-skills-ui-verification.md。
计划与代码不符时先核对源码并记录最小适配；涉及权限/数据或扩大范围再说明，不静默减功能。
```

## 交付与回滚

最终输出包含：变更文件摘要、实际命令与结果、桌面/390px截图、基础技能是否真实启用并调用、未验证项。UI回滚只回退本任务diff，不覆盖既有九项修复；本地总开关可改回false并重启，保留数据库和不可变资源目录，不删数据、不回滚已应用迁移。已选标签不是已加载证据。


## 2026-10-20 执行复核与用户追加要求

手机实现以用户追加指令为准：Inbox和手机会话均从加号菜单进入第二级底部技能列表，不使用slash，不保留独立技能按钮；桌面slash继续使用。新增AgentPage landingSkillIds→AgentChat.initialSelectedSkillIds传递和模型就绪后的首条自动发送等待。

实际复核发现、RED→GREEN测试、桌面/390px截图、真实模型加载、失败恢复、停用及测试资源处理，统一记录在[验收记录](../../agent-skills-ui-verification.md)的“Codex复核与补齐”章节。原Task 7前三项未完门禁按该章节实际证据更新；手机软键盘未验收、Auto停用状态误答单列为限制，不冒充通过。
