import {
  HISTORY_CURSOR_MAX_BYTES,
  type HistoryCursorPayload,
  type HistoryPoint,
} from './types';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isHistoryPoint(value: unknown): value is HistoryPoint {
  if (!value || typeof value !== 'object') return false;
  const point = value as HistoryPoint;
  return isNonEmptyString(point.createdAt) && isNonEmptyString(point.id) && !Number.isNaN(Date.parse(point.createdAt));
}

function assertPayload(value: unknown): HistoryCursorPayload {
  if (!value || typeof value !== 'object') throw new Error('invalid history cursor');
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) throw new Error('unsupported history cursor version');
  if (!isNonEmptyString(raw.userId)) throw new Error('invalid history cursor userId');
  if (!isNonEmptyString(raw.threadId)) throw new Error('invalid history cursor threadId');
  if (raw.direction !== 'before' && raw.direction !== 'after') {
    throw new Error('invalid history cursor direction');
  }
  if (!isHistoryPoint(raw.boundary)) throw new Error('invalid history cursor boundary');
  if (!isHistoryPoint(raw.snapshotUpper)) throw new Error('invalid history cursor snapshotUpper');

  const payload: HistoryCursorPayload = {
    version: 1,
    userId: raw.userId,
    threadId: raw.threadId,
    direction: raw.direction,
    boundary: { createdAt: raw.boundary.createdAt, id: raw.boundary.id },
    snapshotUpper: { createdAt: raw.snapshotUpper.createdAt, id: raw.snapshotUpper.id },
  };

  if (raw.openTurn !== undefined) {
    if (!raw.openTurn || typeof raw.openTurn !== 'object') throw new Error('invalid history cursor openTurn');
    const openTurn = raw.openTurn as { turnId?: unknown };
    if (!isNonEmptyString(openTurn.turnId)) throw new Error('invalid history cursor openTurn');
    payload.openTurn = { turnId: openTurn.turnId };
  }

  return payload;
}

export function encodeHistoryCursor(value: HistoryCursorPayload): string {
  const payload = assertPayload(value);
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  if (Buffer.byteLength(encoded, 'utf8') > HISTORY_CURSOR_MAX_BYTES) {
    throw new Error('history cursor exceeds size limit');
  }
  return encoded;
}

export function decodeHistoryCursor(
  raw: string,
  scope: { userId: string; threadId: string },
): HistoryCursorPayload {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('invalid history cursor');
  if (Buffer.byteLength(raw, 'utf8') > HISTORY_CURSOR_MAX_BYTES) {
    throw new Error('history cursor exceeds size limit');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new Error('invalid history cursor encoding');
  }

  const payload = assertPayload(parsed);
  if (payload.userId !== scope.userId || payload.threadId !== scope.threadId) {
    throw new Error('history cursor scope mismatch');
  }
  return payload;
}
