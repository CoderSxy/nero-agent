import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import {
  emptyHistoryState,
  type HistoryState,
  type HistoryTurn,
  type HistoryWindow,
} from './history-window-types';

function messageTime(message: MastraDBMessage): number {
  return new Date(message.createdAt).getTime();
}

function compareMessages(a: MastraDBMessage, b: MastraDBMessage): number {
  const time = messageTime(a) - messageTime(b);
  if (time !== 0) return time;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function mergeMessagesById(
  current: readonly MastraDBMessage[],
  incoming: readonly MastraDBMessage[],
): MastraDBMessage[] {
  const map = new Map<string, MastraDBMessage>();
  for (const message of current) map.set(message.id, message);
  for (const message of incoming) map.set(message.id, message);
  return [...map.values()].sort(compareMessages);
}

function applyTurnAliases(turns: HistoryTurn[], aliases: Record<string, string>): HistoryTurn[] {
  return turns.map((turn) => {
    const mapped = aliases[turn.turnId] ?? turn.turnId;
    return mapped === turn.turnId ? turn : { ...turn, turnId: mapped };
  });
}

function collectAliases(turns: readonly HistoryTurn[], previous: Record<string, string>): Record<string, string> {
  const aliases = { ...previous };
  for (const turn of turns) {
    if (!turn.replacesTurnIds?.length) continue;
    for (const oldId of turn.replacesTurnIds) aliases[oldId] = turn.turnId;
  }
  return aliases;
}

function mergeTurnLists(
  current: readonly HistoryTurn[],
  incoming: readonly HistoryTurn[],
  aliases: Record<string, string>,
): HistoryTurn[] {
  const byId = new Map<string, HistoryTurn>();
  for (const turn of applyTurnAliases(current as HistoryTurn[], aliases)) {
    byId.set(turn.turnId, turn);
  }
  for (const turn of applyTurnAliases(incoming as HistoryTurn[], aliases)) {
    const existing = byId.get(turn.turnId);
    if (!existing) {
      byId.set(turn.turnId, turn);
      continue;
    }
    const messageIds = [...new Set([...existing.messageIds, ...turn.messageIds])];
    byId.set(turn.turnId, {
      ...existing,
      ...turn,
      messageIds,
      provisional: turn.provisional && existing.provisional,
      originMessageId: turn.originMessageId ?? existing.originMessageId,
      partialBefore: existing.partialBefore && turn.partialBefore,
      partialAfter: existing.partialAfter && turn.partialAfter,
      replacesTurnIds: [...new Set([...(existing.replacesTurnIds ?? []), ...(turn.replacesTurnIds ?? [])])],
    });
  }
  const order = mergeMessagesById(
    current.flatMap((turn) => turn.messageIds.map((id) => ({ id, createdAt: new Date(0), role: 'user', content: { format: 2, parts: [] } }) as MastraDBMessage)),
    [],
  );
  void order;
  // Order turns by first known message id appearance in merged message order — caller reorders via messages.
  return [...byId.values()];
}

function reorderTurns(turns: HistoryTurn[], messages: MastraDBMessage[]): HistoryTurn[] {
  const index = new Map(messages.map((message, i) => [message.id, i]));
  return [...turns].sort((a, b) => {
    const ai = Math.min(...a.messageIds.map((id) => index.get(id) ?? Number.MAX_SAFE_INTEGER));
    const bi = Math.min(...b.messageIds.map((id) => index.get(id) ?? Number.MAX_SAFE_INTEGER));
    return ai - bi;
  });
}

function canJoinWindows(current: HistoryState, incoming: HistoryWindow, mode: 'prepend' | 'append'): boolean {
  if (!current.messages.length) return true;
  const overlap = incoming.messages.some((message) => current.messages.some((row) => row.id === message.id));
  if (overlap) return true;
  if (current.snapshotUpper && incoming.snapshotUpper && current.snapshotUpper !== incoming.snapshotUpper) {
    return false;
  }
  if (mode === 'prepend') {
    return Boolean(incoming.nextCursor && current.previousCursor);
  }
  return Boolean(incoming.previousCursor && current.nextCursor);
}

export function mergeHistoryWindow(
  current: HistoryState,
  incoming: HistoryWindow,
  mode: 'replace' | 'prepend' | 'append' | 'tail',
): HistoryState {
  if (mode === 'replace') {
    const aliases = collectAliases(incoming.turns, {});
    return {
      thread: incoming.thread,
      messages: [...incoming.messages].sort(compareMessages),
      turns: reorderTurns(incoming.turns, incoming.messages),
      previousCursor: incoming.previousCursor,
      nextCursor: incoming.nextCursor,
      snapshotUpper: incoming.snapshotUpper,
      mode: current.mode === 'around' && incoming.nextCursor ? 'around' : current.mode,
      gap: false,
      scrollAnchor: current.scrollAnchor,
      oversizedMessage: incoming.oversizedMessage,
      turnAliases: aliases,
    };
  }

  if (mode === 'tail') {
    // Live/tail merge updates messages only; pagination upper stays fixed.
    const messages = mergeMessagesById(current.messages, incoming.messages);
    const aliases = collectAliases(incoming.turns, current.turnAliases);
    const turns = reorderTurns(mergeTurnLists(current.turns, incoming.turns, aliases), messages);
    return {
      ...current,
      messages,
      turns,
      turnAliases: aliases,
      oversizedMessage: current.oversizedMessage || incoming.oversizedMessage,
    };
  }

  if ((mode === 'prepend' || mode === 'append') && current.mode === 'around' && incoming.snapshotUpper !== current.snapshotUpper) {
    // Do not stitch around and latest across a hole without an explicit join.
    if (!canJoinWindows(current, incoming, mode)) {
      return {
        ...current,
        gap: true,
      };
    }
  }

  if (mode === 'prepend' || mode === 'append') {
    const overlap = incoming.messages.some((message) => current.messages.some((row) => row.id === message.id));
    if (current.gap) {
      // Refuse to silently bridge a documented gap.
      if (!overlap) return { ...current, gap: true };
    } else if (
      current.messages.length &&
      incoming.messages.length &&
      !overlap &&
      (current.mode === 'around' || incoming.snapshotUpper !== current.snapshotUpper) &&
      !canJoinWindows(current, incoming, mode)
    ) {
      return {
        ...current,
        gap: true,
        nextCursor: mode === 'append' ? (incoming.previousCursor ?? current.nextCursor) : current.nextCursor,
      };
    }
  }

  const aliases = collectAliases(incoming.turns, current.turnAliases);
  const messages = mergeMessagesById(current.messages, incoming.messages);
  const turns = reorderTurns(mergeTurnLists(current.turns, incoming.turns, aliases), messages);

  return {
    thread: incoming.thread ?? current.thread,
    messages,
    turns,
    previousCursor: mode === 'prepend' ? incoming.previousCursor : current.previousCursor,
    nextCursor: mode === 'append' ? incoming.nextCursor : current.nextCursor,
    snapshotUpper: current.snapshotUpper ?? incoming.snapshotUpper,
    mode: current.mode,
    gap: current.gap,
    scrollAnchor: current.scrollAnchor,
    oversizedMessage: current.oversizedMessage || incoming.oversizedMessage,
    turnAliases: aliases,
  };
}

export function mergeLiveMessages(current: HistoryState, liveMessages: MastraDBMessage[]): HistoryState {
  if (!liveMessages.length) return current;
  const messages = mergeMessagesById(current.messages, liveMessages);
  if (
    messages.length === current.messages.length &&
    messages.every((message, index) => message === current.messages[index])
  ) {
    return current;
  }
  return {
    ...current,
    messages,
    // Do not update pagination upper from live merges.
  };
}

export { emptyHistoryState };
