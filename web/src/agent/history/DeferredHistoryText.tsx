import { useState, type ReactNode } from 'react';

export const HISTORY_TEXT_PREVIEW_CHARS = 12_000;

export function DeferredHistoryText(props: { text: string; renderFull: (text: string) => ReactNode }) {
  const needsDefer = props.text.length > HISTORY_TEXT_PREVIEW_CHARS;
  const [expanded, setExpanded] = useState(!needsDefer);

  if (!needsDefer || expanded) {
    return <>{props.renderFull(props.text)}</>;
  }

  return (
    <div className="deferred-history-text" data-testid="deferred-history-text">
      <pre className="deferred-history-text-preview">{props.text.slice(0, HISTORY_TEXT_PREVIEW_CHARS)}</pre>
      <button type="button" className="deferred-history-text-expand" onClick={() => setExpanded(true)}>
        展开全文
      </button>
    </div>
  );
}
