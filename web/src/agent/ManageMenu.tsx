import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { NavLink, useLocation } from 'react-router-dom';
import type { Theme } from './ModelSettingsMenu';

export type ManageEntry = {
  id: string;
  label: string;
  to?: string;
  adminOnly?: boolean;
};

export const MANAGE_ENTRIES: ManageEntry[] = [
  { id: 'skills', label: '技能管理', to: '/agent/skills' },
  { id: 'scheduled-tasks', label: '定时任务', to: '/scheduled-tasks', adminOnly: true },
  { id: 'appearance', label: '外观' },
  { id: 'logout', label: '退出登录' },
];

export function ManageMenu({ theme, onThemeChange, user, onLogout, isAdmin }: {
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  user?: { displayName: string; email: string };
  onLogout?: () => void;
  isAdmin?: boolean;
}) {
  const location = useLocation();
  const defaultOpen = location.pathname.startsWith('/scheduled-tasks')
    || location.pathname.startsWith('/agent/skills');
  const [open, setOpen] = useState(defaultOpen);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);

  useEffect(() => {
    if (location.pathname.startsWith('/scheduled-tasks')
      || location.pathname.startsWith('/agent/skills')) setOpen(true);
  }, [location.pathname]);

  const entries = MANAGE_ENTRIES.filter((entry) => !entry.adminOnly || isAdmin);

  return <div className="settings-footer manage-footer">
    {open && <div className="settings-popover manage-popover" role="menu" aria-label="管理">
      {entries.map((entry) => {
        if (entry.id === 'appearance') {
          return <div key={entry.id}>
            <button type="button" role="menuitem" className={appearanceOpen ? 'active' : undefined}
              aria-expanded={appearanceOpen}
              onClick={() => setAppearanceOpen((value) => !value)}>{entry.label}</button>
            {appearanceOpen && <div className="theme-options" role="group" aria-label="主题">
              <button type="button" aria-pressed={theme === 'light'} onClick={() => onThemeChange('light')}>浅色</button>
              <button type="button" aria-pressed={theme === 'dark'} onClick={() => onThemeChange('dark')}>深色</button>
            </div>}
          </div>;
        }
        if (entry.id === 'logout') {
          return onLogout ? <button key={entry.id} type="button" role="menuitem" className="settings-logout"
            onClick={() => setConfirmLogout(true)}>{entry.label}</button> : null;
        }
        if (entry.to) {
          return <NavLink key={entry.id} to={entry.to} role="menuitem"
            className={({ isActive }) => isActive ? 'active' : undefined}
            onClick={() => setOpen(true)}>{entry.label}</NavLink>;
        }
        return null;
      })}
    </div>}
    {user && <span className="settings-account" title={user.email}>{user.displayName}</span>}
    <button className="settings-trigger" type="button" aria-label="管理" aria-expanded={open} aria-haspopup="menu"
      onClick={() => setOpen((value) => !value)}>
      管理 <ChevronDown className={`settings-chevron${open ? '' : ' is-closed'}`} size={14} aria-hidden="true" />
    </button>
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
