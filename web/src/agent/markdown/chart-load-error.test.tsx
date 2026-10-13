import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EChartsBlock } from './EChartsBlock';
import { MermaidBlock } from './MermaidBlock';

vi.mock('echarts', () => { throw new Error('Outdated Optimize Dep'); });
vi.mock('mermaid', () => { throw new Error('Outdated Optimize Dep'); });

afterEach(cleanup);

it('reports an ECharts module load failure instead of blaming valid JSON', async () => {
  render(<EChartsBlock code='{"series":[{"type":"line","data":[1,2]}]}' />);
  expect((await screen.findByRole('alert')).textContent).toContain('图表模块加载失败');
});

it('reports a Mermaid module load failure instead of blaming valid syntax', async () => {
  render(<MermaidBlock code={'flowchart LR\nA --> B'} />);
  expect((await screen.findByRole('alert')).textContent).toContain('流程图模块加载失败');
});
