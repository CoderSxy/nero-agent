import { useEffect, useState, type FormEvent } from 'react';
import { createPrivateModel, deletePrivateModel, listPrivateModels, updatePrivateModel,
  type ApiMode, type PrivateModelInput, type SafeModel } from './model-catalog-client';

interface Draft { displayName: string; providerId: string; modelId: string; baseUrl: string;
  apiMode: ApiMode; enabled: boolean; apiKey: string }

const emptyDraft: Draft = { displayName: '', providerId: '', modelId: '', baseUrl: '', apiMode: 'chat',
  enabled: true, apiKey: '' };

function draftOf(model: SafeModel): Draft {
  return { displayName: model.displayName, providerId: model.providerId, modelId: model.modelId,
    baseUrl: model.baseUrl, apiMode: model.apiMode, enabled: model.enabled, apiKey: '' };
}

function message(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

export function PrivateModelMenu({ onBack, onChanged }: {
  onBack: () => void; onChanged: () => void | Promise<void>;
}) {
  const [models, setModels] = useState<SafeModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ ref: SafeModel['ref'] | null; draft: Draft } | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const [confirmRef, setConfirmRef] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listPrivateModels().then(list => { if (active) setModels(list); })
      .catch(cause => { if (active) { setModels([]); setError(message(cause, '加载我的模型失败')); } });
    return () => { active = false; };
  }, []);

  async function notify() {
    try { await onChanged(); } catch { /* The parent reports catalog refresh failures. */ }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form || saving) return;
    const { draft } = form;
    setSaving(true); setError(null);
    try {
      if (form.ref) {
        const { apiKey, ...rest } = draft;
        const saved = await updatePrivateModel(form.ref, apiKey ? { ...rest, apiKey } : rest);
        setModels(list => (list ?? []).map(model => model.ref === saved.ref ? saved : model));
      } else {
        const input: PrivateModelInput = { ...draft };
        const saved = await createPrivateModel(input);
        setModels(list => [...(list ?? []), saved]);
      }
      setForm(null);
      await notify();
    } catch (cause) { setError(message(cause, '保存模型失败')); }
    finally { setSaving(false); }
  }

  async function toggle(model: SafeModel) {
    setBusyRef(model.ref); setError(null);
    try {
      const saved = await updatePrivateModel(model.ref, { enabled: !model.enabled });
      setModels(list => (list ?? []).map(item => item.ref === saved.ref ? saved : item));
      await notify();
    } catch (cause) { setError(message(cause, '保存模型失败')); }
    finally { setBusyRef(null); }
  }

  async function remove(model: SafeModel) {
    setBusyRef(model.ref); setError(null);
    try {
      await deletePrivateModel(model.ref);
      setModels(list => (list ?? []).filter(item => item.ref !== model.ref));
      setConfirmRef(null);
      await notify();
    } catch (cause) { setError(message(cause, '删除模型失败')); }
    finally { setBusyRef(null); }
  }

  const field = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setForm(current => current && { ...current, draft: { ...current.draft, [key]: value } });

  return <div className="private-models">
    <div className="settings-heading private-title">
      <button type="button" className="private-back" aria-label="返回设置" onClick={onBack}>‹</button>
      <span>设置 → API Key 管理</span>
    </div>
    <p className="settings-help">API Key 仅在提交时发送，保存后不再显示。</p>
    {error && <p className="error" role="alert">{error}</p>}
    {models === null ? <p className="muted settings-help">加载中…</p> : models.length === 0 && !form ?
      <p className="muted settings-help">还没有自己的模型</p> :
      <ul className="private-list">
        {models.map(model => <li key={model.ref} className="private-item">
          <div className="private-meta">
            <span className="private-name">{model.displayName}</span>
            {!model.enabled && <span className="private-badge">已停用</span>}
            <span className="settings-help">{model.providerId}/{model.modelId}</span>
            <span className="settings-help">Key ····{model.keyHint ?? ''}</span>
          </div>
          {confirmRef === model.ref ? <div className="private-actions">
            <button type="button" className="danger" disabled={busyRef === model.ref}
              onClick={() => void remove(model)}>确认删除</button>
            <button type="button" onClick={() => setConfirmRef(null)}>取消删除</button>
          </div> : <div className="private-actions">
            <button type="button" aria-label={`编辑 ${model.displayName}`} disabled={busyRef === model.ref}
              onClick={() => { setForm({ ref: model.ref, draft: draftOf(model) }); setConfirmRef(null); setError(null); }}>编辑</button>
            <button type="button" aria-label={`${model.enabled ? '停用' : '启用'} ${model.displayName}`}
              disabled={busyRef === model.ref} onClick={() => void toggle(model)}>{model.enabled ? '停用' : '启用'}</button>
            <button type="button" aria-label={`删除 ${model.displayName}`} disabled={busyRef === model.ref}
              onClick={() => setConfirmRef(model.ref)}>删除</button>
          </div>}
        </li>)}
      </ul>}
    {form ? <form className="private-form" onSubmit={event => void submit(event)}>
      <label htmlFor="pm-name">显示名称</label>
      <input id="pm-name" required maxLength={80} value={form.draft.displayName} disabled={saving}
        onChange={event => field('displayName', event.target.value)} />
      <label htmlFor="pm-provider">Provider ID</label>
      <input id="pm-provider" required value={form.draft.providerId} disabled={saving}
        onChange={event => field('providerId', event.target.value)} />
      <label htmlFor="pm-model">Model ID</label>
      <input id="pm-model" required value={form.draft.modelId} disabled={saving}
        onChange={event => field('modelId', event.target.value)} />
      <label htmlFor="pm-url">Base URL</label>
      <input id="pm-url" required type="url" placeholder="https://" value={form.draft.baseUrl} disabled={saving}
        onChange={event => field('baseUrl', event.target.value)} />
      <label htmlFor="pm-mode">API 模式</label>
      <select id="pm-mode" value={form.draft.apiMode} disabled={saving}
        onChange={event => field('apiMode', event.target.value as ApiMode)}>
        <option value="chat">chat</option>
        <option value="responses">responses</option>
      </select>
      <label htmlFor="pm-key">API Key</label>
      <input id="pm-key" type="password" autoComplete="off" required={!form.ref} value={form.draft.apiKey}
        placeholder={form.ref ? '留空则保留原 Key' : ''} disabled={saving}
        onChange={event => field('apiKey', event.target.value)} />
      <label className="private-check"><input type="checkbox" checked={form.draft.enabled} disabled={saving}
        onChange={event => field('enabled', event.target.checked)} /> 启用</label>
      <div className="private-actions">
        <button type="submit" disabled={saving}>{saving ? '保存中…' : '保存'}</button>
        <button type="button" disabled={saving} onClick={() => { setForm(null); setError(null); }}>取消</button>
      </div>
    </form> : <button type="button" className="private-add" disabled={models === null}
      onClick={() => { setForm({ ref: null, draft: emptyDraft }); setError(null); }}>添加模型</button>}
  </div>;
}
