import { useState } from 'react';
import type { GetAgentResponse, GetMemoryConfigResponse } from '@mastra/client-js';
import { SectionCard } from '@mastra/playground-ui/components/SectionCard';

function display(value: unknown) {
  if (value == null || value === '') return '未提供';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object' && 'modelId' in value) return String(value.modelId);
  return JSON.stringify(value, null, 2);
}

export function ConfigPanel({ agent, memory, loading, error }: {
  agent: GetAgentResponse | null; memory?: GetMemoryConfigResponse | null; loading: boolean; error: string | null;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({ overview: true, tools: true });
  const memoryConfig = memory?.config;
  const section = (key: string, title: string, children: React.ReactNode) =>
    <SectionCard title={title} action={<button type="button" aria-label={`${open[key] ? '收起' : '展开'}${title}`}
      onClick={() => setOpen(value => ({ ...value, [key]: !value[key] }))}>{open[key] ? '−' : '＋'}</button>}>
      {open[key] && children}
    </SectionCard>;
  return <aside className="config-panel" aria-label="智能体配置">
    <h2>Config</h2><p className="muted">当前智能体配置 · 只读</p>
    {loading && <p>加载配置中…</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {agent && <div className="config-sections">
      {section('overview', '概览', <dl>
        <dt>名称</dt><dd>{display(agent.name)}</dd>
        <dt>模型</dt><dd>{display(import.meta.env.VITE_AGENT_MODEL || agent.modelId)}</dd>
        <dt>描述</dt><dd>{display(agent.description)}</dd>
      </dl>)}
      {section('tools', '工具', <div>{Object.keys(agent.tools ?? {}).length ? Object.keys(agent.tools).map(name =>
        <div className="config-item" key={name}>{name}</div>) : '未提供'}</div>)}
      {(agent.workspaceId || agent.workspaceTools?.length) && section('workspace', '工作区', <div>
        {agent.workspaceId && <p>{agent.workspaceId}</p>}
        {agent.workspaceTools?.map(name => <div className="config-item" key={name}>{name}</div>)}
      </div>)}
      {memoryConfig && section('memory', '记忆', <dl>
        <dt>上下文</dt><dd>{typeof memoryConfig.lastMessages === 'number' ? `最近 ${memoryConfig.lastMessages} 条消息` : '未提供'}</dd>
        <dt>标题</dt><dd>{'generateTitle' in memoryConfig && memoryConfig.generateTitle ? '自动生成' : '未启用'}</dd>
        <dt>观察记忆</dt><dd>{memoryConfig.observationalMemory?.enabled ? '已启用' : '未启用'}</dd>
      </dl>)}
      {agent.instructions && section('instructions', '指令', <pre>{display(agent.instructions)}</pre>)}
    </div>}
  </aside>;
}
