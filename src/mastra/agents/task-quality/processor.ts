import type { Processor } from '@mastra/core/processors';
import { readChartSubmission } from '../chart-data';
import { readSelectedSkillIds } from '../../skills/execution-context';
import { resolveTurnPolicy } from '../turn-policy';
import { evaluateTaskCompletion } from './completion';
import { resolveTaskContract } from './contract';
import type { EvidenceStatus, TaskContract, TaskOutcome } from './types';

export const CHART_EVIDENCE_CONTEXT_KEY = 'nero-agent.chart-evidence';
export const TASK_OUTCOME_CONTEXT_KEY = 'nero-agent.task-outcome';

const TAG = '<task-contract-v1>';

type ChartEvidence = { coverage?: { complete: boolean; missing: string[] }; budgetExhausted?: boolean };
type ContextStore = { get(key: string): unknown; set?(key: string, value: unknown): void };
type QualityState = {
  taskContract?: TaskContract;
  outcomeRevision?: number;
  userGoal?: string;
  chartSnapshot?: ChartEvidence;
  cancelled?: boolean;
  fileVerified?: boolean;
  deliveryUnavailable?: boolean;
  published?: TaskOutcome & { revision: number };
};

type Publishable = TaskOutcome & { revision: number };

export function createTaskQualityProcessor(options: {
  persist?: (runId: string, outcome: Publishable) => Promise<unknown>;
  now?: () => Date;
} = {}) {
  return {
    id: 'task-quality',
    processInputStep({ messages, state, requestContext, runId }: { messages: Array<{ role?: string; content?: unknown; id?: string }>; state: QualityState; requestContext?: ContextStore; runId?: string }) {
      const latest = [...messages].reverse().find(message => message.role === 'user');
      const text = messageText(latest) || state.userGoal || '';
      state.userGoal = text.slice(0, 4000);
      state.taskContract = resolveTaskContract({
        runId: runId || String(latest?.id ?? 'run'),
        userText: text,
        now: options.now?.() ?? new Date('2026-10-22T04:30:00.000Z'),
        targetTimezone: 'Asia/Shanghai',
        hasAttachments: /附件|attachmentId|上传文件/i.test(text),
        selectedSkillIds: readSelectedSkillIds(requestContext as never),
        turnPolicy: resolveTurnPolicy({ userText: text, hasAttachments: /附件|attachmentId|上传文件/i.test(text), selectedSkillIds: readSelectedSkillIds(requestContext as never) }),
      });
    },
    processLLMRequest({ prompt, state }: { prompt: Array<{ role?: string; content?: unknown }>; state: QualityState }) {
      const contract = state.taskContract;
      if (!contract) return;
      const lines = contract.requirements.filter(item => item.importance === 'required').map(item => `- ${item.id}: ${item.description}`).join('\n');
      const content = `${TAG}\n必须覆盖：\n${lines}\n缺项要说明，不能把部分结果说成全部完成。\n</task-contract-v1>`;
      return { prompt: [...prompt.filter(message => !(message.role === 'system' && String(message.content).startsWith(TAG))), { role: 'system' as const, content }] };
    },
    async processOutputStep({ state, text, writer, requestContext, toolCalls, messages, abortSignal }: {
      state: QualityState;
      text?: string;
      writer?: { custom(part: unknown): Promise<void> | void };
      requestContext?: ContextStore;
      toolCalls?: unknown[];
      messages?: unknown[];
      abortSignal?: { aborted?: boolean };
    }) {
      if (toolCalls?.length) return;
      const contract = state.taskContract;
      if (!contract) return;
      const chart = chartEvidence(state, requestContext, text ?? '');
      const files = filesFrom(messages) ?? (state.fileVerified === undefined ? undefined : [{ id: 'file', ok: state.fileVerified }]);
      const stopped = Boolean(chart?.budgetExhausted) || /不再请求模型|已达到执行预算/.test(text ?? '');
      const outcome = state.deliveryUnavailable && !chart?.coverage
        ? evaluateTaskCompletion(contract, { weatherCoverage: {}, chartVerified: false, answerText: '', budgetStopped: stopped })
        : evaluateTaskCompletion(contract, evidenceFor(contract, chart, files, Boolean(state.cancelled) || Boolean(abortSignal?.aborted), stopped, text ?? ''));
      const published = await publish(state, outcome, writer, options.persist);
      requestContext?.set?.(TASK_OUTCOME_CONTEXT_KEY, published);
    },
  } satisfies Processor;
}

function messageText(message: { content?: unknown } | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  const parts = (message.content as { parts?: Array<{ type?: string; text?: string }> } | undefined)?.parts ?? [];
  return parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
}

function chartEvidence(state: QualityState, requestContext: ContextStore | undefined, text: string): ChartEvidence | undefined {
  const shared = requestContext?.get(CHART_EVIDENCE_CONTEXT_KEY) as ChartEvidence | undefined;
  if (state.chartSnapshot?.coverage || shared?.coverage) return state.chartSnapshot?.coverage ? state.chartSnapshot : shared;
  const parsed = readChartSubmission(text, { goal: state.userGoal ?? '', sourceUrls: [] });
  if (!parsed.ok) return shared ?? state.chartSnapshot;
  return { coverage: parsed.coverage ?? parsed.snapshot.coverage ?? { complete: true, missing: [] }, budgetExhausted: shared?.budgetExhausted };
}

function filesFrom(messages: unknown): Array<{ id: string; ok: boolean }> | undefined {
  if (!Array.isArray(messages)) return undefined;
  const files: Array<{ id: string; ok: boolean }> = [];
  for (const message of messages) {
    const parts = (message as { content?: { parts?: Array<{ type?: string; toolInvocation?: { toolName?: string; toolCallId?: string; state?: string; result?: { path?: unknown } } }> } }).content?.parts ?? [];
    for (const part of parts) {
      const call = part.toolInvocation;
      if (part.type !== 'tool-invocation' || call?.toolName !== 'write_file') continue;
      const path = call.result?.path;
      files.push({ id: String(call.toolCallId ?? 'file'), ok: call.state === 'result' && typeof path === 'string' && path.startsWith('/user-files/') });
    }
  }
  return files.length ? files : undefined;
}

function evidenceFor(contract: TaskContract, chart: ChartEvidence | undefined, files: Array<{ id: string; ok: boolean }> | undefined, cancelled: boolean, budgetStopped: boolean, answerText: string) {
  const coverage = chart?.coverage;
  const weatherCoverage: Record<string, EvidenceStatus> = {};
  for (const requirement of contract.requirements) {
    if (requirement.check !== 'weather-data') continue;
    weatherCoverage[requirement.id] = !coverage || coverage.missing.includes(requirement.id) ? 'missing' : 'met';
  }
  if (coverage?.complete) {
    for (const requirement of contract.requirements) {
      if (requirement.importance === 'required' && requirement.check === 'weather-data') weatherCoverage[requirement.id] = 'met';
    }
  }
  return {
    weatherCoverage,
    chartVerified: Boolean(coverage) && !coverage?.missing.includes('delivery.chart'),
    files,
    cancelled,
    budgetStopped,
    answerText,
  };
}

async function publish(state: QualityState, outcome: TaskOutcome, writer: { custom(part: unknown): Promise<void> | void } | undefined, persist?: (runId: string, outcome: Publishable) => Promise<unknown>) {
  const revision = Number(state.outcomeRevision ?? 0) + 1;
  const published = { ...outcome, revision };
  state.outcomeRevision = revision;
  state.published = published;
  await writer?.custom({ type: 'data-nero-task-outcome', data: published });
  await persist?.(outcome.runId, published);
  return published;
}
