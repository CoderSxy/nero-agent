import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillPicker } from './SkillPicker';
import type { SkillSummary } from './types';

const listAvailableSkills = vi.hoisted(() => vi.fn());
vi.mock('./skills-api', () => ({
  listAvailableSkills: (...args: unknown[]) => listAvailableSkills(...args),
}));

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

function page(items: SkillSummary[]) {
  return { items, total: items.length, page: 1, pageSize: 50 };
}

function Harness({ scopeKey = 'thread-1', preserveMissing = false }: {
  scopeKey?: string; preserveMissing?: boolean;
}) {
  const [value, setValue] = useState<string[]>([]);
  return <SkillPicker value={value} onChange={setValue} scopeKey={scopeKey} preserveMissing={preserveMissing} />;
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
  it('searches with a slash, selects from the button, hides non-invocable skills, and removes chips', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '选择技能' }));
    expect(await screen.findByRole('option', { name: 'alpha' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'hidden-auto' })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索技能' }), { target: { value: '/beta' } });
    await waitFor(() => expect(screen.queryByRole('option', { name: 'alpha' })).toBeNull());
    fireEvent.click(screen.getByRole('option', { name: 'beta-check' }));
    expect(screen.getByLabelText('已选技能').textContent).toContain('beta-check');
    fireEvent.click(screen.getByRole('button', { name: '移除技能 beta-check' }));
    expect(screen.queryByLabelText('已选技能')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '选择技能' }));
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索技能' }), { target: { value: '' } });
    fireEvent.click(await screen.findByRole('option', { name: 'alpha' }));
    expect(screen.getByLabelText('已选技能').textContent).toContain('alpha');
  });

  it('stops at five skills and drops ids removed by a permission refresh', async () => {
    const skills = [1, 2, 3, 4, 5, 6].map(n => ({
      ...alpha,
      id: `00000000-0000-4000-8000-00000000000${n}`,
      name: `skill-${n}`,
    }));
    listAvailableSkills.mockResolvedValue(page(skills));
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '选择技能' }));
    for (const skill of skills.slice(0, 5)) {
      fireEvent.click(await screen.findByRole('option', { name: skill.name }));
      fireEvent.click(screen.getByRole('button', { name: '选择技能' }));
    }
    expect(screen.getByRole('status').textContent).toContain('最多选择 5 个技能');
    expect(screen.getAllByRole('option').some(node => (node as HTMLButtonElement).disabled
      && node.textContent === 'skill-6')).toBe(true);
    listAvailableSkills.mockResolvedValue(page([skills[5]!]));
    fireEvent.click(screen.getByRole('button', { name: '刷新技能权限' }));
    await waitFor(() => expect(screen.queryByLabelText('已选技能')).toBeNull());
  });

  it('retains a search result beyond the first 50 skills', async () => {
    const first = Array.from({ length: 50 }, (_, index) => ({ ...alpha, id: `first-${index}`, name: `first-${index}` }));
    listAvailableSkills.mockImplementation(async (query: { page: number; q?: string }) => {
      if (query.q) return page([beta]);
      return { items: query.page === 1 ? first : [beta], total: 51, page: query.page, pageSize: 50 };
    });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '选择技能' }));
    await screen.findByRole('option', { name: 'first-0' });
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索技能' }), { target: { value: 'beta' } });
    fireEvent.click(await screen.findByRole('option', { name: 'beta-check' }));
    await waitFor(() => expect(screen.getByLabelText('已选技能').textContent).toContain('beta-check'));
    fireEvent.click(screen.getByRole('button', { name: '刷新技能权限' }));
    await waitFor(() => expect(listAvailableSkills.mock.calls.some(([query]) => query.page === 2)).toBe(true));
    expect(screen.getByLabelText('已选技能').textContent).toContain('beta-check');
  });

  it('validates shortcut-restored selections across all pages and keeps them if validation fails', async () => {
    const first = Array.from({ length: 50 }, (_, index) => ({ ...alpha, id: `first-${index}` }));
    listAvailableSkills.mockImplementation(async (query: { page: number }) => ({
      items: query.page === 1 ? first : [beta], total: 51, page: query.page, pageSize: 50,
    }));
    function Restored() {
      const [value, setValue] = useState([beta.id]);
      return <SkillPicker value={value} onChange={setValue} />;
    }
    render(<Restored />);
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
    const { rerender } = render(<Harness scopeKey="thread-1" />);
    rerender(<Harness scopeKey="thread-2" />);
    fireEvent.click(screen.getByRole('button', { name: '选择技能' }));
    expect(await screen.findByRole('option', { name: 'beta-check' })).toBeTruthy();
    releaseFirst(page([alpha]));
    await waitFor(() => expect(listAvailableSkills.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByRole('option', { name: 'alpha' })).toBeNull();
  });

  it('keeps a revoked restored id visible as 失效 without substituting another skill', async () => {
    function Restored() {
      const [value, setValue] = useState([alpha.id]);
      return <SkillPicker value={value} onChange={setValue} preserveMissing scopeKey="thread-1" />;
    }
    listAvailableSkills.mockResolvedValue(page([beta]));
    render(<Restored />);
    const chip = await screen.findByLabelText('已选技能');
    expect(chip.textContent).toContain('失效');
    expect(chip.textContent).not.toContain('beta-check');
    expect(chip.querySelector('[data-skill-id]')?.getAttribute('data-skill-id')).toBe(alpha.id);
  });
});
