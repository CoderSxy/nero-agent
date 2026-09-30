import { useState } from 'react';
import type { ModelProvider, ModelSettings } from './model-settings';
import { providerModelIds } from './model-settings';

export type Theme = 'light' | 'dark';

export function ModelSettingsMenu({ models, providers, theme, onModelsChange, onThemeChange, disabled = false,
  error }: {
  models: ModelSettings; providers: ModelProvider[]; theme: Theme;
  onModelsChange: (models: ModelSettings) => void; onThemeChange: (theme: Theme) => void;
  disabled?: boolean; error?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const connected = providerModelIds(providers);
  const options = [...new Set([...connected, models.chatModel, models.memoryModel].filter(Boolean))];
  return <div className="settings-footer">
    {open && <div className="settings-popover" role="dialog" aria-label="设置">
      <div className="settings-heading">模型配置</div>
      <label htmlFor="chat-model">会话模型</label>
      <select id="chat-model" aria-label="会话模型" value={models.chatModel} disabled={disabled}
        onChange={event => onModelsChange({ ...models, chatModel: event.target.value })}>
        {options.map(id => <option value={id} key={id}>{id}{connected.includes(id) ? '' : ' · 未连接'}</option>)}
      </select>
      <label htmlFor="memory-model">记忆模型</label>
      <select id="memory-model" aria-label="记忆模型" value={models.memoryModel} disabled={disabled}
        onChange={event => onModelsChange({ ...models, memoryModel: event.target.value })}>
        {options.map(id => <option value={id} key={id}>{id}{connected.includes(id) ? '' : ' · 未连接'}</option>)}
      </select>
      <p className="settings-help">修改后从下一条消息开始生效。</p>
      {error && <p className="error" role="alert">{error}</p>}
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
