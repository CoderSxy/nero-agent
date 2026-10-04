import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ThreadSidebar } from './ThreadSidebar';

afterEach(cleanup);

it('keeps the logo and settings outside the scrolling conversation list', () => {
  const { container } = render(<ThreadSidebar threads={[]} loading={false} error={null}
    onNew={vi.fn()} onSelect={vi.fn()}
    models={{}} catalog={[]} theme="dark" onModelsChange={vi.fn()} onThemeChange={vi.fn()} />);
  const scroll = container.querySelector('.thread-scroll');
  expect(scroll).toBeTruthy();
  expect(scroll?.contains(container.querySelector('.brand'))).toBe(false);
  expect(scroll?.contains(screen.getByRole('button', { name: '设置' }))).toBe(false);
});
