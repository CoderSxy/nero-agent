import { StrictMode } from 'react';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTurnArtifacts } from './use-turn-artifacts';
import type { TurnArtifacts } from './turn-artifacts';

const listTurnArtifacts = vi.hoisted(() => vi.fn());
vi.mock('./turn-artifacts-client', () => ({
  listTurnArtifacts: (...args: unknown[]) => listTurnArtifacts(...args),
}));

const ETAG = '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"';

function item(runId: string, revision = 1, threadId = 'thread-a'): TurnArtifacts {
  return {
    version: 1,
    runId,
    threadId,
    revision,
    state: 'completed',
    collectionStatus: 'complete',
    anchorMessageId: null,
    artifacts: [{
      path: `out/${runId}.txt`,
      source: 'personal',
      name: `${runId}.txt`,
      change: 'created',
      size: 1,
      etag: ETAG,
    }],
  };
}

afterEach(() => {
  cleanup();
  listTurnArtifacts.mockReset();
});

describe('useTurnArtifacts', () => {
  it('does not let a late response for thread A pollute thread B', async () => {
    let resolveA!: (value: { items: TurnArtifacts[]; nextCursor: string | null }) => void;
    listTurnArtifacts.mockImplementation((threadId: string) => {
      if (threadId === 'thread-a') {
        return new Promise(resolve => { resolveA = resolve; });
      }
      return Promise.resolve({ items: [item('run-b', 1, 'thread-b')], nextCursor: null });
    });

    const { result, rerender } = renderHook(
      ({ threadId }) => useTurnArtifacts({ threadId, messages: [], settledVersion: 0 }),
      { initialProps: { threadId: 'thread-a' } },
    );

    rerender({ threadId: 'thread-b' });
    await waitFor(() => expect(result.current.byRun.has('run-b')).toBe(true));
    resolveA({ items: [item('run-a', 1, 'thread-a')], nextCursor: null });
    await waitFor(() => expect(result.current.byRun.has('run-a')).toBe(false));
    expect(result.current.byRun.has('run-b')).toBe(true);
  });

  it('keeps previous runs when the API fails once', async () => {
    listTurnArtifacts.mockResolvedValue({ items: [item('run-1')], nextCursor: null });

    const { result, rerender } = renderHook(
      ({ settledVersion }) => useTurnArtifacts({
        threadId: 'thread-a',
        messages: [],
        settledVersion,
      }),
      { initialProps: { settledVersion: 0 } },
    );
    await waitFor(() => expect(result.current.byRun.has('run-1')).toBe(true));
    listTurnArtifacts.mockRejectedValue(new Error('network'));
    rerender({ settledVersion: 1 });
    await waitFor(() => expect(result.current.error).toMatch(/network/));
    expect(result.current.byRun.has('run-1')).toBe(true);
  });

  it('pages until known message run refs are covered', async () => {
    listTurnArtifacts.mockImplementation((_threadId: string, options?: { cursor?: string }) => {
      if (!options?.cursor) {
        return Promise.resolve({ items: [item('run-0')], nextCursor: 'c1' });
      }
      return Promise.resolve({ items: [item('run-1')], nextCursor: null });
    });

    const message = {
      id: 'm1',
      role: 'assistant',
      content: {
        format: 2,
        parts: [],
        metadata: { neroArtifactRun: { version: 1, runId: 'run-1', threadId: 'thread-a' } },
      },
    } as any;

    const { result } = renderHook(() => useTurnArtifacts({
      threadId: 'thread-a',
      messages: [message],
      settledVersion: 0,
    }));

    await waitFor(() => expect(result.current.byRun.has('run-1')).toBe(true));
    expect(listTurnArtifacts.mock.calls.some((call) => call[1]?.cursor === 'c1')).toBe(true);
  });

  it('does not re-fetch when settled messages are replaced by equal-content new arrays', async () => {
    listTurnArtifacts.mockImplementation(async () => ({
      items: [item('run-1')],
      nextCursor: null,
    }));
    const base = {
      id: 'm1',
      role: 'assistant' as const,
      content: {
        format: 2 as const,
        parts: [],
        metadata: { neroArtifactRun: { version: 1, runId: 'run-1', threadId: 'thread-a' } },
      },
    };
    const { rerender } = renderHook(
      ({ messages }) => useTurnArtifacts({ threadId: 'thread-a', messages, settledVersion: 0 }),
      { initialProps: { messages: [{ ...base }] as any[] } },
    );
    await waitFor(() => expect(listTurnArtifacts).toHaveBeenCalledTimes(1));
    const started = Date.now();
    while (Date.now() - started < 200) {
      rerender({ messages: [{ ...base }] as any[] });
      await Promise.resolve();
    }
    expect(listTurnArtifacts).toHaveBeenCalledTimes(1);
  });
});

it('loads artifacts after StrictMode aborts the first effect setup', async () => {
 listTurnArtifacts.mockImplementation(async(_thread:string, options:{signal?:AbortSignal})=>{
   await Promise.resolve();
   if(options.signal?.aborted) throw new DOMException('aborted','AbortError');
   return {items:[item('strict-run')],nextCursor:null};
 });
 const messages:any[]=[];
 const {result}=renderHook(()=>useTurnArtifacts({threadId:'thread-a',messages,settledVersion:0}),{wrapper:StrictMode});
 await waitFor(()=>expect(result.current.byRun.has('strict-run')).toBe(true));
});
