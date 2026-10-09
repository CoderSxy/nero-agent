/** Project-level presentation tweaks for the bundled Mastra Studio. */
export function studioChineseClient() {
  const translations: Record<string, string> = {
    'Mastra Studio': '智能体平台',
    Primitives: '核心功能', Evaluation: '评估',
    Agents: '智能体', Agent: '智能体', Tools: '工具', Workspaces: '工作区',
    'Request Context': '请求上下文', 'Review Queue': '审核队列',
    More: '更多', Purpose: '用途', Provider: '模型服务商',
    Workflows: '工作流',
    Observability: '可观测性', Traces: '追踪', Logs: '日志', Metrics: '指标',
    Settings: '设置', Overview: '概览', Chat: '对话', Threads: '会话',
    Memory: '记忆', Schedules: '定时任务', Resources: '资源',
    Processors: '处理器', Integrations: '集成', Prompts: '提示词',
    Scorers: '评分器', Datasets: '数据集', Experiments: '实验',
    Search: '搜索', Filter: '筛选', Name: '名称', Description: '描述',
    Status: '状态', Created: '创建时间', Updated: '更新时间',
    Actions: '操作', Run: '运行', Save: '保存', Cancel: '取消',
    Delete: '删除', Edit: '编辑', Create: '创建', New: '新建',
    Close: '关闭', Back: '返回', Next: '下一步', Previous: '上一步',
    Loading: '加载中', Error: '错误', Success: '成功',
    'New thread': '新建会话', 'New chat': '新建对话',
    'Start a conversation': '开始对话', 'Send message': '发送消息',
    'Type a message...': '输入消息…', 'Ask anything...': '输入问题…',
    'No agents found': '未找到智能体', 'No tools found': '未找到工具',
    'No results found': '没有找到结果', 'No results': '没有结果',
    'Filter agents': '筛选智能体', 'Filter tools': '筛选工具',
    'Filter by name': '按名称筛选', 'View all': '查看全部',
    'Learn more': '了解更多', 'Copy': '复制', Copied: '已复制',
    'Open in new tab': '在新标签页打开', 'More options': '更多选项',
    'Light': '浅色', 'Dark': '深色', 'System': '跟随系统',

    // File attachment popover.
    'Public URL': '公开网址',
    Add: '添加',
    'Or from your computer': '或从本机上传',
    'Add a local file': '添加本地文件',

    // Chat options popover.
    'Chat Method': '对话方式',
    Generate: '生成',
    'Stream subscription (default)': '流式订阅（默认）',
    Stream: '流式生成',
    Network: '网络',
    'Require Tool Approval': '使用工具前需批准',
    Temperature: '温度',
    'Top P': '核采样概率（Top P）',
    'n/a': '不适用',
    Reset: '重置',
    'Advanced Settings': '高级设置',

    // Memory panel.
    'Clone Thread': '复制会话',
    'Create a copy of this conversation': '创建此对话的副本',
    Clone: '复制',
    'Recent Messages': '最近消息',
    'Includes the last 10 messages in context.': '上下文中包含最近 10 条消息。',
    'Observational Memory': '观察记忆',
    MESSAGES: '消息',
    OBSERVATIONS: '观察记录',
    'Analyze Observations': '分析观察记录',
    'Semantic Recall': '语义检索',
    'Semantic recall is not enabled for this agent. Enable it to search through conversation history.':
      '此智能体尚未启用语义检索。启用后可搜索对话历史。',
    'Learn about semantic recall': '了解语义检索',
    'Working Memory': '工作记忆',
    'Working memory is not enabled for this agent. Enable it to maintain context across conversations.':
      '此智能体尚未启用工作记忆。启用后可在不同对话之间保留上下文。',
    'Learn about working memory': '了解工作记忆',
  };

  const uiSelector = '*';
  const attributeSelector = '[placeholder], [aria-label], [title]';

  function translate(root: ParentNode) {
    for (const element of root.querySelectorAll<HTMLElement>(uiSelector)) {
      if (element.closest('script, style, pre, code, textarea, [contenteditable="true"]')) continue;
      for (const node of element.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        const original = node.textContent ?? '';
        const normalized = original.replace(/\s+/g, ' ').trim();
        if (translations[normalized]) node.textContent = original.replace(original.trim(), translations[normalized]);
      }
    }
    for (const element of root.querySelectorAll<HTMLElement>(attributeSelector)) {
      for (const name of ['placeholder', 'aria-label', 'title']) {
        const value = element.getAttribute(name);
        if (value && translations[value]) element.setAttribute(name, translations[value]);
      }
    }
    for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href^="/workflows"]')) {
      link.closest('li')?.setAttribute('hidden', '');
      link.setAttribute('hidden', '');
    }

    const links = document.querySelectorAll<HTMLAnchorElement>('a[data-model-admin-link]');
    const onSettings = location.pathname === '/settings' || location.pathname.startsWith('/settings/');
    links.forEach((link, index) => {
      if (!onSettings || index > 0) link.remove();
    });
    if (onSettings && links.length === 0) {
      const link = document.createElement('a');
      link.href = '/model-admin';
      link.setAttribute('data-model-admin-link', '');
      link.textContent = '公共模型管理';
      link.style.cssText = 'display:inline-block;margin:16px;text-decoration:underline;';
      (document.querySelector('main') ?? document.body).appendChild(link);
    }
  }

  document.documentElement.lang = 'zh-CN';
  document.title = '智能体平台';
  if (location.pathname.startsWith('/workflows')) history.replaceState(null, '', '/agents');
  let scheduled = false;
  const scheduleTranslate = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      translate(document);
    });
  };
  new MutationObserver(scheduleTranslate).observe(document.documentElement, {
    childList: true, subtree: true, characterData: true,
  });
  scheduleTranslate();
}

// esbuild's keepNames helper may be emitted into toString() output under tsx; shim it for the browser.
function studioSameOriginClient() {
  const deployedStudio = location.pathname === '/studio' || location.pathname.startsWith('/studio/');
  if (location.port !== '4111' && !deployedStudio) return;
  (window as Window & { MASTRA_AUTO_DETECT_URL?: string }).MASTRA_AUTO_DETECT_URL = 'true';
  if (deployedStudio) {
    const token = sessionStorage.getItem('nero-agent-session');
    if (!token) {
      location.replace('/agent/new?next=studio');
      return;
    }
    const url = new URL(location.href);
    url.searchParams.set('auth_header', `Bearer ${token}`);
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  try {
    const key = 'mastra-studio-config';
    const stored = localStorage.getItem(key);
    if (!stored) return;
    const config = JSON.parse(stored);
    if (!config || typeof config !== 'object' || config.baseUrl === location.origin) return;
    config.baseUrl = location.origin;
    localStorage.setItem(key, JSON.stringify(config));
  } catch { /* A missing or malformed saved config should not block Studio. */ }
}

const injection = `<script>window.__name=window.__name||function(t){return t};var __name=window.__name;(${studioSameOriginClient.toString()})();(${studioChineseClient.toString()})();</script>`;

export function localizeStudioHtml(html: string): string {
  return html.replace('</head>', `${injection}</head>`);
}

export const studioChineseMiddleware = {
  path: '*',
  handler: async (context: { req: { path: string }; res: Response }, next: () => Promise<void>) => {
    await next();
    if (context.req.path.startsWith('/api/') || context.req.path.startsWith('/assets/')) return;
    if (context.req.path === '/model-admin') return;
    if (!context.res.headers.get('content-type')?.includes('text/html')) return;
    const html = await context.res.text();
    context.res = new Response(localizeStudioHtml(html), {
      status: context.res.status,
      headers: context.res.headers,
    });
  },
};
