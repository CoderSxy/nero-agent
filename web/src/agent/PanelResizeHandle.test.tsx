import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelResizeHandle } from './PanelResizeHandle';

afterEach(cleanup);

function pointer(target: HTMLElement, type: string, clientX: number) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  fireEvent(target, event);
}

describe('panel resize handle', () => {
  it('clamps a left panel while dragging and supports keyboard adjustment', () => {
    const onResize = vi.fn();
    render(<PanelResizeHandle side="left" width={260} min={200} max={420} onResize={onResize} />);
    const handle = screen.getByRole('separator', { name: '调整左侧面板宽度' });
    pointer(handle, 'pointerdown', 300);
    pointer(handle, 'pointermove', 600);
    expect(onResize).toHaveBeenLastCalledWith(420);
    pointer(handle, 'pointermove', 0);
    expect(onResize).toHaveBeenLastCalledWith(200);
    pointer(handle, 'pointerup', 0);
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onResize).toHaveBeenLastCalledWith(270);
  });

  it('grows a right panel when dragging its left edge leftward', () => {
    const onResize = vi.fn();
    render(<PanelResizeHandle side="right" width={320} min={280} max={620} onResize={onResize} />);
    const handle = screen.getByRole('separator', { name: '调整右侧面板宽度' });
    pointer(handle, 'pointerdown', 900);
    pointer(handle, 'pointermove', 800);
    expect(onResize).toHaveBeenLastCalledWith(420);
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(onResize).toHaveBeenLastCalledWith(280);
  });
});
