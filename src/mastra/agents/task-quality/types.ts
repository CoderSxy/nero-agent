import type { TurnDeliveryMode } from '../turn-policy';

export type TaskProfile = 'simple-chart' | 'general' | 'complex';
export type TaskDomain = 'weather' | 'generic';
export type RequirementCheck = 'weather-data' | 'chart' | 'file-exists' | 'declared-only';
export type EvidenceStatus = 'met' | 'missing' | 'unverified';

export type TaskRequirement = {
  id: string;
  importance: 'required' | 'optional';
  origin: 'explicit' | 'default';
  check: RequirementCheck;
  description: string;
};

export type TaskContract = {
  version: 1;
  runId: string;
  deliveryMode: TurnDeliveryMode;
  profile: TaskProfile;
  domain: TaskDomain;
  requirements: TaskRequirement[];
  policyVersion: string;
  referenceInstant?: string;
};

export type TaskOutcome = {
  version: 1;
  runId: string;
  status: 'complete' | 'partial' | 'failed' | 'cancelled';
  verification: 'verified' | 'model-assessed' | 'unverified';
  requirements: Array<{ id: string; status: EvidenceStatus; evidenceRefs: string[] }>;
  reasonCodes: string[];
};

export type CompletionEvidence = {
  weatherCoverage?: Partial<Record<string, EvidenceStatus>>;
  chartVerified?: boolean;
  files?: Array<{ id: string; ok: boolean }>;
  cancelled?: boolean;
  budgetStopped?: boolean;
  answerText?: string;
  mode?: 'observe' | 'enforce';
};

export type RunBudget = {
  mainRequests: number;
  repairs: number;
  tools: number;
  activeMs: number;
};
