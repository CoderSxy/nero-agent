import { useState, type ReactNode } from 'react';
import type { GetAgentResponse, GetMemoryConfigResponse } from '@mastra/client-js';
import { Brain, ChevronRight, Cpu, FileText, Gauge, Sparkles, Workflow, Wrench } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { SkillActivationView } from './message-parts';

function display(value: unknown) {
  if (value == null || value === '') return '未提供';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object' && 'modelId' in value) return String(value.modelId);
  return JSON.stringify(value, null, 2);
}

export function ConfigPanel({ agent, memory, models, loading, error, availableCatalog, turnActivations = [] }: {
  agent: GetAgentResponse | null; memory?: GetMemoryConfigResponse | null; models?: { chatModel: string; memoryModel: string };
  loading: boolean; error: string | null;
  /** Names the user may invoke. Distinct from skills actually loaded this turn. */
  availableCatalog?: string[];
  turnActivations?: SkillActivationView[];
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({ overview: true, workspace: false, memory: true });
  const [promptView, setPromptView] = useState<'read' | 'source'>('read');
  const memoryConfig = memory?.config;
  const toggle = (key: string) => setOpen(value => ({ ...value, [key]: !value[key] }));
  const extra = agent as unknown as Record<string, unknown> | null;
  const tools = agent ? [...new Set([...names(agent.tools), ...(agent.workspaceTools ?? [])])] : [];
  const workflows = names(agent?.workflows);
  const processors = [...new Set([...names(extra?.inputProcessors), ...names(extra?.outputProcessors)])];
  const catalogNames = availableCatalog ?? names(agent?.skills);
  const scorers = names(extra?.scorers);
  return <aside className="config-panel" aria-label="智能体配置">
    <header className="config-header"><h2>配置</h2><span>只读</span></header>
    <div className="config-body">
      {loading && <p>加载配置中…</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {agent && <div className="config-sections">
        <ConfigGroup tone="tools" icon={<Wrench size={18} />} title="工具"
          summary={<span className="config-count">{tools.length}</span>}><Chips items={tools} /></ConfigGroup>
        <ConfigGroup tone="workflow" icon={<Workflow size={18} />} title="工作流"
          summary={!workflows.length ? '未配置' : workflows.length}>{workflows.length > 0 && <Chips items={workflows} />}</ConfigGroup>
        <ConfigGroup tone="processors" icon={<Cpu size={18} />} title="处理器"
          summary={!processors.length ? '未配置' : processors.length}>{processors.length > 0 && <Chips items={processors} />}</ConfigGroup>
        <ConfigGroup tone="skills" icon={<Sparkles size={18} />} title="技能"
          summary={!catalogNames.length ? '未配置' : catalogNames.length}>
          <div className="config-skill-split">
            <section aria-label="可用目录">
              <h4>可用目录</h4>
              <Chips items={catalogNames} />
            </section>
            <section aria-label="本轮加载">
              <h4>本轮加载</h4>
              {turnActivations.length === 0 ? <span className="config-none">本轮未加载</span> : <ul className="skill-execution-badges">
                {turnActivations.map(item => <li key={`${item.serverExecutionId}/${item.skillId}/${item.version ?? ''}/${item.status}`}
                  data-status={item.status}>
                  {item.status === 'failed' ? '加载失败' : '已加载'} {item.name}
                  {item.version != null ? ` v${item.version}` : ''}
                  {item.hashPrefix ? ` ${item.hashPrefix}` : ''}
                </li>)}
              </ul>}
            </section>
          </div>
        </ConfigGroup>
        <ConfigGroup tone="scorers" icon={<Gauge size={18} />} title="评分器"
          summary={!scorers.length ? '未配置' : scorers.length}>{scorers.length > 0 && <Chips items={scorers} />}</ConfigGroup>
        <ConfigGroup tone="memory" icon={<Brain size={18} />} title="记忆">
          {memoryConfig ? <>
            <dl className="config-details">
              <dt>状态</dt><dd><Status enabled /></dd>
              <dt>最近消息数</dt><dd><span className="config-chip">{typeof memoryConfig.lastMessages === 'number' ? memoryConfig.lastMessages : '未提供'}</span></dd>
              <dt>自动生成标题</dt><dd><Status enabled={Boolean('generateTitle' in memoryConfig && memoryConfig.generateTitle)} /></dd>
              {models?.memoryModel && <><dt>记忆模型</dt><dd>{models.memoryModel}</dd></>}
            </dl>
            <button type="button" className="config-detail-toggle" onClick={() => toggle('memory')}
              aria-label={`${open.memory ? '收起' : '展开'}记忆`} aria-expanded={Boolean(open.memory)}>
              观察记忆 <ChevronRight size={18} className={open.memory ? 'is-open' : ''} /></button>
            {open.memory && <dl className="config-details config-observation">
              <dt>状态</dt><dd><Status enabled={Boolean(memoryConfig.observationalMemory?.enabled)} /></dd>
              {memoryConfig.observationalMemory?.observationModel && <><dt>模型</dt><dd>{display(memoryConfig.observationalMemory.observationModel)}</dd></>}
            </dl>}
          </> : <p className="config-none">未配置</p>}
        </ConfigGroup>
        <ConfigGroup tone="prompt" icon={<FileText size={18} />} title="系统提示词"
          summary={<span className="config-tabs"><button type="button" aria-pressed={promptView === 'read'}
            onClick={() => setPromptView('read')}>阅读</button><button type="button" aria-pressed={promptView === 'source'}
              onClick={() => setPromptView('source')}>源码</button></span>}>
          {promptView === 'read' ? <div className="config-prompt config-prompt--read">
            <ReactMarkdown>{display(agent.instructions)}</ReactMarkdown></div> :
            <pre className="config-prompt">{display(agent.instructions)}</pre>}
        </ConfigGroup>
        <ConfigGroup tone="overview" icon={<FileText size={18} />} title="概览"
          summary={<button type="button" className="config-collapse" aria-label={`${open.overview ? '收起' : '展开'}概览`}
            onClick={() => toggle('overview')}>{open.overview ? '−' : '＋'}</button>}>
          {open.overview && <dl className="config-details"><dt>名称</dt><dd>{display(agent.name)}</dd>
            <dt>会话模型</dt><dd>{display(models?.chatModel || agent.modelId)}</dd>
            <dt>描述</dt><dd>{display(agent.description)}</dd></dl>}
        </ConfigGroup>
        <ConfigGroup tone="workspace" icon={<FileText size={18} />} title="工作区"
          summary={<button type="button" className="config-collapse" aria-label={`${open.workspace ? '收起' : '展开'}工作区`}
            onClick={() => toggle('workspace')}>{open.workspace ? '−' : '＋'}</button>}>
          {open.workspace && <div className="config-workspace">{agent.workspaceId ? <p>智能体配置：{agent.workspaceId}</p> : <p>未提供</p>}</div>}
        </ConfigGroup>
      </div>}
    </div>
  </aside>;
}

function names(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item :
    typeof item === 'object' && item !== null && 'name' in item ? String(item.name) :
      typeof item === 'object' && item !== null && 'id' in item ? String(item.id) : '').filter(Boolean);
  if (value && typeof value === 'object') return Object.keys(value);
  return [];
}

function ConfigGroup({ tone, icon, title, summary, children }: {
  tone: string; icon: ReactNode; title: string; summary?: ReactNode; children?: ReactNode;
}) {
  return <section className={`config-group config-group--${tone}`}>
    <div className="config-group-heading"><span className="config-group-icon" aria-hidden="true">{icon}</span>
      <h3>{title}</h3>{summary && <span className="config-group-summary">{summary}</span>}</div>
    {children}
  </section>;
}

function Chips({ items }: { items: string[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return <span className="config-none">None</span>;
  return <div className="config-chips">{(expanded ? items : items.slice(0, 10)).map(name =>
    <span className="config-chip" key={name}>{name}</span>)}
    {items.length > 10 && <button type="button" className="config-more"
      aria-label={expanded ? '收起额外项目' : `显示剩余 ${items.length - 10} 项`}
      onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : `+${items.length - 10}`}</button>}</div>;
}

function Status({ enabled }: { enabled: boolean }) {
  return <span className={`config-status ${enabled ? 'config-status--enabled' : ''}`}>
    <span aria-hidden="true">●</span> {enabled ? 'Enabled' : 'Disabled'}</span>;
}
