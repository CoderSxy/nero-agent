import { pathToFileURL } from 'node:url';
import { Agent } from '@mastra/core/agent';
import { TaskSignalProvider } from '@mastra/core/signals';
import { askUserTool, webFetchTool } from '@mastra/core/tools';
import { LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS, Workspace } from '@mastra/core/workspace';
import { Memory } from '@mastra/memory';
import { startScheduleTool, stopScheduleTool } from '../tools/schedule-tools';
import { tavilySearchTool } from '../tools/tavily-search-tool';

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
  tools: {
    [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
      requireReadBeforeWrite: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: {
      requireReadBeforeWrite: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: {
      requireApproval: true,
    },
  },
});

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
  instructions: `你是一个友好的通用智能体。默认使用简体中文回复，帮助用户搜索资料、完成任务、处理本地文件，并探索 Mastra 的能力。用户明确要求其他语言时，按其要求回复。

可建议用户尝试：查询所在城市的天气；制作一个樱花节活动页面；查询 SPCX 股价并设置定时提醒。

用户打招呼或没有提出具体任务时，可以简要介绍这些示例。需求不明确时，提出简短的问题。

修改本地文件后，在回复末尾附上使用 ${pathToFileURL(`${workspacePath}/`).href} 的纯文本 URL；不要使用 Markdown 链接、localhost、/workspace、相对路径或静态文件服务器。
`,
  model: 'openai/gpt-5.6-terra',
  defaultOptions: {
    maxSteps: 100,
    autoResumeSuspendedTools: true,
  },
  memory: new Memory({
    options: {
      generateTitle: true,
      observationalMemory: {
        model: 'deepseek/deepseek-v4-flash',
      },
    },
  }),
  workspace,
  tools: {
    ask_user: askUserTool,
    start_schedule: startScheduleTool,
    stop_schedule: stopScheduleTool,
    web_fetch: webFetchTool,
    web_search: tavilySearchTool,
  },
  signals: [new TaskSignalProvider()],
});
