import { decodeHistoryCursor, encodeHistoryCursor } from './cursor';
import type { HistoryRepository, HistoryScope } from './repository';
import { selectHistorySlice } from './turns';
import {
  HISTORY_MAX_MESSAGES,
  HISTORY_METADATA_BATCH,
  HISTORY_TURNS,
  type HistoryCursorPayload,
  type HistoryMetadata,
  type HistoryPoint,
  type HistoryTurn,
  type HistoryWindow,
} from './types';

export type HistoryWindowQuery = {
  before?: string;
  after?: string;
  around?: string;
};

export class HistoryServiceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function exclusiveQueryCount(query: HistoryWindowQuery): number {
  return [query.before, query.after, query.around].filter((value) => value != null && value !== '').length;
}

function toMastraMessage(row: {
  id: string;
  role: string;
  type?: string;
  createdAt: string;
  threadId: string;
  resourceId: string;
  content: unknown;
}) {
  return {
    id: row.id,
    role: row.role,
    createdAt: row.createdAt,
    threadId: row.threadId,
    resourceId: row.resourceId,
    content: row.content,
    ...(row.type ? { type: row.type } : {}),
  };
}

function cursorPayload(
  scope: HistoryScope,
  direction: 'before' | 'after',
  boundary: HistoryPoint,
  snapshotUpper: HistoryPoint,
  openTurnId?: string,
): HistoryCursorPayload {
  return {
    version: 1,
    userId: scope.userId,
    threadId: scope.threadId,
    direction,
    boundary,
    snapshotUpper,
    ...(openTurnId ? { openTurn: { turnId: openTurnId } } : {}),
  };
}

async function readMetadataWindow(
  repo: HistoryRepository,
  scope: HistoryScope,
  args: {
    upper: HistoryPoint;
    before?: HistoryPoint;
    after?: HistoryPoint;
    ascending?: boolean;
    client: Parameters<HistoryRepository['readMetadata']>[2];
  },
): Promise<{ rows: HistoryMetadata[]; reachedBound: boolean }> {
  // One window needs at most 200 messages + 1 probe on the far side.
  const limit = HISTORY_MAX_MESSAGES + 1;
  const batches: HistoryMetadata[] = [];
  let cursorBefore = args.before;
  let cursorAfter = args.after;
  let reachedBound = false;

  while (batches.length < limit) {
    const take = Math.min(HISTORY_METADATA_BATCH, limit - batches.length);
    const chunk = await repo.readMetadata(
      scope,
      {
        upper: args.upper,
        before: cursorBefore,
        after: cursorAfter,
        limit: take,
        ascending: args.ascending,
      },
      args.client,
    );
    if (chunk.length === 0) {
      reachedBound = true;
      break;
    }
    if (args.ascending) {
      batches.push(...chunk);
      cursorAfter = { id: chunk[chunk.length - 1]!.id, createdAt: chunk[chunk.length - 1]!.createdAt };
    } else {
      // readMetadata returns ASC; for DESC scans we asked descending then reversed → ASC chronological chunk
      batches.unshift(...chunk);
      cursorBefore = { id: chunk[0]!.id, createdAt: chunk[0]!.createdAt };
    }
    if (chunk.length < take) {
      reachedBound = true;
      break;
    }
  }

  // Deduplicate by id while preserving ASC order.
  const seen = new Set<string>();
  const rows: HistoryMetadata[] = [];
  for (const row of batches) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  return { rows, reachedBound };
}

function enrichPartialTurns(
  turns: HistoryTurn[],
  contexts: Map<string, { messageId: string; preview: string }>,
): HistoryTurn[] {
  return turns.map((turn) => {
    if (!turn.partialBefore || turn.originMessageId) return turn;
    const context = contexts.get(turn.turnId);
    if (!context) return turn;
    return { ...turn, turnContext: context };
  });
}

export async function loadHistoryWindow(
  repo: HistoryRepository,
  scope: HistoryScope,
  query: HistoryWindowQuery,
): Promise<HistoryWindow> {
  if (exclusiveQueryCount(query) > 1) {
    throw new HistoryServiceError(400, 'before, after, and around are mutually exclusive');
  }

  return repo.withReadTransaction(async (client) => {
    const thread = await repo.getThread(scope, client);
    if (!thread) throw new HistoryServiceError(404, 'thread not found');

    const liveUpper = await repo.getUpper(scope, client);
    if (!liveUpper) {
      return {
        version: 1,
        thread,
        messages: [],
        turns: [],
        previousCursor: null,
        nextCursor: null,
        snapshotUpper: null,
        oversizedMessage: false,
      };
    }

    let snapshotUpper = liveUpper;
    let openTurnId: string | undefined;
    let mode: 'latest' | 'before' | 'after' | 'around' = 'latest';
    let beforePoint: HistoryPoint | undefined;
    let afterPoint: HistoryPoint | undefined;
    let aroundId: string | undefined;

    if (query.before) {
      mode = 'before';
      const payload = decodeHistoryCursor(query.before, scope);
      if (payload.direction !== 'before') throw new HistoryServiceError(400, 'cursor direction mismatch');
      snapshotUpper = payload.snapshotUpper;
      beforePoint = payload.boundary;
      openTurnId = payload.openTurn?.turnId;
    } else if (query.after) {
      mode = 'after';
      const payload = decodeHistoryCursor(query.after, scope);
      if (payload.direction !== 'after') throw new HistoryServiceError(400, 'cursor direction mismatch');
      snapshotUpper = payload.snapshotUpper;
      afterPoint = payload.boundary;
      openTurnId = payload.openTurn?.turnId;
    } else if (query.around) {
      mode = 'around';
      aroundId = query.around;
      const target = await repo.findTarget(scope, aroundId, client);
      if (!target) throw new HistoryServiceError(404, 'target message not found');
      snapshotUpper = liveUpper;
    }

    let metaRows: HistoryMetadata[] = [];
    let reachedStart = false;
    let reachedEnd = false;

    if (mode === 'after') {
      const { rows, reachedBound } = await readMetadataWindow(repo, scope, {
        upper: snapshotUpper,
        after: afterPoint,
        ascending: true,
        client,
      });
      metaRows = rows;
      reachedEnd = reachedBound || (rows.length > 0 && rows[rows.length - 1]!.id === snapshotUpper.id);
      reachedStart = false;
    } else if (mode === 'around' && aroundId) {
      const target = await repo.findTarget(scope, aroundId, client);
      if (!target) throw new HistoryServiceError(404, 'target message not found');
      const beforeHalf = Math.ceil((HISTORY_MAX_MESSAGES + 1) / 2);
      const afterHalf = HISTORY_MAX_MESSAGES + 1 - beforeHalf;
      const older = await repo.readMetadata(
        scope,
        { upper: snapshotUpper, before: { id: target.id, createdAt: target.createdAt }, limit: beforeHalf },
        client,
      );
      const newer = await repo.readMetadata(
        scope,
        {
          upper: snapshotUpper,
          after: { id: target.id, createdAt: target.createdAt },
          limit: afterHalf,
          ascending: true,
        },
        client,
      );
      const targetMeta = await repo.readMetadata(
        scope,
        {
          upper: { id: target.id, createdAt: target.createdAt },
          before: undefined,
          limit: 1,
        },
        client,
      );
      const selfMeta = targetMeta.find((row) => row.id === target.id);
      if (!selfMeta) throw new HistoryServiceError(404, 'target message not found');
      const merged = [...older, ...(selfMeta ? [selfMeta] : []), ...newer];
      const seen = new Set<string>();
      metaRows = merged.filter((row) => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
      });
      reachedStart = older.length < beforeHalf;
      reachedEnd = newer.length < afterHalf || metaRows.some((row) => row.id === snapshotUpper.id);
    } else {
      // latest or before
      const { rows, reachedBound } = await readMetadataWindow(repo, scope, {
        upper: snapshotUpper,
        before: beforePoint,
        client,
      });
      metaRows = rows;
      reachedStart = reachedBound;
      reachedEnd = !beforePoint;
    }

    const slice = selectHistorySlice(
      metaRows,
      mode === 'around' ? 'around' : mode === 'after' ? 'after' : mode === 'before' ? 'before' : 'latest',
      aroundId,
      {
        snapshotUpperId: snapshotUpper.id,
        openTurnId,
        reachedStart,
        reachedEnd,
      },
    );

    // If we fetched a probe beyond the selected window, trim selection already handled by selectHistorySlice.
    // Cap selected ids defensively.
    const selectedIds = slice.ids.slice(0, HISTORY_MAX_MESSAGES);

    const messageRows = await repo.readMessages(scope, selectedIds, client);
    const messages = messageRows.map(toMastraMessage);

    const contexts = new Map<string, { messageId: string; preview: string }>();
    for (const turn of slice.turns) {
      if (!turn.partialBefore || turn.originMessageId) continue;
      const firstId = turn.messageIds[0];
      const first = metaRows.find((row) => row.id === firstId);
      if (!first) continue;
      const found = await repo.findTurnContext(
        scope,
        { id: first.id, createdAt: first.createdAt },
        HISTORY_MAX_MESSAGES,
        client,
      );
      if (found) contexts.set(turn.turnId, { messageId: found.messageId, preview: found.preview });
    }

    const turns = enrichPartialTurns(slice.turns, contexts);

    const firstSelected = selectedIds[0]
      ? (metaRows.find((row) => row.id === selectedIds[0]) ??
        (messageRows[0] ? { id: messageRows[0].id, createdAt: messageRows[0].createdAt } : null))
      : null;
    const lastSelected = selectedIds[selectedIds.length - 1]
      ? (metaRows.find((row) => row.id === selectedIds[selectedIds.length - 1]) ??
        (messageRows[messageRows.length - 1]
          ? {
              id: messageRows[messageRows.length - 1]!.id,
              createdAt: messageRows[messageRows.length - 1]!.createdAt,
            }
          : null))
      : null;

    const openForBefore = turns[0]?.provisional && turns[0]?.partialBefore ? turns[0].turnId : undefined;

    const previousCursor =
      slice.hasBefore && firstSelected
        ? encodeHistoryCursor(
            cursorPayload(
              scope,
              'before',
              { id: firstSelected.id, createdAt: firstSelected.createdAt },
              snapshotUpper,
              openForBefore,
            ),
          )
        : null;
    const nextCursor =
      slice.hasAfter && lastSelected
        ? encodeHistoryCursor(
            cursorPayload(
              scope,
              'after',
              { id: lastSelected.id, createdAt: lastSelected.createdAt },
              snapshotUpper,
              turns.at(-1)?.partialAfter ? turns.at(-1)?.turnId : undefined,
            ),
          )
        : null;

    return {
      version: 1,
      thread,
      messages,
      turns,
      previousCursor,
      nextCursor,
      snapshotUpper: encodeHistoryCursor(cursorPayload(scope, 'before', snapshotUpper, snapshotUpper)),
      oversizedMessage: slice.oversizedMessage,
    };
  });
}

export const historyWindowLimits = {
  turns: HISTORY_TURNS,
  maxMessages: HISTORY_MAX_MESSAGES,
  metadataBatch: HISTORY_METADATA_BATCH,
};
