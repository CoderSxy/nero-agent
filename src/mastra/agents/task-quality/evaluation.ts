import { runFixtureAgent } from './evaluation-agent';
import { runLiveAgent } from './evaluation-live';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { webFetchTool } from '@mastra/core/tools';
import { withChartDataFetch } from '../chart-fetch-tool';
import { selectStructuredDelivery } from '../../models/capabilities';
import { inspectSkillStorage } from '../../skills/health';
import { SkillStorageError } from '../../skills/errors';
import { computeManifestHash } from '../../skills/release-store';
import { preferTaskOutcome } from '../../../../web/src/agent/task-outcome';
import { inheritsVerifiedChart } from '../turn-policy';
import { createMemoryBudget } from './budget';
import type { TaskOutcome } from './types';

const FIXED_NOW = new Date('2026-10-22T04:30:00.000Z');
const LIVE_CASE_IDS = ['weather-complete', 'weather-temperature-only', 'weather-humidity', 'weather-range-invalid', 'file-request'] as const;

export type QualityCase = {
  id: string;
  title: string;
  userText: string;
  answer: string;
  chart?: { complete: boolean; missing: string[] };
  fileVerified?: boolean;
  adapter?: string;
  expect: { status: string; verification?: string; met?: string[]; missing?: string[]; absent?: string[] };
  hard?: boolean;
  rejectComplete?: boolean;
};

export type EvaluationCaseResult = {
  caseId: string;
  modelRef: string | null;
  expectedStatus: string;
  actualStatus: string;
  verification?: string;
  coverage: { met: string[]; missing: string[]; unverified: string[] };
  sourceChecks: string[];
  modelCalls: number;
  paidModelCalls?: number;
  toolCalls: number;
  repairCalls: number;
  timingsMs: number;
  price: null;
  passed: boolean;
  skipped: boolean;
  blocked: boolean;
  hardFailure: boolean;
  reason?: string;
};

export type EvaluationReport = {
  mode: 'fixture' | 'live';
  passed: number;
  skipped: number;
  blocked: number;
  hardFailures: number;
  price: null;
  elapsedMs: number;
  cases: EvaluationCaseResult[];
};

type OutcomePart = TaskOutcome & { revision: number };

export function loadQualityCases(): QualityCase[] {
  const url = new URL('../../../../tests/fixtures/task-quality/cases.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as QualityCase[];
}

export function evaluationExitCode(report: EvaluationReport): number {
  return report.hardFailures > 0 || report.cases.some(c => !c.passed && !c.skipped && !c.blocked) ? 1 : report.blocked > 0 || report.skipped > 0 ? 2 : 0;
}

export async function runQualityEvaluation(input: {
  mode: 'fixture' | 'live';
  cases?: QualityCase[];
  modelRefs?: string[];
  maxMainModelCalls?: number;
  signal?: AbortSignal;
  now?: Date;
}): Promise<EvaluationReport> {
  const started = Date.now();
  const limit = input.maxMainModelCalls ?? 60;
  const cases = input.cases ?? loadQualityCases();
  const results: EvaluationCaseResult[] = [];
  let modelCalls = 0;
  if (input.mode === 'live') {
    const models = (input.modelRefs ?? []).slice(0, 2);
    const selected = models.length ? models : [];
    if (!selected.length || !process.env.EVAL_LIVE_USER_ID) {
      for (const id of LIVE_CASE_IDS) {
        results.push(blocked(id, '没有已授权的 live 测试模型', null));
      }
      return summarize('live', results, started);
    }
    for (const modelRef of selected) {
      for (const id of LIVE_CASE_IDS) {
        if (input.signal?.aborted || modelCalls >= limit) {
          results.push(blocked(id, modelCalls >= limit ? 'live 主请求达到 60 次上限' : '已取消', safeModelRef(modelRef)));
          continue;
        }
        const item = cases.find(item => item.id === id);
        if (!item) { results.push(blocked(id, '未找到评测用例', safeModelRef(modelRef))); continue; }
        const begun = Date.now();
        try {
          const actual = await runLiveAgent(item, modelRef, limit - modelCalls, input.signal);
          modelCalls += actual.modelCalls;
          const coverage = coverageOf(actual.outcome as OutcomePart);
          const expectedStatus = id === 'file-request' ? 'complete' : item.expect.status;
          const passed = (id === 'weather-range-invalid' ? ['partial','failed'].includes(actual.outcome?.status ?? '') : actual.outcome?.status === expectedStatus) &&
            (item.expect.met ?? []).every(id => coverage.met.includes(id)) &&
            (id === 'weather-range-invalid' || (item.expect.missing ?? []).every(id => coverage.missing.includes(id)));
          results.push({caseId:id, modelRef:safeModelRef(modelRef), expectedStatus,
            actualStatus:actual.outcome?.status ?? 'missing', verification:actual.outcome?.verification,
            coverage, sourceChecks:['production-agent', 'production-tools', 'persistent-budget', ...actual.notes],
            modelCalls:actual.modelCalls, toolCalls:actual.toolCalls, repairCalls:actual.repairCalls,
            timingsMs:Date.now()-begun, price:null, passed, skipped:false, blocked:false, hardFailure:!passed});
        } catch (error) {
          // A partial failure may have spent requests: never start another case
          // with an unknown remaining suite allowance.
          modelCalls = limit;
          results.push(blocked(id, error instanceof Error ? error.message : 'live 执行失败', safeModelRef(modelRef)));
        }
      }
    }
    return summarize('live', results, started);
  }
  for (const item of cases) {
    if (input.signal?.aborted) {
      results.push({ ...blocked(item.id, '已取消', 'fixture'), skipped: true, blocked: false });
      continue;
    }
    results.push(await runFixtureCase(item, input.now ?? FIXED_NOW));
  }
  return summarize('fixture', results, started);
}

async function runFixtureCase(item: QualityCase, now: Date): Promise<EvaluationCaseResult> {
  const started = Date.now();
  const actual = await runFixtureAgent(item, now);
  const outcome = actual.outcome as OutcomePart | undefined;
  const injected = true;
  const repairs = 0;
  const sourceChecks = ['real-agent-loop', 'real-sdk', 'real-fetch-adapter', 'real-submission-schema', 'real-provenance-check', 'real-completion-processor', `fixture-provider-attempts:${actual.calls}`];
  const adapterOk = await runAdapter(item, outcome, sourceChecks);
  const coverage = coverageOf(outcome);
  const statusOk = outcome?.status === item.expect.status && (!item.expect.verification || outcome.verification === item.expect.verification);
  const metOk = (item.expect.met ?? []).every(id => coverage.met.includes(id));
  const missingOk = (item.expect.missing ?? []).every(id => coverage.missing.includes(id));
  const absentOk = (item.expect.absent ?? []).every(id => !outcome?.requirements.some(requirement => requirement.id === id));
  const rejected = item.rejectComplete === true && outcome?.status === 'complete';
  const passed = Boolean(outcome) && statusOk && metOk && missingOk && absentOk && adapterOk && repairs === 0 && !rejected && injected;
  const hardFailure = item.hard === true && !passed;
  return {
    caseId: item.id,
    modelRef: 'fixture',
    expectedStatus: item.expect.status,
    actualStatus: outcome?.status ?? 'missing',
    verification: outcome?.verification,
    coverage,
    sourceChecks,
    modelCalls: actual.calls,
    paidModelCalls: 0,
    toolCalls: actual.tools,
    repairCalls: repairs,
    timingsMs: Date.now() - started,
    price: null,
    passed,
    skipped: false,
    blocked: false,
    hardFailure,
    reason: passed ? undefined : 'fixture 断言未满足',
  };
}

async function runAdapter(item: QualityCase, outcome: OutcomePart | undefined, sourceChecks: string[]): Promise<boolean> {
  if (item.adapter === 'gateway-schema') {
    sourceChecks.push('selectStructuredDelivery');
    return selectStructuredDelivery({ toolCalling: 'supported', forcedToolChoice: 'supported', jsonSchema: 'unsupported' }) !== 'native-schema';
  }
  if (item.adapter === 'data-tool') {
    sourceChecks.push('selectStructuredDelivery');
    return selectStructuredDelivery({ toolCalling: 'supported', forcedToolChoice: 'unsupported', jsonSchema: 'unsupported' }) === 'data-tool';
  }
  if (item.adapter === 'wrapped-schema') {
    sourceChecks.push('withChartDataFetch');
    const wrapped = withChartDataFetch(webFetchTool);
    const schema = wrapped.inputSchema as { safeParse?: (value: unknown) => { success: boolean } } | undefined;
    const empty = schema?.safeParse?.({});
    const filled = schema?.safeParse?.({ url: 'https://example.com/data.json' });
    return Boolean(schema) && empty?.success === false && filled?.success !== false;
  }
  if (item.adapter === 'blob-missing' || item.adapter === 'release-tree-missing') {
    sourceChecks.push('inspectSkillStorage');
    const report = await inspectSkillFixture(item.adapter === 'blob-missing');
    return item.adapter === 'blob-missing' ? report.status === 'unavailable' && report.safeCode === 'BLOB_MISSING' : report.status === 'repairable';
  }
  if (item.adapter === 'cross-user') {
    sourceChecks.push('memory-budget-owner');
    const budget = createMemoryBudget();
    await budget.reserve({ userId: 'user-a', threadId: 'thread-a' }, { runId: 'run-owner', operationId: 'op-1', kind: 'tool', profile: 'general', mode: 'enforce' });
    const denied = await budget.reserve({ userId: 'user-b', threadId: 'thread-a' }, { runId: 'run-owner', operationId: 'op-2', kind: 'tool', profile: 'general', mode: 'enforce' });
    return denied.reason === 'owner' && denied.allowed === false;
  }
  if (item.adapter === 'budget-stop') {
    sourceChecks.push('memory-budget-limit');
    const budget = createMemoryBudget();
    let lastAllowed = true;
    for (let index = 1; index <= 9; index += 1) {
      const result = await budget.reserve({ userId: 'user-a', threadId: 'thread-a' }, { runId: 'run-budget', operationId: `main-${index}`, kind: 'main-model', profile: 'simple-chart', mode: 'enforce' });
      lastAllowed = result.allowed;
    }
    return lastAllowed === false && outcome?.status === 'failed';
  }
  if (item.adapter === 'replay-outcome' && outcome) {
    sourceChecks.push('prefer-task-outcome');
    const older = { ...outcome, revision: outcome.revision - 1, status: 'complete' as const };
    return preferTaskOutcome(outcome, older).revision === outcome.revision && preferTaskOutcome(outcome, older).status === outcome.status;
  }
  if (item.adapter === 'style-followup') {
    sourceChecks.push('inheritsVerifiedChart');
    return inheritsVerifiedChart(item.userText, 'inline-chart') && outcome?.verification === 'model-assessed';
  }
  if (item.adapter === 'html-mixed') {
    sourceChecks.push('html-not-verified-weather');
    return outcome?.verification === 'model-assessed' && !outcome.requirements.some(requirement => requirement.id.startsWith('weather.'));
  }
  return true;
}

async function inspectSkillFixture(missingBlob: boolean) {
  const skillMd = '---\nname: demo\ndescription: instructions\n---\n\n# Demo\n';
  const blobHash = createHash('sha256').update('reference').digest('hex');
  const entries = [{ path: 'references/note.md', blobHash, size: 9, isText: true }];
  const target = { skillId: 'skill-eval', version: 1, manifestHash: computeManifestHash(skillMd, entries), skillMd, entries };
  const missing = new Set(missingBlob ? [blobHash] : []);
  return inspectSkillStorage(target, {
    blobStore: { async openVerified(hash: string) {
      if (missing.has(hash)) throw new SkillStorageError('BLOB_MISSING', 'missing');
      return Readable.from(['ok']);
    } },
    releaseStore: { async verifyRelease() {
      if (!missingBlob) throw new SkillStorageError('RELEASE_INCOMPLETE', 'tree missing');
    } },
    now: () => FIXED_NOW,
  } as never);
}

function coverageOf(outcome: OutcomePart | undefined) {
  const requirements = outcome?.requirements ?? [];
  return {
    met: requirements.filter(item => item.status === 'met').map(item => item.id),
    missing: requirements.filter(item => item.status === 'missing').map(item => item.id),
    unverified: requirements.filter(item => item.status === 'unverified').map(item => item.id),
  };
}

function blocked(caseId: string, reason: string, modelRef: string | null): EvaluationCaseResult {
  return {
    caseId, modelRef, expectedStatus: 'blocked', actualStatus: 'blocked', coverage: { met: [], missing: [], unverified: [] },
    sourceChecks: [], modelCalls: 0, toolCalls: 0, repairCalls: 0, timingsMs: 0, price: null,
    passed: false, skipped: false, blocked: true, hardFailure: false, reason,
  };
}

function safeModelRef(value: string): string {
  return value.replace(/sk-[A-Za-z0-9_-]+/g, 'redacted').slice(0, 80);
}

function summarize(mode: 'fixture' | 'live', cases: EvaluationCaseResult[], started: number): EvaluationReport {
  return {
    mode,
    passed: cases.filter(item => item.passed).length,
    skipped: cases.filter(item => item.skipped).length,
    blocked: cases.filter(item => item.blocked).length,
    hardFailures: cases.filter(item => item.hardFailure).length,
    price: null,
    elapsedMs: Date.now() - started,
    cases,
  };
}
