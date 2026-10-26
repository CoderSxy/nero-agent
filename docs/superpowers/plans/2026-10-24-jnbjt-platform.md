# 江南百景图规划平台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本计划不要求创建并行代理；用户另行授权时才使用代理执行。

**Goal:** 在新仓库中建设可追溯知识来源、可保存城市状态并进行可靠生产与布局规划的轻量 Web 工具。

**Architecture:** npm workspaces 模块化单体，React 静态前端 + 一个 Fastify API 进程。PostgreSQL 复用现有实例并隔离数据库；Wiki 默认在本机离线采集，审核后导入，AI 调用外部模型。

**Tech Stack:** Node.js 22（最低 22.13）、TypeScript、React、Vite、Fastify 5、TypeBox、pg、Cheerio、React-Konva、Vitest、Playwright。

**Spec:** `../specs/2026-10-24-jnbjt-platform-design.md`。将两份文档复制到新仓库时，可分别命名 `docs/design.md` 与 `docs/implementation-plan.md` 并更新此引用。

## Global Constraints

- 新仓库建议名 `jnbjt-planner`；本计划中的所有代码路径均相对于新仓库，不在 nero-agent 实现游戏业务。
- 一套前端、一个后端进程；后端建议监听 `127.0.0.1:3100`，部署前检查端口；同域 `/api/v1`。
- Node.js 22，最低 22.13；依赖初始化时核对安全版本和 Fastify 插件兼容性，固定版本并提交 lockfile。
- PostgreSQL 独立 `jnbjt` 数据库和应用账号；连接池上限 3。
- AI/视觉/布局长任务执行并发总数 1；每用户排队上限 10。
- 图片仅 JPEG/PNG/WebP，单文件 10 MiB、2000 万像素，文件私有。
- Wiki 并发 1，请求间隔至少 3 秒并加入抖动，初始每次最多 100 请求，页面最多 100 个候选；站点更严格限制优先。
- 缺失数值不能填 0；AI 不生成可直接发布的游戏事实；导入、识别和布局修改均保留审核/确认。
- 不包含 Tauri、自动游戏操作、游戏账号接入、Redis、独立向量库和微服务。

## Review Focus

- Wiki 页面中导航、图片单位和合并单元格混合：任务 1–2 使用真实快照验证，不能把页面抓取成功当解析正确。
- 同名建筑跨城不同、生产数值含条件：任务 2–3 强制 variant 与 unknown 语义，计算不得忽略缺失约束。
- 网络重试或进程重启：任务 4 验证幂等认领、租约恢复与有限重试，不重复应用结果。
- 多标签页保存和截图合并：任务 3、7 验证 409 版本冲突与确认前不修改状态。
- 同机低内存及现有服务共享：任务 8 用实测 RSS、现有服务健康和恢复演练决定部署，不只看新应用返回 200。

## Task 1：采集探针与资料覆盖报告（P0）

**Files:** `packages/knowledge-import/src/{policy,client,probe}.ts`、`scripts/wiki-probe.ts`、`tests/fixtures/wiki/`、`tests/wiki-policy.test.ts`、`tests/wiki-probe.test.ts`、`docs/data-coverage.md`。一并建立所需最小根 package.json、workspace、TypeScript 和测试配置。

**Interfaces:** `checkSourceUrl(url: URL, robotsText: string): {allowed: boolean; reason: string}`；`probeWiki(config: ProbeConfig): Promise<ProbeReport>`。ProbeReport 包含采样 URL、revision、API 能力、字段覆盖、缺失和拒绝原因；ProbeConfig 的来源域与路径固定在配置，不接受任意公网 URL。

- [ ] 先写测试：robots 禁止 index.php/oldid 路径，允许范围外域名和重定向被拒绝；429 读取 Retry-After，403 停止，不进入无上限重试。
- [ ] 运行 `npm test -- tests/wiki-policy.test.ts tests/wiki-probe.test.ts`，确认缺实现失败。
- [ ] 实现策略、串行限速、20 秒超时、最多 3 次退避、API JSON error 处理；定义 ProbeConfig/ProbeReport 并导出。测试使用固定网络替身，避免日常测试请求真实 Wiki。
- [ ] 通过上述测试后，显式运行 `npm run wiki:probe -- --limit 20`；只读采集允许的公开样本，保存快照和报告，原始资料不默认提交 Git。若站点禁止或资料不足，报告具体缺口，不能扩大抓取范围绕过限制。
- [ ] 验收 API 和至少两类详情页的结构，输出许可/robots 检查、字段缺失和适用城市。提交代码与报告，不提交私人图片和密钥。

## Task 2：结构化知识导入与资料站（P1 前半）

**Files:** `packages/contracts/src/knowledge.ts`、`packages/knowledge-import/src/{parse-building,normalize,bundle}.ts`、`scripts/{wiki-sync,import-bundle,migrate}.ts`、`migrations/001_knowledge.sql`、`apps/api/src/{app,server}.ts`、`apps/api/src/plugins/db.ts`、`apps/api/src/modules/knowledge/{routes,repository}.ts`、`apps/web/src/features/knowledge/KnowledgePage.tsx`、`tests/{wiki-parser,knowledge-import,knowledge-search}.test.ts`。

**Interfaces:** `parseBuilding(snapshot: SourceSnapshot): ParsedBuildingDraft`；`buildKnowledgeBundle(drafts: ParsedBuildingDraft[]): KnowledgeBundle`；`importKnowledgeBundle(pool: Pool, bundle: KnowledgeBundle): Promise<ImportReport>`；`searchKnowledge(query: KnowledgeQuery): Promise<KnowledgeHit[]>`。类型在 contracts 中定义，事实草稿包含城市分支、原文、null/unknown 和字段来源，不把草稿类型误用成 published fact。

- [ ] 写真实允许样本的快照测试：城市同名分支、图片单位、rowspan/colspan、生产档位、“15+60”等条件表达式；未知值不变成 0，导航内容不进入生产表。
- [ ] 写数据库测试：同 bundle 重导不重复；人工覆盖不被刷新覆盖；候选导入失败不切换激活知识版本；字段可定位 snapshotId。
- [ ] 运行 `npm test -- tests/wiki-parser.test.ts tests/knowledge-import.test.ts tests/knowledge-search.test.ts`，确认必要测试先失败；测试库与生产库完全隔离。
- [ ] 实现编号迁移器、解析器、哈希数据包、暂存/审核/发布 CLI；发布在事务中切换知识版本，至少保留上个可用版本。
- [ ] 实现 GET `/api/v1/knowledge/search`、GET `/api/v1/buildings/:id` 和前端资料列表/详情，展示来源、许可、更新时间、已确认/待确认。中文检索包含名称、别名和短词降级。
- [ ] 运行上述测试及 `npm run typecheck`、`npm run build`；人工抽检首批关键数值，不用模型自己“审核”自己的抽取结果。提交。

## Task 3：独立登录、城市存档与生产计算（P1 后半–P2）

**Files:** `migrations/002_player_data.sql`、`apps/api/src/plugins/auth.ts`、`apps/api/src/modules/{auth,cities,production}/`、`packages/contracts/src/{city,production}.ts`、`packages/domain/src/{production,recipe-graph}.ts`、`apps/web/src/features/{auth,cities,production}/`、`scripts/create-user.ts`、`tests/{auth-isolation,city-version,production}.test.ts`。

**Interfaces:** `calculateProduction(input: ProductionInput, rules: RuleSet): ProductionResult`；`saveCity(userId: string, cityId: string, expectedVersion: number, state: CityState): Promise<CitySnapshot>`。ProductionResult 明确包括状态、材料缺口、轮数、理论耗时、日历时间估计、假设和缺失条件；版本冲突映射 HTTP 409。

- [ ] 写测试：未登录 401、跨用户 404/403、Cookie 只限当前主机、CSRF 拒绝、旧 version 返回 409；密码与 Key 不出响应。
- [ ] 写计算测试：单配方取整、投入缺口、零产出、未知条件、循环链拒算、城市变体、经验证的加成顺序、上线频率影响估计时间。真实规则有来源，合成样例标记 synthetic。
- [ ] 运行 `npm test -- tests/auth-isolation.test.ts tests/city-version.test.ts tests/production.test.ts` 确认先失败。
- [ ] 实现管理员 CLI 开户、服务端 session、鉴权、城市保存/导出、参数化 SQL 和纯函数计算；先只支持有完整数据的指定配方与已验证链路，不自动补齐未知规则。
- [ ] 加入城市录入和生产计算页面；不调用模型也可使用。运行测试、typecheck、build，浏览器完成登录→录入→保存→计算→刷新复现；作为首个可发布版本。提交。

## Task 4：长任务与模型适配层（P4/P5/P6 共用基础）

**Files:** `migrations/003_jobs.sql`、`packages/contracts/src/jobs.ts`、`apps/api/src/modules/jobs/{repository,runner,routes}.ts`、`apps/api/src/modules/ai/{client,capabilities}.ts`、`tests/{jobs-recovery,model-client}.test.ts`。

**Interfaces:** `enqueueJob(userId: string, key: string, input: JobInput): Promise<Job>`；`claimNextJob(workerId: string): Promise<Job|null>`；`runJob(job: Job, signal: AbortSignal): Promise<JobResult>`；`requestModel(input: ModelRequest, signal: AbortSignal): Promise<ModelResponse>`。JobInput 是 assistant/recognition/layout 的带类型联合，handler 注册固定，不能提交任意函数名或 URL。

- [ ] 写测试：并发执行总数始终 1、排队上限 10、同用户 key 幂等、租约过期恢复、运行中续租、取消结果不落盘、跨用户不能读 job；模型超时和 JSON 错误可重试但有上限。
- [ ] 运行 `npm test -- tests/jobs-recovery.test.ts tests/model-client.test.ts` 确认失败后再实现事务认领、租约、持久状态、关闭处理与统一错误响应。
- [ ] 模型配置仅环境变量或服务端受控配置；对文本/视觉能力做小样本探测，失败标明不可用；不声称拥有 embedding。
- [ ] 运行测试、typecheck 和 build；在测试环境中断并重启任务执行器，验证恢复和日志脱敏。提交。

## Task 5：地图编辑与独立约束校验（P3）

**Files:** `packages/contracts/src/layout.ts`、`packages/domain/src/{grid,layout-validation,effects}.ts`、`migrations/004_layouts.sql`、`apps/api/src/modules/layouts/{routes,repository}.ts`、`apps/web/src/features/editor/{MapEditor,BuildingPalette,LayoutInspector}.tsx`、`apps/web/src/features/editor/history.ts`、`tests/{layout-rules,layout-roundtrip}.test.ts`、`tests/e2e/editor.spec.ts`。

**Interfaces:** `validateLayout(layout: Layout, rules: LayoutRuleSet): LayoutValidation`；`getAffectedBuildings(layout: Layout, effect: EffectRule): EffectEvaluation`。Layout 用整数格坐标、可建区、固定区域、道路、建筑和 schemaVersion/knowledgeVersion 表达；显示坐标不进入游戏逻辑。

- [ ] 写测试：旋转尺寸、边界、碰撞、不可建区、道路规则、锁定建筑、已核验的雕像范围；不支持的范围规则返回 unknown，不能默认命中。
- [ ] 运行 `npm test -- tests/layout-rules.test.ts tests/layout-roundtrip.test.ts` 确认失败，随后实现纯函数校验、保存与 409 冲突。
- [ ] 建立 React-Konva 编辑器：拖动吸附、选择、可用旋转、撤销重做、保存、JSON/PNG 导出；自定义底图明确标记。复杂编辑桌面优先，手机先提供浏览与检查。
- [ ] 通过单测、typecheck、build 与 `npm run test:e2e -- tests/e2e/editor.spec.ts`，保存后重开一致；检查桌面与 390px 手机布局。提交。

## Task 6：带来源的 AI 助手（P4）

**Files:** `apps/api/src/modules/ai/{assistant,tools,citations}.ts`、`packages/contracts/src/assistant.ts`、`apps/web/src/features/assistant/{AssistantPage,AnswerSources}.tsx`、`tests/{assistant-grounding,assistant-failures}.test.ts`、`tests/fixtures/assistant/questions.json`。

**Interfaces:** `answerQuestion(input: AssistantInput, context: AssistantContext, signal: AbortSignal): Promise<AssistantAnswer>`；AssistantAnswer 包含事实、计算结果、建议、引用、假设和缺失信息。tools.ts 只封装前面任务的已定义接口，不新增任意执行能力；布局建议尚未实现时返回 unsupported。

- [ ] 准备 30 条问题，写测试覆盖跨城同名、未知事实、规则缺失、伪造引用、资料内提示注入、模型离线。引用 ID 必须来自本次检索，计算数值必须来自 ProductionResult。
- [ ] 运行 `npm test -- tests/assistant-grounding.test.ts tests/assistant-failures.test.ts` 确认先失败；实现检索→必要计算→schema 验证→答案，补充查询最多两轮，每次检索 5–8 段并限制总上下文。
- [ ] 基于 jobs 返回异步结果；私有存档仅当前用户可读。修改建议只输出差异，不写城市和布局。
- [ ] 跑离线测试和 30 条显式实时评估；输出准确率、引用正确率、拒答和检索失败案例，不能以文风主观判断代替记录。typecheck、build 通过后提交。

## Task 7：截图草稿与局部布局建议（P5–P6，可分别交付）

**Files:** `migrations/005_uploads_drafts.sql`、`apps/api/src/plugins/uploads.ts`、`apps/api/src/modules/imports/{recognize,apply,routes}.ts`、`packages/contracts/src/recognition.ts`、`apps/web/src/features/imports/{UploadPage,RecognitionReview}.tsx`、`packages/domain/src/layout-search.ts`、`apps/api/src/modules/layouts/propose.ts`、`tests/{uploads,recognition-apply,layout-search}.test.ts`。

**Interfaces:** `recognizeScreenshot(uploadId: string, context: RecognitionContext, signal: AbortSignal): Promise<RecognitionDraft>`；`applyRecognition(userId: string, draftId: string, expectedVersion: number, corrections: RecognitionCorrections): Promise<CitySnapshot>`；`proposeLayout(input: LayoutSearchInput, rules: LayoutRuleSet): LayoutProposal`。

- [ ] 写测试：伪装类型、超过 10 MiB/2000 万像素、私有文件越权、重复截图不累加、识别未知留空、确认前不变更、旧版本 409；测试用可控图片和模型替身。
- [ ] 实现图片校验/重编码/EXIF 去除、带证据的草稿、人工校正、事务应用，模型服务用途在上传流程明确展示；HEIC 显示转换说明。
- [ ] 使用至少 20 张用户自有截图进行逐字段评估，记录资源面板/建筑详情的准确率与拒识率；不承诺全城重建。运行 `npm test -- tests/uploads.test.ts tests/recognition-apply.test.ts`，typecheck、build 后可先交付截图功能。
- [ ] 为局部布局写测试：锁定位置不变、全候选经独立校验、无解保留原布局、超时退出、相同输入种子可复现。实现枚举候选和受限启发式评分，`LayoutProposal` 包含可行性、评分、差异和未验证约束。
- [ ] 用目标城市样本测 CPU 和事件循环阻塞；只有超预算时才加 worker_threads，不直接在 Fastify 请求循环里运行长搜索。通过 `npm test -- tests/layout-search.test.ts`，记录运行预算与原布局/候选比较后提交。

## Task 8：上线、恢复与交接（P7；P1–P2 首次发布时先执行适用部分）

**Files:** `deploy/{jnbjt.service,nginx-api.conf,README.md}`、`scripts/{build-release,verify-release,backup}.sh`、`docs/{operations,acceptance}.md`、`tests/e2e/smoke.spec.ts`。

**Interfaces:** `npm run build` 产出可上传的 web/api；`npm run db:migrate` 只执行未登记迁移；GET `/api/v1/health` 表示存活、GET `/api/v1/ready` 检查数据库并对未就绪返回非 200。发布校验脚本比较 SHA-256，不上传环境变量和本地数据库。

- [ ] 在本地/CI 构建 Linux 可运行包；涉及图片原生库时验证 Linux/amd64 依赖；`npm run typecheck`、`npm test`、`npm run build`、`npm run test:e2e -- tests/e2e/smoke.spec.ts` 全部通过后生成发布记录。
- [ ] 生产只读检查端口 3100、现有服务峰值内存、PostgreSQL容量、Nginx/证书/续期配置；不覆盖既有站点，不重建已有 PostgreSQL。
- [ ] 独立数据库/账号、系统用户、目录和环境文件；连接池 3、总长任务并发 1。用实测 RSS 决定服务内存限制，记录 heap 与 RSS 的区别。
- [ ] 先备份当前 jnbjt 配置和数据，安装版本目录，迁移，启动 systemd，校验 ready；`nginx -t` 后再切换 jnbjt 静态根和 `/api/` 路由，保留原证书与跳转。
- [ ] 公网验证 HTTPS 200、HTTP 301、未登录私人 API 401、跨用户隔离、上传/存档/计算核心链路；检查现有 agent 站点仍正常。任务模块上线时测试重启恢复和取消。
- [ ] 实际恢复一次数据库与图片备份到隔离环境；实际演练应用版本回滚，确认用户数据保留；记录证书续期单元和下一执行时间。验收记录只填写实际通过项。
- [ ] 交付当前阶段的功能清单、已知限制和后续顺序，提交变更。没有执行的阶段不能标完成。

## 自审与执行范围

方案各部分对应：来源与许可→任务 1–2；事实/检索→任务 2；用户/计算→任务 3；异步与模型→任务 4；地图→任务 5；AI→任务 6；截图与建议→任务 7；运行/恢复→任务 8。Review Focus 五项都指定了测试归属。

先执行任务 1–3 并以任务 8 的适用部分交付首版；后续任务 4–7 按各自里程碑推进。此文档当前只完成规划，未创建新仓库、安装依赖、执行批量采集、迁移数据库或部署业务 API。
