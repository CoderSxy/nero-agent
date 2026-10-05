import { useState } from 'react';

export type Theme = 'light' | 'dark';

export function ModelSettingsMenu({ theme, onThemeChange }: {
  theme: Theme; onThemeChange: (theme: Theme) => void;
}) {
  const [open, setOpen] = useState(false);
  return <div className="settings-footer">
    {open && <div className="settings-popover" role="dialog" aria-label="设置">
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
