# Agent Skills 输入交互与管理页对齐设计

日期：2026-10-20。状态：原始范围已确认并由Cursor实现；Codex复核补齐及手机追加要求见验收记录。

配套计划：[执行计划](../plans/2026-10-20-agent-skills-ui-alignment.md)。基础能力沿用 [Agent Skills 设计](2026-10-19-agent-skills-design.md) 及 [九项修复记录](../../skills-nine-fixes-verification.md)。本设计只替换相关交互，并完成本地基础技能启用验收，不重新实现 Skill 子系统。

## 2026-10-20 用户追加要求（手机部分优先于下文原方案）

手机Inbox及手机会话采用datax移动端的加号二级选择：`＋ → 选择技能 → 底部技能列表 → 已选标签`。手机不显示独立技能按钮，不通过输入`/`打开列表，输入提示不再提示slash。桌面继续保留slash。Inbox维护自己的所选UUID并经`initialSelectedSkillIds`传到新会话首条消息；模型配置未就绪时等待后自动发送一次。手机二级面板可搜索、关闭、刷新、显示名称/描述和5项上限，不引入datax依赖。

## 1. 目的与成功标准

用户希望：聊天时输入 `/` 即可像 datax 一样搜索并选择技能，不再看到输入框外突兀的多行技能工具条；技能管理采用 datax 的卡片、分组和编辑体验；日常运行中技能真正可选择、可加载，而非一直显示英文禁用错误。

交付必须同时满足：

1. `/` 弹层、键盘选择、可移除标签和原始草稿能够协调工作。
2. 空闲聊天默认不显示“选择技能 / 刷新 / 刷新快捷入口”常驻工具条。
3. 当前项目最多选择 5 个技能、多技能 RequestContext、服务端权限和 execution pin 语义不变。
4. 管理页展示真实可维护范围和真实状态，预览、编辑、发布、停用与授权操作仍可用。
5. 本地配置完成后，以真实登录身份跑通创建、发布、选择和对话加载；没有跑通时明确记录阻塞，不能拿 mock 测试代替。
6. 390px 手机视口、桌面、明暗主题下可用，弹层不被裁剪，管理编辑不产生页面横向溢出。

## 2. 已核实的现状

### 2.1 不可用提示的来源

`src/mastra/skills/routes.ts` 在总开关关闭时返回 HTTP 503 / `SKILLS_DISABLED` / `Agent skills are disabled`。`config.ts` 要求显式 `SKILLS_STORAGE_ROOT`，导入预览还要求 `SKILLS_IMPORT_TEMP_ROOT`。本轮检查的本地 `.env` 未发现这些技能配置；运行进程可能有额外环境覆盖，因此执行时仍需核对实际服务状态。

这属于部署启用问题，不能通过隐藏报错、默认返回空数组、删除鉴权或将全局默认开关改成 true 解决。基础指令技能和脚本执行是独立能力，本次只要求启用前者。

### 2.2 选择器现状

- `web/src/agent/AgentComposer.tsx` 已接入 `SkillPicker` 和 `SkillShortcutDock`。
- `/` 只通过 `draft.startsWith('/')` 判断；选择后清空整个匹配草稿。缺少按光标替换和完整键盘交互。
- `SkillPicker.tsx` 已有完整分页读取、5 个上限、跨会话防串、失效标签和失败发送保留机制；必须保留这些九项修复成果。
- `SkillShortcutDock` 实际位于 `SkillShortcutForm.tsx`，不存在独立的 `SkillShortcutDock.tsx`；其常驻刷新与原始错误共同造成截图的第二行。
- 现有 CSS 已有选择器样式，不能仅根据截图认定“样式没加载”。此次从布局与交互本身调整。

### 2.3 管理页现状

`SkillsPage.tsx` 使用左列表、右详情，已包含正文、文件、版本、授权、快捷配置和导入/同步。管理列表 DTO 只有 SkillRecord 和能力布尔值，没有 description。现有后端搜索是 canonicalName 搜索，不能把 UI 占位符写成“名称或描述”而不实现相应检索。

## 3. 参考范围及边界

只读参考目录：`/Users/nerosun/裂缝中的阳光/sxy/工作/tc-yyxt/tc-prime-ai-datax`。

| 参考文件 | 借鉴点 |
| --- | --- |
| apps/web/src/components/ChatComposer.tsx | 光标附近 slash 识别、浮层、键盘导航、技能标签 |
| apps/web/src/components/ComposerSkillPicker.tsx | 名称/描述搜索和轻量技能入口 |
| apps/web/src/pages/SkillsPage.tsx | 顶栏、搜索分组、状态卡片、展开预览和权限动作 |
| apps/web/src/pages/skill-editor/* | 独立编辑工作区、清晰的文件/版本操作分区 |

不引入 Ant Design，不照搬 datax API、组织部门模型、状态数值或单技能语义。不修改参考仓库。当前项目仍用 React、lucide-react、CSS 变量、既有路由/API/权限模型。此次不新增技能市场、远程安装、分组 CRUD、作者姓名查询、运行时已加载聚合接口或脚本开关。

## 4. 输入框体验

### 4.1 视觉布局

输入框内上方放已选技能标签及已有附件；下方保留模型、附件、发送等操作。添加一个紧凑的“技能”入口，供手机、鼠标或不熟悉 slash 的用户打开同一面板。输入提示可为“向智能体发送消息，输入 / 选择技能…”。

弹层锚定输入框上边缘，宽度桌面取 `min(420px, 可用视口宽度)`，距视口边缘至少 8px；列表最多高 320px，整体不超过动态可视区域减 16px。手机使用可用宽度；根据可用空间向上或向下放置，布局监听滚动、resize、visualViewport resize，关闭时清理监听。祖先 overflow 导致裁剪时使用 portal，不依赖任意超大 z-index。

每行显示图标、名称、最多两行描述、已选标识；上方标题“选择技能”，下方提示“↑↓ 切换 · Enter 选择 · Esc 关闭”。搜索为空显示全部可调用技能；已选择项明确显示并不可重复添加。最多 5 个时未选项不可添加，显示“最多选择 5 个技能”。

刷新/重试只出现在弹层状态区，不常驻占据聊天区域。快捷入口保留真实可用的入口内容；其刷新改为按需操作，错误通过同一状态文案规则展示，不能重复输出两个英文错误。快捷表单本身不重写。

### 4.2 Slash 识别与替换契约

新增纯函数 `resolveSkillSlash(text, selectionStart, selectionEnd): SkillSlashMatch | null`，match 包含 `start/end/query`，索引遵循 DOM textarea 的 UTF-16 offset。

规则：

- 仅光标折叠且位于 `/关键词` token 内或末尾时打开；`/` 前只允许文本开头或空白，关键词不得包含空白或 `/`。
- `请使用 /天气 分析` 中光标位于“天气”末尾可以打开；替换范围包含该完整 token，保留其后的正文。
- `https://example.com`、`/usr/bin`、`a/b`、选中文字、光标在 token 之前均不触发。将路径视为普通文本，不完全复制 datax 对任意斜杠的识别。
- `replaceSkillSlash(text, match)` 只删除 `[start,end)`；不 trim 全文、不清空其他内容、不改附件，返回新 text 和删除位置 caret。
- 如果删除造成两侧空白相邻，不额外标准化。正文保真优先。
- 选择后恢复输入框焦点和 caret；保留已有标签，按 UUID 去重。
- 编辑和选择时重新校验 match 仍对应当前草稿；会话变化后旧 match 无效。

### 4.3 键盘、输入法和关闭行为

- ArrowDown/ArrowUp 只在面板打开且有可选项时移动，循环选择并滚动可见。
- Enter 在面板打开时优先选择高亮项，不能同时发送消息；无结果、加载或错误时也不能误发送。
- Esc 关闭并保留 `/关键词` 文本；在用户未修改该 token 或重新显式打开之前，不自动立即重开。
- Tab 关闭，保留普通焦点移动；Shift+Enter 保持原换行行为，不选择、不发送。
- IME composing 或 keyCode 229 时，不以 Enter 选择/发送；compositionend 后按实际光标更新。
- 点击外部关闭；点击面板不提前 blur 丢失光标；切换会话、开始运行、组件卸载时关闭和取消在途请求。
- 面板关闭时维持既有 Enter 发送逻辑，不改变发送能力判断。面板未激活前不能让 Enter 自动添加首项。

### 4.4 选择、加载与权限

选择只产生 `selectedSkillIds` 意图，通过现有 `mergeSkillSelection` 发送。不得把完整 SKILL.md 拼到用户文本，不以名称替代 UUID，不绕过工具/Processor。

完整目录成功返回后才能清除失效选择；搜索局部结果、第一页、请求失败都不是撤权证据。保留 `preserveMissing` 的失败发送恢复逻辑。目录和搜索请求使用 AbortController/序列号加 scopeKey 防止旧响应覆盖新会话；关闭搜索时也必须使旧搜索响应失效。

标签文案“已选技能”；实际工具加载仍由现有执行徽标表示。搜索候选不显示为已加载，基础开关启用不意味着脚本可运行。

## 5. 状态与错误契约

新增前端纯转换 `toSkillUiState(error)`，按 `SkillApiError.code/status` 识别，禁止字符串匹配英文 message。

| 状态 | 文案/行为 |
| --- | --- |
| loading | 正在加载技能…，不显示空状态 |
| ready-empty | 暂无可用技能；仅表示成功空目录，可提供管理入口但管理权限仍由服务器检查 |
| search-empty | 未找到匹配技能；保留搜索字与已有标签 |
| SKILLS_DISABLED | 技能功能未启用，请联系管理员配置；管理页额外给出配置说明链接，客户端不能“点击开启” |
| 401 | 登录状态已失效，请重新登录；遵循项目已有登录处理 |
| 403 | 暂无技能访问权限；不得伪装成空目录 |
| 其他错误 | 技能加载失败，请重试；保留选择和草稿 |
| 达到上限 | 最多选择 5 个技能 |

底层 SkillApiError 保持原结构供调用方识别；仅展示层映射中文。原始内部消息不要直接贴到聊天布局，也不打印 token/cookie。禁用状态与网络错误不可自动清空技能选择。

## 6. 管理页体验

### 6.1 列表首页

顶栏“技能管理”，说明“管理你有维护权限的技能”；操作为新建、导入、刷新。搜索占位符明确写“按技能名称搜索”，复用当前名称检索。分组筛选沿用 `groupId` 和既有分页，每页 20。列表请求取消/序列号保护，搜索和分组切换回第 1 页，不能让旧请求覆盖新条件。

列表主体采用卡片；按当前页分组展示，组头说明“本页 N 项”，不冒充全局数量。空组显示“未分组”，groups 元数据加载失败使用“分组信息暂不可用”并允许重试，不把已有 groupId 错标为未分组。

卡片包括名称、描述、启用/停用、已发布 vN/未发布、可见范围（私有/全局/受限）和分组；不渲染 revision 等内部字段为主视觉信息。未发布时展示“草稿”，enabled=true 但没有 publishedVersion 不能显示“可调用”。版本缺失、停用和运行加载是不同状态。

本期不做“已加载”tab，也不将“启用”等同“已加载”。列表范围为“可管理技能”，不使用“所有人的全部技能”文案。保持分页，不只抓一页后做全局过滤。

### 6.2 卡片描述的最小后端补齐

仅扩展管理列表 DTO `SkillManageListItem.description: string`，不返回完整正文、grants 或 audienceIds。前后端类型同步，旧响应缺 description 时 UI 兜底“暂无描述”。

service 在现有权限检查后取当前已发布版本 description；无已发布版本时，仅 caps.canViewDraft 允许读取草稿 description，否则返回空串。不得因描述查询放宽权限或把未授权草稿摘要泄露给仅有发布权限的用户。优先复用 loadCaps/版本查询结果，避免新增每卡片 HTTP 请求。不改变 GET /agent-skills 的分页与搜索语义；空或丢失版本返回空串。

### 6.3 展开预览与编辑面板

卡片展开按需请求现有详情，最多展开一张；成功结果按 `skillId + revision` 缓存。切卡片、关闭和修改后避免过期响应回填。用现有 Markdown 渲染方式预览；不得启用 raw HTML。无权读草稿时只读已发布正文，不能因为可管理列表可见就加载草稿。

“编辑”打开独立工作区：桌面右侧宽面板，390px 全屏编辑；顶部返回/关闭、名称、状态，正文/文件/版本/权限/快捷五个页签沿用现有组件和动作。编辑草稿和发布正文明确标注，不能静默展示错误版本。

未保存修改在关闭编辑、切换技能时提示“有未保存的修改，是否放弃？”；保留/放弃两项。浏览器关闭仅可使用原生 beforeunload；当前main.tsx使用BrowserRouter，不能直接调用只支持数据路由的useBlocker。本次不改全站router；保证编辑面板关闭和切换技能时提示，刷新/关闭浏览器使用原生beforeunload。浏览器内部后退或其他绕开编辑面板的站内跳转不承诺阻断，需在验收记录明确这一限制。保存成功、明确放弃后清除dirty。

动作权限保持既有逻辑：编辑 canEdit，发布/回滚 canPublish，启停与权限/快捷维护依现有 canManage 等实际后端检查。不要只按角色或作者字段重算。卡片按钮阻止冒泡，不能同时展开。变更动作执行期间阻止重复提交，成功刷新 detail、卡片及其 revision；409 保留本地草稿并显示冲突处理，不自动覆盖。

导入/同步保持预览确认流程、不自动发布；文件、授权、历史版本能力不得因换 UI 丢失。抽取原有编辑控制器时不要重写这些契约。

## 7. 配置与本地启用

代码仓库默认 `AGENT_SKILLS_ENABLED=false` 不变。`.env.example` 增加注释样例：

```dotenv
AGENT_SKILLS_ENABLED=false
SKILL_SCRIPT_EXECUTION_ENABLED=false
# 启用基础技能时显式设置；不使用用户workspace或/tmp作为默认持久目录。
# SKILLS_STORAGE_ROOT=/absolute/admin-owned/skills
# SKILLS_IMPORT_TEMP_ROOT=/absolute/admin-owned/skill-imports
```

实际启用仅在 Cursor 得到后续执行授权的本地目标环境进行：先核对数据库迁移至 013（已应用则不重复建表）、确认已有环境变量是否由 shell/部署注入，再设置两个独立管理员目录，最后开总开关并重启实际 Mastra 进程。目录不得是用户 workspace、源码 public 或其他用户可写共享目录；沿用环境现有数据盘约定。

只追加或精确更新相关键，不重写整个 .env，不展示其余密钥，不自动提交 .env。不自动开启脚本、修改 Docker 网络、关闭磁盘保护或更换镜像。生产启用不包含在此次本地 UI 任务中。

## 8. 文件边界

| 文件 | 职责 |
| --- | --- |
| web/src/agent/skills/skill-slash.ts + .test.ts | token识别和替换纯函数 |
| web/src/agent/skills/skill-ui-state.ts + .test.ts | 错误到中文展示状态映射 |
| web/src/agent/skills/SkillPicker.tsx + .test.tsx | 目录/搜索、可选项、上限、请求隔离；改为受控弹层，不保留常驻toolbar |
| web/src/agent/skills/SkillSelectionChips.tsx | 已选UUID标签及失效展示，单一职责 |
| web/src/agent/AgentComposer.tsx + AgentChat.test.tsx | 光标、组合输入、键盘优先级、标签/弹层挂载、发送集成 |
| web/src/agent/AgentComposer.test.tsx | 新建直接覆盖输入框事件的组件测试，复用既有Mock模式 |
| web/src/agent/skills/SkillShortcutForm.tsx + .test.tsx | 移除常驻刷新、映射错误；保留现有快捷字段/选项 |
| web/src/agent/skills/SkillCard.tsx + .test.tsx | 管理卡片、动作、预览 |
| web/src/agent/skills/SkillEditorPanel.tsx + .test.tsx | 从SkillsPage抽取已有详情维护工作区，保留权限/冲突/dirty保护 |
| web/src/agent/skills/SkillsPage.tsx + .test.tsx | 顶栏、搜索分组、分页、选中与编辑协调 |
| src/mastra/skills/{types,service}.ts，前端types.ts | 管理列表description最小契约扩展 |
| web/src/agent/skills/skills-api.ts | 需要时透传AbortSignal，不改变URL/鉴权/If-Match |
| web/src/styles.css、web/src/agent/mobile/mobile.css | 主题、浮层、卡片与窄屏布局 |
| .env.example、docs/deployment/agent-skills.md | 启用说明和样例，不存真实密钥 |
| docs/agent-skills-ui-verification.md | 执行证据、截图位置、未跑项和阻塞 |

## 9. 验收门禁

单元/组件：纯token边界、正文保真、IME、键盘优先级、错误映射、分页>50、跨scope响应、失效选择保留、卡片权限、dirty/409、分组与分页。后端：管理description权限与旧接口回归。检查根与web类型、构建。

真实浏览器至少桌面与390px各一次：未启用、无技能、可用技能、搜索无结果、已选择/删除、5项上限、快捷入口、卡片预览、编辑返回、文件/版本/授权与导入入口；保存截图并检查暗色主题、滚动定位、虚拟键盘可用性。

真实本地服务：登录本人账号，新建唯一测试技能并保存draft；验证未发布不进入可调用目录；发布并按既有语义启用；`/`选中后发送一条要求执行正文标记的消息，验证工具/Processor实际加载，消息面板有真实加载事件。对话发送后UUID意图不丢失，搜索未选技能不冒充已加载。测试技能结束后停用，不直接删数据库数据。

测试通过、启用完成、真实模型执行、浏览器验收分开记录。模型无凭据或服务无法启动时，准确记录阻塞与已完成范围。现有48项磁盘保护失败只作为历史线索，不能不跑就宣称本轮仍完全相同。所有未跑项不得勾为通过。
