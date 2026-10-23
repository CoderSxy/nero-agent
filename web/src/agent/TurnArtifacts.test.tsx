import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnArtifacts } from './TurnArtifacts';
import type { TurnArtifacts as TurnArtifactsValue } from './turn-artifacts';

const ETAG = '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"';

function value(overrides: Partial<TurnArtifactsValue> = {}): TurnArtifactsValue {
  return {
    version: 1,
    runId: 'run-1',
    threadId: 't1',
    revision: 1,
    state: 'completed',
    collectionStatus: 'complete',
    anchorMessageId: 'm1',
    artifacts: [
      { path: 'a/one.txt', source: 'personal', name: 'one.txt', change: 'created', size: 1, etag: ETAG },
      { path: 'b/two.txt', source: 'personal', name: 'two.txt', change: 'updated', size: 2, etag: ETAG },
      { path: 'c/three.txt', source: 'personal', name: 'three.txt', change: 'created', size: 3, etag: ETAG },
      { path: 'd/four.txt', source: 'personal', name: 'four.txt', change: 'created', size: 4, etag: ETAG },
    ],
    ...overrides,
  };
}

afterEach(cleanup);

describe('TurnArtifacts', () => {
  it('shows three items by default and expands the rest', () => {
    const onOpen = vi.fn();
    render(<TurnArtifacts value={value()} onOpenArtifact={onOpen} />);
    expect(screen.getByText('本轮产物 · 4 个文件')).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开 a/one.txt' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '打开 d/four.txt' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开其余 1 个' }));
    expect(screen.getByRole('button', { name: '打开 d/four.txt' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(screen.queryByRole('button', { name: '打开 d/four.txt' })).toBeNull();
  });

  it('disambiguates same names and opens via keyboard', () => {
    const onOpen = vi.fn();
    render(<TurnArtifacts value={value({
      artifacts: [
        { path: 'a/report.txt', source: 'personal', name: 'report.txt', change: 'created', size: 1, etag: ETAG },
        { path: 'b/report.txt', source: 'personal', name: 'report.txt', change: 'updated', size: 2, etag: ETAG },
      ],
    })} onOpenArtifact={onOpen} />);
    expect(screen.getByText(/· a/)).toBeTruthy();
    expect(screen.getByText(/· b/)).toBeTruthy();
    const button = screen.getByRole('button', { name: '打开 a/report.txt' });
    expect(button.getAttribute('title')).toBe('a/report.txt');
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ path: 'a/report.txt' }));
  });

  it('hides complete empty lists and shows partial hint', () => {
    const { rerender } = render(<TurnArtifacts value={value({ artifacts: [] })} onOpenArtifact={vi.fn()} />);
    expect(screen.queryByText(/本轮产物/)).toBeNull();
    rerender(<TurnArtifacts value={value({
      artifacts: [],
      collectionStatus: 'partial',
    })} onOpenArtifact={vi.fn()} />);
    expect(screen.getByText('部分文件未完成采集')).toBeTruthy();
  });

  it('uses retained-file title for failed turns', () => {
    render(<TurnArtifacts value={value({ state: 'failed', artifacts: value().artifacts.slice(0, 1) })}
      onOpenArtifact={vi.fn()} />);
    expect(screen.getByText('本轮保留文件 · 1 个文件')).toBeTruthy();
  });

  it('hides running and suspended lists', () => {
    const { rerender } = render(<TurnArtifacts value={value({ state: 'running' })} onOpenArtifact={vi.fn()} />);
    expect(screen.queryByText(/本轮/)).toBeNull();
    rerender(<TurnArtifacts value={value({ state: 'suspended' })} onOpenArtifact={vi.fn()} />);
    expect(screen.queryByText(/本轮/)).toBeNull();
  });
});
