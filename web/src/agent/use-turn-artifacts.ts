import { useEffect, useMemo, useRef, useState } from 'react';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { listTurnArtifacts } from './turn-artifacts-client';
import {
  isTerminalArtifactState,
  mergeTurnArtifacts,
  parseTurnArtifacts,
  readArtifactRunRef,
  readArtifactsFromMessageParts,
  type TurnArtifacts,
} from './turn-artifacts';

function collectRunIds(messages: MastraDBMessage[]): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    const runId = readArtifactRunRef(message)?.runId;
    if (runId) ids.add(runId);
    const fromPart = readArtifactsFromMessageParts(message);
    if (fromPart?.runId) ids.add(fromPart.runId);
  }
  return [...ids].sort();
}

function mapsEqual(a: ReadonlyMap<string, TurnArtifacts>, b: ReadonlyMap<string, TurnArtifacts>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (!other) return false;
    if (
      other.revision !== value.revision ||
      other.state !== value.state ||
      other.collectionStatus !== value.collectionStatus ||
      other.artifacts.length !== value.artifacts.length
    ) {
      return false;
    }
  }
  return true;
}

export function useTurnArtifacts(input: {
  threadId: string | null | undefined;
  messages: MastraDBMessage[];
  settledVersion: number;
}): {
  byRun: ReadonlyMap<string, TurnArtifacts>;
  error: string | null;
  refresh: () => void;
} {
  const [remoteByRun, setRemoteByRun] = useState<ReadonlyMap<string, TurnArtifacts>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const generation = useRef(0);
  const loadedThread = useRef<string | null>(null);
  const inflightKey = useRef<string | null>(null);

  const localByRun = useMemo(() => {
    const threadId = input.threadId?.trim();
    const merged = new Map<string, TurnArtifacts>();
    if (!threadId) return merged;
    for (const message of input.messages) {
      const fromPart = readArtifactsFromMessageParts(message);
      if (fromPart && fromPart.threadId === threadId) {
        merged.set(fromPart.runId, mergeTurnArtifacts(merged.get(fromPart.runId), fromPart));
      }
    }
    return merged;
  }, [input.threadId, input.messages]);

  const runIdsKey = useMemo(
    () => collectRunIds(input.messages).join(','),
    [input.messages],
  );

  const remoteKey = `${input.threadId?.trim() ?? ''}|${runIdsKey}|${input.settledVersion}|${refreshToken}`;

  useEffect(() => {
    const threadId = input.threadId?.trim();
    if (!threadId) {
      loadedThread.current = null;
      setRemoteByRun(new Map());
      setError(null);
      return;
    }
    if (loadedThread.current !== threadId) {
      loadedThread.current = threadId;
      setRemoteByRun(new Map());
      setError(null);
    }
    if (inflightKey.current === remoteKey) return;
    inflightKey.current = remoteKey;
    const gen = ++generation.current;
    const controller = new AbortController();
    const needed = new Set(runIdsKey ? runIdsKey.split(',').filter(Boolean) : []);

    (async () => {
      const merged = new Map<string, TurnArtifacts>();
      try {
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = await listTurnArtifacts(threadId, {
            cursor,
            limit: 50,
            signal: controller.signal,
          });
          if (gen !== generation.current) return;
          for (const item of page.items) {
            merged.set(item.runId, mergeTurnArtifacts(merged.get(item.runId), item));
            needed.delete(item.runId);
          }
          cursor = page.nextCursor ?? undefined;
          pages += 1;
        } while (cursor && (needed.size > 0 || pages < 1) && pages < 20);

        if (gen !== generation.current) return;
        setRemoteByRun((previous) => {
          const next = new Map(previous);
          for (const [runId, value] of merged) {
            const combined = mergeTurnArtifacts(next.get(runId), value);
            const existing = next.get(runId);
            if (existing && existing.revision > combined.revision) continue;
            next.set(runId, combined);
          }
          return mapsEqual(previous, next) ? previous : next;
        });
        setError(null);
      } catch (err) {
        if (controller.signal.aborted || gen !== generation.current) return;
        if (merged.size > 0) {
          setRemoteByRun((previous) => {
            const next = new Map(previous);
            for (const [runId, value] of merged) {
              next.set(runId, mergeTurnArtifacts(next.get(runId), value));
            }
            return mapsEqual(previous, next) ? previous : next;
          });
        }
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (gen === generation.current && inflightKey.current === remoteKey) inflightKey.current = null;
      }
    })();

    return () => {
      // StrictMode may immediately set up this same key again after aborting it.
      if (gen === generation.current) {
        generation.current += 1;
        if (inflightKey.current === remoteKey) inflightKey.current = null;
      }
      controller.abort();
    };
  }, [remoteKey, runIdsKey, input.threadId]);

  const byRun = useMemo(() => {
    const merged = new Map(remoteByRun);
    for (const [runId, value] of localByRun) {
      merged.set(runId, mergeTurnArtifacts(merged.get(runId), value));
    }
    return merged;
  }, [localByRun, remoteByRun]);

  return {
    byRun,
    error,
    refresh: () => setRefreshToken((value) => value + 1),
  };
}

export function absorbStreamArtifact(
  current: ReadonlyMap<string, TurnArtifacts>,
  payload: unknown,
): ReadonlyMap<string, TurnArtifacts> {
  const parsed = parseTurnArtifacts(payload);
  if (!parsed || !isTerminalArtifactState(parsed.state)) return current;
  const next = new Map(current);
  next.set(parsed.runId, mergeTurnArtifacts(current.get(parsed.runId), parsed));
  return next;
}
