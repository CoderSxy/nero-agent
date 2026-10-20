import { useEffect, useState } from 'react';
import {
  renderShortcutMessage,
  SHORTCUT_FIELD_TYPES,
  SHORTCUT_LIMITS,
  validateShortcut,
  type ShortcutField,
  type ShortcutFieldType,
  type ShortcutPrompt,
} from '../../../../src/mastra/skills/shortcuts';
import { getSkillShortcut, listAvailableShortcuts, putSkillShortcut } from './skills-api';
import { toSkillUiState } from './skill-ui-state';
import type { SkillShortcutAvailable, SkillShortcutRecord } from './types';

export type ShortcutApplyResult = {
  skillId: string;
  text: string;
};

function emptyValues(fields: ShortcutField[]): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (const field of fields) values[field.key] = field.type === 'boolean' ? false : '';
  return values;
}

function rawValues(fields: ShortcutField[], values: Record<string, string | boolean>): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.key];
    if (field.type === 'boolean') raw[field.key] = value === true;
    else if (field.type === 'number') raw[field.key] = typeof value === 'string' ? value : '';
    else raw[field.key] = typeof value === 'string' ? value : '';
  }
  return raw;
}

export function SkillShortcutForm({
  shortcut,
  disabled = false,
  onApply,
  onCancel,
}: {
  shortcut: Pick<SkillShortcutAvailable, 'skillId' | 'label' | 'fields' | 'prompts'>;
  disabled?: boolean;
  onApply: (result: ShortcutApplyResult) => void;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState(() => emptyValues(shortcut.fields));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValues(emptyValues(shortcut.fields));
    setError(null);
  }, [shortcut]);

  function apply(template: string) {
    try {
      const text = renderShortcutMessage(shortcut.fields, template, rawValues(shortcut.fields, values));
      setError(null);
      onApply({ skillId: shortcut.skillId, text });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '参数无效');
    }
  }

  return <section className="skill-shortcut-form" aria-label={`${shortcut.label} 参数`}>
    <strong>{shortcut.label}</strong>
    {shortcut.fields.map(field => <label key={field.key}>
      {field.label}{field.required ? '（必填）' : ''}
      {field.type === 'textarea' ? <textarea aria-label={field.label} disabled={disabled} value={String(values[field.key] ?? '')}
        onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))} /> : null}
      {field.type === 'text' ? <input aria-label={field.label} disabled={disabled} value={String(values[field.key] ?? '')}
        onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))} /> : null}
      {field.type === 'number' ? <input aria-label={field.label} type="number" disabled={disabled}
        min={field.min} max={field.max} value={String(values[field.key] ?? '')}
        onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))} /> : null}
      {field.type === 'boolean' ? <input aria-label={field.label} type="checkbox" disabled={disabled}
        checked={values[field.key] === true}
        onChange={event => setValues(current => ({ ...current, [field.key]: event.target.checked }))} /> : null}
      {field.type === 'select' ? <select aria-label={field.label} disabled={disabled} value={String(values[field.key] ?? '')}
        onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))}>
        <option value="">请选择</option>
        {(field.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}
      </select> : null}
    </label>)}
    {error ? <p role="alert">{error}</p> : null}
    <div className="skill-shortcut-actions">
      {shortcut.prompts.map(prompt => <button key={prompt.label} type="button" disabled={disabled}
        onClick={() => apply(prompt.template)}>{prompt.label}</button>)}
      {onCancel ? <button type="button" onClick={onCancel}>取消</button> : null}
    </div>
  </section>;
}

export function SkillShortcutDock({
  disabled = false,
  scopeKey = '',
  suppressStatus = false,
  onApply,
}: {
  disabled?: boolean;
  scopeKey?: string;
  suppressStatus?: boolean;
  onApply: (result: ShortcutApplyResult) => void;
}) {
  const [items, setItems] = useState<SkillShortcutAvailable[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const active = items.find(item => item.id === activeId) ?? null;

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void listAvailableShortcuts(controller.signal)
      .then(page => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(page.items)) throw new Error('技能快捷入口响应格式错误');
        setItems(page.items);
        setActiveId(current => page.items.some(item => item.id === current) ? current : null);
      })
      .catch(cause => {
        if (controller.signal.aborted) return;
        setError(toSkillUiState(cause).message);
      });
    return () => controller.abort();
  }, [scopeKey, nonce]);

  if (!error && items.length === 0) return null;
  return <div className="composer-shortcut-row" aria-label="技能快捷入口">
    {items.map(item => <button key={item.id} type="button" disabled={disabled}
      aria-pressed={item.id === activeId} onClick={() => setActiveId(item.id)}>
      {item.label}
    </button>)}
    <button type="button" aria-label="快捷入口菜单" aria-haspopup="menu" aria-expanded={menuOpen}
      disabled={disabled} onClick={() => setMenuOpen(open => !open)}>⋯</button>
    {menuOpen && <div role="menu" aria-label="快捷入口操作">
      <button type="button" role="menuitem" disabled={disabled} onClick={() => {
        setMenuOpen(false);
        setNonce(value => value + 1);
      }}>刷新快捷入口</button>
    </div>}
    {error && !suppressStatus ? <p role="alert">{error}</p> : null}
    {active ? <SkillShortcutForm shortcut={active} disabled={disabled} onCancel={() => setActiveId(null)}
      onApply={result => { onApply(result); setActiveId(null); }} /> : null}
  </div>;
}

function blankField(index: number): ShortcutField {
  return { key: `field${index}`, label: `字段${index}`, type: 'text', required: false };
}

function cleanField(field: ShortcutField): ShortcutField {
  const base: ShortcutField = {
    key: field.key.trim(),
    label: field.label.trim(),
    type: field.type,
    required: field.required,
  };
  if (field.type === 'number') {
    if (field.min !== undefined && field.min !== ('' as unknown)) base.min = Number(field.min);
    if (field.max !== undefined && field.max !== ('' as unknown)) base.max = Number(field.max);
    if (Number.isNaN(base.min)) delete base.min;
    if (Number.isNaN(base.max)) delete base.max;
  }
  if (field.type === 'select') base.options = (field.options ?? []).map(option => option.trim()).filter(Boolean);
  return base;
}

export function SkillShortcutEditor({
  skillId,
  canManage,
}: {
  skillId: string;
  canManage: boolean;
}) {
  const [label, setLabel] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [sort, setSort] = useState('0');
  const [fields, setFields] = useState<ShortcutField[]>([]);
  const [prompts, setPrompts] = useState<ShortcutPrompt[]>([]);
  const [revision, setRevision] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!canManage) return undefined;
    let active = true;
    setLoading(true);
    setError(null);
    void getSkillShortcut(skillId)
      .then(result => {
        if (!active) return;
        applyRecord(result.shortcut);
      })
      .catch(cause => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : '快捷配置加载失败');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [skillId, canManage]);

  function applyRecord(shortcut: SkillShortcutRecord | null) {
    setLabel(shortcut?.label ?? '');
    setEnabled(shortcut?.enabled ?? true);
    setSort(String(shortcut?.sort ?? 0));
    setFields(shortcut?.fields ?? []);
    setPrompts(shortcut?.prompts ?? []);
    setRevision(shortcut?.revision ?? '0');
  }

  async function save() {
    setError(null);
    setStatus(null);
    try {
      const config = validateShortcut({
        label,
        enabled,
        sort: Number(sort),
        fields: fields.map(cleanField),
        prompts: prompts.map(prompt => ({ label: prompt.label.trim(), template: prompt.template })),
      });
      const saved = await putSkillShortcut(skillId, { expectedRevision: revision, ...config });
      applyRecord(saved.shortcut);
      setStatus('已保存快捷配置。配置不会授予技能使用权限。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    }
  }

  if (!canManage) return <p role="status">只有技能所有者或管理员可以维护快捷配置。</p>;
  return <section className="skill-shortcut-editor" aria-label="快捷配置">
    {loading ? <p role="status">加载快捷配置…</p> : null}
    <label>入口名称
      <input aria-label="入口名称" value={label} maxLength={SHORTCUT_LIMITS.LABEL_MAX}
        onChange={event => setLabel(event.target.value)} />
    </label>
    <label>排序
      <input aria-label="排序" value={sort} onChange={event => setSort(event.target.value)} />
    </label>
    <label><input aria-label="启用快捷入口" type="checkbox" checked={enabled}
      onChange={event => setEnabled(event.target.checked)} /> 启用快捷入口</label>
    <div className="skill-shortcut-actions">
      <button type="button" disabled={fields.length >= SHORTCUT_LIMITS.MAX_FIELDS}
        onClick={() => setFields(current => [...current, blankField(current.length + 1)])}>添加字段</button>
      <button type="button" disabled={prompts.length >= SHORTCUT_LIMITS.MAX_PROMPTS}
        onClick={() => setPrompts(current => [...current, { label: `选项${current.length + 1}`, template: '' }])}>添加提示选项</button>
    </div>
    <p role="status">字段 {fields.length}/{SHORTCUT_LIMITS.MAX_FIELDS}，提示选项 {prompts.length}/{SHORTCUT_LIMITS.MAX_PROMPTS}</p>
    {fields.map((field, index) => <fieldset key={`${field.key}-${index}`}>
      <legend>字段 {index + 1}</legend>
      <label>key <input aria-label={`字段${index + 1} key`} value={field.key}
        onChange={event => setFields(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, key: event.target.value } : item))} /></label>
      <label>名称 <input aria-label={`字段${index + 1} 名称`} value={field.label}
        onChange={event => setFields(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} /></label>
      <label>类型 <select aria-label={`字段${index + 1} 类型`} value={field.type}
        onChange={event => setFields(current => current.map((item, itemIndex) => itemIndex === index
          ? { ...item, type: event.target.value as ShortcutFieldType, options: event.target.value === 'select' ? item.options ?? [''] : undefined }
          : item))}>
        {SHORTCUT_FIELD_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
      </select></label>
      <label><input aria-label={`字段${index + 1} 必填`} type="checkbox" checked={field.required}
        onChange={event => setFields(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, required: event.target.checked } : item))} /> 必填</label>
      {field.type === 'number' ? <>
        <label>下限 <input aria-label={`字段${index + 1} 下限`} value={field.min ?? ''}
          onChange={event => setFields(current => current.map((item, itemIndex) => itemIndex === index
            ? { ...item, min: event.target.value === '' ? undefined : Number(event.target.value) } : item))} /></label>
        <label>上限 <input aria-label={`字段${index + 1} 上限`} value={field.max ?? ''}
          onChange={event => setFields(current => current.map((item, itemIndex) => itemIndex === index
            ? { ...item, max: event.target.value === '' ? undefined : Number(event.target.value) } : item))} /></label>
      </> : null}
      {field.type === 'select' ? <label>选项（每行一个）
        <textarea aria-label={`字段${index + 1} 选项`} value={(field.options ?? []).join('\n')}
          onChange={event => setFields(current => current.map((item, itemIndex) => itemIndex === index
            ? { ...item, options: event.target.value.split('\n') } : item))} />
      </label> : null}
      <button type="button" onClick={() => setFields(current => current.filter((_, itemIndex) => itemIndex !== index))}>删除字段</button>
    </fieldset>)}
    {prompts.map((prompt, index) => <fieldset key={`prompt-${index}`}>
      <legend>提示选项 {index + 1}</legend>
      <label>名称 <input aria-label={`提示选项${index + 1} 名称`} value={prompt.label}
        onChange={event => setPrompts(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} /></label>
      <label>模板 <textarea aria-label={`提示选项${index + 1} 模板`} value={prompt.template}
        onChange={event => setPrompts(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, template: event.target.value } : item))} /></label>
      <button type="button" onClick={() => setPrompts(current => current.filter((_, itemIndex) => itemIndex !== index))}>删除提示选项</button>
    </fieldset>)}
    {error ? <p role="alert">{error}</p> : null}
    {status ? <p role="status">{status}</p> : null}
    <button type="button" onClick={() => void save()}>保存快捷配置</button>
  </section>;
}
