import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MermaidBlock } from './MermaidBlock';
const engine = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: engine }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('recovers when invalid Mermaid source is replaced and preserves the source view', async () => {
  engine.render.mockRejectedValueOnce(new Error('syntax')).mockResolvedValue({ svg: '<svg><text>A</text></svg>' });
  const view = render(<MermaidBlock code='invalid' />);
  expect((await screen.findByRole('alert')).textContent).toContain('语法无效');
  view.rerender(<MermaidBlock code={'flowchart LR\nA-->B'} />);
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  await waitFor(() => expect(view.container.querySelector('svg')).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: '源码' }));
  expect(view.container.querySelector('.chart-source')?.textContent).toBe('flowchart LR\nA-->B');
  expect(screen.queryByRole('img')).toBeNull();
  expect(engine.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ securityLevel: 'strict' }));
});
