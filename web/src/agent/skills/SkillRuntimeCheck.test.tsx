import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SkillRuntimeCheck, SkillRuntimeReport } from './SkillRuntimeCheck';
const check = vi.fn();
vi.mock('./skills-api', () => ({ checkSkillRuntime: (...args: unknown[]) => check(...args) }));
afterEach(() => { cleanup(); check.mockReset(); });
const report = { status: 'blocked' as const, fingerprint: 'x', checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString(), message: '请修复后重新检查', items: [{ kind: 'python' as const, name: 'python-pptx', status: 'missing' as const, message: '缺少 python-pptx' }] };
it('shows concrete missing dependencies instead of claiming ready', () => {
  render(<SkillRuntimeReport report={report} />);
  expect(screen.getByText('缺少依赖或能力')).toBeTruthy(); expect(screen.getByText('缺少 python-pptx')).toBeTruthy();
});
it('checks saved version, retries forcibly, and hides stale result on unsaved edits', async () => {
  check.mockResolvedValue({ report });
  const view = render(<SkillRuntimeCheck skillId="skill" version={2} revision="3" dirty={false} />);
  expect(await screen.findByText('缺少 python-pptx')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '重新检查' }));
  expect(check.mock.calls.at(-1)?.slice(0, 3)).toEqual(['skill', 2, true]);
  view.rerender(<SkillRuntimeCheck skillId="skill" version={2} revision="3" dirty />);
  expect(screen.queryByText('缺少 python-pptx')).toBeNull(); expect(screen.getByText(/保存修改后/)).toBeTruthy();
});
