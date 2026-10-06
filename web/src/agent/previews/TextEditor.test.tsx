import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextEditor } from './TextEditor';

vi.mock('./monaco-setup', () => ({}));
vi.mock('@monaco-editor/react', () => ({ default: ({ value, onChange }: {
  value: string; onChange(value: string): void;
}) => <textarea aria-label="源码" value={value} onChange={event => onChange(event.target.value)} /> }));
afterEach(cleanup);

describe('text editor previews', () => {
  it('renders Markdown formatting and a GFM table', () => {
    render(<TextEditor path="note.md" kind="markdown" value={'**bold**\n\n| A | B |\n|---|---|\n| 1 | 2 |'} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '预览' }));
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByRole('table')).toBeTruthy();
  });

  it('shows HTML in an iframe without same-origin permission', () => {
    render(<TextEditor path="page.html" kind="html" value="<h1>Hello</h1>" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '预览' }));
    const frame = screen.getByTitle('page.html 预览');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame.getAttribute('srcdoc')).toBe('<h1>Hello</h1>');
  });
});
