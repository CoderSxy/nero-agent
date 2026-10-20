import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateShortcutValues } from '../../../../src/mastra/skills/shortcuts';
import { AgentComposer } from '../AgentComposer';
import { SkillShortcutEditor, SkillShortcutForm } from './SkillShortcutForm';
import type { SkillShortcutAvailable } from './types';

const listAvailableSkills = vi.hoisted(() => vi.fn());
const listAvailableShortcuts = vi.hoisted(() => vi.fn());
const getSkillShortcut = vi.hoisted(() => vi.fn());
const putSkillShortcut = vi.hoisted(() => vi.fn());
vi.mock('./skills-api', async () => ({
  ...await vi.importActual<typeof import('./skills-api')>('./skills-api'),
  listAvailableSkills: (...args: unknown[]) => listAvailableSkills(...args),
  listAvailableShortcuts: (...args: unknown[]) => listAvailableShortcuts(...args),
  getSkillShortcut: (...args: unknown[]) => getSkillShortcut(...args),
  putSkillShortcut: (...args: unknown[]) => putSkillShortcut(...args),
}));

const SKILL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const fixture: SkillShortcutAvailable = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  skillId: SKILL_ID,
  skillName: 'reference-demo',
  label: 'reference-demo 清单',
  sort: 1,
  enabled: true,
  revision: '1',
  fields: [
    { key: 'topic', label: '主题', type: 'text', required: true },
    { key: 'detail', label: '说明', type: 'textarea', required: false },
    { key: 'level', label: '级别', type: 'select', required: true, options: ['低', '高'] },
    { key: 'count', label: '数量', type: 'number', required: true, min: 1, max: 3 },
    { key: 'confirm', label: '确认', type: 'boolean', required: false },
  ],
  prompts: [{
    label: '按清单处理',
    template: '请按 reference-demo 清单处理 {{topic}}。说明 {{detail}}。级别 {{level}}。数量 {{count}}。确认 {{confirm}}。保留 ${1+1} 与 <b>html</b>',
  }],
};

function ComposerHarness() {
  const [draft, setDraft] = useState('');
  const [ids, setIds] = useState<string[]>([]);
  return <>
    <AgentComposer draft={draft} onDraftChange={setDraft} isRunning={false} onSend={vi.fn()} onStop={vi.fn()}
      selectedSkillIds={ids} onSelectedSkillIdsChange={setIds} />
    <output aria-label="草稿">{draft}</output>
    <output aria-label="快捷所选技能">{ids.join(',')}</output>
  </>;
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

beforeEach(() => {
  listAvailableSkills.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
});

describe('SkillShortcutForm', () => {
  it('fills five controls and applies a literal user message with the skill id', () => {
    const onApply = vi.fn();
    render(<SkillShortcutForm shortcut={fixture} onApply={onApply} />);
    expect(screen.getByLabelText('主题')).toBeTruthy();
    expect(screen.getByLabelText('说明').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('级别').tagName).toBe('SELECT');
    expect((screen.getByLabelText('数量') as HTMLInputElement).type).toBe('number');
    expect((screen.getByLabelText('确认') as HTMLInputElement).type).toBe('checkbox');

    fireEvent.click(screen.getByRole('button', { name: '按清单处理' }));
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/必填/);

    expect(() => validateShortcutValues(fixture.fields, {
      topic: '发票', detail: '', level: '中', count: 2, confirm: false,
    })).toThrow(/可选项/);
    fireEvent.change(screen.getByLabelText('主题'), { target: { value: 'function(){ throw 1 }' } });
    fireEvent.change(screen.getByLabelText('说明'), { target: { value: '{{topic}}' } });
    fireEvent.change(screen.getByLabelText('级别'), { target: { value: '高' } });
    fireEvent.change(screen.getByLabelText('数量'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: '按清单处理' }));
    expect(screen.getByRole('alert').textContent).toMatch(/上限/);

    fireEvent.change(screen.getByLabelText('数量'), { target: { value: '2' } });
    fireEvent.click(screen.getByLabelText('确认'));
    fireEvent.click(screen.getByRole('button', { name: '按清单处理' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    const result = onApply.mock.calls[0]?.[0] as { skillId: string; text: string };
    expect(result.skillId).toBe(SKILL_ID);
    expect(result.text).toBe('请按 reference-demo 清单处理 function(){ throw 1 }。说明 {{topic}}。级别 高。数量 2。确认 true。保留 ${1+1} 与 <b>html</b>');
    expect(result.text.includes('system')).toBe(false);
    expect('role' in (result as object)).toBe(false);
  });

  it('hides a shortcut after it disappears from the available list', async () => {
    listAvailableSkills.mockResolvedValue({
      items: [{
        id: SKILL_ID, name: 'reference-demo', description: 'checklist', version: 1,
        userInvocable: true, availability: 'instructions-only',
      }],
      total: 1, page: 1, pageSize: 50,
    });
    listAvailableShortcuts.mockResolvedValue({ items: [fixture] });
    render(<ComposerHarness />);
    fireEvent.click(await screen.findByRole('button', { name: 'reference-demo 清单' }));
    fireEvent.change(screen.getByLabelText('主题'), { target: { value: '发票' } });
    fireEvent.change(screen.getByLabelText('级别'), { target: { value: '低' } });
    fireEvent.change(screen.getByLabelText('数量'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: '按清单处理' }));
    expect(screen.getByLabelText('草稿').textContent).toContain('请按 reference-demo 清单处理 发票');
    expect(screen.getByLabelText('快捷所选技能').textContent).toBe(SKILL_ID);
    expect(screen.getByLabelText('草稿').textContent?.includes('system')).toBe(false);

    listAvailableShortcuts.mockResolvedValue({ items: [] });
    fireEvent.click(screen.getByRole('button', { name: '快捷入口菜单' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '刷新快捷入口' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'reference-demo 清单' })).toBeNull());
  });

  it('stops at ten fields and twenty prompt options', async () => {
    getSkillShortcut.mockResolvedValue({ shortcut: null });
    putSkillShortcut.mockResolvedValue({ shortcut: null });
    render(<SkillShortcutEditor skillId={SKILL_ID} canManage />);
    await screen.findByRole('button', { name: '保存快捷配置' });
    const addField = screen.getByRole('button', { name: '添加字段' });
    for (let index = 0; index < 10; index += 1) fireEvent.click(addField);
    expect(addField).toHaveProperty('disabled', true);
    expect(screen.getByRole('status').textContent).toContain('字段 10/10');
    const addPrompt = screen.getByRole('button', { name: '添加提示选项' });
    for (let index = 0; index < 20; index += 1) fireEvent.click(addPrompt);
    expect(addPrompt).toHaveProperty('disabled', true);
    expect(screen.getAllByRole('status').some(node => node.textContent?.includes('提示选项 20/20'))).toBe(true);
  });

  it('does not offer shortcut maintenance without manage permission', () => {
    render(<SkillShortcutEditor skillId={SKILL_ID} canManage={false} />);
    expect(screen.getByRole('status').textContent).toMatch(/所有者或管理员/);
    expect(screen.queryByRole('button', { name: '保存快捷配置' })).toBeNull();
  });
  it('reports a malformed shortcut response without crashing the composer', async () => {
    listAvailableShortcuts.mockResolvedValue({});
    render(<ComposerHarness />);
    expect((await screen.findByRole('alert')).textContent).toContain('技能加载失败');
    expect(screen.getByRole('textbox',{name:'发送消息'})).toBeTruthy();
  });

});
