import { useEffect, useRef, useState } from 'react';
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

export function useTurnArtifacts(input: {
  threadId: string | null | undefined;
  messages: MastraDBMessage[];
  settledVersion: number;
}): {
  byRun: ReadonlyMap<string, TurnArtifacts>;
  error: string | null;
  refresh: () => void;
} {
  const [byRun, setByRun] = useState<ReadonlyMap<string, TurnArtifacts>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const generation = useRef(0);

  const loadedThread = useRef<string | null>(null);

  useEffect(() => {
    const threadId = input.threadId?.trim();
    if (!threadId) {
      loadedThread.current = null;
      setByRun(new Map());
      setError(null);
      return;
    }
    if (loadedThread.current !== threadId) {
      loadedThread.current = threadId;
      setByRun(new Map());
      setError(null);
    }
    const gen = ++generation.current;
    const controller = new AbortController();

    (async () => {
      const merged = new Map<string, TurnArtifacts>();
      // Seed from live/history message parts + metadata.
      for (const message of input.messages) {
        const fromPart = readArtifactsFromMessageParts(message);
        if (fromPart && fromPart.threadId === threadId) {
          merged.set(fromPart.runId, mergeTurnArtifacts(merged.get(fromPart.runId), fromPart));
        }
      }

      try {
        let cursor: string | undefined;
        const needed = new Set(
          input.messages
            .map((message) => readArtifactRunRef(message)?.runId)
            .filter((id): id is string => Boolean(id)),
        );
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
        setByRun((previous) => {
          const next = new Map(previous);
          for (const [runId, value] of merged) {
            next.set(runId, mergeTurnArtifacts(next.get(runId), value));
          }
          return next;
        });
        setError(null);
      } catch (err) {
        if (controller.signal.aborted || gen !== generation.current) return;
        if (merged.size > 0) {
          setByRun((previous) => {
            const next = new Map(previous);
            for (const [runId, value] of merged) {
              next.set(runId, mergeTurnArtifacts(next.get(runId), value));
            }
            return next;
          });
        }
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      controller.abort();
    };
  }, [input.threadId, input.settledVersion, input.messages, refreshToken]);

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
