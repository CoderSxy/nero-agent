import { useRef } from 'react';

type Side = 'left' | 'right';
type Drag = { pointerId: number; startX: number; startWidth: number };

export function PanelResizeHandle({ side, width, min, max, onResize }: {
  side: Side; width: number; min: number; max: number; onResize: (width: number) => void;
}) {
  const drag = useRef<Drag | null>(null);
  const clamp = (value: number) => Math.max(min, Math.min(max, value));
  const direction = side === 'left' ? 1 : -1;
  return <div className={`panel-resize-handle panel-resize-handle--${side}`}
    role="separator" aria-label={`调整${side === 'left' ? '左' : '右'}侧面板宽度`}
    aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={width}
    tabIndex={0}
    onPointerDown={event => {
      if (event.button !== 0) return;
      drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    }}
    onPointerMove={event => {
      if (!drag.current || drag.current.pointerId !== event.pointerId) return;
      onResize(clamp(drag.current.startWidth + direction * (event.clientX - drag.current.startX)));
    }}
    onPointerUp={event => {
      if (drag.current?.pointerId === event.pointerId) drag.current = null;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={event => {
      if (event.key === 'Home') onResize(min);
      else if (event.key === 'End') onResize(max);
      else if (event.key === 'ArrowLeft') onResize(clamp(width - 10 * direction));
      else if (event.key === 'ArrowRight') onResize(clamp(width + 10 * direction));
      else return;
      event.preventDefault();
    }} />;
}
