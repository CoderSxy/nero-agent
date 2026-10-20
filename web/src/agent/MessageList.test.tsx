import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MessageList } from './MessageList';

const styles = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../styles.css'), 'utf8');
const fetchWorkspaceFile = vi.hoisted(() => vi.fn());
vi.mock('./client', () => ({
  fetchWorkspaceFile: (...args: unknown[]) => fetchWorkspaceFile(...args),
}));

beforeAll(() => vi.stubGlobal('PointerEvent', MouseEvent));
afterAll(() => vi.unstubAllGlobals());
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const pendingMessage = { id: 'a', role: 'assistant', content: { format: 2, parts: [
  { type: 'text', text: '正在执行' },
  { type: 'tool-invocation', toolInvocation: { state: 'approval-requested', toolCallId: 'tool-1', toolName: 'search', args: { query: 'hello' } } },
] } };

describe('message anchors', () => {
  it('renders persisted message ids on each message row', () => {
    const messages = [
      { id: 'user/1', role: 'user', content: { format: 2, parts: [{ type: 'text', text: '问题' }] } },
      { id: 'msg?id=2', role: 'assistant', content: { format: 2, parts: [{ type: 'text', text: '回答' }] } },
    ];
    const { container } = render(<MessageList messages={messages as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    const anchors = [...container.querySelectorAll('[data-message-id]')];
    expect(anchors.map(node => node.getAttribute('data-message-id'))).toEqual(['user/1', 'msg?id=2']);
  });
});

describe('message actions', () => {
  it('shows copy, the recorded model, and local time below a completed answer', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const message = { id: 'answer', role: 'assistant', createdAt: new Date(2026, 9, 16, 9, 30),
      content: { format: 2, parts: [
        { type: 'step-start', model: 'openai/gpt-5' },
        { type: 'text', text: '**第一段**' },
        { type: 'text', text: '第二段' },
      ] } };
    render(<MessageList messages={[message] as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    const actions = screen.getByRole('group', { name: '回复操作' });
    expect(actions.textContent).toContain('openai/gpt-5');
    expect(actions.textContent).toContain('09:30');
    fireEvent.click(screen.getByRole('button', { name: '复制消息' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('**第一段**\n\n第二段'));
    expect(screen.getByText('已复制')).toBeTruthy();
  });

  it('hides reply actions while streaming and omits a model when none was recorded', () => {
    const message = { id: 'answer', role: 'assistant', createdAt: new Date(2026, 9, 16, 9, 30),
      content: { format: 2, parts: [{ type: 'text', text: '部分回复' }] } };
    const props = { error: null, onApprove: vi.fn(), onDecline: vi.fn(), onAnswer: vi.fn() };
    const view = render(<MessageList messages={[message] as never} isRunning {...props} />);
    expect(screen.queryByRole('group', { name: '回复操作' })).toBeNull();
    view.rerender(<MessageList messages={[message] as never} isRunning={false} {...props} />);
    const actions = screen.getByRole('group', { name: '回复操作' });
    expect(actions.textContent).toContain('09:30');
    expect(actions.querySelector('.message-model-name')).toBeNull();
  });

  it('formats reply time like datax for today, recent days, and older messages', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 16, 12));
    try {
      const messages = [
        { id: 'today', role: 'assistant', createdAt: new Date(2026, 9, 16, 9, 58),
          content: { format: 2, parts: [{ type: 'text', text: '今天' }] } },
        { id: 'yesterday', role: 'assistant', createdAt: new Date(2026, 9, 15, 21, 2),
          content: { format: 2, parts: [{ type: 'text', text: '昨天' }] } },
        { id: 'older', role: 'assistant', createdAt: new Date(2026, 9, 1, 9, 58),
          content: { format: 2, parts: [{ type: 'text', text: '较早' }] } },
      ];
      const { container } = render(<MessageList messages={messages as never} isRunning={false} error={null}
        onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
      const time = (id: string) => container.querySelector(`[data-message-id="${id}"] .message-time`)?.textContent;
      expect(time('today')).toBe('09:58');
      expect(time('yesterday')).toBe('周四 21:02');
      expect(time('older')).toBe('10月1日 09:58');
    } finally { vi.useRealTimers(); }
  });

  it('uses a recorded model from the same turn when the final text is a separate message', () => {
    const messages = [
      { id: 'user', role: 'user', content: { format: 2, parts: [{ type: 'text', text: '问题' }] } },
      { id: 'process', role: 'assistant', content: { format: 2, parts: [
        { type: 'step-start', model: 'workbuddy.chat/kimi-k3-1' },
        { type: 'reasoning', reasoning: '分析中', state: 'done' },
      ] } },
      { id: 'answer', role: 'assistant', content: { format: 2, parts: [{ type: 'text', text: '回答' }] } },
    ];
    const { container } = render(<MessageList messages={messages as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(container.querySelector('[data-message-id="answer"] .message-model-name')?.textContent)
      .toBe('workbuddy.chat/kimi-k3-1');
    expect(container.querySelector('[data-message-id="process"] .message-actions')).toBeNull();
  });
});

describe('message tools and stream state', () => {
  it('places a saved process-only message before the answer from the same turn', () => {
    const messages = [
      { id: 'user', role: 'user', content: { format: 2, parts: [{ type: 'text', text: '苏州天气' }] } },
      { id: 'answer', role: 'assistant', content: { format: 2, parts: [{ type: 'text', text: '今天多云' }] } },
      { id: 'process', role: 'assistant', content: { format: 2, parts: [
        { type: 'reasoning', reasoning: '核对天气数据', state: 'done' },
      ] } },
    ];
    const { container } = render(<MessageList messages={messages as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect([...container.querySelectorAll('[data-message-id]')].map(node => node.getAttribute('data-message-id')))
      .toEqual(['user', 'process', 'answer']);
  });
  it('turns a completed JSON chart fence into a chart and switches both ways', async () => {
    const option = '{"xAxis":{"type":"category","data":["周一","周二"]},"yAxis":{"type":"value"},"series":[{"type":"line","data":[26,28]}]}';
    const text = (end: string) => `趋势如下：\n\n\`\`\`json\n${option}${end}\n\n最高温先升后降。`;
    const message = (value: string) => ({ id: 'json-chart', role: 'assistant', content: { format: 2, parts: [
      { type: 'text', text: value },
    ] } });
    const props = { isRunning: true, error: null, onApprove: vi.fn(), onDecline: vi.fn(), onAnswer: vi.fn() };
    const view = render(<MessageList messages={[message(text(''))] as never} {...props} />);
    expect(view.container.querySelector('[data-chart="echarts"]')).toBeNull();
    view.rerender(<MessageList messages={[message(text('\n```'))] as never} {...props} />);
    expect(await screen.findByRole('img', { name: 'ECharts 图表' })).toBeTruthy();
    expect(screen.getByText('最高温先升后降。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '源码' }));
    expect(screen.getByText(option)).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'ECharts 图表' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '图形' }));
    expect(screen.getByRole('img', { name: 'ECharts 图表' })).toBeTruthy();
  });

  it('renders a completed JSON5 chart with a single series in the message body', async () => {
    const source = "{xAxis:{type:'category',data:['一月','二月']},yAxis:{type:'value'},series:{type:'line',data:[1,2]},}";
    const message = { id: 'single-series-chart', role: 'assistant', content: { format: 2, parts: [
      { type: 'text', text: `趋势如下：\n\n\`\`\`json\n${source}\n\`\`\`\n\n说明文字。` },
    ] } };
    render(<MessageList messages={[message] as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(await screen.findByRole('img', { name: 'ECharts 图表' })).toBeTruthy();
    expect(screen.getByText('说明文字。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '源码' }));
    expect(screen.getByText(source)).toBeTruthy();
  });
  it('keeps ordinary JSON as code', () => {
    const message = { id: 'plain-json', role: 'assistant', content: { format: 2, parts: [
      { type: 'text', text: '```json\n{"series":[{"name":"记录","data":[1,2]}]}\n```' },
    ] } };
    const view = render(<MessageList messages={[message] as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(view.container.querySelector('[data-chart="echarts"]')).toBeNull();
    expect(view.container.textContent).toContain('"series"');
  });

  it('shows an unfinished ECharts fence as code until the closing marker arrives', () => {
    const unfinished = { id: 'chart', role: 'assistant', content: { format: 2, parts: [
      { type: 'text', text: '```echarts\n{"series":[{"type":"bar","data":[2,3]}]}' },
    ] } };
    const props = { isRunning: true, error: null, onApprove: vi.fn(), onDecline: vi.fn(), onAnswer: vi.fn() };
    const view = render(<MessageList messages={[unfinished] as never} {...props} />);
    expect(view.container.querySelector('[data-chart="echarts"]')).toBeNull();
    expect(view.container.textContent).toContain('"series"');

    const finished = { ...unfinished, content: { format: 2, parts: [
      { type: 'text', text: '```echarts\n{"series":[{"type":"bar","data":[2,3]}]}\n```' },
    ] } };
    view.rerender(<MessageList messages={[finished] as never} {...props} />);
    expect(view.container.querySelector('[data-chart="echarts"]')).toBeTruthy();
  });

  it('renders a completed Mermaid fence as a diagram', async () => {
    const originalMeasure = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'getComputedTextLength');
    const originalBox = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'getBBox');
    Object.defineProperty(SVGElement.prototype, 'getComputedTextLength', { configurable: true, value: () => 80 });
    Object.defineProperty(SVGElement.prototype, 'getBBox', {
      configurable: true, value: () => ({ x: 0, y: 0, width: 80, height: 20 }),
    });
    const message = { id: 'diagram', role: 'assistant', content: { format: 2, parts: [
      { type: 'text', text: '```mermaid\nflowchart LR\nA --> B\n```' },
    ] } };
    try {
      const view = render(<MessageList messages={[message] as never} isRunning={false} error={null}
        onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
      expect(await screen.findByRole('img', { name: 'Mermaid 流程图' })).toBeTruthy();
      await waitFor(() => expect(view.container.querySelector('.agent-chart__diagram svg')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: '源码' }));
      expect(view.container.querySelector('.chart-source')?.textContent).toBe('flowchart LR\nA --> B');
      expect(screen.queryByRole('img', { name: 'Mermaid 流程图' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '图形' }));
      expect(screen.getByRole('img', { name: 'Mermaid 流程图' })).toBeTruthy();
    } finally {
      if (originalMeasure) Object.defineProperty(SVGElement.prototype, 'getComputedTextLength', originalMeasure);
      else Reflect.deleteProperty(SVGElement.prototype, 'getComputedTextLength');
      if (originalBox) Object.defineProperty(SVGElement.prototype, 'getBBox', originalBox);
      else Reflect.deleteProperty(SVGElement.prototype, 'getBBox');
    }
  });
  it('shows invalid ECharts content as source without executing it', () => {
    const marker = '__nero_chart_side_effect__';
    const message = { id: 'unsafe-chart', role: 'assistant', content: { format: 2, parts: [
      { type: 'text', text: `\`\`\`echarts\n(()=>{globalThis.${marker}=true;return {}})()\n\`\`\`` },
    ] } };
    const view = render(<MessageList messages={[message] as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(view.container.querySelector('[data-chart="echarts"]')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('图表配置格式不正确');
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });
  it('shows live reasoning and a bordered running process', () => {
    const message = { id: 'live', role: 'assistant', content: { format: 2, parts: [
      { type: 'reasoning', reasoning: '正在规划搜索', state: 'streaming' },
      { type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: 'search', toolName: 'tavily_search', args: { query: '苏州天气' } } },
    ] } };
    const { container } = render(<MessageList messages={[message] as never} isRunning error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(screen.getByText('Reasoning')).toBeTruthy();
    expect(screen.getByText('正在规划搜索')).toBeTruthy();
    expect(screen.getByText('苏州天气')).toBeTruthy();
    expect(container.querySelector('.process-message--running')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('正在处理');
  });
  it('keeps a wide streamed table inside the running process frame', () => {
    const table = [
      '| 口径 | 来源 | 换算 | 100 积分 ≈ |',
      '|---|---|---|---|',
      '| 公认换算参考 | 腾讯云开发者社区文章（2026-07-31，多方测试+官方文档验证） | 1 积分 ≈ 31,874 Token | 约 319 万 Token |',
    ].join('\n');
    const message = { id: 'table', role: 'assistant', content: { format: 2, parts: [
      { type: 'reasoning', reasoning: '先核对积分口径', state: 'done' },
      { type: 'text', text: `结论如下：\n\n${table}\n` },
    ] } };
    const { container } = render(<MessageList messages={[message] as never} isRunning error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    const frame = container.querySelector('.process-message--running');
    expect(frame?.querySelector('table')).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(styles).toMatch(/\.process-message \{[^}]*overflow-x: auto/);
    expect(styles).toMatch(/grid-template-columns: minmax\(0, 1fr\)/);
    expect(styles).toMatch(/\.message-list \.mastra-markdown :is\(th, td\) \{[^}]*overflow-wrap: anywhere/);
  });
  it('shows an observing badge only for an observation marker', () => {
    const message = { id: 'observing', role: 'assistant', content: { format: 2, parts: [
      { type: 'data-om-observation-start', data: { tokensToObserve: 42600 } },
    ] } };
    render(<MessageList messages={[message] as never} isRunning error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(screen.getByText('Observing ~42.6k tokens')).toBeTruthy();
    expect(screen.queryByText('正在处理…')).toBeNull();
  });
  it('shows one expandable completed observation with Studio details', () => {
    const message = { id: 'observed', role: 'assistant', content: { format: 2, parts: [
      { type: 'data-om-observation-start', data: { cycleId: 'c1', tokensToObserve: 93500 } },
      { type: 'data-om-observation-end', data: { cycleId: 'c1', completedAt: '2026-10-09T06:47:00Z',
        tokensObserved: 93500, observationTokens: 382, durationMs: 29700,
        observations: 'Date: Oct 9, 2026\n* 🟢 (14:47) Research summary',
        currentTask: 'Continue research', suggestedResponse: 'Answer concisely' } },
    ] } };
    const { container } = render(<MessageList messages={[message] as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(container.querySelectorAll('[data-om-badge="c1"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Observed 93\.5k→382 tokens/ }));
    expect(screen.getByText('Input: 93.5k')).toBeTruthy();
    expect(screen.getByText('Output: 382')).toBeTruthy();
    expect(screen.getByText('Compression: 245x')).toBeTruthy();
    expect(screen.getByText('Duration:')).toBeTruthy();
    expect(screen.getByText('Research summary')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Observations' }));
    expect(screen.queryByText('Research summary')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Current Task' }));
    expect(screen.getByText('Continue research')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Suggested Response' }));
    expect(screen.getByText('Answer concisely')).toBeTruthy();
  });
  it('shows a buffered observation from saved messages with its expandable contents', () => {
    const messages = [
      { id: 'buffer-start', role: 'assistant', content: { format: 2, parts: [
        { type: 'data-om-buffering-start', data: { cycleId: 'buffer-1', operationType: 'observation', tokensToBuffer: 14700 } },
      ] } },
      { id: 'buffer-end', role: 'assistant', content: { format: 2, parts: [
        { type: 'data-om-buffering-end', data: { cycleId: 'buffer-1', operationType: 'observation',
          tokensBuffered: 14700, bufferedTokens: 272,
          observations: 'Date: Oct 15, 2026\n* 🟢 (16:17) User asked about Suzhou weather' } },
      ] } },
    ];
    const { container } = render(<MessageList messages={messages as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(container.querySelectorAll('[data-om-badge="buffer-1"]')).toHaveLength(1);
    expect(container.querySelector('[data-om-state="buffering-complete"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Buffered observations 14\.7k→272 tokens/ }));
    expect(screen.getByText('User asked about Suzhou weather')).toBeTruthy();
  });
  it('shows buffering progress and failure without leaving a stale progress marker', () => {
    const start = { id: 'buffer-start', role: 'assistant', content: { format: 2, parts: [
      { type: 'data-om-buffering-start', data: { cycleId: 'buffer-2', operationType: 'reflection', tokensToBuffer: 2000 } },
    ] } };
    const props = { isRunning: true, error: null, onApprove: vi.fn(), onDecline: vi.fn(), onAnswer: vi.fn() };
    const view = render(<MessageList messages={[start] as never} {...props} />);
    expect(screen.getByText('Buffering reflection ~2.0k tokens')).toBeTruthy();
    view.rerender(<MessageList messages={[start, { id: 'buffer-failed', role: 'assistant', content: { format: 2, parts: [
      { type: 'data-om-buffering-failed', data: { cycleId: 'buffer-2', operationType: 'reflection', error: 'model unavailable' } },
    ] } }] as never} {...props} isRunning={false} />);
    expect(view.container.querySelectorAll('[data-om-badge="buffer-2"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Buffered reflection failed' }));
    expect(screen.getByText('model unavailable')).toBeTruthy();
  });
  it('does not leave an orphan buffering spinner in a completed conversation', () => {
    const message = { id: 'orphan', role: 'assistant', content: { format: 2, parts: [
      { type: 'data-om-buffering-start', data: { cycleId: 'orphan-1', operationType: 'observation', tokensToBuffer: 6800 } },
      { type: 'text', text: '已经完成的回答' },
    ] } };
    const props = { error: null, onApprove: vi.fn(), onDecline: vi.fn(), onAnswer: vi.fn() };
    const view = render(<MessageList messages={[message] as never} isRunning {...props} />);
    expect(screen.getByText('Buffering observations ~6.8k tokens')).toBeTruthy();
    view.rerender(<MessageList messages={[message] as never} isRunning={false} {...props} />);
    expect(screen.queryByText('Buffering observations ~6.8k tokens')).toBeNull();
    expect(screen.getByText('已经完成的回答')).toBeTruthy();
  });
  it('hides an old orphan spinner while another turn is running', () => {
    const messages = [
      { id: 'old', role: 'assistant', content: { format: 2, parts: [
        { type: 'data-om-buffering-start', data: { cycleId: 'old-cycle', tokensToBuffer: 6800 } },
      ] } },
      { id: 'new-user', role: 'user', content: { format: 2, parts: [{ type: 'text', text: '新问题' }] } },
      { id: 'new', role: 'assistant', content: { format: 2, parts: [
        { type: 'data-om-buffering-start', data: { cycleId: 'new-cycle', tokensToBuffer: 2000 } },
      ] } },
    ];
    const { container } = render(<MessageList messages={messages as never} isRunning error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(container.querySelector('[data-om-badge="old-cycle"]')).toBeNull();
    expect(container.querySelector('[data-om-badge="new-cycle"]')).toBeTruthy();
  });
  it('shows plain buffered observations instead of an empty detail panel', () => {
    const message = { id: 'plain-buffer', role: 'assistant', content: { format: 2, parts: [
      { type: 'data-om-buffering-end', data: { cycleId: 'plain-buffer', operationType: 'observation',
        tokensBuffered: 9000, bufferedTokens: 363, observations: '<observations>用户想要秋季旅行建议</observations>' } },
    ] } };
    render(<MessageList messages={[message] as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Buffered observations 9\.0k→363 tokens/ }));
    expect(screen.getByText('用户想要秋季旅行建议')).toBeTruthy();
    expect(screen.queryByText('No observations')).toBeNull();
  });
  it('omits a completed buffering marker with no visible observations', () => {
    const message = { id: 'empty-buffer', role: 'assistant', content: { format: 2, parts: [
      { type: 'data-om-buffering-end', data: { cycleId: 'empty-buffer', operationType: 'observation',
        tokensBuffered: 9000, bufferedTokens: 363, observations: '   ' } },
      { type: 'text', text: '最终回答' },
    ] } };
    const { container } = render(<MessageList messages={[message] as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(container.querySelector('[data-om-badge="empty-buffer"]')).toBeNull();
    expect(screen.getByText('最终回答')).toBeTruthy();
  });
  it('shows activated observations and failed synchronous observations', () => {
    const messages = [
      { id: 'activated', role: 'assistant', content: { format: 2, parts: [
        { type: 'data-om-activation', data: { cycleId: 'activation-1', operationType: 'observation',
          tokensActivated: 14700, observationTokens: 272,
          observations: 'Date: Oct 15, 2026\n* 🟢 (16:17) Activated weather notes' } },
      ] } },
      { id: 'failed', role: 'assistant', content: { format: 2, parts: [
        { type: 'data-om-observation-failed', data: { cycleId: 'failed-1', operationType: 'reflection', error: 'reflection failed' } },
      ] } },
    ];
    const { container } = render(<MessageList messages={messages as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(container.querySelector('[data-om-badge="activation-1"][data-om-state="activated"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Observed 14\.7k→272 tokens/ }));
    expect(screen.getByText('Activated weather notes')).toBeTruthy();
    expect(screen.getByText('reflection failed')).toBeTruthy();
  });
  it('deduplicates a cycle when start and end are saved in separate messages', () => {
    const messages = [
      { id: 'start', role: 'assistant', content: { format: 2, parts: [
        { type: 'data-om-observation-start', data: { cycleId: 'c2', tokensToObserve: 12000 } },
      ] } },
      { id: 'end', role: 'assistant', content: { format: 2, parts: [
        { type: 'data-om-observation-end', data: { cycleId: 'c2', tokensObserved: 12000,
          observationTokens: 300, durationMs: 2000 } },
      ] } },
    ];
    const { container } = render(<MessageList messages={messages as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(container.querySelectorAll('[data-om-badge="c2"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-from="assistant"]')).toHaveLength(1);
  });
  it('expands extracted values and failures in the Studio badge', () => {
    const message = { id: 'extracted', role: 'assistant', content: { format: 2, parts: [
      { type: 'data-om-observation-end', data: { cycleId: 'c3', tokensObserved: 1000,
        observationTokens: 100, extractedValues: { score: 42 },
        extractionFailures: [{ slug: 'summary', error: 'unavailable' }] } },
    ] } };
    render(<MessageList messages={[message] as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Extractions \(1\).*1 failed/ }));
    expect(screen.getByText('score')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('unavailable')).toBeTruthy();
  });
  it('renders a saved user signal as a user bubble', () => {
    const signal = { id: 'signal-1', role: 'signal', type: 'user', content: { format: 2,
      metadata: { signal: { type: 'user' } }, parts: [{ type: 'text', text: '刚发送的消息' }] } };
    render(<MessageList messages={[signal] as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(screen.getByText('刚发送的消息').closest('[data-from]')?.getAttribute('data-from')).toBe('user');
  });
  it('renders a suspended ask_user as choices and submits the selected answer', async () => {
    const answer = vi.fn().mockResolvedValue(undefined);
    const message = { id: 'question', role: 'assistant', content: { format: 2, metadata: {
      mode: 'stream', suspendedTools: { ask_user: { toolCallId: 'ask-1', suspendPayload: {
        question: '采用哪种语言？', selectionMode: 'single_select', options: [
          { label: 'Python', description: '提供 Python 示例' }, { label: 'JavaScript', description: '提供 JS 示例' },
        ],
      } } },
    }, parts: [{ type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: 'ask-1',
      toolName: 'ask_user', args: { question: '采用哪种语言？' } } }] } };
    render(<MessageList messages={[message] as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={answer} />);
    expect(screen.getByText('采用哪种语言？')).toBeTruthy();
    expect(screen.getByText('提供 Python 示例')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /批准|Approve/i })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Python/ }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith('ask-1', 'Python'));
  });

  it('submits free-text and multi-select ask_user answers in their expected shapes', async () => {
    const answer = vi.fn().mockResolvedValue(undefined);
    const makeMessage = (id: string, payload: unknown) => ({ id, role: 'assistant', content: { format: 2,
      metadata: { mode: 'stream', suspendedTools: { ask_user: { toolCallId: id, suspendPayload: payload } } },
      parts: [{ type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: id,
        toolName: 'ask_user', args: payload } }],
    } });
    const { rerender } = render(<MessageList messages={[makeMessage('free', { question: '补充说明？' })] as never}
      isRunning={false} error={null} onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={answer} />);
    fireEvent.change(screen.getByRole('textbox', { name: '补充说明？' }), { target: { value: '  详细一点  ' } });
    fireEvent.click(screen.getByRole('button', { name: /提交|Submit answer/i }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith('free', '详细一点'));
    rerender(<MessageList messages={[makeMessage('multi', { question: '选择内容', selectionMode: 'multi_select',
      options: [{ label: '示例' }, { label: '测试' }] })] as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={answer} />);
    fireEvent.click(screen.getByRole('checkbox', { name: '示例' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '测试' }));
    fireEvent.click(screen.getByRole('button', { name: /提交|Submit answer/i }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith('multi', ['示例', '测试']));
  });

  it('does not mistake another suspended tool for an approval', () => {
    const message = { id: 'suspended', role: 'assistant', content: { format: 2,
      metadata: { mode: 'stream', suspendedTools: { custom_tool: { toolCallId: 'custom-1', suspendPayload: {
        reason: 'waiting',
      } } } }, parts: [{ type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: 'custom-1',
        toolName: 'custom_tool', args: { input: 'x' } } }],
    } };
    render(<MessageList messages={[message] as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /批准|Approve/i })).toBeNull();
    expect(screen.getByText(/已暂停/)).toBeTruthy();
  });
  it('waits for ask_user to suspend before offering its answer form', () => {
    const message = { id: 'running-question', role: 'assistant', content: { format: 2, parts: [
      { type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: 'ask-2', toolName: 'ask_user',
        args: { question: '请选择语言', options: [{ label: 'Python' }] } } },
    ] } };
    render(<MessageList messages={[message] as never} isRunning error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(screen.queryByText('请选择语言')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('does not offer an answer for an unfinished ask_user call without suspension data', () => {
    const message = { id: 'unfinished-question', role: 'assistant', content: { format: 2, parts: [
      { type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: 'ask-4', toolName: 'ask_user',
        args: { question: '选择语言', options: [{ label: 'Python' }] } } },
    ] } };
    render(<MessageList messages={[message] as never} isRunning={false} error="连接中断"
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('restores a real approval from message metadata after remount', () => {
    const message = { id: 'approval', role: 'assistant', content: { format: 2,
      metadata: { mode: 'stream', requireApprovalMetadata: { 'tool-2': {
        toolCallId: 'tool-2', toolName: 'execute_command', args: { command: 'pwd' },
      } } }, parts: [{ type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: 'tool-2',
        toolName: 'execute_command', args: { command: 'pwd' } } }],
    } };
    render(<MessageList messages={[message] as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(screen.getByRole('button', { name: /批准|Approve/i })).toBeTruthy();
  });

  it('shows the answered ask_user question from history without asking again', () => {
    const message = { id: 'answered', role: 'assistant', content: { format: 2, parts: [
      { type: 'tool-invocation', toolInvocation: { state: 'result', toolCallId: 'ask-3', toolName: 'ask_user',
        args: { question: '选择语言', options: [{ label: 'Python' }] },
        result: { content: 'User answered: Python', isError: false } } },
    ] } };
    render(<MessageList messages={[message] as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(screen.getByText('选择语言')).toBeTruthy();
    expect(screen.getByText('User answered: Python')).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
  });
  it('keeps partial text and displays an unfinished error', () => {
    render(<MessageList messages={[pendingMessage] as never} isRunning={false} error="连接断开"
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(screen.getByText('正在执行')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('回复未完成');
  });
  it('submits an approval once while pending', async () => {
    let resolve!: () => void;
    const approve = vi.fn(() => new Promise<void>(done => { resolve = done; }));
    render(<MessageList messages={[pendingMessage] as never} isRunning={false} error={null}
      onApprove={approve} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    const button = screen.getByRole('button', { name: /批准|Approve/i });
    fireEvent.click(button); fireEvent.click(button);
    expect(approve).toHaveBeenCalledTimes(1);
    resolve();
  });
  it('does not offer approval for an ordinary running tool', () => {
    const message = { ...pendingMessage, content: { ...pendingMessage.content, parts: [
      { type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: 'tool-1', toolName: 'search', args: {} } },
    ] } };
    render(<MessageList messages={[message] as never} isRunning={true} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /批准|Approve/i })).toBeNull();
  });
  it('allows a retry when the approval API fails', async () => {
    const approve = vi.fn().mockRejectedValue(new Error('network error'));
    render(<MessageList messages={[pendingMessage] as never} isRunning={false} error={null}
      onApprove={approve} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    const button = screen.getByRole('button', { name: /批准|Approve/i });
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    fireEvent.click(button);
    expect(approve).toHaveBeenCalledTimes(2);
  });

  it('renders history attachment cards by ids in text when Mastra renames message.id', async () => {
    fetchWorkspaceFile.mockResolvedValue(new Blob(['img'], { type: 'image/png' }));
    const createObjectURL = vi.fn(() => 'blob:history-shot');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const agentText = [
      '请看图',
      '',
      '[[nero-attachments]]',
      'id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa|name=shot.png|mime=image/png',
      '[[/nero-attachments]]',
    ].join('\n');
    // message.id ≠ prepare clientMessageId (Mastra client-set-* / server id after reload).
    const message = { id: 'client-set-renamed', role: 'user', content: { format: 2, parts: [{ type: 'text', text: agentText }] } };
    const attachments = [{
      attachmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      clientMessageId: 'pending-1',
      source: 'personal' as const,
      path: 'uploads/u1/shot.png',
      name: 'shot.png',
      size: 4,
      mimeType: 'image/png',
      etag: 'e1',
      status: 'available' as const,
    }];
    const { unmount } = render(<MessageList messages={[message] as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()}
      threadAttachments={attachments} />);
    expect(screen.getByText('请看图')).toBeTruthy();
    expect(screen.queryByText(/nero-attachments/)).toBeNull();
    expect(screen.queryByText(/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/)).toBeNull();
    expect(await screen.findByLabelText('附件 shot.png')).toBeTruthy();
    unmount();
    expect(revokeObjectURL).toHaveBeenCalled();
  });

  it('shows changed and deleted attachment statuses as non-interactive cards', () => {
    const message = { id: 'pending-2', role: 'user', content: { format: 2, parts: [{ type: 'text', text: '文件' }] } };
    const attachments = [
      {
        attachmentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        clientMessageId: 'pending-2',
        source: 'personal' as const, path: 'docs/a.txt', name: 'a.txt',
        size: 3, mimeType: 'text/plain', etag: 'e1', status: 'changed' as const,
      },
      {
        attachmentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        clientMessageId: 'pending-2',
        source: 'personal' as const, path: 'docs/gone.txt', name: 'gone.txt',
        size: 3, mimeType: 'text/plain', etag: 'e2', status: 'deleted' as const,
      },
    ];
    render(<MessageList messages={[message] as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()}
      threadAttachments={attachments} />);
    expect(screen.getByText('文件已更新')).toBeTruthy();
    expect(screen.getByText('文件已删除')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /预览 gone|打开 gone/ })).toBeNull();
  });

  it('shows a failed explicit skill load without treating it as success', () => {
    const hash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const message = { id: 'skills', role: 'assistant', content: { format: 2,
      metadata: { neroSkillActivations: [
        { serverExecutionId: 'exec-1', skillId: 'skill-1', name: 'checklist', version: 3,
          manifestHash: hash, status: 'failed', errorCode: 'SKILL_NOT_FOUND' },
      ] },
      parts: [{ type: 'text', text: '未能加载技能' }],
    } };
    render(<MessageList messages={[message] as never} isRunning={false} error={null}
      onApprove={vi.fn()} onDecline={vi.fn()} onAnswer={vi.fn()} />);
    const badges = screen.getByRole('list', { name: '技能加载结果' });
    expect(badges.textContent).toContain('加载失败');
    expect(badges.textContent).toContain('checklist');
    expect(badges.textContent).toContain('v3');
    expect(badges.textContent).toContain('01234567');
    expect(badges.textContent).toContain('SKILL_NOT_FOUND');
    expect(badges.textContent).not.toContain('已加载');
    expect(screen.queryByText('/Users/')).toBeNull();
  });
});
