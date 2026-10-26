import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HistoryTurnShell } from './HistoryTurnShell';

describe('HistoryTurnShell', () => {
  it('keeps pinned turns mounted and falls back without IntersectionObserver', () => {
    const original = globalThis.IntersectionObserver;
    // @ts-expect-error test override
    delete globalThis.IntersectionObserver;
    render(
      <HistoryTurnShell turnId="t1" pinned>
        <span>pinned-body</span>
      </HistoryTurnShell>,
    );
    expect(screen.getByText('pinned-body')).toBeTruthy();
    globalThis.IntersectionObserver = original;
  });

  it('unmounts offscreen content when observer reports not intersecting', () => {
    let callback: IntersectionObserverCallback = () => undefined;
    class FakeObserver {
      constructor(cb: IntersectionObserverCallback) {
        callback = cb;
      }
      observe() {
        callback([{ isIntersecting: false } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = '';
      thresholds = [];
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    render(
      <HistoryTurnShell turnId="t2">
        <span>body</span>
      </HistoryTurnShell>,
    );
    expect(screen.queryByText('body')).toBeNull();
    vi.unstubAllGlobals();
  });
});
