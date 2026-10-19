import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { init } from 'echarts';
import { EChartsBlock } from './EChartsBlock';
const mocks = vi.hoisted(() => ({ init: vi.fn(), setOption: vi.fn(), dispose: vi.fn(), resize: vi.fn() }));
vi.mock('echarts', () => ({ init: mocks.init }));
let width = 640;
let notifyResize: (() => void) | undefined;
const disconnect = vi.fn();
const option = '{"xAxis":{},"yAxis":{},"series":[{"type":"line","data":[1,2]}]}';
beforeEach(() => {
  width = 640;
  vi.mocked(init).mockReturnValue({ setOption: mocks.setOption, dispose: mocks.dispose, resize: mocks.resize } as never);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(360);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { notifyResize = callback; }
    observe() {} disconnect = disconnect;
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); notifyResize = undefined; });
it('recovers after a rendering error when corrected source arrives', async () => {
  mocks.setOption.mockImplementationOnce(() => { throw new Error('missing axis'); });
  const view = render(<EChartsBlock code='{"series":[{"type":"line","data":[1]}]}' />);
  expect((await screen.findByRole('alert')).textContent).toContain('渲染失败');
  expect(screen.getByRole('button', { name: '图形' }).getAttribute('aria-pressed')).toBe('false');
  view.rerender(<EChartsBlock code={option} />);
  await waitFor(() => expect(mocks.setOption).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('alert')).toBeNull();
});
it('recovers from parse failure without keeping stale fallback state', async () => {
  const view = render(<EChartsBlock code='{series:' />);
  expect(screen.getByRole('alert').textContent).toContain('格式不正确');
  view.rerender(<EChartsBlock code={option} />);
  await waitFor(() => expect(mocks.setOption).toHaveBeenCalledTimes(1));
});
it('waits for nonzero size, initializes once, and resizes without reapplying options', async () => {
  width = 0;
  render(<EChartsBlock code={option} />);
  await act(async () => { await Promise.resolve(); });
  expect(mocks.init).not.toHaveBeenCalled();
  width = 640;
  act(() => notifyResize?.());
  await waitFor(() => expect(mocks.init).toHaveBeenCalledTimes(1));
  act(() => { notifyResize?.(); window.dispatchEvent(new Event('resize')); });
  expect(mocks.setOption).toHaveBeenCalledTimes(1);
  expect(mocks.resize).toHaveBeenCalled();
});
it('keeps source view on resize and disposes resources on unmount', async () => {
  const view = render(<EChartsBlock code={option} />);
  await waitFor(() => expect(mocks.init).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: '源码' }));
  act(() => { notifyResize?.(); window.dispatchEvent(new Event('resize')); });
  expect(screen.getByRole('button', { name: '源码' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: '图形' }));
  expect(mocks.setOption).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(mocks.dispose).toHaveBeenCalledTimes(1);
  expect(disconnect).toHaveBeenCalled();
});
it('keeps source and copying available on syntax or structure failure', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const source = '{series:[],v:NaN}';
  render(<EChartsBlock code={source} />);
  expect(screen.getByRole('alert').textContent).toContain('NaN');
  fireEvent.click(screen.getByRole('button', { name: '复制源码' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(source));
  expect(screen.getByText(source)).toBeTruthy();
});
it('contains resize callback errors and does not affect other charts', async () => {
  const view = render(<><EChartsBlock code={option} /></>);
  await waitFor(() => expect(mocks.init).toHaveBeenCalledTimes(1));
  view.rerender(<><EChartsBlock code={option} /><EChartsBlock code='{series:[]}' /></>);
  await waitFor(() => expect(mocks.init).toHaveBeenCalledTimes(2));
  mocks.resize.mockImplementationOnce(() => { throw new Error('resize problem'); });
  act(() => window.dispatchEvent(new Event('resize')));
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(screen.getAllByRole('img', { name: 'ECharts 图表' })).toHaveLength(1);
});
it('does not initialize a chart after it was unmounted during module loading', async () => {
  const view = render(<EChartsBlock code={option} />);
  view.unmount();
  await act(async () => { await vi.dynamicImportSettled(); });
  expect(mocks.init).not.toHaveBeenCalled();
});
it('applies only the latest source when options are replaced before loading completes', async () => {
  const view = render(<EChartsBlock code={option} />);
  view.rerender(<EChartsBlock code='{series:[]}' />);
  await act(async () => { await vi.dynamicImportSettled(); });
  expect(mocks.init).toHaveBeenCalledTimes(1);
  expect(mocks.setOption).toHaveBeenCalledWith(expect.objectContaining({ series: [] }));
});
it('waits while source view is selected and initializes on returning to chart', async () => {
  width = 0;
  render(<EChartsBlock code={option} />);
  fireEvent.click(screen.getByRole('button', { name: '源码' }));
  await act(async () => { await vi.dynamicImportSettled(); });
  width = 640;
  act(() => notifyResize?.());
  expect(mocks.init).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '图形' }));
  await waitFor(() => expect(mocks.init).toHaveBeenCalledTimes(1));
});
it('uses the app dark palette and preserves source selection while the theme changes', async () => {
  const originalClass = document.documentElement.className;
  document.documentElement.className = 'dark';
  try {
    render(<EChartsBlock code={option} />);
    await waitFor(() => expect(mocks.init).toHaveBeenCalledTimes(1));
    expect(mocks.init.mock.calls[0][1]).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: '源码' }));
    await act(async () => { document.documentElement.className = 'light'; });
    expect(screen.getByRole('button', { name: '源码' }).getAttribute('aria-pressed')).toBe('true');
    expect(mocks.init).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '图形' }));
    await waitFor(() => expect(mocks.init).toHaveBeenCalledTimes(2));
    expect(mocks.init.mock.calls[1][1]).toBeUndefined();
  } finally { document.documentElement.className = originalClass; }
});
