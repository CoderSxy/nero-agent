export type TaskOutcomePart = {
  version?: 1;
  runId: string;
  revision: number;
  status: 'complete' | 'partial' | 'failed' | 'cancelled';
  verification: 'verified' | 'model-assessed' | 'unverified';
  requirements: Array<{ id: string; status: 'met' | 'missing' | 'unverified' }>;
};

export function preferTaskOutcome(current: TaskOutcomePart | undefined, next: TaskOutcomePart): TaskOutcomePart {
  if (!current || current.runId !== next.runId) return next;
  if (next.revision < current.revision) return current;
  return next;
}

export function outcomeText(outcome: TaskOutcomePart): string {
  const missing = outcome.requirements.filter(item => item.status === 'missing').map(item => item.id);
  if (outcome.status === 'cancelled') return '已取消，已有结果保留。';
  if (outcome.verification === 'model-assessed') return '回答已完成，平台没有逐项核验。';
  if (outcome.status === 'complete') return '已核对完成。';
  if (outcome.status === 'partial') return `部分完成，缺少：${missing.join('、') || '部分字段'}。`;
  return `未完成${missing.length ? `，缺少：${missing.join('、')}` : ''}。`;
}
