import { describe, expect, it } from 'vitest';
import {
  mergeTurnArtifacts,
  parseTurnArtifacts,
  readArtifactRunRef,
  type TurnArtifacts,
} from './turn-artifacts';

const ETAG = '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"';

function sample(overrides: Partial<TurnArtifacts> = {}): TurnArtifacts {
  return {
    version: 1,
    runId: 'run-1',
    threadId: 'thread-1',
    revision: 2,
    state: 'completed',
    collectionStatus: 'complete',
    anchorMessageId: 'msg-1',
    artifacts: [{
      path: 'threads/t1/output/a.txt',
      source: 'personal',
      name: 'a.txt',
      change: 'created',
      size: 12,
      etag: ETAG,
    }],
    ...overrides,
  };
}

describe('parseTurnArtifacts', () => {
  it('rejects malformed DTOs, illegal paths, and unknown version/source', () => {
    expect(parseTurnArtifacts(null)).toBeNull();
    expect(parseTurnArtifacts({ ...sample(), version: 2 })).toBeNull();
    expect(parseTurnArtifacts({
      ...sample(),
      artifacts: [{ ...sample().artifacts[0], path: '/abs.txt' }],
    })).toBeNull();
    expect(parseTurnArtifacts({
      ...sample(),
      artifacts: [{ ...sample().artifacts[0], path: '../escape.txt' }],
    })).toBeNull();
    expect(parseTurnArtifacts({
      ...sample(),
      artifacts: [{ ...sample().artifacts[0], source: 'agent' }],
    })).toBeNull();
  });

  it('accepts a valid payload', () => {
    expect(parseTurnArtifacts(sample())?.runId).toBe('run-1');
  });
});

describe('mergeTurnArtifacts', () => {
  it('does not let revision 2 overwrite revision 3', () => {
    const current = sample({ revision: 3 });
    const next = sample({ revision: 2, artifacts: [] });
    expect(mergeTurnArtifacts(current, next)).toBe(current);
  });

  it('does not let running overwrite a terminal revision', () => {
    const current = sample({ revision: 4, state: 'completed' });
    const next = sample({ revision: 5, state: 'running' });
    expect(mergeTurnArtifacts(current, next)).toBe(current);
  });

  it('keeps the newer terminal revision', () => {
    const current = sample({ revision: 2, state: 'completed' });
    const next = sample({ revision: 3, state: 'failed', artifacts: [] });
    expect(mergeTurnArtifacts(current, next)).toBe(next);
  });
});

describe('readArtifactRunRef', () => {
  it('reads trusted metadata and refuses text/url inference', () => {
    const message = {
      id: 'm1',
      role: 'assistant',
      content: {
        format: 2,
        parts: [{ type: 'text', text: 'see out/report.pptx' }],
        metadata: { neroArtifactRun: { version: 1, runId: 'run-9', threadId: 't1' } },
      },
    } as any;
    expect(readArtifactRunRef(message)).toEqual({ runId: 'run-9', threadId: 't1' });
    expect(readArtifactRunRef({
      id: 'm2',
      role: 'assistant',
      content: { format: 2, parts: [{ type: 'text', text: 'out/report.pptx' }] },
    } as any)).toBeNull();
  });
});
