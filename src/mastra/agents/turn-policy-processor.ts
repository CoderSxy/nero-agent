import type { Processor } from '@mastra/core/processors';
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
    processInputStep({ messages, tools, activeTools, state, requestContext, messageList }) {
      if (!state.policy) {
        const latest = [...messages].reverse().find(m => m.role === 'user' || (m.role === 'signal' && ['user', 'user-message'].includes(m.type ?? '')));
        const text = messageText(latest);
        state.policy = resolveTurnPolicy({ userText: text, hasAttachments: /\[.*附件|attachmentId|附件\s*ID|上传文件/i.test(text), selectedSkillIds: readSelectedSkillIds(requestContext) });
      }
      const policy = state.policy as TurnPolicy;
      if (policy.deliveryMode !== 'inline-chart') return {};
      // Positive allowlist also excludes executable/skill tools that could write HTML indirectly.
      const allowed = (state.repairing ? [] : Object.keys(tools ?? {})).filter(name => INLINE_TOOLS.has(name) && (!activeTools || activeTools.includes(name)));
      return { tools: Object.fromEntries(allowed.map(name => [name, tools![name]])), activeTools: allowed,
        ...(state.repairing ? { toolChoice: 'none' as const } : {}) };
    },
    processLLMRequest({ prompt, state, tracingContext }) {
      const policy = state.policy as TurnPolicy | undefined;
      if (!policy || policy.deliveryMode !== 'inline-chart') return;
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
