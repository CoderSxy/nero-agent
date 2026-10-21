import type { Processor } from '@mastra/core/processors';
import {isTurnUserMessage} from './turn-messages';
import { decideNextStep, progressFromMessages } from './run-progress';
import { readSelectedSkillIds } from '../skills/execution-context';
import { resolveTurnPolicy, validateInlineChart, type TurnPolicy } from './turn-policy';

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
      if (!state.policy || state.userKey !== userKey) {
        const previous = (state.policy as TurnPolicy | undefined)?.deliveryMode
          ?? ([...messages].reverse().some(m => m.role === 'assistant' && validateInlineChart(messageText(m)).ok) ? 'inline-chart' : undefined);
        state.policy = resolveTurnPolicy({ userText: text, previousDeliveryMode: previous, hasAttachments: /\[.*附件|attachmentId|附件\s*ID|上传文件/i.test(text), selectedSkillIds: readSelectedSkillIds(requestContext) });
        state.userKey = userKey;
        state.repairing = false;
        delete state.chartValid;
      }
      const policy = state.policy as TurnPolicy;
      const decision = decideNextStep(progressFromMessages(messages), policy.deliveryMode === 'inline-chart', stepNumber);
      state.progressDecision = decision;
      if (decision === 'finalize') return { tools: {}, activeTools: [], toolChoice: 'none' as const };
      if (policy.deliveryMode !== 'inline-chart') return {};
      // Positive allowlist also excludes executable/skill tools that could write HTML indirectly.
      const allowed = (state.repairing ? [] : Object.keys(tools ?? {})).filter(name => INLINE_TOOLS.has(name) && (!activeTools || activeTools.includes(name)));
      return { tools: Object.fromEntries(allowed.map(name => [name, tools![name]])), activeTools: allowed,
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
      const content = `${TAG}\n本轮交付：会话内 ECharts 图表。只取数、核对并输出严格 JSON 的 echarts 围栏，附来源与日期范围；不创建或编辑文件，不手算 SVG 布局。${state.repairing ? '这是唯一一次修正：复用已有数据，禁止调用工具。数据不足就明确说明，不能编造。' : ''}\n</turn-delivery-v1>`;
      tracingContext?.currentSpan?.update({ metadata: { deliveryMode: policy.deliveryMode, deliveryPolicyVersion: '1' } });
      return { prompt: [...prompt.filter(m => !(m.role === 'system' && m.content.startsWith(TAG))), { role: 'system' as const, content }] };
    },
    async processOutputStep({ text, toolCalls, state, abort, writer, messageList }) {
      if ((state.policy as TurnPolicy | undefined)?.deliveryMode !== 'inline-chart' || toolCalls?.length) return messageList;
      const validation = validateInlineChart(text ?? '');
      if (!validation.ok && !state.repairing) {
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
