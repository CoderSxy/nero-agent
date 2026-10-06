import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { GetAgentResponse, GetMemoryConfigResponse } from '@mastra/client-js';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { AGENT_ID, client } from './client';
import { useThreadList } from './use-thread-list';
import { loadScopedThread, neighborAfterDeletion } from './thread-scope';
import { ThreadSidebar } from './ThreadSidebar';
import { AgentChat } from './AgentChat';
import { ConfigPanel } from './ConfigPanel';
import { RightPanelDock } from './RightPanelDock';
import { WorkspaceFileTree } from './WorkspaceFileTree';
import { WorkspaceFileOverlay } from './WorkspaceFileOverlay';
import { getSelectableModels, type ModelRef, type SafeModel } from './model-catalog-client';
import { getDefaultModels, readThreadModels, saveThreadModels, withThreadModels,
  type ModelSettings } from './model-settings';
import type { Theme } from './ModelSettingsMenu';
import type { CurrentUser } from '../App';
import type { PendingUserMessage } from './pending-user-message';

function initialTheme(): Theme {
  try { return localStorage.getItem('nero-agent-theme') === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }
}

function completeModels(models: Partial<ModelSettings>): ModelSettings | null {
  return models.chatModel && models.memoryModel
    ? { chatModel: models.chatModel, memoryModel: models.memoryModel } : null;
}

export function AgentPage({ user, onLogout }: { user: CurrentUser; onLogout: () => void }) {
  const { threadId: routeThreadId } = useParams();
  const threadId = routeThreadId === 'new' ? undefined : routeThreadId;
  const navigate = useNavigate();
  const list = useThreadList(user.id);
  const [messages, setMessages] = useState<MastraDBMessage[]>([]);
  const [pendingByThread, setPendingByThread] = useState<Record<string, PendingUserMessage[]>>({});
  const [filesRefreshVersion, setFilesRefreshVersion] = useState(0);
  const [fileRequest, setFileRequest] = useState<{ path: string; id: number } | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [agent, setAgent] = useState<GetAgentResponse | null>(null);
  const [memory, setMemory] = useState<GetMemoryConfigResponse | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [catalog, setCatalog] = useState<SafeModel[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [threadMetadata, setThreadMetadata] = useState<unknown>(null);
  const [draftModels, setDraftModels] = useState<Partial<ModelSettings>>({});
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const defaults = useMemo(() => catalog ? getDefaultModels(catalog) : null, [catalog]);
  const available = useMemo(() => new Set((catalog ?? []).map(model => model.ref)), [catalog]);
  const threadRead = useMemo(() => threadId && catalog ? readThreadModels(threadMetadata, catalog) : null,
    [threadId, threadMetadata, catalog]);
  const models: Partial<ModelSettings> = threadId
    ? threadRead ? (threadRead.invalid ? threadRead.settings : { ...defaults, ...threadRead.settings }) : {}
    : { ...defaults, ...Object.fromEntries(Object.entries(draftModels).filter(([, ref]) => available.has(ref))) };
  const selected = completeModels(models);
  const newThreadModels = selected ?? defaults;
  const canCreate = Boolean(catalog && defaults && newThreadModels);
  const sendBlockedReason = !catalog ? (catalogError ?? '模型列表加载中…')
    : selected ? null
      : threadRead?.invalid ? '该会话使用的模型已不可用，请重新选择模型'
        : !defaults ? '请先配置公共默认模型' : '请重新选择模型';
  const names = new Map((catalog ?? []).map(model => [model.ref, model.displayName]));
  const configModels = selected
    ? { chatModel: names.get(selected.chatModel) ?? selected.chatModel,
      memoryModel: names.get(selected.memoryModel) ?? selected.memoryModel } : undefined;
  const workspaceSource = agent?.workspaceId && agent.workspaceId !== 'user-workspace' ? 'agent' : 'personal';
  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light');
    try { localStorage.setItem('nero-agent-theme', theme); } catch { /* Storage may be disabled. */ }
  }, [theme]);
  useEffect(() => {
    let active = true;
    Promise.allSettled([client.getAgent(AGENT_ID).details(), client.getMemoryConfig({ agentId: AGENT_ID }),
      getSelectableModels()])
      .then(([agentResult, memoryResult, catalogResult]) => {
        if (!active) return;
        if (agentResult.status === 'fulfilled') setAgent(agentResult.value);
        else setConfigError('加载智能体配置失败');
        if (memoryResult.status === 'fulfilled') setMemory(memoryResult.value);
        if (catalogResult.status === 'fulfilled') setCatalog(catalogResult.value);
        else setCatalogError(catalogResult.reason instanceof Error ? catalogResult.reason.message : '加载模型列表失败');
        setConfigLoading(false);
      });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!threadId) { setMessages([]); setThreadMetadata(null); return; }
    let active = true;
    setLoadingThread(true); setMessages([]); setThreadMetadata(null);
    loadScopedThread(threadId, user.id).then(result => {
      if (active) { setMessages(result.messages as MastraDBMessage[]);
        setThreadMetadata(result.thread.metadata); setNotice(null); setLoadingThread(false); }
    }).catch(() => {
      if (active) { setMessages([]); setLoadingThread(false); setNotice('会话不存在或无权访问'); navigate('/agent/new', { replace: true }); }
    });
    return () => { active = false; };
  }, [threadId, navigate, user.id]);
  async function create() {
    if (!canCreate || !newThreadModels) { setNotice(catalog ? '请先配置公共默认模型' : '模型列表尚未加载，请稍后重试'); return; }
    try { const thread = await list.createThread(newThreadModels); setNotice(null); navigate(`/agent/${thread.id}`); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : '新建会话失败'); }
  }
  async function changeModels(next: ModelSettings) {
    if (!available.has(next.chatModel) || !available.has(next.memoryModel)) {
      setSettingsError('所选模型不在可用列表中，请重新选择'); return;
    }
    if (!threadId) { setDraftModels(next); setSettingsError(null); return; }
    const previous = threadMetadata;
    setThreadMetadata(withThreadModels(previous, next)); setSettingsSaving(true); setSettingsError(null);
    try { await saveThreadModels(client.getMemoryThread({ threadId, agentId: AGENT_ID }), next, user.id);
      await list.refresh(); }
    catch (cause) { setThreadMetadata(previous);
      setSettingsError(cause instanceof Error ? cause.message : '保存模型配置失败'); }
    finally { setSettingsSaving(false); }
  }
  function selectComposerModel(ref: ModelRef) {
    void changeModels({ chatModel: ref, memoryModel: ref });
  }
  async function deleteThread(id: string) {
    const nextId = neighborAfterDeletion(list.threads, id);
    await list.deleteThread(id);
    setPendingByThread(current => { const next = { ...current }; delete next[id]; return next; });
    setNotice(null);
    navigate(nextId ? `/agent/${nextId}` : '/agent/new', { replace: true });
  }
  return <main className="agent-layout">
    <ThreadSidebar threads={list.threads} currentId={threadId} loading={list.loading} error={list.error}
      onNew={() => void create()} onSelect={id => navigate(`/agent/${id}`)} onDelete={deleteThread}
      onRename={list.renameThread}
      theme={theme} onThemeChange={setTheme}
      canCreate={canCreate} user={user} onLogout={onLogout} />
    <section className="agent-center">
      {notice && <div role="alert" className="notice">{notice}</div>}
      {loadingThread ? <div className="empty-chat">加载会话中…</div> : threadId && !notice ?
        <AgentChat key={threadId} threadId={threadId} resourceId={user.id} initialMessages={messages} models={selected}
          catalog={catalog ?? []} modelRef={selected?.chatModel} onModelChange={selectComposerModel}
          modelDisabled={settingsSaving} modelError={settingsError}
          sendBlockedReason={sendBlockedReason} onMessageSent={message => {
            void list.confirmFirstMessageTitle(threadId, message.text).catch(() => void list.refresh());
            void list.refresh();
            setFilesRefreshVersion(value => value + 1);
          }}
          onFilesChanged={() => setFilesRefreshVersion(value => value + 1)}
          pendingUserMessages={pendingByThread[threadId] ?? []}
          onMessageSubmitted={message => {
            list.previewFirstMessageTitle(threadId, message.text);
            setPendingByThread(current => ({ ...current,
              [threadId]: [...(current[threadId] ?? []), message] }));
          }}
          onMessageFailed={message => {
            list.discardFirstMessageTitle(threadId, message.text);
            setPendingByThread(current => ({ ...current,
              [threadId]: (current[threadId] ?? []).filter(item => item.id !== message.id) }));
          }} /> :
        <div className="empty-chat"><h1>智能体</h1><p>开始一段新对话</p><button type="button"
          disabled={!canCreate} onClick={() => void create()}>新建会话</button></div>}
      {fileRequest && <WorkspaceFileOverlay request={fileRequest} source={workspaceSource}
        onClosed={() => setFileRequest(null)} onSaved={() => setFilesRefreshVersion(value => value + 1)} />}
    </section>
    <RightPanelDock config={<ConfigPanel agent={agent} memory={memory} loading={configLoading} error={configError}
      models={configModels} />}
      files={<WorkspaceFileTree source={workspaceSource}
        workspaceId={workspaceSource === 'agent' ? agent?.workspaceId : undefined}
        refreshVersion={filesRefreshVersion} onOpenFile={path => setFileRequest(current => ({ path, id: (current?.id ?? 0) + 1 }))} />} />
  </main>;
}
