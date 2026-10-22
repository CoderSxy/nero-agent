import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentComposer } from './AgentComposer';
import type { ComposerAttachment } from './attachment-types';
import type { SkillSummary } from './skills/types';

const animationsDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
beforeAll(() => Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, writable: true, value: () => [] }));
afterAll(() => {
  if (animationsDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', animationsDescriptor);
  else Reflect.deleteProperty(Element.prototype, 'getAnimations');
});

const listAvailableSkills = vi.hoisted(() => vi.fn());
const listAvailableShortcuts = vi.hoisted(() => vi.fn());
vi.mock('./skills/skills-api', async () => {
  const actual = await vi.importActual<typeof import('./skills/skills-api')>('./skills/skills-api');
  return {
    ...actual,
    listAvailableSkills: (...args: unknown[]) => listAvailableSkills(...args),
    listAvailableShortcuts: (...args: unknown[]) => listAvailableShortcuts(...args),
  };
});

const weatherId = '11111111-1111-4111-8111-111111111111';
const weather: SkillSummary = {
  id: weatherId, name: '天气', description: '预报', version: 1,
  userInvocable: true, availability: 'instructions-only',
};
const attachment: ComposerAttachment = {
  key: 'file-1', source: 'personal', path: 'notes/a.txt', name: 'a.txt',
  size: 4, mimeType: 'text/plain', etag: 'e', state: 'ready',
};

function Harness({ isRunning = false, scopeKey = 'thread-1', initial = '' }: {
  isRunning?: boolean; scopeKey?: string; initial?: string;
}) {
  const [draft, setDraft] = useState(initial);
  const [ids, setIds] = useState<string[]>([]);
  const onSend = vi.fn();
  return <>
    <AgentComposer draft={draft} onDraftChange={setDraft} isRunning={isRunning} onSend={onSend} onStop={vi.fn()}
      attachments={[attachment]} selectedSkillIds={ids} onSelectedSkillIdsChange={setIds} skillScopeKey={scopeKey} />
    <output aria-label="草稿">{draft}</output>
    <output aria-label="所选">{ids.join(',')}</output>
    <button type="button" onClick={onSend}>记录发送</button>
  </>;
}

function typeAt(value: string, caret: number) {
  const input = screen.getByRole('textbox', { name: '发送消息' }) as HTMLTextAreaElement;
  input.focus();
  fireEvent.change(input, { target: { value } });
  input.setSelectionRange(caret, caret);
  fireEvent.select(input);
  return input;
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  listAvailableShortcuts.mockResolvedValue({ items: [] });
  listAvailableSkills.mockImplementation(async (query: { q?: string }) => {
    if (query.q && !'天气'.includes(query.q)) return { items: [], total: 0, page: 1, pageSize: 50 };
    return { items: [weather], total: 1, page: 1, pageSize: 50 };
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('AgentComposer slash skills', () => {
  it('replaces only the slash token and keeps surrounding text, attachments, and unique ids', async () => {
    const onSend = vi.fn();
    function Box() {
      const [draft, setDraft] = useState('前文 请 /天气 分析 后文');
  const [ids, setIds] = useState<string[]>([]);
      return <AgentComposer draft={draft} onDraftChange={setDraft} isRunning={false} onSend={onSend} onStop={vi.fn()}
        attachments={[attachment]} selectedSkillIds={ids} onSelectedSkillIdsChange={setIds} skillScopeKey="thread-1" />;
    }
    render(<Box />);
    typeAt('前文 请 /天气 分析 后文', '前文 请 /天气'.length);
    fireEvent.click(await screen.findByRole('option', { name: '天气' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveProperty('value', '前文 请  分析 后文'));
    expect(screen.getByLabelText('附件 a.txt')).toBeTruthy();
    expect(screen.getAllByText('天气').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('已选技能').textContent?.match(/天气/g)).toHaveLength(1);
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '技能' }));
    expect(await screen.findByRole('searchbox', { name: '搜索技能' })).toBeTruthy();
  });

  it('lets Enter select from the panel and keeps Shift+Enter and a closed panel on their own paths', async () => {
    const onSend = vi.fn();
    function Box() {
      const [draft, setDraft] = useState('');
      const [ids, setIds] = useState<string[]>([]);
      return <AgentComposer draft={draft} onDraftChange={setDraft} isRunning={false} onSend={onSend} onStop={vi.fn()}
        selectedSkillIds={ids} onSelectedSkillIdsChange={setIds} />;
    }
    render(<Box />);
    const input = typeAt('/', 1);
    expect(await screen.findByRole('option', { name: '天气' })).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByLabelText('已选技能').textContent).toContain('天气'));
    expect(onSend).not.toHaveBeenCalled();

    typeAt('/暂无', 3);
    await waitFor(() => expect(screen.getByText('未找到匹配技能')).toBeTruthy());
    fireEvent.keyDown(screen.getByRole('textbox', { name: '发送消息' }), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole('textbox', { name: '发送消息' }), { key: 'Escape' });
    expect(screen.queryByText('未找到匹配技能')).toBeNull();
    fireEvent.select(screen.getByRole('textbox', { name: '发送消息' }));
    expect(screen.queryByText('未找到匹配技能')).toBeNull();
    typeAt('/天气', 3);
    expect(await screen.findByRole('option', { name: '天气' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('textbox', { name: '发送消息' }), { key: 'Escape' });
    typeAt('你好', 2);
    fireEvent.keyDown(screen.getByRole('textbox', { name: '发送消息' }), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('ignores an IME Enter, restores the caret, and closes on Tab, outside click, running, or scope change', async () => {
    const onSend = vi.fn();
    function Box({ running = false, scopeKey = 'thread-1' }: { running?: boolean; scopeKey?: string }) {
      const [draft, setDraft] = useState('');
      const [ids, setIds] = useState<string[]>([]);
      return <AgentComposer draft={draft} onDraftChange={setDraft} isRunning={running} onSend={onSend} onStop={vi.fn()}
        selectedSkillIds={ids} onSelectedSkillIdsChange={setIds} skillScopeKey={scopeKey} />;
    }
    const { rerender } = render(<Box />);
    const input = typeAt('/天气', 3);
    expect(await screen.findByRole('option', { name: '天气' })).toBeTruthy();
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true });
    fireEvent.compositionEnd(input);
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('已选技能')).toBeNull();

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect((screen.getByRole('textbox', { name: '发送消息' }) as HTMLTextAreaElement).selectionStart).toBe(0));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '发送消息' }));

    typeAt('/天气', 3);
    await screen.findByRole('option', { name: '天气' });
    fireEvent.keyDown(screen.getByRole('textbox', { name: '发送消息' }), { key: 'Tab' });
    expect(screen.queryByRole('option', { name: '天气' })).toBeNull();

    typeAt('/天', 2);
    await screen.findByRole('option', { name: '天气' });
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('option', { name: '天气' })).toBeNull();

    typeAt('/天气', 3);
    await screen.findByRole('option', { name: '天气' });
    rerender(<Box running />);
    expect(screen.queryByRole('option', { name: '天气' })).toBeNull();
    rerender(<Box scopeKey="thread-2" />);
    typeAt('请 /天气', '请 /天气'.length);
    await screen.findByRole('option', { name: '天气' });
    rerender(<Box scopeKey="thread-3" />);
    expect(screen.queryByRole('option', { name: '天气' })).toBeNull();
  });
  it('uses the mobile plus sheet for skills and leaves slash text untouched', async () => {
    function Mobile() {
      const [draft, setDraft] = useState('');
      const [ids, setIds] = useState<string[]>([]);
      return <AgentComposer draft={draft} onDraftChange={setDraft} isRunning={false}
        onSend={vi.fn()} onStop={vi.fn()} mobileInline selectedSkillIds={ids} onSelectedSkillIdsChange={setIds} />;
    }
    render(<Mobile />);
    const input = typeAt('/天气',3);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('button',{name:'技能'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'添加附件'}));
    fireEvent.click(screen.getByRole('menuitem',{name:'选择技能'}));
    expect(await screen.findByRole('dialog',{name:'选择技能'})).toBeTruthy();
    fireEvent.click(await screen.findByRole('option',{name:'天气'}));
    expect(screen.getByLabelText('已选技能').textContent).toContain('天气');
    expect((input as HTMLTextAreaElement).value).toBe('/天气');
    expect(screen.queryByRole('dialog',{name:'选择技能'})).toBeNull();
  });

});
