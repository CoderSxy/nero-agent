import { describe, expect, it } from 'vitest';
import { outcomeText, preferTaskOutcome, type TaskOutcomePart } from './task-outcome';

const base = (revision: number, status: TaskOutcomePart['status'] = 'partial'): TaskOutcomePart => ({
  runId: 'run-1', revision, status, verification: 'verified',
  requirements: [{ id: 'weather.condition', status: status === 'complete' ? 'met' : 'missing' }],
});

describe('task outcome reconciliation', () => {
  it('keeps the newest revision for the same run and ignores an older replay', () => {
    const first = preferTaskOutcome(undefined, base(1));
    const next = preferTaskOutcome(first, base(2, 'complete'));
    const replay = preferTaskOutcome(next, base(1));
    expect(replay.revision).toBe(2);
    expect(replay.status).toBe('complete');
    expect(preferTaskOutcome(replay, { ...base(1), runId: 'run-2' }).runId).toBe('run-2');
  });

  it('describes partial and verified results on the answer itself', () => {
    expect(outcomeText(base(1))).toContain('部分完成');
    expect(outcomeText(base(1))).toContain('weather.condition');
    expect(outcomeText({ ...base(1, 'complete'), verification: 'model-assessed' })).toContain('没有逐项核验');
  });
});
