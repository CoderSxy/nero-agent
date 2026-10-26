import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DeferredHistoryText, HISTORY_TEXT_PREVIEW_CHARS } from './DeferredHistoryText';

describe('DeferredHistoryText', () => {
  it('shows a plain preview until expanded', () => {
    const renderFull = vi.fn((text: string) => <div data-testid="full">{text.length}</div>);
    render(<DeferredHistoryText text={'x'.repeat(HISTORY_TEXT_PREVIEW_CHARS + 10)} renderFull={renderFull} />);
    expect(screen.getByTestId('deferred-history-text')).toBeTruthy();
    expect(renderFull).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '展开全文' }));
    expect(screen.getByTestId('full').textContent).toBe(String(HISTORY_TEXT_PREVIEW_CHARS + 10));
  });
});
