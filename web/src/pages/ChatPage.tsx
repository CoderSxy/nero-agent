import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChatView } from '../components/ChatView';
import { LeftPanel } from '../components/LeftPanel';
import { createMastraClient } from '../lib/mastra-client';
import { historyFromMessages } from '../lib/messages';
import {
  emptyTurn,
  markApproval,
  type AssistantTurn,
  type ToolCard,
} from '../lib/stream-reducer';
import { shouldApplyThreadUpdate, shouldSkipThreadLoad } from '../lib/thread-guards';
import { sortThreads, type ThreadSummary } from '../lib/thread-label';

type MastraClient = ReturnType<typeof createMastraClient>;
type HistoryItem = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  reasoning?: string;
  tools?: ToolCard[];
};

function appendTurn(base: AssistantTurn, addition: AssistantTurn): AssistantTurn {
  const tools = [...base.tools];
  addition.tools.forEach((tool) => {
    const index = tools.findIndex((item) => item.toolCallId === tool.toolCallId);
    if (index === -1) {
      tools.push(tool);
      return;
    }
    tools[index] = {
      ...tools[index],
      ...tool,
      approval: tool.approval === 'none' ? tools[index].approval : tool.approval,
    };
  });
  return {
    text: base.text + addition.text,
    reasoning: base.reasoning + addition.reasoning,
    tools,
    error: addition.error ?? base.error,
    runId: addition.runId ?? base.runId,
  };
}

export function ChatPage({ client }: { client?: MastraClient }) {
  const api = useMemo(() => client ?? createMastraClient(), [client]);
  const navigate = useNavigate();
  const { threadId } = useParams();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [userMessages, setUserMessages] = useState<Array<{ id: string; text: string }>>([]);
  const [assistant, setAssistant] = useState<AssistantTurn | null>(null);
  const [pending, setPending] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [listError, setListError] = useState<string>();
  const [banner, setBanner] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);
  const assistantRef = useRef<AssistantTurn | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const skipLoadThreadIdsRef = useRef(new Set<string>());
  const activeThreadRef = useRef<string | undefined>(threadId);
  const prevThreadIdRef = useRef<string | undefined>(undefined);
  const lastFailedTextRef = useRef<string | null>(null);

  function updateAssistant(turn: AssistantTurn | null) {
    assistantRef.current = turn;
    setAssistant(turn);
  }

  useEffect(() => {
    let active = true;
    setListError(undefined);
    api.listThreads().then((items) => {
      if (!active) return;
      setThreads(sortThreads(items));
      setBanner((current) => current === '无法连接助手，请确认 npm run dev 已启动' ? undefined : current);
    }).catch(() => {
      if (!active) return;
      setListError('会话列表暂不可用');
      setBanner('无法连接助手，请确认 npm run dev 已启动');
    });
    return () => {
      active = false;
    };
  }, [api, reloadKey]);

  useEffect(() => {
    const previousThreadId = prevThreadIdRef.current;
    prevThreadIdRef.current = threadId;
    activeThreadRef.current = threadId;

    if (previousThreadId !== undefined && previousThreadId !== threadId && controllerRef.current) {
      controllerRef.current.abort();
      controllerRef.current = null;
      setPending(false);
      void api.abortThread(previousThreadId).catch(() => {
        // The local stream is already stopped; keep the partial reply.
      });
    }
  }, [api, threadId]);

  useEffect(() => {
    if (!threadId) {
      setHistory([]);
      setUserMessages([]);
      updateAssistant(null);
      return;
    }
    if (shouldSkipThreadLoad(skipLoadThreadIdsRef.current, threadId)) {
      return;
    }
    let active = true;
    api.getThread(threadId).then(() => api.getMessages(threadId)).then((messages) => {
      if (!active) return;
      setHistory(historyFromMessages(messages));
      setUserMessages([]);
      updateAssistant(null);
    }).catch((error: unknown) => {
      if (!active) return;
      if (error instanceof Error && /\b404\b/.test(error.message)) {
        navigate('/chat/new', { replace: true });
        return;
      }
      setBanner('无法连接助手，请确认 npm run dev 已启动');
    });
    return () => {
      active = false;
    };
  }, [api, navigate, reloadKey, threadId]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  async function stream(thread: string, text: string) {
    const controller = new AbortController();
    controllerRef.current = controller;
    setPending(true);
    setBanner(undefined);
    lastFailedTextRef.current = text;
    const onTurn = (turn: AssistantTurn) => {
      if (!shouldApplyThreadUpdate(activeThreadRef.current, thread)) return;
      updateAssistant(turn);
    };
    try {
      await api.streamMessage(thread, text, onTurn, controller.signal);
      lastFailedTextRef.current = null;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setBanner('回复失败，可重新发送');
      }
    } finally {
      skipLoadThreadIdsRef.current.delete(thread);
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setPending(false);
      }
    }
  }

  function moveCurrentTurnToHistory(): HistoryItem[] {
    const next = [...history];
    userMessages.forEach((message) => next.push({ ...message, role: 'user' }));
    const current = assistantRef.current;
    if (current && (current.text || current.reasoning || current.tools.length)) {
      next.push({
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        text: current.text,
        reasoning: current.reasoning,
        tools: current.tools,
      });
    }
    setHistory(next);
    return next;
  }

  async function handleSend(text: string) {
    let targetId = threadId;
    if (!targetId) {
      try {
        const thread = await api.createThread(text);
        targetId = thread.id;
        skipLoadThreadIdsRef.current.add(thread.id);
        setThreads((items) => [thread, ...items.filter((item) => item.id !== thread.id)]);
        navigate(`/chat/${thread.id}`, { replace: true });
      } catch {
        lastFailedTextRef.current = text;
        setBanner('无法创建会话，请稍后重试');
        return;
      }
    }
    moveCurrentTurnToHistory();
    setUserMessages([{ id: `user-${Date.now()}`, text }]);
    updateAssistant(emptyTurn());
    await stream(targetId, text);
  }

  async function handleStop() {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setPending(false);
    if (threadId) {
      try {
        await api.abortThread(threadId);
      } catch {
        // The local stream is already stopped; keep the partial reply.
      }
    }
  }

  async function handleApproval(toolCallId: string, approval: 'approved' | 'declined') {
    const current = assistantRef.current;
    const thread = threadId;
    if (!current?.runId || !thread) return;
    const base = markApproval(current, toolCallId, approval);
    updateAssistant(base);
    const controller = new AbortController();
    controllerRef.current = controller;
    setPending(true);
    setBanner(undefined);
    try {
      const receive = (addition: AssistantTurn) => {
        if (!shouldApplyThreadUpdate(activeThreadRef.current, thread)) return;
        updateAssistant(appendTurn(base, addition));
      };
      if (approval === 'approved') {
        await api.approveTool(current.runId, toolCallId, receive, controller.signal);
      } else {
        await api.declineTool(current.runId, toolCallId, receive, controller.signal);
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setBanner('回复失败，可重新发送');
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setPending(false);
      }
    }
  }

  function handleRetry() {
    const text = lastFailedTextRef.current;
    if (text && threadId) {
      updateAssistant(emptyTurn());
      void stream(threadId, text);
      return;
    }
    if (text) {
      void handleSend(text);
      return;
    }
    setReloadKey((key) => key + 1);
  }

  return (
    <div className="chat-shell">
      <LeftPanel
        threads={threads}
        activeId={threadId}
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
        error={listError}
      />
      <ChatView
        mode={threadId ? 'thread' : 'new'}
        userMessages={userMessages}
        assistant={assistant}
        history={history}
        pending={pending}
        banner={banner}
        onSend={(text) => void handleSend(text)}
        onStop={() => void handleStop()}
        onApprove={(toolCallId) => void handleApproval(toolCallId, 'approved')}
        onDecline={(toolCallId) => void handleApproval(toolCallId, 'declined')}
        onRetry={handleRetry}
      />
    </div>
  );
}
