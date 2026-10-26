import {
  HISTORY_MAX_MESSAGES,
  HISTORY_TARGET_BYTES,
  HISTORY_TURNS,
  type HistoryMetadata,
  type HistorySliceMode,
  type HistorySliceResult,
  type HistoryTurn,
} from './types';

export type HistorySliceOptions = {
  snapshotUpperId?: string;
  openTurnId?: string;
  /** When true, rows[0] is known to be the first message in the thread. */
  reachedStart?: boolean;
  /** When true, rows[rows.length-1] is known to be the newest message at snapshotUpper. */
  reachedEnd?: boolean;
};

/** Matches pending-user-message / isTurnUserMessage: metadata.signal.type wins over message.type. */
export function isHistoryUserMessage(row: HistoryMetadata): boolean {
  if (row.role === 'user') return true;
  if (row.role !== 'signal') return false;
  const type = row.signalType ?? row.type;
  return type === 'user' || type === 'user-message';
}

function comparePoint(a: HistoryMetadata, b: HistoryMetadata): number {
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function sortAsc(rows: readonly HistoryMetadata[]): HistoryMetadata[] {
  return [...rows].sort(comparePoint);
}

function provisionalTurnId(snapshotUpperId: string, newestId: string): string {
  return `partial:${snapshotUpperId}:${newestId}`;
}

function legacyTurnId(firstId: string): string {
  return `legacy:${firstId}`;
}

type RawTurn = {
  startIndex: number;
  endIndex: number; // inclusive
  originIndex: number | null; // index of user message, or null if unknown/legacy fragment
  knownLegacy: boolean;
};

/** Partition ASC rows into turns. Leading non-user messages form a legacy/open turn. */
export function partitionTurns(rows: readonly HistoryMetadata[]): RawTurn[] {
  const turns: RawTurn[] = [];
  let current: RawTurn | null = null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (isHistoryUserMessage(row)) {
      if (current) turns.push(current);
      current = { startIndex: i, endIndex: i, originIndex: i, knownLegacy: false };
      continue;
    }
    if (!current) {
      current = { startIndex: i, endIndex: i, originIndex: null, knownLegacy: true };
    } else {
      current.endIndex = i;
    }
  }
  if (current) turns.push(current);
  return turns;
}

function buildTurn(
  rows: readonly HistoryMetadata[],
  raw: RawTurn,
  from: number,
  to: number,
  options: {
    snapshotUpperId: string;
    openTurnId?: string;
    partialBefore: boolean;
    partialAfter: boolean;
    reachedStart: boolean;
    replacesTurnIds?: string[];
  },
): HistoryTurn {
  const messageIds = rows.slice(from, to + 1).map((row) => row.id);
  const newestId = messageIds[messageIds.length - 1]!;
  const originInSlice =
    raw.originIndex !== null && raw.originIndex >= from && raw.originIndex <= to
      ? rows[raw.originIndex]!.id
      : null;

  if (originInSlice) {
    const replaces =
      options.openTurnId && options.openTurnId !== originInSlice
        ? [options.openTurnId, ...(options.replacesTurnIds ?? [])]
        : options.replacesTurnIds;
    return {
      turnId: originInSlice,
      originMessageId: originInSlice,
      provisional: false,
      ...(replaces && replaces.length ? { replacesTurnIds: [...new Set(replaces)] } : {}),
      messageIds,
      partialBefore: options.partialBefore || from > raw.startIndex,
      partialAfter: options.partialAfter || to < raw.endIndex,
    };
  }

  // Legacy only formalizes when we reached thread start and include the first message.
  if (raw.knownLegacy && options.reachedStart && from === 0 && from === raw.startIndex) {
    const id = legacyTurnId(rows[from]!.id);
    return {
      turnId: id,
      originMessageId: null,
      provisional: false,
      ...(options.openTurnId && options.openTurnId !== id ? { replacesTurnIds: [options.openTurnId] } : {}),
      messageIds,
      partialBefore: false,
      partialAfter: options.partialAfter || to < raw.endIndex,
    };
  }

  const turnId = options.openTurnId
    ? options.openTurnId
    : provisionalTurnId(options.snapshotUpperId, newestId);

  return {
    turnId,
    originMessageId: null,
    provisional: true,
    messageIds,
    partialBefore: true,
    partialAfter: options.partialAfter || to < raw.endIndex,
  };
}

/** Select a contiguous interval; forward pages keep their boundary-adjacent prefix. */
export function selectHistorySlice(
  rowsInput: readonly HistoryMetadata[],
  mode: HistorySliceMode,
  targetId?: string,
  options: HistorySliceOptions = {},
): HistorySliceResult {
  const rows = sortAsc(rowsInput);
  if (!rows.length) return { ids: [], turns: [], hasBefore: false, hasAfter: false, oversizedMessage: false };
  const rawTurns = partitionTurns(rows);
  const upper = options.snapshotUpperId ?? rows.at(-1)!.id;
  const target = mode === 'around' ? rows.findIndex((row) => row.id === targetId) : -1;
  if (mode === 'around' && target < 0) throw new Error('around target missing');
  let from = 0;
  let to = rows.length - 1;
  if (mode === 'after') {
    to = Math.min(rawTurns[Math.min(HISTORY_TURNS, rawTurns.length) - 1]!.endIndex, HISTORY_MAX_MESSAGES - 1);
  } else if (mode === 'around') {
    const t = rawTurns.findIndex((turn) => target >= turn.startIndex && target <= turn.endIndex);
    let left = t,
      right = t;
    while (right - left + 1 < HISTORY_TURNS && (left > 0 || right < rawTurns.length - 1)) {
      if (left > 0) left--;
      if (right - left + 1 < HISTORY_TURNS && right < rawTurns.length - 1) right++;
    }
    from = rawTurns[left]!.startIndex;
    to = rawTurns[right]!.endIndex;
    if (to - from + 1 > HISTORY_MAX_MESSAGES) {
      from = Math.max(from, target - Math.floor(HISTORY_MAX_MESSAGES / 2));
      to = Math.min(to, from + HISTORY_MAX_MESSAGES - 1);
      from = Math.max(rawTurns[left]!.startIndex, to - HISTORY_MAX_MESSAGES + 1);
    }
  } else {
    from = Math.max(
      rawTurns[Math.max(0, rawTurns.length - HISTORY_TURNS)]!.startIndex,
      to - HISTORY_MAX_MESSAGES + 1,
    );
  }
  // Drop only whole edge turns, never an around target or a boundary-adjacent turn.
  let selected = rawTurns.filter((t) => t.endIndex >= from && t.startIndex <= to);
  const bytes = () => rows.slice(from, to + 1).reduce((sum, row) => sum + row.contentBytes, 0);
  while (selected.length > 1 && bytes() > HISTORY_TARGET_BYTES) {
    const first = selected[0]!,
      last = selected.at(-1)!;
    const dropLeft =
      mode === 'after'
        ? false
        : mode !== 'around'
          ? true
          : target > first.endIndex && (target >= last.startIndex || target - from >= to - target);
    if (dropLeft) {
      from = first.endIndex + 1;
      selected.shift();
    } else {
      to = last.startIndex - 1;
      selected.pop();
    }
  }
  // Split a single heavy turn as well. At most one intrinsically oversized message
  // is exempt; ordinary neighbours must still fit the soft byte budget.
  const fits = (start: number, end: number) => {
    const sizes = rows.slice(start, end + 1).map((row) => row.contentBytes);
    const largest = Math.max(0, ...sizes);
    return (
      sizes.reduce((sum, size) => sum + size, 0) - (largest > HISTORY_TARGET_BYTES ? largest : 0) <=
      HISTORY_TARGET_BYTES
    );
  };
  if (!fits(from, to)) {
    if (mode === 'around') {
      const min = from,
        max = to;
      from = target;
      to = target;
      for (;;) {
        const left = from > min && fits(from - 1, to);
        const right = to < max && fits(from, to + 1);
        if (!left && !right) break;
        if (left && (!right || target - from <= to - target)) from--;
        else to++;
      }
    } else {
      while (from < to && !fits(from, to)) {
        if (mode === 'after') to--;
        else from++;
      }
    }
    selected = rawTurns.filter((turn) => turn.endIndex >= from && turn.startIndex <= to);
  }
  const turns = selected.map((raw, index) => {
    const start = Math.max(from, raw.startIndex),
      end = Math.min(to, raw.endIndex);
    const continued =
      mode === 'before'
        ? index === selected.length - 1
        : mode === 'after'
          ? index === 0 && raw.originIndex === null
          : false;
    return buildTurn(rows, raw, start, end, {
      snapshotUpperId: upper,
      openTurnId: continued ? options.openTurnId : undefined,
      partialBefore: start > raw.startIndex || (raw.originIndex === null && !options.reachedStart),
      partialAfter: end < raw.endIndex || (end === rows.length - 1 && options.reachedEnd === false),
      reachedStart: Boolean(options.reachedStart),
    });
  });
  return {
    ids: rows.slice(from, to + 1).map((row) => row.id),
    turns,
    hasBefore: from > 0 || !options.reachedStart,
    hasAfter: to < rows.length - 1 || options.reachedEnd === false,
    oversizedMessage: rows.slice(from, to + 1).some((row) => row.contentBytes > HISTORY_TARGET_BYTES),
  };
}
