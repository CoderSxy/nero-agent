# Agent Skills UI 对齐验收记录

工作目录：`nero-agent`。分支：`dev_sxy1`。记录日期：2026-10-20。本文件只记录实际命令结果，未跑项不标通过。

## 基线（Task 0）

### 工作区

会话开始时的快照含大量已修改文件；执行时 `git status --short` 只剩两份未跟踪文档：

- `docs/superpowers/plans/2026-10-20-agent-skills-ui-alignment.md`
- `docs/superpowers/specs/2026-10-20-agent-skills-ui-alignment-design.md`

产品代码在 `1de3fdf feat: skill 补充` 已入库。本任务不把这两份文档当作产品交付，也不提交。

### 版本

| 项 | 实际值 |
| --- | --- |
| Node | v22.22.0 |
| `@mastra/core` | 1.71.0 |
| `mastra` CLI | 1.31.3 |
| React | 19.1.0 |
| Vitest | 3.2.4 |
| `@mastra/playground-ui` | 59.0.0 |
| `react-router-dom` | 7.6.2 |

### 关键接口

- `ComposerInput`（`playground-ui` `composer.d.ts`）是 `ForwardRefExoticComponent<ComposerInputProps & RefAttributes<HTMLTextAreaElement>>`，props 继承 `textarea`。`ref` 指向 textarea，`onKeyDown` / `onSelect` / composition 事件可直接透传，不需要 `inputRef` 或强制类型转换。
- `main.tsx` 使用 `BrowserRouter`。测试使用 `MemoryRouter`。编辑关闭与切技能用组件守卫，刷新关闭用 `beforeunload`，不升级全站数据路由。
- 选择器现况：`SkillPicker` 仍是工具条 + `slashQuery`；`listAvailableSkills` 已接受 `AbortSignal`。管理列表 DTO 尚无 `description`。
- 路由在总开关关闭时抛出 HTTP 503 / `SKILLS_DISABLED` / `Agent skills are disabled`。`isAgentSkillsEnabled()` 仅在 `AGENT_SKILLS_ENABLED===true` 时为真。

### datax 借鉴（只读，未复制鉴权或依赖）

| 文件 | 借鉴 |
| --- | --- |
| `ChatComposer.tsx` | 光标处 slash token、浮层、键盘、IME 不提交 |
| `ComposerSkillPicker.tsx` | 名称/描述入口与搜索面板；不引入 Ant Design Select |
| `SkillsPage.tsx` | 顶栏、分组卡片、展开预览、权限动作；不复制“已加载”tab 与部门树 |
| `skill-editor/SkillEditorWorkspace.tsx` | 独立编辑工作区与返回；不复制其状态枚举 |

路径 `/usr/bin` 与 URL 不按 datax 的“任意斜杠”打开。

### 服务配置来源

`.env` 与 `.env.example` 均未出现 `AGENT_SKILLS_ENABLED`、`SKILLS_STORAGE_ROOT`、`SKILLS_IMPORT_TEMP_ROOT`、`SKILL_SCRIPT_EXECUTION_ENABLED`。监听 4111 的进程环境里这四个键也不存在。未认证请求 `GET /agent-skills/available` 返回 401 `Invalid or expired token`，尚未进入技能开关分支。5173 上有 web 开发服务。本阶段未改配置、未重启。

### 基线命令

- `npm test --prefix web -- --maxWorkers=1 src/agent/skills src/agent/AgentChat.test.tsx src/agent/AgentPage.test.tsx`：12 files / 110 tests 通过（约 18.7s）。
- `./node_modules/.bin/tsc --noEmit`：退出码 0，无诊断输出。

## Task 证据

### Task 1–3（slash、受控面板、输入框）

- `resolveSkillSlash` / `replaceSkillSlash`：折叠选区、空白分隔 token、query 只取光标前、end 指向 token 结尾；`/usr/bin`、URL、`a/b` 返回 null。替换只删 `[start,end)`，`请 /天气 分析` → `请  分析`，caret 2。
- `toSkillUiState`：`SKILLS_DISABLED` →「技能功能未启用，请联系管理员配置」，retryable false；401/403 独立文案；其他失败可重试。
- `SkillPicker` 为受控 `forwardRef` 面板。完整成功目录才 `onCatalogChange`。搜索与 scope 用序列号和 `AbortController` 丢弃旧响应。目录失败与 `SKILLS_DISABLED` 不清空已选。失效标签只在 phase 为 ready 且完整目录缺少该 id 时出现。
- 输入框先判断 IME，再 Shift+Enter，再交给面板，最后才发送。Esc 用 dismissed token 记住关闭，避免立刻重开。
- 快捷入口的常驻「刷新快捷入口」改为菜单项。
- 定向测试：slash 12、ui-state 3、picker 13、skills-api 3、composer 3、AgentChat 43、shortcut 4、ScheduledTasksPage 8，均通过。

### Task 4（管理列表 description）

- `SkillManageListItem.description`：有已发布版本时用该 published 描述；没有已发布版本时，仅 `canEdit` 或 `canManage` 读取草稿描述；仅 publish 授权得到空串。缺版本为空串。列表不增加 `skillMd` / `grants` / `audienceIds`。
- 适配：现有 `canViewDraft` 把 publish 授权也算进去。本任务没有改 policy，草稿描述改由 edit/manage 判断。
- `node --env-file-if-exists=.env --import tsx --test tests/skills-management.test.ts` 中带 description 断言的管理用例通过。随后整份 `tests/skills-*.test.ts` 一并通过，见 Task 7。

### Task 5–6（卡片、编辑面板、管理首页）

- `SkillCard`：空描述显示「暂无描述」；状态为草稿 / 已发布 / 停用；没有「已加载」。动作按钮 `stopPropagation`。
- `SkillEditorPanel` 负责返回确认和 dirty 时的 `beforeunload`。详情、页签、409 和授权仍在 `SkillsPage`，作为 children 传入。关闭和切换技能都走「有未保存的修改，是否放弃？」。
- 管理首页为分组卡片。分组数量文案是「本页 N 项」。分组接口失败时，带 `groupId` 的技能标「分组信息暂不可用」，空 `groupId` 仍是「未分组」。列表请求带 `AbortSignal` 和序列号。当前页被删空且 page>1 时退一页。
- `npm test --prefix web -- --maxWorkers=1 src/agent/skills src/agent/AgentPage.test.tsx src/App.test.tsx`：16 files / 101 tests 通过。

## 真实服务

- 迁移 010–013 在 `app_schema_migrations` 中已存在。`npm run db:migrate` 退出码 0，没有打印新的 `Applied`。
- 本地 `.env` 只追加了 `AGENT_SKILLS_ENABLED=true`、`SKILLS_STORAGE_ROOT`、`SKILLS_IMPORT_TEMP_ROOT`。目录是新建的 `~/.nero-agent/skills-storage` 与 `~/.nero-agent/skills-import-temp`，不在用户 workspace 和 `/tmp`。`SKILL_SCRIPT_EXECUTION_ENABLED` 仍未设置。
- 已有 `npm run dev` 在文件变更后重启 Mastra。重启日志：`mastra 1.31.3 ready`。未认证 `GET /agent-skills/available` 返回 401 `Invalid or expired token`，说明总开关已打开（关闭时同一路由先返回 503）。
- 重启后日志对一批已有发布版本打印 `skill release unavailable … BLOB_MISSING`。新建的存储目录是空的，数据库里的旧发布指针指向的 blob 不在这个目录。没有删除数据库行，也没有改脚本、Docker、配额或磁盘保护。
- 本地基础技能是否已真实调用：否。没有登录凭据，没有创建验收技能，没有真实模型响应。不能把 401 或已选标签当成已调用。

## 桌面 / 390px 截图

未跑。当前会话没有浏览器工具，jsdom 测试不能代替视觉验收。手机软键盘未验证。

## 命令结果（Task 7）

| 命令 | 结果 |
| --- | --- |
| `./node_modules/.bin/tsc --noEmit` | 退出码 0 |
| `npm test --prefix web -- --maxWorkers=1` | 58 files / 401 tests 通过 |
| `node --env-file-if-exists=.env --import tsx --test tests/skills-*.test.ts` | 125 tests，119 pass，6 skip，0 fail。6 项 skip 均为 `SKILLS_DOCKER_INTEGRATION!=true` |
| `npm test` | 461 tests，424 pass，0 fail，37 skip。skip 含 Docker 门禁，以及该脚本不加载 `.env` 时的数据库用例。带 `.env` 的 skills 套件已单独通过 |
| `npm run build:web` | 退出码 0（含 `tsc -b` 与 vite build） |
| 临时源副本 `npm run build:mastra` | 退出码 0。临时目录已删除。仓库内正在使用的 `.mastra` 仍在 |
| `git diff --check` | 退出码 0 |

## 未跑项

- 浏览器桌面与 390px 交互、暗色、滚动和焦点
- 手机软键盘
- 真实登录、创建唯一技能、草稿不可调用、发布启用、`/` 选中后的真实模型/工具加载
- 撤权或停用后的真实发送恢复
- 没有自动 commit / push

## 回滚

UI 回滚只回退本计划产生的 diff。本地总开关把 `.env` 的 `AGENT_SKILLS_ENABLED` 改回 false 并重启即可。保留数据库和 `~/.nero-agent` 下的目录，不删数据，不回滚已应用迁移。

## 已知限制

当前 `BrowserRouter` 不使用 `useBlocker`。浏览器内部后退及其他绕开编辑面板的站内导航不承诺拦截。仅 publish 授权看不到草稿描述；已发布版本的描述仍对管理列表可见。

## Codex 复核与补齐（2026-10-20）

本节为后续实际复核，覆盖上文“未跑”的三项；上文为 Cursor 当时的历史记录，不能当成本节执行后的最终状态。

### 复核修复

1. 搜索独立标记当前 query/scope 与 pending/error；新搜索未完成时不展示或选择旧候选。搜索403等错误不再吞掉，且不清除原选择。回归在修复前失败，修复后通过。
2. 显式搜索输入框复用键盘处理（上下/Enter/Esc/Tab与IME）；不再只有textarea能操作候选。回归在修复前失败，修复后通过。
3. 卡片发布当前dirty技能前确认；拒绝时不发布、不重载覆盖本地正文。新建切换和导入完成切换也走dirty守卫。卡片发布回归在修复前失败，修复后通过；补充新建保留断言。
4. 真实390px检查发现Inbox未接选择状态；补齐landingSkillIds和AgentChat.initialSelectedSkillIds，在新会话首条请求保持UUID意图，离开landing后不串到其他会话。
5. 新会话配置未就绪时不提前消耗sendOnMount的一次机会，配置就绪后只发送一次；补充延迟配置RED→GREEN测试。
6. 新增landing入口暴露快捷API异常响应会崩溃；加入items数组校验，错误归一化展示，不再在异步setState回调抛异常。异常响应RED→GREEN测试及App登录测试通过。

### 用户追加的手机交互要求

用户明确指定：手机Inbox通过加号icon的二级弹层选择技能，参考datax；手机不使用slash触发。

最终实现：手机“＋”→操作菜单“选择技能”→底部技能选择面板（搜索/关闭/刷新/列表）→选中回到输入框标签。手机不显示独立“技能”按钮，`/`仅为普通输入；桌面保持slash和显式技能入口。当前聊天和Inbox共用这一手机入口，Inbox首条消息正确传入已选UUID。保留最多5项。

只读对照了datax `apps/web/src/mobile/MobileComposerAttachmentPicker.tsx` 的 actions→skills 视图；没有引入其Drawer依赖、单选语义或API。原计划中手机slash的截图仅代表中间状态，最终以mobile-plus截图为准。

### 真实浏览器与模型证据

- 使用Chrome原有已登录的本地管理员会话，没有读取或导出浏览器token，没有新建账号或重置凭据。新开标签页没有登录，因此使用同一登录标签页中的独立验收对话。
- 主技能：`qa-ui-20261020-mvgcekuy`，ID `ba0af2b8-536f-480f-ba58-d80c91043553`，私有；主版本v1，manifestHash前缀`a43f40e7`。正文含唯一标记`SKILL_UI_ACCEPT_20261020_K7P9`，用户提问不含标记内容。
- UI创建、保存草稿；未发布时slash搜索显示“未找到匹配技能”；发布后仍停用，启用后可选择。桌面实际模型调用skill工具并回复唯一标记。
- 桌面对话：`/agent/82b732fd-6528-4622-a269-7237ebcd8fea`。先Auto、后切GLM-5.3-Flash；首轮Auto未按正文执行，后续明确模型+指定技能真实调用成功，不能宣称所有模型首轮行为稳定。
- 手机Inbox通过加号二级列表选中主技能，发送首条消息自动创建会话，实际skill调用并返回同一标记。手机对话：`/agent/d5229eb4-f536-4bf9-8d5d-dec10723e294`。
- 只读数据库审计确认上述执行存在`load/ok/v1`；移动首轮execution为`c56e7146-eb77-4c56-8cd1-df707e0ea0de`。不是仅根据chip声称已加载。
- 为真实上限验收，通过应用service创建5个同owner私有占位技能，名称为主技能名加`-limit-1`到`-limit-5`。浏览器选5项后第6项isEnabled=false；移除标签后继续选择主技能。
- 桌面与390×844检查了卡片、资源、版本、权限、快捷配置、导入入口及正文预览；手机列表和编辑页面scrollWidth=390，没有横向溢出。浅色与深色均检查；截图保存在下方目录。物理手机软键盘仍未验证，不能用桌面viewport代替。
- 编辑工作版v2加入未保存测试文本，返回时观察到原生“有未保存的修改，是否放弃？”确认框；取消后文本仍在。随后还原测试文本，不发布v2。浏览器原生确认曾导致DOM自动化等待，切到原生窗口完成取消，没有绕过保护。
- 上传仅含公开验收文字的`skill-ui-acceptance.txt`（43B）。浏览器扩展setFiles受file URL权限限制，改用原生系统文件选择器完成上传，没有扩大扩展权限。未上传私人文件。
- 失败恢复：只对刚上传且内容已核实的验收附件做可逆rename；真实发送报“文件不存在”后，原草稿、已选技能及附件全部恢复。立即将文件rename回原路径并删除恢复清单，未删除用户文件。随后从本消息移除测试附件，保留文件本身。
- 停用：通过应用service只停用本轮6个明确命名的验收技能。携带旧选择发送后，页面真实显示`加载失败 … SKILL_UNAVAILABLE`；没有停用后的load/ok审计。刷新目录显示“暂无可用技能”。没有修改其他技能或清理已有测试DB行。

### 已知模型输出限制（不能标通过）

停用后的服务端加载拒绝及UI失败徽标正确，但本次Auto回复参考了历史成功tool结果，错误声称“可用”。该回复不是鉴权成功证据，本轮不把它算作正确的状态回答。此处涉及模型对历史工具结果和动态失败指令的理解；未在UI任务中改动服务端的部分加载/失败协议，也未用前端隐藏该错误答案。需要另外针对真实模型与代理的prompt兼容性评估；本轮只确认服务端拒绝旧选择、没有继续成功加载。

### 截图

目录：[skill-ui-20261020](screenshots/skill-ui-20261020)。

| 文件 | 证据 |
| --- | --- |
| desktop-management.jpg | 桌面卡片管理与真实发布状态 |
| desktop-slash.jpg | 桌面slash查询当前技能 |
| real-skill-loaded.jpg | 桌面真实skill工具与唯一标记 |
| mobile-management.jpg / mobile-editor.jpg | 390px管理卡片与编辑工作区 |
| mobile-plus-actions.jpg | 手机加号第一级操作菜单 |
| mobile-plus-skills-dark.jpg | 最终手机第二级底部技能列表，深色主题 |
| mobile-five-limit.jpg | 五项上限与第六项禁用 |
| mobile-real-skill-loaded.jpg | 手机首条消息真实加载结果 |
| mobile-send-failure-restored.jpg | 真实失败后草稿、技能与附件恢复 |
| mobile-disabled-skill-rejected.jpg | 停用后SKILL_UNAVAILABLE及实际模型误答，保留原始证据 |

`mobile-slash.jpg`是用户追加要求前的中间截图，不代表最终手机交互。验收后恢复原先浅色主题和默认视口，6个临时技能保持停用，没有自动commit/push。

### 最终命令结果

下表由最后一轮命令实际结束后填写；不沿用Cursor旧的通过数量。


| 最终检查 | 本轮实际结果 |
| --- | --- |
| 前端全量 `npm test --prefix web -- --maxWorkers=1` | 58 files / 411 pass / 0 fail；日志 `/tmp/skill-ui-final-web.log` |
| 新增模型配置延迟自动发送回归 | AgentChat 45/45，包含初始技能UUID与只发送一次；日志 `/tmp/skill-ui-handoff-ready-green.log` |
| 快捷异常响应与App登录 | 11/11；日志 `/tmp/skill-ui-shortcut-malformed-green.log` |
| 根目录 `tsc --noEmit` | 退出0，无诊断；日志 `/tmp/skill-ui-final-types.log` |
| 后端管理/路由实际DB定向回归 | 6 pass / 0 fail / 0 skip；日志 `/tmp/skill-ui-final-backend.log` |

前端全量曾暴露App快捷响应异常，上述RED→GREEN后最终411项通过。构建初轮发现测试里的Testing Library `exact`参数不合法，已移除（字面name本身按全名匹配）；不影响产品行为。最终构建结果见本节后续补充。此次未重新运行全量后端、真实Docker、根目录全部测试或后端构建：本轮补齐只改前端及文档，Cursor后端description已由6项定向复核；不把Cursor旧命令结果冒充本轮重跑。

计划末尾三项已按上述真实证据勾选，表示执行了验收而非所有模型所有状态回答都正确；Auto误答及物理软键盘限制仍明确保留。

- 最终 `npm run build:web`：退出0，包含web `tsc -b`及Vite 8003模块打包；Vite构建2m55s，只有既有大chunk警告。日志 `/tmp/skill-ui-final-build-web.log`。
- 普通消息真实回归：新会话不选择技能，发送“普通消息回归：请只回复 UI_NORMAL_OK。”，实际收到 `UI_NORMAL_OK`，没有技能加载徽标；证据 `screenshots/skill-ui-20261020/normal-message-ok.jpg`。
- 最终 `git diff --check` 通过；计划无剩余未勾选执行项。未重新执行的根全量/后端构建/真实Docker及物理软键盘仍按上述边界记录，Auto停用误答仍为已知限制。
