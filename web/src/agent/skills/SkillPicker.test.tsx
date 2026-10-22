import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillApiError } from './skills-api';
import { SkillPicker, type SkillPickerHandle } from './SkillPicker';
import { SkillSelectionChips } from './SkillSelectionChips';
import type { SkillSummary } from './types';

const listAvailableSkills = vi.hoisted(() => vi.fn());
vi.mock('./skills-api', async () => {
  const actual = await vi.importActual<typeof import('./skills-api')>('./skills-api');
  return { ...actual, listAvailableSkills: (...args: unknown[]) => listAvailableSkills(...args) };
});

const alpha: SkillSummary = {
  id: '11111111-1111-4111-8111-111111111111', name: 'alpha', description: 'a', version: 1,
  userInvocable: true, availability: 'instructions-only',
};
const beta: SkillSummary = {
  id: '22222222-2222-4222-8222-222222222222', name: 'beta-check', description: 'b', version: 2,
  userInvocable: true, availability: 'ready',
};
const hidden: SkillSummary = {
  id: '33333333-3333-4333-8333-333333333333', name: 'hidden-auto', description: 'h', version: 1,
  userInvocable: false, availability: 'ready',
};

function page(items: SkillSummary[], total = items.length) {
  return { items, total, page: 1, pageSize: 50 };
}

function Panel({ scopeKey = 'thread-1', preserveMissing = false, initial = [] as string[],
  initialOpen = true, inputMode = 'search' as 'search' | 'slash' }: {
  scopeKey?: string; preserveMissing?: boolean; initial?: string[]; initialOpen?: boolean;
  inputMode?: 'search' | 'slash';
}) {
  const ref = useRef<SkillPickerHandle>(null);
  const [value, setValue] = useState(initial);
  const [open, setOpen] = useState(initialOpen);
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<SkillSummary[]>([]);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [scope, setScope] = useState(scopeKey);
  if (scope !== scopeKey) {
    setScope(scopeKey);
    setCatalog([]);
    setPhase('loading');
  }
  return <>
    <button type="button" onClick={() => setOpen(true)}>打开技能面板</button>
    <SkillSelectionChips value={value} catalog={catalog} phase={phase} preserveMissing={preserveMissing}
      onRemove={id => setValue(current => current.filter(item => item !== id))} />
    <SkillPicker ref={ref} value={value} onChange={setValue} scopeKey={scopeKey} preserveMissing={preserveMissing}
      open={open} query={query} onQueryChange={setQuery} inputMode={inputMode}
      onRequestClose={() => setOpen(false)} onPicked={() => setOpen(false)}
      onCatalogChange={setCatalog} onPhaseChange={setPhase} />
  </>;
}

function key(ref: RefObject<SkillPickerHandle | null>, name: string, shiftKey = false) {
  const event = {
    key: name,
    shiftKey,
    preventDefault: vi.fn(),
    nativeEvent: { isComposing: false, keyCode: name === 'Enter' ? 13 : 0 },
  } as unknown as KeyboardEvent<HTMLTextAreaElement>;
  let consumed = false;
  act(() => { consumed = ref.current?.handleKeyDown(event) ?? false; });
  return { consumed, event };
}

beforeEach(() => {
  listAvailableSkills.mockImplementation(async (query: { q?: string }) => {
    const all = [alpha, beta, hidden];
    if (!query.q) return page(all);
    return page(all.filter(item => item.name.includes(query.q!)));
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('SkillPicker', () => {
  it('does not render the old toolbar while closed', () => {
    render(<Panel initialOpen={false} />);
    expect(screen.queryByRole('button', { name: '选择技能' })).toBeNull();
    expect(screen.queryByRole('button', { name: '刷新技能权限' })).toBeNull();
    expect(screen.queryByRole('listbox', { name: '可选技能' })).toBeNull();
  });

  it('shows name, description, and selection state, and refuses a duplicate', async () => {
    render(<Panel initial={[alpha.id]} />);
    const option = await screen.findByRole('option', { name: 'alpha' });
    expect(option.textContent).toContain('a');
    expect(option.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(option);
    expect(screen.getAllByLabelText('已选技能')).toHaveLength(1);
    expect(screen.getByLabelText('已选技能').textContent).toContain('alpha');
  });

  it('stops at five skills and drops ids removed by a permission refresh', async () => {
    const skills = [1, 2, 3, 4, 5, 6].map(n => ({
      ...alpha,
      id: `00000000-0000-4000-8000-00000000000${n}`,
      name: `skill-${n}`,
    }));
    listAvailableSkills.mockResolvedValue(page(skills));
    render(<Panel />);
    for (const skill of skills.slice(0, 5)) {
      fireEvent.click(await screen.findByRole('option', { name: skill.name }));
      fireEvent.click(screen.getByRole('button', { name: '打开技能面板' }));
    }
    expect(screen.getByRole('status').textContent).toContain('最多选择 5 个技能');
    expect(screen.getAllByRole('option').some(node => (node as HTMLButtonElement).disabled
      && node.textContent?.includes('skill-6'))).toBe(true);
    listAvailableSkills.mockResolvedValue(page([skills[5]!]));
    fireEvent.click(screen.getByRole('button', { name: '刷新技能权限' }));
    await waitFor(() => expect(screen.queryByLabelText('已选技能')).toBeNull());
  });

  it('keeps loading, error, and search-empty distinct', async () => {
    let release: (value: ReturnType<typeof page>) => void = () => undefined;
    listAvailableSkills.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const { rerender } = render(<Panel />);
    expect(screen.getByRole('status').textContent).toContain('正在加载技能');
    expect(screen.queryByText('暂无可用技能')).toBeNull();
    release(page([]));
    expect(await screen.findByText('暂无可用技能')).toBeTruthy();

    listAvailableSkills.mockRejectedValue(new Error('offline'));
    rerender(<Panel scopeKey="thread-err" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('技能加载失败，请重试');
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();

    listAvailableSkills.mockImplementation(async (query: { q?: string }) => (
      query.q ? page([]) : page([alpha])
    ));
    rerender(<Panel scopeKey="thread-search" inputMode="search" />);
    fireEvent.change(await screen.findByRole('searchbox', { name: '搜索技能' }), { target: { value: 'missing' } });
    expect(await screen.findByText('未找到匹配技能')).toBeTruthy();
  });

  it('retains a search result beyond the first 50 skills', async () => {
    const first = Array.from({ length: 50 }, (_, index) => ({ ...alpha, id: `first-${index}`, name: `first-${index}` }));
    listAvailableSkills.mockImplementation(async (query: { page: number; q?: string }) => {
      if (query.q) return page([beta]);
      return { items: query.page === 1 ? first : [beta], total: 51, page: query.page, pageSize: 50 };
    });
    render(<Panel inputMode="search" />);
    await screen.findByRole('option', { name: 'first-0' });
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索技能' }), { target: { value: 'beta' } });
    fireEvent.click(await screen.findByRole('option', { name: 'beta-check' }));
    await waitFor(() => expect(screen.getByLabelText('已选技能').textContent).toContain('beta-check'));
    fireEvent.click(screen.getByRole('button', { name: '打开技能面板' }));
    fireEvent.click(screen.getByRole('button', { name: '刷新技能权限' }));
    await waitFor(() => expect(listAvailableSkills.mock.calls.some(([query]) => query.page === 2)).toBe(true));
    expect(screen.getByLabelText('已选技能').textContent).toContain('beta-check');
  });

  it('does not clear a selection from the first page or a search page', async () => {
    const first = Array.from({ length: 50 }, (_, index) => ({ ...alpha, id: `first-${index}`, name: `first-${index}` }));
    let releasePage2: (value: ReturnType<typeof page>) => void = () => undefined;
    listAvailableSkills.mockImplementation(async (query: { page: number; q?: string }) => {
      if (query.q) return page([alpha]);
      if (query.page === 1) return { items: first, total: 51, page: 1, pageSize: 50 };
      return new Promise(resolve => { releasePage2 = resolve; });
    });
    render(<Panel initial={[beta.id]} inputMode="search" />);
    fireEvent.change(await screen.findByRole('searchbox', { name: '搜索技能' }), { target: { value: 'alpha' } });
    await screen.findByRole('option', { name: 'alpha' });
    expect(screen.getByLabelText('已选技能').textContent).not.toContain('失效');
    releasePage2({ items: [beta], total: 51, page: 2, pageSize: 50 });
    await waitFor(() => expect(screen.getByLabelText('已选技能').textContent).toContain('beta-check'));
  });

  it('ignores a late search result after the query is cleared', async () => {
    let releaseSearch: (value: ReturnType<typeof page>) => void = () => undefined;
    listAvailableSkills.mockImplementation(async (query: { q?: string }) => {
      if (query.q === 'alpha') return new Promise(resolve => { releaseSearch = resolve; });
      return page([alpha, beta]);
    });
    render(<Panel inputMode="search" />);
    await screen.findByRole('option', { name: 'beta-check' });
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索技能' }), { target: { value: 'alpha' } });
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索技能' }), { target: { value: '' } });
    releaseSearch(page([alpha]));
    await waitFor(() => expect(listAvailableSkills.mock.calls.some(([query]) => query.q === 'alpha')).toBe(true));
    expect(screen.getByRole('option', { name: 'beta-check' })).toBeTruthy();
  });

  it('validates shortcut-restored selections across all pages and keeps them if validation fails', async () => {
    const first = Array.from({ length: 50 }, (_, index) => ({ ...alpha, id: `first-${index}` }));
    listAvailableSkills.mockImplementation(async (query: { page: number }) => ({
      items: query.page === 1 ? first : [beta], total: 51, page: query.page, pageSize: 50,
    }));
    render(<Panel initial={[beta.id]} />);
    await waitFor(() => expect(screen.getByLabelText('已选技能').textContent).toContain('beta-check'));
    listAvailableSkills.mockImplementation(async (query: { page: number }) => {
      if (query.page === 2) throw new Error('offline');
      return { items: first, total: 51, page: 1, pageSize: 50 };
    });
    fireEvent.click(screen.getByRole('button', { name: '刷新技能权限' }));
    await waitFor(() => expect(listAvailableSkills.mock.calls.filter(([query]) => query.page === 2).length).toBeGreaterThan(1));
    expect(screen.getByLabelText('已选技能').textContent).toContain('beta-check');
  });

  it('ignores a late catalog response after the scope changes', async () => {
    let releaseFirst: (value: ReturnType<typeof page>) => void = () => undefined;
    const first = new Promise<ReturnType<typeof page>>(resolve => { releaseFirst = resolve; });
    let calls = 0;
    listAvailableSkills.mockImplementation(() => {
      calls += 1;
      if (calls === 1) return first;
      return Promise.resolve(page([beta]));
    });
    const { rerender } = render(<Panel scopeKey="thread-1" />);
    rerender(<Panel scopeKey="thread-2" />);
    expect(await screen.findByRole('option', { name: 'beta-check' })).toBeTruthy();
    releaseFirst(page([alpha]));
    await waitFor(() => expect(listAvailableSkills.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByRole('option', { name: 'alpha' })).toBeNull();
  });

  it('ignores a late catalog failure after the scope changes and keeps a disabled catalog value', async () => {
    let rejectFirst: (error: Error) => void = () => undefined;
    const first = new Promise<ReturnType<typeof page>>((_, reject) => { rejectFirst = reject; });
    let calls = 0;
    listAvailableSkills.mockImplementation(() => {
      calls += 1;
      if (calls === 1) return first;
      return Promise.resolve(page([beta]));
    });
    const { rerender } = render(<Panel scopeKey="thread-1" initial={[alpha.id]} />);
    listAvailableSkills.mockImplementation(() => {
      calls += 1;
      if (calls === 1) return first;
      return Promise.resolve(page([alpha]));
    });
    rerender(<Panel scopeKey="thread-2" initial={[alpha.id]} />);
    expect(await screen.findByRole('option', { name: 'alpha' })).toBeTruthy();
    rejectFirst(new SkillApiError(503, 'SKILLS_DISABLED', 'Agent skills are disabled'));
    await waitFor(() => expect(listAvailableSkills.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText('技能功能未启用，请联系管理员配置')).toBeNull();
    expect(screen.getByLabelText('已选技能').textContent).toContain('alpha');

    listAvailableSkills.mockRejectedValue(new SkillApiError(503, 'SKILLS_DISABLED', 'Agent skills are disabled'));
    rerender(<Panel scopeKey="thread-disabled" initial={[alpha.id]} />);
    expect(await screen.findByText('技能功能未启用，请联系管理员配置')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    expect(screen.getByLabelText('已选技能').textContent).toContain(alpha.id);
  });

  it('shows a temporary name before the catalog is ready and does not mark it invalid', async () => {
    let release: (value: ReturnType<typeof page>) => void = () => undefined;
    listAvailableSkills.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    render(<Panel initial={['pending-id']} />);
    const chip = await screen.findByLabelText('已选技能');
    expect(chip.textContent).toContain('pending-id');
    expect(chip.textContent).not.toContain('失效');
    release(page([beta]));
    await waitFor(() => expect(screen.getByLabelText('已选技能').textContent).toContain('失效'));
  });

  it('keeps a revoked restored id visible as 失效 without substituting another skill', async () => {
    listAvailableSkills.mockResolvedValue(page([beta]));
    render(<Panel initial={[alpha.id]} preserveMissing />);
    const chip = await screen.findByLabelText('已选技能');
    await waitFor(() => expect(chip.textContent).toContain('失效'));
    expect(chip.textContent).not.toContain('beta-check');
    expect(chip.querySelector('[data-skill-id]')?.getAttribute('data-skill-id')).toBe(alpha.id);
  });

  it('moves the highlight with the keyboard, skips disabled rows, and leaves Shift+Enter alone', async () => {
    const gamma: SkillSummary = { ...alpha, id: '44444444-4444-4444-8444-444444444444', name: 'gamma', description: 'g' };
    listAvailableSkills.mockResolvedValue(page([alpha, beta, gamma]));
    const ref = { current: null as SkillPickerHandle | null };
    const picked: string[] = [];
    function KeyboardPanel() {
      const inner = useRef<SkillPickerHandle>(null);
      const [value, setValue] = useState([alpha.id]);
      const [open, setOpen] = useState(true);
      const [catalog, setCatalog] = useState<SkillSummary[]>([]);
      const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
      ref.current = inner.current;
      return <>
        <SkillSelectionChips value={value} catalog={catalog} phase={phase} onRemove={() => undefined} />
        <SkillPicker ref={node => { inner.current = node; ref.current = node; }} value={value}
          onChange={setValue} open={open} query="" onQueryChange={() => undefined} inputMode="slash"
          onRequestClose={() => setOpen(false)} onPicked={id => picked.push(id)}
          onCatalogChange={setCatalog} onPhaseChange={setPhase} />
      </>;
    }
    render(<KeyboardPanel />);
    await screen.findByRole('option', { name: 'gamma' });
    expect(screen.getByRole('option', { name: 'beta-check' }).getAttribute('data-highlighted')).toBe('true');
    expect(key(ref, 'ArrowDown').consumed).toBe(true);
    expect(screen.getByRole('option', { name: 'gamma' }).getAttribute('data-highlighted')).toBe('true');
    expect(key(ref, 'ArrowDown').consumed).toBe(true);
    expect(screen.getByRole('option', { name: 'beta-check' }).getAttribute('data-highlighted')).toBe('true');
    expect(key(ref, 'ArrowUp').consumed).toBe(true);
    expect(screen.getByRole('option', { name: 'gamma' }).getAttribute('data-highlighted')).toBe('true');
    expect(key(ref, 'Enter', true).consumed).toBe(false);
    expect(key(ref, 'Enter').consumed).toBe(true);
    expect(picked).toEqual(['44444444-4444-4444-8444-444444444444']);

    listAvailableSkills.mockResolvedValue(page([]));
    picked.length = 0;
    fireEvent.click(screen.getByRole('button', { name: '刷新技能权限' }));
    expect(await screen.findByText('暂无可用技能')).toBeTruthy();
    expect(key(ref, 'Enter').consumed).toBe(true);
    expect(picked).toEqual([]);
    expect(key(ref, 'Escape').consumed).toBe(true);
  });
  it('does not offer stale catalog entries while a search is pending', async () => {
    listAvailableSkills.mockImplementation(async (query: { q?: string }) => {
      if (query.q) return new Promise(() => {});
      return page([alpha, beta]);
    });
    render(<Panel />);
    await screen.findByRole('option', { name: 'alpha' });
    const input = screen.getByRole('searchbox', { name: '搜索技能' });
    fireEvent.change(input, { target: { value: 'missing' } });
    expect(screen.queryByRole('option', { name: 'alpha' })).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('正在搜索技能');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByLabelText('已选技能')).toBeNull();
  });

  it('shows a search permission failure without falling back to unrelated entries', async () => {
    listAvailableSkills.mockImplementation(async (query: { q?: string }) => {
      if (query.q) throw new SkillApiError(403, 'FORBIDDEN', 'no access');
      return page([alpha]);
    });
    render(<Panel initial={[alpha.id]} />);
    await screen.findByRole('option', { name: 'alpha' });
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索技能' }), { target: { value: 'secret' } });
    expect((await screen.findByRole('alert')).textContent).toContain('暂无技能访问权限');
    expect(screen.queryByRole('option')).toBeNull();
    expect(screen.getByLabelText('已选技能').textContent).toContain('alpha');
  });

  it('supports navigation, selection and escape from the explicit search input', async () => {
    render(<Panel />);
    await screen.findByRole('option', { name: 'alpha' });
    const input = screen.getByRole('searchbox', { name: '搜索技能' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByLabelText('已选技能').textContent).toContain('beta-check');
    fireEvent.click(screen.getByRole('button', { name: '打开技能面板' }));
    fireEvent.keyDown(screen.getByRole('searchbox', { name: '搜索技能' }), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('keeps a missing-resource skill visible but not selectable', async () => {
    listAvailableSkills.mockResolvedValue(page([{
      ...alpha, name: 'broken-skill', storageHealth: 'unavailable',
    }]));
    render(<Panel />);
    const option = await screen.findByRole('option', { name: 'broken-skill' });
    expect(option.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('资源缺失，暂不可执行')).toBeTruthy();
  });

});
