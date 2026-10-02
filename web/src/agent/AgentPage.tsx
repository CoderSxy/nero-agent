import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { GetAgentResponse, GetMemoryConfigResponse } from '@mastra/client-js';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { AGENT_ID, client } from './client';
import { useThreadList } from './use-thread-list';
import { loadScopedThread } from './thread-scope';
import { ThreadSidebar } from './ThreadSidebar';
import { AgentChat } from './AgentChat';
import { ConfigPanel } from './ConfigPanel';
import { getDefaultModels, readThreadModels, saveThreadModels, type ModelProvider,
  type ModelSettings } from './model-settings';
import type { Theme } from './ModelSettingsMenu';
import type { CurrentUser } from '../App';

function initialTheme(): Theme {
  try { return localStorage.getItem('nero-agent-theme') === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }
}

function configuredMemoryModel(memory: GetMemoryConfigResponse | null): string | undefined {
  const config = memory?.config?.observationalMemory;
  if (!config || typeof config !== 'object') return undefined;
  if ('observationModel' in config && typeof config.observationModel === 'string') return config.observationModel;
  if ('model' in config && typeof config.model === 'string') return config.model;
  return undefined;
}

export function AgentPage({ user, onLogout }: { user: CurrentUser; onLogout: () => void }) {
  const { threadId } = useParams();
  const navigate = useNavigate();
  const list = useThreadList(user.id);
  const [messages, setMessages] = useState<MastraDBMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [agent, setAgent] = useState<GetAgentResponse | null>(null);
  const [memory, setMemory] = useState<GetMemoryConfigResponse | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [threadModels, setThreadModels] = useState<Partial<ModelSettings>>({});
  const [draftModels, setDraftModels] = useState<Partial<ModelSettings>>({});
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const defaults = getDefaultModels(import.meta.env.VITE_AGENT_MODEL || agent?.modelId || '',
    configuredMemoryModel(memory), providers);
  const models = { ...defaults, ...(threadId ? threadModels : draftModels) };
  const canCreate = !configLoading && Boolean(models.chatModel && models.memoryModel);
  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light');
    try { localStorage.setItem('nero-agent-theme', theme); } catch { /* Storage may be disabled. */ }
  }, [theme]);
  useEffect(() => {
    let active = true;
    Promise.allSettled([client.getAgent(AGENT_ID).details(), client.getMemoryConfig({ agentId: AGENT_ID }),
      client.listAgentsModelProviders()])
      .then(([agentResult, memoryResult, providerResult]) => {
        if (!active) return;
        if (agentResult.status === 'fulfilled') setAgent(agentResult.value);
        else setConfigError('加载智能体配置失败');
        if (memoryResult.status === 'fulfilled') setMemory(memoryResult.value);
        if (providerResult.status === 'fulfilled') setProviders(providerResult.value.providers);
        setConfigLoading(false);
      });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!threadId) { setMessages([]); setThreadModels({}); return; }
    let active = true;
    setLoadingThread(true); setMessages([]); setThreadModels({});
    loadScopedThread(threadId, user.id).then(result => {
      if (active) { setMessages(result.messages as MastraDBMessage[]);
        setThreadModels(readThreadModels(result.thread.metadata)); setNotice(null); setLoadingThread(false); }
    }).catch(() => {
      if (active) { setMessages([]); setLoadingThread(false); setNotice('会话不存在或无权访问'); navigate('/agent/new', { replace: true }); }
    });
    return () => { active = false; };
  }, [threadId, navigate, user.id]);
  async function create() {
    if (!canCreate) { setNotice('模型配置尚未加载，请稍后重试'); return; }
    try { const thread = await list.createThread(models); setNotice(null); navigate(`/agent/${thread.id}`); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : '新建会话失败'); }
  }
  async function changeModels(next: ModelSettings) {
    if (!threadId) { setDraftModels(next); setSettingsError(null); return; }
    const previous = threadModels;
    setThreadModels(next); setSettingsSaving(true); setSettingsError(null);
    try { await saveThreadModels(client.getMemoryThread({ threadId, agentId: AGENT_ID }), next);
      await list.refresh(); }
    catch (cause) { setThreadModels(previous);
      setSettingsError(cause instanceof Error ? cause.message : '保存模型配置失败'); }
    finally { setSettingsSaving(false); }
  }
  return <main className="agent-layout">
    <ThreadSidebar threads={list.threads} currentId={threadId} loading={list.loading} error={list.error}
      onNew={() => void create()} onSelect={id => navigate(`/agent/${id}`)}
      models={models} providers={providers} theme={theme} onModelsChange={next => void changeModels(next)}
      onThemeChange={setTheme} settingsError={settingsError} settingsSaving={settingsSaving}
      canCreate={canCreate} user={user} onLogout={onLogout} />
    <section className="agent-center">
      {notice && <div role="alert" className="notice">{notice}</div>}
      {loadingThread ? <div className="empty-chat">加载会话中…</div> : threadId && !notice ?
        <AgentChat key={threadId} threadId={threadId} resourceId={user.id} initialMessages={messages} models={models}
          onMessageSent={() => void list.refresh()} /> :
        <div className="empty-chat"><h1>智能体</h1><p>开始一段新对话</p><button type="button"
          disabled={!canCreate} onClick={() => void create()}>新建会话</button></div>}
    </section>
    <ConfigPanel agent={agent} memory={memory} loading={configLoading} error={configError} models={models} />
  </main>;
}
