import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Keep a measured shell while expensive history content is outside the scroller. */
export function HistoryTurnShell(props: {
  turnId: string;
  pinned?: boolean;
  children: ReactNode;
  onHeightChange?: (turnId: string, height: number) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hasObserver = typeof IntersectionObserver !== 'undefined';
  const [visible, setVisible] = useState(!hasObserver || Boolean(props.pinned));
  const [focused, setFocused] = useState(false);
  const [height, setHeight] = useState(240);
  const shown = props.pinned || focused || !hasObserver || visible;
  useEffect(() => {
    const node = rootRef.current;
    if (!node || !hasObserver) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const selection = window.getSelection();
        if (
          !entry?.isIntersecting &&
          (node.contains(document.activeElement) ||
            (selection &&
              !selection.isCollapsed &&
              ((selection.anchorNode && node.contains(selection.anchorNode)) ||
                (selection.focusNode && node.contains(selection.focusNode)))))
        )
          return;
        setVisible(Boolean(entry?.isIntersecting));
      },
      { root: node.closest('[data-slot="message-scroller-viewport"]'), rootMargin: '1000px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasObserver, props.turnId]);
  useEffect(() => {
    const node = rootRef.current;
    if (!node || !shown || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const next = node.getBoundingClientRect().height;
      if (next > 0) {
        setHeight(next);
        props.onHeightChange?.(props.turnId, next);
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [shown, props.onHeightChange, props.turnId]);
  return (
    <div
      ref={rootRef}
      data-turn-id={props.turnId}
      data-testid={`history-turn-${props.turnId}`}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
      style={!shown ? { minHeight: height } : undefined}
    >
      {shown ? props.children : null}
    </div>
  );
}
