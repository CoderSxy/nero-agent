import { Agent, type ToolsInput } from '@mastra/core/agent';
import { TaskSignalProvider } from '@mastra/core/signals';
import { askUserTool, webFetchTool } from '@mastra/core/tools';
import { LocalFilesystem, LocalSandbox, Workspace } from '@mastra/core/workspace';
import { temporalProcessor } from '../temporal/processor';
import { temporalInstructions } from '../temporal/instructions';
import { chartInstructions } from './chart-instructions';
import { createTurnPolicyProcessor } from './turn-policy-processor';
import { memoryForRequest } from './memory-model';
import { startScheduleTool, stopScheduleTool } from '../tools/schedule-tools';
import type { RequestContext } from '@mastra/core/request-context';
import { resolveSelectedModel, trustedUserFrom } from '../models/resolver';
import { createTransportModel } from '../models/transport';
import { tavilySearchTool } from '../tools/tavily-search-tool';
import { isWorkspaceResolverEnabled } from '../workspace/config';
import { resolveUserFilesystem } from '../workspace/resolver';
import { isUserFilesEnabled } from '../files/policy';
import { attachmentPersistenceProcessor } from '../files/attachment-persistence-processor';
import { userFileTools } from '../files/tools';
import { disabledNativeWorkspaceTools } from '../sandbox/native-tools';
import { sandboxTools } from '../sandbox/tool';
import { financeSearchTool, financeInterfaceInfoTool, financeFetchTool } from '../finance/tools';
import { isFinanceEnabled, trustedFinanceCategory } from '../finance/scope';
import { installSkillExecutionBindings } from '../skills/agent-bindings';
import {
  resolveSkillAgentProcessor,
  resolveSkillAgentTools,
} from '../skills/factory';

const workspacePath = 'workspace';

const workspace = new Workspace({
  id: 'agent-workspace',
  name: '智能体工作区',
  filesystem: new LocalFilesystem({
    basePath: workspacePath,
  }),
  sandbox: new LocalSandbox({
    workingDirectory: workspacePath,
  }),
  tools: disabledNativeWorkspaceTools,
});

const userWorkspace = new Workspace({
  id: 'user-workspace',
  name: '用户工作区',
  filesystem: resolveUserFilesystem,
  tools: disabledNativeWorkspaceTools,
});

function isAdmin(requestContext: RequestContext): boolean {
  try {
    return trustedUserFrom(requestContext).roles.includes('admin');
  } catch {
    return false;
  }
}

const turnPolicyProcessor = createTurnPolicyProcessor();

export const agent = new Agent({
  id: 'agent',
  name: '智能体',
  description:
    '通用智能体，可以搜索资料、管理任务、处理本地文件、执行经批准的命令并创建定时任务。',
  metadata: {
    suggestedPrompts: [
      '这个周末上海的天气怎么样？',
      '现在 SPCX 的股价是多少？',
      '制作一个日本樱花节活动页面。',
    ],
  },
  instructions: () => `你是一个友好的通用智能体。默认使用简体中文回复，帮助用户搜索资料、完成任务、处理本地文件，并探索 Mastra 的能力。用户明确要求其他语言时，按其要求回复。

${temporalInstructions}

可建议用户尝试：查询所在城市的天气；制作一个樱花节活动页面；查询 SPCX 股价并设置定时提醒。

用户打招呼或没有提出具体任务时，可以简要介绍这些示例。需求不明确时，提出简短的问题。

${isUserFilesEnabled() ? `用户要求保存 Markdown、HTML 或其他文本到工作区时，使用 write_file 工具写入当前会话目录，path 使用相对路径；写入成功后再告知用户。修改本地文件后，在回复中给出工具返回的应用内路径 /user-files/<threadId>/<相对路径>，不要输出宿主 file: URL、localhost 或磁盘绝对路径。

查找或修改已有文本文件时，优先：glob 找路径 → grep 或 read_file 定位内容并取得 ETag → 用 edit 做一次精确替换。调用 edit 时必须把 read_file/grep 返回的 ETag 原样传入 expectedEtag，不要改写或猜测。若返回 STALE_VERSION（版本冲突），重新 read_file 或 grep 后再 edit，不要用旧 ETag 盲目重试覆盖。grep 为字面文本搜索，不是正则。

文件工具默认 scope 为当前会话目录（thread）。仅当用户明确要求处理个人工作区中的上传或其他个人文件时，才使用 scope: "workspace" 与工作区相对路径（例如 uploads/<UUID>/note.txt）。不要猜测宿主绝对路径、file: URL 或其他用户/其他会话路径。

用户消息中若列出附件 ID 与名称，使用 read_attached_file({ attachmentId }) 读取；不要猜测工作区路径，也不要用 glob/grep/edit 的 path 传附件 ID。文本附件返回内容；图片仅在当前模型支持视觉时可读。` : '当前环境文件功能未开放。用户要求读写工作区文件时，明确说明暂不可用；不要调用无关工具代替文件操作。'}

执行脚本时：execute_command 使用 command + args；execute_bash 支持完整 Bash 语法。每次都是新进程，export、source、cd 不会跨调用保留。启用任务依赖环境后，Python 已使用当前会话的虚拟环境，安装用 python -m pip install；Node 依赖在当前会话目录 npm install，不用 sudo、apt 或系统全局安装。公开 HTTP/HTTPS 出口仅在管理员配置就绪时可用，尊重工具返回的网络错误，不尝试绕过。需要使用技能脚本或模板时，先 prepare_skill_resources 获取容器路径；不要猜 /primeai 等其他平台路径。退出码非零或没有预期产物时不得宣称成功。

${chartInstructions}
`,
  model: async ({ requestContext }) => createTransportModel((await resolveSelectedModel(requestContext, 'chat')).config),
  maxProcessorRetries: 1,
  defaultOptions: {
    maxSteps: 100,
    autoResumeSuspendedTools: true,
  },
  memory: memoryForRequest,
  workspace: ({ requestContext }) => {
    if (!isAdmin(requestContext)) return undefined;
    return isWorkspaceResolverEnabled() ? userWorkspace : workspace;
  },
  tools: ({ requestContext }) => resolveAgentTools(requestContext),
  // App skill/skill_read/skill_search only — do NOT configure native Agent.skills auto-tools.
  inputProcessors: [temporalProcessor, attachmentPersistenceProcessor, resolveSkillAgentProcessor(), turnPolicyProcessor],
  outputProcessors: [attachmentPersistenceProcessor, resolveSkillAgentProcessor(), turnPolicyProcessor],
  signals: [new TaskSignalProvider()],
});

// Chat / stream / resume / sendMessage: bind server-owned runId before skill pins.
installSkillExecutionBindings(agent);

function resolveAgentTools(requestContext: RequestContext): ToolsInput {
  const common = {
    ask_user: askUserTool,
    web_fetch: webFetchTool,
    web_search: tavilySearchTool,
    ...(isUserFilesEnabled() ? userFileTools : {}),
    ...sandboxTools(),
    ...(isFinanceEnabled() && trustedFinanceCategory(requestContext) ? {
      finance_search: financeSearchTool,
      finance_interface_info: financeInterfaceInfoTool,
      finance_fetch: financeFetchTool,
    } : {}),
    ...resolveSkillAgentTools(),
  };
  if (isAdmin(requestContext)) {
    return { ...common, start_schedule: startScheduleTool, stop_schedule: stopScheduleTool } as ToolsInput;
  }
  return common as ToolsInput;
}

export function listAgentToolIds(requestContext: RequestContext): string[] {
  return Object.keys(resolveAgentTools(requestContext));
}
