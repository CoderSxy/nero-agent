import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import { ChatShell } from '@mastra/playground-ui/components/ChatShell';
import type { GetAgentResponse, GetMemoryConfigResponse } from '@mastra/client-js';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { AGENT_ID, client, getFinanceCapabilities } from './client';
import { loadScopedThread } from './thread-scope';
import { AgentChat } from './AgentChat';
import { AgentComposer } from './AgentComposer';
import { ConfigPanel } from './ConfigPanel';
import { RightPanelDock } from './RightPanelDock';
import { WorkspaceFileTree } from './WorkspaceFileTree';
import { WorkspaceFileOverlay } from './WorkspaceFileOverlay';
import { getSelectableModels, type ModelRef, type SafeModel } from './model-catalog-client';
import { getDefaultModels, readThreadModels, saveThreadModels, withThreadModels,
  type ModelSettings } from './model-settings';
import type { PendingUserMessage } from './pending-user-message';
import { readThreadFinanceCategory, saveThreadFinanceCategory, type FinanceCategory } from './finance-category';
import type { AgentShellContextValue } from './AgentShell';
import { scheduledRunOfThread } from './thread-source';
import { MobileInbox } from './mobile/MobileInbox';
import { useMobileLayout } from './mobile/useMobileLayout';
import { MobileComposerDock } from './mobile/MobileComposerDock';
import { listAvailableSkills } from './skills/skills-api';
import type { SkillActivationView } from './message-parts';
import type { WorkspaceArtifact, WorkspaceRevealRequest } from './turn-artifacts';
import type { WorkspaceSource } from './workspace-files';

function completeModels(models: Partial<ModelSettings>): ModelSettings | null {
  return models.chatModel && models.memoryModel
    ? { chatModel: models.chatModel, memoryModel: models.memoryModel } : null;
}

function ModelStatusNotice({ status, error, isAdmin, onRetry }: {
  status: 'loading' | 'error' | 'blocked' | 'ready';
  error: string | null;
  isAdmin: boolean;
  onRetry: () => void;
}) {
  if (status === 'ready') return null;
  const message = status === 'loading' ? '正在加载模型列表…'
    : status === 'error' ? '模型列表加载失败，暂时无法发送消息。'
      : isAdmin ? '还没有启用的公共默认模型。在 Studio 的模型目录中启用一个后即可开始。'
        : '管理员尚未配置公共默认模型，暂时无法开始会话。';
  return <div className={`model-status model-status--${status}`}
    role={status === 'error' ? 'alert' : 'status'} title={error ?? undefined}>
    <span className="model-status-dot" aria-hidden="true" />
    <span className="model-status-text">{message}</span>
    {status === 'error' && <button type="button" className="model-status-action" onClick={onRetry}>重试</button>}
  </div>;
}

export function AgentPage() {
  const { user, list, historySearch, setChatActions, threadSource, setThreadSource, visibleThreads } = useOutletContext<AgentShellContextValue>();
  const mobile = useMobileLayout();
  const { threadId: routeThreadId } = useParams();
  const threadId = routeThreadId === 'new' ? undefined : routeThreadId;
  const [searchParams] = useSearchParams();
  const targetMessageId = searchParams.get('targetMessageId') ?? undefined;
  const navigate = useNavigate();
  const [messages, setMessages] = useState<MastraDBMessage[]>([]);
  const [availableCatalog, setAvailableCatalog] = useState<string[] | undefined>(undefined);
  const [turnActivations, setTurnActivations] = useState<SkillActivationView[]>([]);
  const [landingDraft, setLandingDraft] = useState('');
  const [landingSkillIds, setLandingSkillIds] = useState<string[]>([]);
  const [pendingLandingAction, setPendingLandingAction] = useState(false);
  const [landingFocused, setLandingFocused] = useState(false);
  const [creatingThread, setCreatingThread] = useState(false);
  const [handoffThreadId, setHandoffThreadId] = useState<string | null>(null);
  const [handoffSendThreadId, setHandoffSendThreadId] = useState<string | null>(null);
  const pendingLandingFilesRef = useRef<{ files: File[]; kind: 'file' | 'image'; directory?: string }[]>([]);
  const pendingLandingPickerRef = useRef(false);
  const creatingThreadRef = useRef(false);
  const pendingFinanceCategoryRef = useRef<FinanceCategory | null>(null);
  const landingCreationStartedRef = useRef(false);
  const routeThreadIdRef = useRef(routeThreadId);
  routeThreadIdRef.current = routeThreadId;
  const [pendingByThread, setPendingByThread] = useState<Record<string, PendingUserMessage[]>>({});
  const [filesRefreshVersion, setFilesRefreshVersion] = useState(0);
  const [fileRequest, setFileRequest] = useState<{
    path: string;
    id: number;
    source: WorkspaceSource;
    threadId: string;
  } | null>(null);
  const [dockOpenRequest, setDockOpenRequest] = useState<{ id: number; panel: 'files' } | null>(null);
  const [revealRequest, setRevealRequest] = useState<WorkspaceRevealRequest | null>(null);
  const nextOpenId = useRef(0);

  const openWorkspaceArtifact = useCallback((file: WorkspaceArtifact) => {
    if (!threadId) return;
    nextOpenId.current += 1;
    const id = nextOpenId.current;
    const source: WorkspaceSource = file.source;
    setDockOpenRequest({ id, panel: 'files' });
    setRevealRequest({ id, path: file.path, source, threadId });
    setFileRequest({ id, path: file.path, source, threadId });
  }, [threadId]);
  const [attachRequest, setAttachRequest] = useState<{
    id: number; threadId: string; path: string; source: 'personal' | 'agent';
  } | null>(null);
  const nextAttachId = useRef(0);
  const [loadingThread, setLoadingThread] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [agent, setAgent] = useState<GetAgentResponse | null>(null);
  const [memory, setMemory] = useState<GetMemoryConfigResponse | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [catalog, setCatalog] = useState<SafeModel[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [threadMetadata, setThreadMetadata] = useState<unknown>(null);
  const [metadataThreadId, setMetadataThreadId] = useState<string | null>(null);
  const [financeEnabled, setFinanceEnabled] = useState(false);
  const [financeSaving, setFinanceSaving] = useState(false);
  const [financeError, setFinanceError] = useState<string | null>(null);
  const [draftModels, setDraftModels] = useState<Partial<ModelSettings>>({});
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [rightPreferredWidth, setRightPreferredWidth] = useState(320);
  const compactPanels = viewportWidth <= 1050;
  const rightMax = Math.max(280, Math.min(620, viewportWidth - (compactPanels ? 40 : 600)));
  const rightWidth = Math.min(rightPreferredWidth, rightMax);
  const defaults = useMemo(() => catalog ? getDefaultModels(catalog) : null, [catalog]);
  const available = useMemo(() => new Set((catalog ?? []).map(model => model.ref)), [catalog]);
  const threadRead = useMemo(() => threadId && catalog ? readThreadModels(threadMetadata, catalog) : null,
    [threadId, threadMetadata, catalog]);
  const financeCategory = threadId && metadataThreadId === threadId
    ? readThreadFinanceCategory(threadMetadata) : null;
  const scheduledRun = threadId && metadataThreadId === threadId
    ? scheduledRunOfThread(threadMetadata) : null;
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
  const modelStatus: 'loading' | 'error' | 'blocked' | 'ready' = catalogLoading ? 'loading'
    : catalogError ? 'error'
      : catalog && !defaults ? 'blocked' : 'ready';
  const isAdmin = user.roles.includes('admin');
  const modelStatusNotice = <ModelStatusNotice status={modelStatus} error={catalogError}
    isAdmin={isAdmin} onRetry={() => void loadCatalog()} />;
  const names = new Map((catalog ?? []).map(model => [model.ref, model.displayName]));
  const configModels = selected
    ? { chatModel: names.get(selected.chatModel) ?? selected.chatModel,
      memoryModel: names.get(selected.memoryModel) ?? selected.memoryModel } : undefined;
  const workspaceSource = agent?.workspaceId && agent.workspaceId !== 'user-workspace' ? 'agent' : 'personal';
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    const ids = new Set(list.threads.map((thread) => thread.id));
    setPendingByThread((current) => {
      const next = { ...current };
      let changed = false;
      for (const id of Object.keys(next)) {
        if (!ids.has(id)) { delete next[id]; changed = true; }
      }
      return changed ? next : current;
    });
  }, [list.threads]);
  const loadCatalog = useCallback(() => {
    setCatalogLoading(true);
    setCatalogError(null);
    return getSelectableModels()
      .then(items => setCatalog(items))
      .catch(cause => setCatalogError(cause instanceof Error ? cause.message : '加载模型列表失败'))
      .finally(() => setCatalogLoading(false));
  }, []);
  useEffect(() => {
    let active = true;
    Promise.allSettled([client.getAgent(AGENT_ID).details(), client.getMemoryConfig({ agentId: AGENT_ID })])
      .then(([agentResult, memoryResult]) => {
        if (!active) return;
        if (agentResult.status === 'fulfilled') setAgent(agentResult.value);
        else setConfigError('加载智能体配置失败');
        if (memoryResult.status === 'fulfilled') setMemory(memoryResult.value);
        setConfigLoading(false);
      });
    void loadCatalog();
    return () => { active = false; };
  }, [loadCatalog]);
  useEffect(() => {
    let active = true;
    void getFinanceCapabilities().then(result => { if (active) setFinanceEnabled(result.enabled); })
      .catch(() => { if (active) setFinanceEnabled(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!threadId) { setMessages([]); setThreadMetadata(null); setMetadataThreadId(null); return; }
    let active = true;
    setFinanceError(null);
    setLoadingThread(true); setMessages([]); setThreadMetadata(null);
    loadScopedThread(threadId, user.id).then(result => {
      if (active) { setMessages(result.messages as MastraDBMessage[]);
        setThreadMetadata(result.thread.metadata); setMetadataThreadId(threadId);
        setNotice(null); setLoadingThread(false); }
    }).catch(() => {
      if (active) { setMessages([]); setLoadingThread(false); setNotice('会话不存在或无权访问'); navigate('/agent/new', { replace: true }); }
    });
    return () => { active = false; };
  }, [threadId, navigate, user.id]);
  useEffect(() => { setFinanceSaving(false); setFinanceError(null); setTurnActivations([]); }, [threadId]);
  useEffect(() => {
    let cancelled = false;
    void listAvailableSkills({ page: 1, pageSize: 50 }).then(page => {
      if (!cancelled) setAvailableCatalog(page.items.filter(item => item.userInvocable !== false).map(item => item.name));
    }).catch(() => { if (!cancelled) setAvailableCatalog([]); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (threadId) { setLandingFocused(false); return; }
    landingCreationStartedRef.current = false;
    setLandingFocused(false);
    setLandingDraft('');
    setLandingSkillIds([]);
    setPendingLandingAction(false);
    setHandoffThreadId(null);
    setHandoffSendThreadId(null);
    pendingLandingFilesRef.current = [];
    pendingLandingPickerRef.current = false;
  }, [threadId]);
  useEffect(() => {
    if (handoffThreadId && threadId && threadId !== handoffThreadId) setHandoffThreadId(null);
  }, [handoffThreadId, threadId]);
  useEffect(() => {
    setAttachRequest(current => current?.threadId === threadId ? current : null);
    setFileRequest(current => current?.threadId === threadId ? current : null);
    setRevealRequest(current => current?.threadId === threadId ? current : null);
    if (!threadId) {
      setDockOpenRequest(null);
    }
  }, [threadId]);
  useEffect(() => {
    if (!threadId && landingFocused && canCreate && !landingCreationStartedRef.current) {
      void create(true);
    }
  }, [threadId, landingFocused, canCreate]);
  useEffect(() => {
    if (!threadId && pendingLandingAction && canCreate && !creatingThreadRef.current) void create(true);
  }, [threadId, pendingLandingAction, canCreate]);
  async function create(fromLanding = false, sendAfterCreate = false) {
    if (creatingThreadRef.current || (fromLanding && landingCreationStartedRef.current)) return;
    if (!canCreate || !newThreadModels) { setNotice(catalog ? '请先配置公共默认模型' : '模型列表尚未加载，请稍后重试'); return; }
    creatingThreadRef.current = true;
    if (fromLanding) landingCreationStartedRef.current = true;
    setCreatingThread(true);
    try {
      const thread = await list.createThread(newThreadModels);
      if (fromLanding && routeThreadIdRef.current !== 'new') return;
      if (pendingFinanceCategoryRef.current) {
        const category = pendingFinanceCategoryRef.current;
        await saveThreadFinanceCategory(thread.id, client.getMemoryThread({ threadId: thread.id, agentId: AGENT_ID }),
          category, user.id);
        pendingFinanceCategoryRef.current = null;
        setFinanceSaving(false);
      }
      setHandoffThreadId(fromLanding ? thread.id : null);
      setHandoffSendThreadId(sendAfterCreate ? thread.id : null);
      setNotice(null);
      navigate(`/agent/${thread.id}`);
    } catch (cause) {
      if (fromLanding) landingCreationStartedRef.current = false;
      pendingFinanceCategoryRef.current = null;
      setFinanceSaving(false);
      setNotice(cause instanceof Error ? cause.message : '新建会话失败');
    } finally {
      creatingThreadRef.current = false;
      setCreatingThread(false);
    }
  }
  async function changeFinanceCategory(next: FinanceCategory | null) {
    if (!threadId) {
      if (!next) return;
      if (!canCreate) { setFinanceError('模型列表尚未加载，请稍后重试'); return; }
      pendingFinanceCategoryRef.current = next;
      setFinanceSaving(true); setFinanceError(null);
      if (!creatingThreadRef.current) await create(true);
      return;
    }
    const currentThreadId = threadId;
    setFinanceSaving(true); setFinanceError(null);
    try {
      const metadata = await saveThreadFinanceCategory(currentThreadId,
        client.getMemoryThread({ threadId: currentThreadId, agentId: AGENT_ID }), next, user.id);
      if (routeThreadIdRef.current === currentThreadId) setThreadMetadata(metadata);
      await list.refresh();
    } catch (cause) {
      if (routeThreadIdRef.current === currentThreadId)
        setFinanceError(cause instanceof Error ? cause.message : '保存财经分类失败');
    } finally {
      if (routeThreadIdRef.current === currentThreadId) setFinanceSaving(false);
    }
  }
  async function changeModels(next: ModelSettings) {
    if (!available.has(next.chatModel) || !available.has(next.memoryModel)) {
      setSettingsError('所选模型不在可用列表中，请重新选择'); return;
    }
    if (!threadId) { setDraftModels(next); setSettingsError(null); return; }
    const previous = threadMetadata;
    setThreadMetadata(withThreadModels(previous, next)); setSettingsSaving(true); setSettingsError(null);
    try { await saveThreadModels(client.getMemoryThread({ threadId, agentId: AGENT_ID }), next, user.id, threadId);
      await list.refresh(); }
    catch (cause) { try {
      const latest = await client.getMemoryThread({ threadId, agentId: AGENT_ID }).get();
      if (routeThreadIdRef.current === threadId) setThreadMetadata(latest.metadata);
    } catch { if (routeThreadIdRef.current === threadId) setThreadMetadata(previous); }
      setSettingsError(cause instanceof Error ? cause.message : '保存模型配置失败'); }
    finally { setSettingsSaving(false); }
  }
  function selectComposerModel(ref: ModelRef) {
    void changeModels({ chatModel: ref, memoryModel: ref });
  }
  useEffect(() => {
    setChatActions({ onNew: () => void create(!threadId), canCreate });
  }, [canCreate, threadId, setChatActions]);
  const landingComposer = <AgentComposer draft={landingDraft} onDraftChange={setLandingDraft}
    selectedSkillIds={landingSkillIds} onSelectedSkillIdsChange={setLandingSkillIds} skillScopeKey={`landing:${user.id}`}
    financeCategory={null} financeEnabled={financeEnabled} financeSaving={financeSaving}
    onFinanceCategoryChange={value => void changeFinanceCategory(value)}
    onInputFocus={mobile ? undefined : () => { setLandingFocused(true); if (canCreate) void create(true); }}
    isRunning={false} sendDisabled={!canCreate || creatingThread} attachmentsDisabled={!mobile} mobileInline={mobile}
    onSend={() => void create(true, mobile)} onStop={() => undefined}
    onUploadFiles={(files, kind, directory) => {
      pendingLandingFilesRef.current.push({ files, kind, directory });
      setPendingLandingAction(true);
    }}
    onChooseWorkspaceFiles={() => {
      pendingLandingPickerRef.current = true;
      setPendingLandingAction(true);
    }}
    catalog={catalog ?? []} modelRef={selected?.chatModel} onModelChange={selectComposerModel}
    modelDisabled={creatingThread} />;
  return <>
    <section className="agent-center">
      {notice && <div role="alert" className="notice">{notice}</div>}
      {financeError && <div role="alert" className="notice">{financeError}</div>}
      {mobile && !threadId ? <MobileInbox threads={visibleThreads} source={threadSource}
        onSourceChange={setThreadSource} onNavigate={path => navigate(path)}
        onOpenThread={id => navigate(`/agent/${encodeURIComponent(id)}`)}
        loading={list.loading} error={list.error} modelCount={catalog?.length}
        composer={<MobileComposerDock>{modelStatusNotice}{landingComposer}</MobileComposerDock>} /> : loadingThread ? <div className="empty-chat">加载会话中…</div> : threadId && !notice ?
        <AgentChat key={threadId} title={list.threads.find(thread => thread.id === threadId)?.title || '未命名会话'}
          onOpenArtifact={openWorkspaceArtifact}
          threadId={threadId} resourceId={user.id} initialMessages={messages} models={selected}
          scheduledRun={scheduledRun}
          initialDraft={handoffThreadId === threadId ? landingDraft : ''}
          initialSelectedSkillIds={handoffThreadId === threadId ? landingSkillIds : []}
          focusComposer={handoffThreadId === threadId}
          sendOnMount={handoffSendThreadId === threadId}
          initialFiles={handoffThreadId === threadId ? pendingLandingFilesRef.current : []}
          openPickerOnMount={handoffThreadId === threadId && pendingLandingPickerRef.current}
          catalog={catalog ?? []} modelRef={selected?.chatModel} onModelChange={selectComposerModel}
          modelDisabled={settingsSaving} modelError={settingsError}
          financeCategory={financeCategory} financeEnabled={financeEnabled} financeSaving={financeSaving}
          onFinanceCategoryChange={value => void changeFinanceCategory(value)}
          sendBlockedReason={sendBlockedReason} onMessageSent={message => {
            void historySearch.invalidateThread(threadId);
            void list.confirmFirstMessageTitle(threadId, message.text).catch(() => void list.refresh());
            void list.refresh();
            setFilesRefreshVersion(value => value + 1);
          }}
          onResponseSettled={() => {
            void historySearch.invalidateThread(threadId);
            void list.refresh();
          }}
          onFilesChanged={() => setFilesRefreshVersion(value => value + 1)}
          attachmentRefreshVersion={filesRefreshVersion}
          pendingUserMessages={pendingByThread[threadId] ?? []}
          attachRequest={attachRequest?.threadId === threadId ? attachRequest : null}
          onMessageSubmitted={message => {
            list.previewFirstMessageTitle(threadId, message.text);
            setPendingByThread(current => ({ ...current,
              [threadId]: [...(current[threadId] ?? []), message] }));
          }}
          onMessageFailed={message => {
            list.discardFirstMessageTitle(threadId, message.text);
            setPendingByThread(current => ({ ...current,
              [threadId]: (current[threadId] ?? []).filter(item => item.id !== message.id) }));
          }}
          targetMessageId={targetMessageId} onTurnActivations={setTurnActivations} /> :
        <ChatShell className="chat-shell chat-shell--empty">
          <ChatShell.Stage><ChatShell.Viewport><ChatShell.Content><ChatShell.Column />
          </ChatShell.Content></ChatShell.Viewport></ChatShell.Stage>
          <ChatShell.Dock><ChatShell.Column>
            <div className="chat-welcome"><h1>有什么可以帮你？</h1></div>
            {modelStatusNotice}
            {landingComposer}
          </ChatShell.Column></ChatShell.Dock>
        </ChatShell>}
      {fileRequest && fileRequest.threadId === (threadId ?? '') && (
        <WorkspaceFileOverlay
          request={fileRequest}
          source={fileRequest.source}
          onClosed={() => setFileRequest(null)}
          onSaved={() => setFilesRefreshVersion(value => value + 1)}
        />
      )}
    </section>
    {!mobile && (() => {
      const filesSource = revealRequest?.source ?? workspaceSource;
      return <RightPanelDock width={rightWidth} maxWidth={rightMax} onResize={setRightPreferredWidth}
        openRequest={dockOpenRequest ?? undefined}
        config={<ConfigPanel agent={agent} memory={memory} loading={configLoading} error={configError}
        models={configModels} availableCatalog={availableCatalog} turnActivations={turnActivations} />}
        files={<WorkspaceFileTree source={filesSource}
          workspaceId={filesSource === 'agent' ? agent?.workspaceId : undefined}
          refreshVersion={filesRefreshVersion}
          revealRequest={revealRequest && revealRequest.threadId === threadId ? revealRequest : undefined}
          onOpenFile={path => {
            if (!threadId) return;
            nextOpenId.current += 1;
            setFileRequest({
              path,
              id: nextOpenId.current,
              source: filesSource,
              threadId,
            });
          }}
          onAttachFile={threadId ? (path, source) => {
            nextAttachId.current += 1;
            setAttachRequest({ id: nextAttachId.current, threadId, path, source });
          } : undefined}
          onFilesChanged={() => setFilesRefreshVersion(value => value + 1)} />} />;
    })()}
  </>;
}
