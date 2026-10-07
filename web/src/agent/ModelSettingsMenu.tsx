import { useState } from 'react';

export type Theme = 'light' | 'dark';

export function ModelSettingsMenu({ theme, onThemeChange, user, onLogout }: {
  theme: Theme; onThemeChange: (theme: Theme) => void;
  user?: { displayName: string; email: string }; onLogout?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  return <div className="settings-footer">
    {open && <div className="settings-popover" role="dialog" aria-label="设置">
      <div className="settings-heading">外观</div>
      <div className="theme-options" role="group" aria-label="主题">
        <button type="button" aria-pressed={theme === 'light'} onClick={() => onThemeChange('light')}>浅色</button>
        <button type="button" aria-pressed={theme === 'dark'} onClick={() => onThemeChange('dark')}>深色</button>
      </div>
      {onLogout && <><div className="settings-divider" />
        <button type="button" className="settings-logout" onClick={() => setConfirmLogout(true)}>退出登录</button></>}
    </div>}
    {user && <span className="settings-account" title={user.email}>{user.displayName}</span>}
    <button className="settings-trigger" type="button" aria-label="设置" aria-expanded={open} aria-haspopup="dialog"
      onClick={() => setOpen(value => !value)}>设置 <span className="settings-chevron">{open ? '⌄' : '⌃'}</span></button>
    {confirmLogout && <div className="thread-confirm-backdrop"><div className="thread-confirm" role="alertdialog"
      aria-modal="true" aria-label="确认退出登录">
      <h2>退出登录</h2><p>确定退出当前账号吗？</p>
      <div className="thread-confirm-actions">
        <button type="button" onClick={() => setConfirmLogout(false)}>取消</button>
        <button type="button" className="danger" onClick={() => onLogout?.()}>确认退出</button>
      </div>
    </div></div>}
  </div>;
}
