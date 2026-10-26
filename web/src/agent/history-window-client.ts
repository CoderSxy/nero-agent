import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { apiFetch } from './client';
import type { HistoryTurn, HistoryWindow } from './history-window-types';

export class HistoryWindowError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  throw new HistoryWindowError(502, '历史消息时间格式无效');
}

function normalizeMessage(raw: unknown): MastraDBMessage {
  if (!raw || typeof raw !== 'object') throw new HistoryWindowError(502, '历史消息格式无效');
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id) throw new HistoryWindowError(502, '历史消息缺少 id');
  if (typeof row.role !== 'string' || !row.role) throw new HistoryWindowError(502, '历史消息缺少 role');
  return {
    ...(row as object),
    id: row.id,
    role: row.role as MastraDBMessage['role'],
    createdAt: asDate(row.createdAt),
    content: row.content as MastraDBMessage['content'],
  } as MastraDBMessage;
}

function normalizeTurn(raw: unknown): HistoryTurn {
  if (!raw || typeof raw !== 'object') throw new HistoryWindowError(502, '历史轮次格式无效');
  const turn = raw as Record<string, unknown>;
  if (typeof turn.turnId !== 'string' || !Array.isArray(turn.messageIds)) {
    throw new HistoryWindowError(502, '历史轮次格式无效');
  }
  return {
    turnId: turn.turnId,
    originMessageId: typeof turn.originMessageId === 'string' ? turn.originMessageId : null,
    provisional: Boolean(turn.provisional),
    ...(Array.isArray(turn.replacesTurnIds)
      ? { replacesTurnIds: turn.replacesTurnIds.filter((id): id is string => typeof id === 'string') }
      : {}),
    messageIds: turn.messageIds.filter((id): id is string => typeof id === 'string'),
    partialBefore: Boolean(turn.partialBefore),
    partialAfter: Boolean(turn.partialAfter),
    ...(turn.turnContext && typeof turn.turnContext === 'object'
      ? {
          turnContext: {
            messageId: String((turn.turnContext as { messageId?: unknown }).messageId ?? ''),
            preview: String((turn.turnContext as { preview?: unknown }).preview ?? ''),
          },
        }
      : {}),
  };
}

export function normalizeHistoryWindow(raw: unknown): HistoryWindow {
  if (!raw || typeof raw !== 'object') throw new HistoryWindowError(502, '历史窗口响应无效');
  const body = raw as Record<string, unknown>;
  if (body.version !== 1) throw new HistoryWindowError(502, '不支持的历史窗口版本');
  if (!body.thread || typeof body.thread !== 'object') throw new HistoryWindowError(502, '历史窗口缺少 thread');
  if (!Array.isArray(body.messages)) throw new HistoryWindowError(502, '历史窗口 messages 无效');
  if (!Array.isArray(body.turns)) throw new HistoryWindowError(502, '历史窗口 turns 无效');
  const thread = body.thread as Record<string, unknown>;
  if (typeof thread.id !== 'string' || typeof thread.resourceId !== 'string') {
    throw new HistoryWindowError(502, '历史窗口 thread 无效');
  }
  return {
    version: 1,
    thread: {
      id: thread.id,
      resourceId: thread.resourceId,
      metadata: thread.metadata,
      updatedAt: typeof thread.updatedAt === 'string' ? thread.updatedAt : String(thread.updatedAt ?? ''),
    },
    messages: body.messages.map(normalizeMessage),
    turns: body.turns.map(normalizeTurn),
    previousCursor: typeof body.previousCursor === 'string' ? body.previousCursor : null,
    nextCursor: typeof body.nextCursor === 'string' ? body.nextCursor : null,
    snapshotUpper: typeof body.snapshotUpper === 'string' ? body.snapshotUpper : null,
    oversizedMessage: Boolean(body.oversizedMessage),
  };
}

export async function fetchHistoryWindow(
  threadId: string,
  options: { before?: string; after?: string; around?: string; signal?: AbortSignal } = {},
): Promise<HistoryWindow> {
  const params = new URLSearchParams();
  if (options.before) params.set('before', options.before);
  if (options.after) params.set('after', options.after);
  if (options.around) params.set('around', options.around);
  const query = params.toString();
  const path = `/agent-history/threads/${encodeURIComponent(threadId)}/window${query ? `?${query}` : ''}`;
  const response = await apiFetch(path, { signal: options.signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    const message =
      typeof payload.error === 'string' && payload.error
        ? payload.error
        : response.status === 403
          ? '无权访问该会话'
          : response.status === 404
            ? '会话或消息不存在'
            : '加载历史失败';
    throw new HistoryWindowError(response.status, message);
  }
  const raw = await response.json().catch(() => null);
  return normalizeHistoryWindow(raw);
}
