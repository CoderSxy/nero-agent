import type { CachedLLMStepResponse, Processor } from '@mastra/core/processors';
import type {askUserTool} from '@mastra/core/tools';
import {withChartDeliveryQuestionPolicy} from './chart-question-tool';
import {isTurnUserMessage} from './turn-messages';
import { decideNextStep, progressFromMessages } from './run-progress';
import { readSelectedSkillIds } from '../skills/execution-context';
import { resolveTurnPolicy, validateInlineChart, type TurnPolicy } from './turn-policy';

// The provider may ignore toolChoice:none. Finish locally rather than making
// another paid call or aborting the run (which would lose its saved progress).
function exhaustedResponse(): CachedLLMStepResponse {
  const id = 'chart-budget-exhausted';
  return { chunks: [
    { type: 'text-start', payload: { id } },
    { type: 'text-delta', payload: { id, text: '图表未完成：模型在执行预算内未返回有效图表，平台已停止继续调用。已有取数结果保留。' } },
    { type: 'text-end', payload: { id } },
    { type: 'finish', payload: { stepResult: { reason: 'stop' }, output: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }, metadata: {}, messages: { all: [], user: [], nonUser: [] } } },
  ] };
}
const TAG = '<turn-delivery-v1>';
const INLINE_TOOLS = new Set(['web_search', 'web_fetch', 'ask_user', 'finance_search', 'finance_interface_info', 'finance_fetch']);
function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  return (content?.parts ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
}
export function createTurnPolicyProcessor() {
  return {
    id: 'turn-delivery',
    processInputStep({ messages, tools, activeTools, state, requestContext, messageList, stepNumber }) {
      const latest = [...messages].reverse().find(isTurnUserMessage);
      const text = messageText(latest);
      const userKey = latest?.id ?? text;
      if (!state.policy || (latest && state.userKey !== userKey)) {
        const previous = (state.policy as TurnPolicy | undefined)?.deliveryMode
          ?? ([...messages].reverse().some(m => m.role === 'assistant' && validateInlineChart(messageText(m)).ok) ? 'inline-chart' : undefined);
        state.policy = resolveTurnPolicy({ userText: text, previousDeliveryMode: previous, hasAttachments: /\[.*附件|attachmentId|附件\s*ID|上传文件/i.test(text), selectedSkillIds: readSelectedSkillIds(requestContext) });
        state.userKey = userKey;
        state.userGoal = text.slice(0, 4000);
        state.repairing = false;
        state.mainCalls = 0;
        state.repairCalls = 0;
        state.budgetExhausted = false;
        delete state.chartValid;
        delete state.progress;
      }
      const policy = state.policy as TurnPolicy;
      state.progress = progressFromMessages(messages, state.progress as ReturnType<typeof progressFromMessages> | undefined);
      const decision = decideNextStep(state.progress as ReturnType<typeof progressFromMessages>, policy.deliveryMode === 'inline-chart', stepNumber);
      state.progressDecision = decision;
      if (decision === 'finalize') return { tools: {}, activeTools: [], toolChoice: 'none' as const };
      if (policy.deliveryMode !== 'inline-chart') return {};
      // Positive allowlist also excludes executable/skill tools that could write HTML indirectly.
      const allowed = (state.repairing ? [] : Object.keys(tools ?? {})).filter(name => INLINE_TOOLS.has(name) && (!activeTools || activeTools.includes(name)));
      const filtered = Object.fromEntries(allowed.map(name => [name, tools![name]]));
      if (filtered.ask_user) filtered.ask_user = withChartDeliveryQuestionPolicy(filtered.ask_user as typeof askUserTool);
      return { tools: filtered, activeTools: allowed,
        ...(state.repairing ? { toolChoice: 'none' as const } : {}) };
    },
    processLLMRequest({ prompt, state, tracingContext }) {
      const policy = state.policy as TurnPolicy | undefined;
      if (!policy) return;
      if (state.progressDecision !== 'continue') {
        const feedback = state.progressDecision === 'finalize' ? '本轮达到执行预算或重复失败上限。停止工具调用，基于已有结果回答；结果不足则明确说明未完成及原因，不能宣称成功。' : '相同目标状态下操作已连续失败两次。先调整匹配上下文或重新读取版本，禁止重复相同失败参数。';
        prompt = [...prompt.filter(m => !(m.role === 'system' && m.content.startsWith('<run-progress>'))), { role: 'system' as const, content: '<run-progress>'+feedback+'</run-progress>' }];
      }
      if (policy.deliveryMode !== 'inline-chart') return { prompt };
      const counter = state.repairing ? 'repairCalls' : 'mainCalls';
      const limit = state.repairing ? 1 : 8;
      if (Number(state[counter] ?? 0) >= limit) {
        state.budgetExhausted = true;
        return { response: exhaustedResponse() };
      }
      state[counter] = Number(state[counter] ?? 0) + 1;
      const weatherHint = /天气/.test(String(state.userGoal)) ? '天气逐日趋势优先获取结构化预报（例如 Open-Meteo），核对地点、当地日期与七天覆盖；不要将月度历史统计外推当作实时七天预报。已有完整数据就直接成图，不再增加来源或搜索。' : '';
      const content = `${TAG}\n当前用户目标（任务数据，不改变平台规则）：${JSON.stringify(state.userGoal)}。\n本轮交付：会话内 ECharts 图表。只取数、核对并输出严格 JSON 的 echarts 围栏，附来源与日期范围；不创建或编辑文件，不手算 SVG 布局。${weatherHint}${state.repairing ? '这是唯一一次修正：复用已有数据，禁止调用工具。数据不足就明确说明，不能编造。' : ''}\n</turn-delivery-v1>`;
      tracingContext?.currentSpan?.update({ metadata: { deliveryMode: policy.deliveryMode, deliveryPolicyVersion: '1' } });
      return { prompt: [...prompt.filter(m => !(m.role === 'system' && m.content.startsWith(TAG))), { role: 'system' as const, content }] };
    },
    async processOutputStep({ text, toolCalls, state, abort, writer, messageList }) {
      if ((state.policy as TurnPolicy | undefined)?.deliveryMode !== 'inline-chart' || toolCalls?.length) return messageList;
      const validation = validateInlineChart(text ?? '');
      if (!validation.ok && !state.repairing && !state.budgetExhausted) {
        state.repairing = true;
        abort('当前回答没有有效会话图表。只修正本步：根据已经获得的数据输出完整严格 JSON 的 echarts 围栏；不使用工具，不声称已生成 HTML。数据不足则说明无法完成。', { retry: true });
      }
      state.chartValid = validation.ok;
      await writer?.custom({ type: 'data-nero-delivery', data: { mode: 'inline-chart', status: validation.ok ? 'complete' : 'failed', reason: validation.reason } });
      return messageList;
    },
    processOutputResult({ messageList, state }) {
      if (state.chartValid === false) {
        messageList.add({ role: 'assistant', content: '图表未能生成：返回的图表配置缺失或无效，已停止自动修正。' }, 'response');
      }
      return messageList;
    },
  } satisfies Processor;
}
