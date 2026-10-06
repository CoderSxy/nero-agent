# Agent Right Panels and File Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Agent 页实现互斥、顺序动画的 Config/文件面板，以及当前工作区文件的预览、文本编辑和安全保存。

**Architecture:** 保留现有 Agent 页面和 Mastra 工作区读取路由，拆出面板控制器、文件树、文件预览层与文件客户端。服务端增加基于 ETag 的条件保存，并复用现有身份、来源和路径约束；前端使用 Motion 顺序切换面板，预览器按文件类型懒加载。

**Tech Stack:** React 19、TypeScript、Vite/Vitest、Motion、Monaco、react-pdf、PPTX renderer、open-file-viewer、Mastra 1.71、Hono。

**Spec:** `docs/superpowers/specs/2026-10-06-agent-right-panels-file-preview-design.md`

## Global Constraints

- 只实现目录树、刷新、预览、文本编辑和保存；不引入上传、删除、重命名、移动或压缩操作。
- 同时最多一个右侧面板，允许都关闭；从一个切到另一个时旧面板退出完成后才进入新面板。
- 当前工作区来源规则保持不变：个人工作区按用户隔离，`?source=agent` 仅管理员可访问。
- 仅现存文本文件可保存；只读文件无保存按钮；修改后关闭有保存、放弃、继续编辑三个选择。
- 所有新 Mastra API 路由在 `src/mastra/index.ts` 注册；使用根目录的 `npm run dev`、`npm run build`。
- 从已登录的 `apiFetch` 获取 Blob；预览器不直接请求带身份认证的工作区地址。

## Review Focus

- 快速交替点击两个面板按钮：最终只显示最后选中的面板，旧面板退出前新面板不出现（Task 3）。
- 文件读取或切换期间再次选择文件：过期响应不能覆盖最新选择或未保存草稿（Task 5）。
- 文件名包含空格、`#`、中文或百分号：客户端路径编码与服务端解码仍指向同一文件（Task 2）。
- 符号链接、路径穿越与跨用户工作区：保存必须拒绝且不能写出根目录（Task 1）。
- Agent 或另一窗口在预览后修改文件：旧 ETag 保存得到 412，草稿留在前端（Task 1、Task 5）。

---

## File Map

- `src/mastra/files/workspace-editor.ts`：文本判定、大小、ETag、条件保存服务。
- `src/mastra/files/routes.ts`、`src/mastra/index.ts`：工作区文件 GET 版本头和 PUT 路由注册。
- `web/src/agent/workspace-files.ts`：文件类型判定和文件读取/条件保存客户端。
- `web/src/agent/RightPanelDock.tsx`：切换按钮、动画顺序和响应式面板容器。
- `web/src/agent/WorkspaceFileTree.tsx`：目录结构、展开、刷新和选择。
- `web/src/agent/WorkspaceFileOverlay.tsx`：预览、编辑草稿、保存和关闭确认。
- `web/src/agent/previews/*`：Monaco 与只读格式的懒加载预览器。
- `web/src/agent/AgentPage.tsx`、`ConfigPanel.tsx`、`styles.css`：集成及布局；删除不再使用的 `ThreadFiles.tsx`。

### Task 1: 条件保存工作区文本文件

**Files:** Create `src/mastra/files/workspace-editor.ts`, `tests/workspace-editor.test.ts`; modify `src/mastra/files/routes.ts`, `src/mastra/index.ts`, `tests/workspace-file-routes.test.ts`.

**Interfaces:** `readWorkspaceVersion(data: Uint8Array): string` 产生带引号的强 ETag；`saveWorkspaceText(filesystem: WorkspaceFilesystem, path: string, text: string, expectedEtag: string): Promise<string>` 校验已存在文本、UTF-8、大小、版本后写入并返回新 ETag。GET 保持原二进制响应并加 `ETag`；PUT `/current-workspace/files/*` 使用现有 `currentWorkspace`、`relativeFilePath`，请求为 `text/plain; charset=utf-8` + `If-Match`，成功返回新 `ETag`，冲突返回 412。

- [ ] **Step 1: Write failing tests.** 在 `workspace-editor.test.ts` 测试正常覆盖、缺失/二进制/超限、旧 ETag；在 `workspace-file-routes.test.ts` 测试个人与管理员来源的保存、401/403、路径穿越及符号链接逃逸。
- [ ] **Step 2: Verify red.** Run `node --import tsx --test tests/workspace-editor.test.ts tests/workspace-file-routes.test.ts`; expected new tests fail because save route/service is absent.
- [ ] **Step 3: Implement.** 以现有工作区文件 GET/权限模式增加路由；对同一工作区路径串行化校验与写入，使用当前版本的 `WorkspaceFilesystem.readFile/writeFile`；限制编辑内容为 10 MiB，拒绝 NUL/无效 UTF-8，路径必须指向原有普通文件，状态码区分 400/403/404/409/412/413。
- [ ] **Step 4: Verify green.** Run `node --import tsx --test tests/workspace-editor.test.ts tests/workspace-file-routes.test.ts`; expected 0 failures.
- [ ] **Step 5: Commit.** `git add src/mastra/files/workspace-editor.ts src/mastra/files/routes.ts src/mastra/index.ts tests/workspace-editor.test.ts tests/workspace-file-routes.test.ts && git commit -m "feat: save workspace text with version checks"`.

### Task 2: 文件客户端与类型策略

**Files:** Create `web/src/agent/workspace-files.ts`, `web/src/agent/workspace-files.test.ts`; modify `web/src/agent/client.ts` only if shared auth helper needs a small extension.

**Interfaces:** `workspaceFilePath(path: string, source: 'personal' | 'agent'): string`; `openWorkspaceFile(path, source): Promise<{ blob: Blob; etag: string | null; kind: PreviewKind; text?: string }>`；`saveWorkspaceFile(path, source, text, etag): Promise<string>`。`PreviewKind` 为 `text | markdown | html | image | pdf | pptx | office-drawing | unsupported`；内容探测优先排除二进制，未知有效 UTF-8 文本仍可编辑。

- [ ] **Step 1: Write failing tests.** 覆盖文件类型映射、未知 UTF-8 与二进制、`a b/#中%25.md` 编码、Bearer 请求、ETag 传递、412 错误信息。
- [ ] **Step 2: Verify red.** Run `npm test --prefix web -- workspace-files.test.ts`; expected new tests fail because module is absent.
- [ ] **Step 3: Implement.** 复用 `apiFetch`，限制在线文本打开为 10 MiB；旧版 Office 与未知二进制标记只读。响应读取 Blob 后将其传给预览器；不暴露带身份认证的原地址。
- [ ] **Step 4: Verify green.** Run `npm test --prefix web -- workspace-files.test.ts`; expected 0 failures.
- [ ] **Step 5: Commit.** `git add web/src/agent/workspace-files.ts web/src/agent/workspace-files.test.ts web/src/agent/client.ts && git commit -m "feat: classify and fetch workspace previews"`.

### Task 3: 互斥右侧面板与顺序动画

**Files:** Create `web/src/agent/RightPanelDock.tsx`, `web/src/agent/RightPanelDock.test.tsx`; modify `web/package.json`, root `package-lock.json`, `web/src/agent/AgentPage.tsx`, `web/src/styles.css`.

**Interfaces:** `RightPanelDock({ config, files }: { config: React.ReactNode; files: React.ReactNode })` 自管 `config | files | null`；外部只传面板内容。默认 Config 开启，两个按钮固定上 Config 下文件；`aria-expanded` 与真实可见面板同步。

- [ ] **Step 1: Write failing tests.** 验证初始 Config、同按钮关闭、两者都关、切换时旧面板退出后才出现新面板、快速点击以最后目标为准、减少动态效果。
- [ ] **Step 2: Verify red.** Run `npm test --prefix web -- RightPanelDock.test.tsx`; expected new tests fail because dock is absent.
- [ ] **Step 3: Implement.** 安装 `motion`（沿用参考项目兼容版本），使用 `AnimatePresence mode="wait"` 与 Motion 的布局动画；只挂载一个 `aside`，响应式下改为覆盖式抽屉，给对话区留出固定按钮空间。将原有 Config 从 AgentPage 的常驻第三列移入 dock。
- [ ] **Step 4: Verify green.** Run `npm test --prefix web -- RightPanelDock.test.tsx AgentPage.test.tsx`; expected 0 failures.
- [ ] **Step 5: Commit.** 提交本任务依赖锁文件、组件、样式与测试，消息 `feat: add animated agent right panels`。

### Task 4: 工作区目录树

**Files:** Create `web/src/agent/WorkspaceFileTree.tsx`, `web/src/agent/WorkspaceFileTree.test.tsx`; modify `web/src/agent/ConfigPanel.tsx`, `web/src/agent/ConfigPanel.test.tsx`, `web/src/agent/AgentPage.tsx`, `web/src/styles.css`; delete `web/src/agent/ThreadFiles.tsx`.

**Interfaces:** `WorkspaceFileTree({ source, workspaceId, refreshVersion, onOpenFile }: { source: 'personal' | 'agent'; workspaceId?: string; refreshVersion: number; onOpenFile(path: string): void })`。从 `listWorkspaceFiles` 获取完整目录，按目录优先、中文名称排序；刷新保留仍存在目录的展开状态。

- [ ] **Step 1: Write failing tests.** 验证嵌套目录展开/折叠、文件点击回调、刷新保留展开、加载/空/错误、个人与 Agent 来源、文件生成后的刷新。
- [ ] **Step 2: Verify red.** Run `npm test --prefix web -- WorkspaceFileTree.test.tsx ConfigPanel.test.tsx`; expected new tree expectations fail.
- [ ] **Step 3: Implement.** 用现有 `listWorkspaceFiles` 构树；目录按钮支持键盘与 `aria-expanded`，文件类型图标来自 `lucide-react`；Config 的工作区卡片保留配置信息，移除内嵌文件列表；在文件面板挂载新树。
- [ ] **Step 4: Verify green.** Run `npm test --prefix web -- WorkspaceFileTree.test.tsx ConfigPanel.test.tsx AgentPage.test.tsx`; expected 0 failures.
- [ ] **Step 5: Commit.** 提交组件、集成、样式、测试，消息 `feat: browse workspace files in right panel`。

### Task 5: 对话区文件预览、文本编辑及关闭确认

**Files:** Create `web/src/agent/WorkspaceFileOverlay.tsx`, `web/src/agent/WorkspaceFileOverlay.test.tsx`, `web/src/agent/previews/TextEditor.tsx`, `web/src/agent/previews/ReadOnlyPreview.tsx`; modify `web/src/agent/AgentPage.tsx`, `web/src/styles.css`, `web/package.json`, root `package-lock.json`.

**Interfaces:** `WorkspaceFileOverlay({ request, source, onClosed, onSaved }: { request: { path: string; id: number }; source: 'personal' | 'agent'; onClosed(): void; onSaved(): void })`。父级每次选文件递增 `request.id`；预览层内部持有当前文件，只有脏文件确认完成后才处理新请求；关闭或保存失败不丢草稿。`TextEditor` 负责 Monaco 文本/Markdown/HTML 源码与预览；`ReadOnlyPreview` 负责图片、PDF、PPTX、Office/draw.io 与下载兜底。

- [ ] **Step 1: Write failing tests.** 覆盖文本编辑保存、快捷键、干净关闭、脏文件三选项、切换文件时的确认、并发读取过期响应、保存失败/412 保留草稿、二进制无保存按钮、预览失败可下载与 objectURL 清理。
- [ ] **Step 2: Verify red.** Run `npm test --prefix web -- WorkspaceFileOverlay.test.tsx`; expected new tests fail because overlay is absent.
- [ ] **Step 3: Implement.** 安装参考项目采用的 `@monaco-editor/react`、`monaco-editor`、`react-pdf`、`pdfjs-dist`、`@aiden0z/pptx-renderer`、`@open-file-viewer/core` 与 `@open-file-viewer/react`；按需 import 预览器，按已确认类型策略设置只读/编辑，HTML 以无同源权限的沙箱 iframe 显示。预览层用绝对定位只覆盖 `.agent-center`；保存后触发目录刷新。
- [ ] **Step 4: Verify green.** Run `npm test --prefix web -- WorkspaceFileOverlay.test.tsx AgentPage.test.tsx`; expected 0 failures.
- [ ] **Step 5: Commit.** 提交预览组件、依赖锁文件、集成、样式和测试，消息 `feat: preview and edit workspace files`。

### Task 6: 全量验证与视觉验收

**Files:** 只修改前述任务中经验证发现的问题文件和对应测试。

**Interfaces:** 以上所有组件与接口；此任务不新增产品能力。

- [ ] **Step 1: Run full tests.** `npm test && npm test --prefix web`；记录失败并仅修复与本功能相关的回归。
- [ ] **Step 2: Run build.** `npm run build`；确认 Mastra 与 Web 构建均成功。
- [ ] **Step 3: Browser check.** 用根目录 `npm run dev` 启动，检查桌面/窄屏、亮/暗主题、减少动态效果、Config→文件→关闭的顺序及文本/只读文件预览；若因登录环境不可用，明确记录未验证项。
- [ ] **Step 4: Audit.** `git diff --check`，核对设计文档全部验收项，确认无越权接口、无遗留 `objectURL` 与未保存草稿丢失路径。
- [ ] **Step 5: Commit fixes.** 如有验收修复，单独提交；无修复则不产生空提交。
