import type { CompletionEvidence, EvidenceStatus, TaskContract, TaskOutcome, TaskRequirement } from './types';

function statusFor(requirement: TaskRequirement, evidence: CompletionEvidence): EvidenceStatus {
  if (requirement.check === 'declared-only') return 'unverified';
  if (requirement.check === 'chart') return evidence.chartVerified === true ? 'met' : 'missing';
  if (requirement.check === 'file-exists') return evidence.files?.some(file => file.ok) ? 'met' : 'missing';
  const reported = evidence.weatherCoverage?.[requirement.id];
  if (reported === 'met' || reported === 'missing' || reported === 'unverified') return reported;
  return 'missing';
}

export function evaluateTaskCompletion(contract: TaskContract, evidence: CompletionEvidence): TaskOutcome {
  const requirements = contract.requirements.map(requirement => ({
    id: requirement.id,
    status: statusFor(requirement, evidence),
    evidenceRefs: statusFor(requirement, evidence) === 'met' ? [`evidence:${requirement.id}`] : [],
  }));
  const byId = new Map(contract.requirements.map(requirement => [requirement.id, requirement]));
  const checkable = requirements.filter(item => byId.get(item.id)?.importance === 'required' && byId.get(item.id)?.check !== 'declared-only');
  const missing = checkable.filter(item => item.status === 'missing');
  const unverified = checkable.filter(item => item.status === 'unverified');
  const met = requirements.some(item => item.status === 'met');
  let status: TaskOutcome['status'];
  if (evidence.cancelled) status = 'cancelled';
  else if (checkable.length === 0) status = evidence.answerText?.trim() ? 'complete' : 'failed';
  else if (missing.length === 0 && unverified.length === 0) status = 'complete';
  else if (met) status = 'partial';
  else status = 'failed';
  const verification: TaskOutcome['verification'] = checkable.length === 0
    ? (status === 'complete' ? 'model-assessed' : 'unverified')
    : unverified.length > 0 ? 'unverified' : 'verified';
  const reasonCodes = [
    ...missing.map(item => `missing:${item.id}`),
    ...unverified.map(item => `unverified:${item.id}`),
    ...(evidence.budgetStopped ? ['budget-stopped'] : []),
    ...(evidence.cancelled ? ['cancelled'] : []),
  ];
  return { version: 1, runId: contract.runId, status, verification, requirements, reasonCodes };
}
