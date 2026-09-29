import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { GetAgentResponse, GetMemoryConfigResponse } from '@mastra/client-js';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { AGENT_ID, client } from './client';
import { useThreadList } from './use-thread-list';
import { loadScopedThread, RESOURCE_ID } from './thread-scope';
import { ThreadSidebar } from './ThreadSidebar';
import { AgentChat } from './AgentChat';
import { ConfigPanel } from './ConfigPanel';

export function AgentPage() {
  const { threadId } = useParams();
  const navigate = useNavigate();
  const list = useThreadList();
  const [messages, setMessages] = useState<MastraDBMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [agent, setAgent] = useState<GetAgentResponse | null>(null);
  const [memory, setMemory] = useState<GetMemoryConfigResponse | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
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
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!threadId) { setMessages([]); return; }
    let active = true;
    setLoadingThread(true); setMessages([]);
    loadScopedThread(threadId).then(result => {
      if (active) { setMessages(result.messages as MastraDBMessage[]); setNotice(null); setLoadingThread(false); }
    }).catch(() => {
      if (active) { setMessages([]); setLoadingThread(false); setNotice('会话不存在或无权访问'); navigate('/agent/new', { replace: true }); }
    });
    return () => { active = false; };
  }, [threadId, navigate]);
  async function create() {
    try { const thread = await list.createThread(); setNotice(null); navigate(`/agent/${thread.id}`); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : '新建会话失败'); }
  }
  return <main className="agent-layout">
    <ThreadSidebar threads={list.threads} currentId={threadId} loading={list.loading} error={list.error}
      onNew={() => void create()} onSelect={id => navigate(`/agent/${id}`)} />
    <section className="agent-center">
      {notice && <div role="alert" className="notice">{notice}</div>}
      {loadingThread ? <div className="empty-chat">加载会话中…</div> : threadId && !notice ?
        <AgentChat key={threadId} threadId={threadId} resourceId={RESOURCE_ID} initialMessages={messages}
          onMessageSent={() => void list.refresh()} /> :
        <div className="empty-chat"><h1>智能体</h1><p>开始一段新对话</p><button type="button" onClick={() => void create()}>新建会话</button></div>}
    </section>
    <ConfigPanel agent={agent} memory={memory} loading={configLoading} error={configError} />
  </main>;
}
