import { useState } from 'react';
import type { ModelRef, SafeModel } from './model-catalog-client';
import type { ModelSettings } from './model-settings';
import { PrivateModelMenu } from './PrivateModelMenu';

export type Theme = 'light' | 'dark';

function ModelSelect({ id, label, value, catalog, disabled, onChange }: {
  id: string; label: string; value?: ModelRef; catalog: SafeModel[]; disabled: boolean;
  onChange: (ref: ModelRef) => void;
}) {
  const available = value !== undefined && catalog.some(model => model.ref === value);
  const groups = [['public', '公共模型'], ['private', '我的模型']] as const;
  return <select id={id} aria-label={label} value={available ? value : ''} disabled={disabled}
    onChange={event => onChange(event.target.value as ModelRef)}>
    {!available && <option value="" disabled>模型不可用，请重新选择</option>}
    {groups.map(([scope, title]) => {
      const items = catalog.filter(model => model.scope === scope);
      return items.length > 0 && <optgroup label={title} key={scope}>
        {items.map(model => <option value={model.ref} key={model.ref}>
          {model.displayName} · {model.providerId}/{model.modelId}</option>)}
      </optgroup>;
    })}
  </select>;
}

export function ModelSettingsMenu({ models, catalog, theme, onModelsChange, onThemeChange, onCatalogChange,
  disabled = false, error }: {
  models: Partial<ModelSettings>; catalog: SafeModel[]; theme: Theme;
  onModelsChange: (models: ModelSettings) => void; onThemeChange: (theme: Theme) => void;
  onCatalogChange?: () => void | Promise<void>;
  disabled?: boolean; error?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'main' | 'private'>('main');
  const unavailable = catalog.length > 0 && (!models.chatModel || !models.memoryModel
    || !catalog.some(model => model.ref === models.chatModel) || !catalog.some(model => model.ref === models.memoryModel));
  const [pending, setPending] = useState<Partial<ModelSettings>>({});
  const choose = (field: keyof ModelSettings) => (ref: ModelRef) => {
    const next = { ...models, ...pending, [field]: ref };
    if (next.chatModel && next.memoryModel) {
      setPending({});
      onModelsChange({ chatModel: next.chatModel, memoryModel: next.memoryModel });
    } else setPending(next);
  };
  return <div className="settings-footer">
    {open && view === 'private' && <div className="settings-popover" role="dialog" aria-label="API Key 管理">
      <PrivateModelMenu onBack={() => setView('main')} onChanged={() => onCatalogChange?.()} />
    </div>}
    {open && view === 'main' && <div className="settings-popover" role="dialog" aria-label="设置">
      <div className="settings-heading">模型配置</div>
      <label htmlFor="chat-model">会话模型</label>
      <ModelSelect id="chat-model" label="会话模型" value={pending.chatModel ?? models.chatModel} catalog={catalog}
        disabled={disabled} onChange={choose('chatModel')} />
      <label htmlFor="memory-model">记忆模型</label>
      <ModelSelect id="memory-model" label="记忆模型" value={pending.memoryModel ?? models.memoryModel} catalog={catalog}
        disabled={disabled} onChange={choose('memoryModel')} />
      <p className="settings-help">修改后从下一条消息开始生效。</p>
      {unavailable && <p className="settings-help" role="status">当前模型不可用，请重新选择模型。</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <button type="button" className="settings-link" onClick={() => setView('private')}>API Key 管理</button>
      <div className="settings-divider" />
      <div className="settings-heading">外观</div>
      <div className="theme-options" role="group" aria-label="主题">
        <button type="button" aria-pressed={theme === 'light'} onClick={() => onThemeChange('light')}>浅色</button>
        <button type="button" aria-pressed={theme === 'dark'} onClick={() => onThemeChange('dark')}>深色</button>
      </div>
    </div>}
    <button className="settings-trigger" type="button" aria-label="设置" aria-expanded={open} aria-haspopup="dialog"
      onClick={() => setOpen(value => !value)}><span aria-hidden="true">⚙</span> 设置 <span className="settings-chevron">{open ? '⌄' : '⌃'}</span></button>
  </div>;
}
