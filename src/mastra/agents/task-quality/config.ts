import type { TaskProfile, RunBudget } from './types';

const DEFAULTS: Record<TaskProfile, RunBudget> = {
  'simple-chart': { mainRequests: 8, repairs: 1, tools: 12, activeMs: 180_000 },
  general: { mainRequests: 20, repairs: 1, tools: 30, activeMs: 300_000 },
  complex: { mainRequests: 40, repairs: 1, tools: 60, activeMs: 900_000 },
};

const LIMITS: RunBudget = { mainRequests: 100, repairs: 1, tools: 100, activeMs: 1_800_000 };

export function resolveTaskQualityMode(value: unknown): 'observe' | 'enforce' {
  if (value === undefined || value === '' || value === 'observe') return 'observe';
  if (value === 'enforce') return 'enforce';
  throw new Error('AGENT_TASK_QUALITY_MODE must be observe or enforce');
}

function boundedInteger(value: unknown, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`Invalid task budget ${name}`);
  }
  return value;
}

export function resolveTaskBudget(profile: TaskProfile, override?: Partial<RunBudget>): RunBudget {
  const base = DEFAULTS[profile];
  if (!base) throw new Error('Unknown task budget profile');
  if (!override) return { ...base };
  const next = { ...base };
  for (const key of Object.keys(override) as Array<keyof RunBudget>) {
    if (override[key] === undefined) continue;
    next[key] = boundedInteger(override[key], LIMITS[key], key);
  }
  return next;
}
