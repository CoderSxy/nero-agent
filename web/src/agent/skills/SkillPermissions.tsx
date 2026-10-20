import { useState } from 'react';
import type { SkillGrantInput, SkillGrantPermission, SkillGroupRecord, SkillVisibility } from './types';

export type SkillPermissionsProps = {
  visibility: SkillVisibility;
  groupId: string | null;
  groups: SkillGroupRecord[];
  grants: SkillGrantInput[];
  canManage: boolean;
  busy: boolean;
  onSave: (input: {
    visibility: SkillVisibility;
    groupId: string | null;
    grants: SkillGrantInput[];
  }) => void;
};

const PERMS: SkillGrantPermission[] = ['use', 'edit', 'publish'];

export function SkillPermissions({
  visibility,
  groupId,
  groups,
  grants: initialGrants,
  canManage,
  busy,
  onSave,
}: SkillPermissionsProps) {
  const [nextVisibility, setNextVisibility] = useState<SkillVisibility>(visibility);
  const [nextGroupId, setNextGroupId] = useState<string>(groupId ?? '');
  const [grants, setGrants] = useState<SkillGrantInput[]>(initialGrants);
  const [userId, setUserId] = useState('');
  const [permission, setPermission] = useState<SkillGrantPermission>('use');

  return <section className="skill-permissions" aria-label="技能权限">
    <header className="skill-panel-header">
      <div>
        <h2>权限与可见性</h2>
        <p className="skill-version-meta">保存会携带 revision；授权变更替换整组 grants。</p>
      </div>
    </header>
    {!canManage ? <p role="status">仅 owner/admin 可修改可见性与授权。</p> : (
      <form className="skill-permissions-form" onSubmit={event => {
        event.preventDefault();
        onSave({
          visibility: nextVisibility,
          groupId: nextGroupId || null,
          grants,
        });
      }}>
        <label>
          可见性
          <select
            aria-label="可见性"
            value={nextVisibility}
            disabled={busy}
            onChange={event => setNextVisibility(event.target.value as SkillVisibility)}
          >
            <option value="private">private</option>
            <option value="restricted">restricted</option>
            <option value="global">global（仅 admin）</option>
          </select>
        </label>
        <label>
          分类
          <select
            aria-label="分类"
            value={nextGroupId}
            disabled={busy}
            onChange={event => setNextGroupId(event.target.value)}
          >
            <option value="">未分类</option>
            {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
        </label>
        <fieldset className="skill-grant-fieldset">
          <legend>用户授权</legend>
          <div className="skill-grant-add">
            <input
              aria-label="授权用户 ID"
              placeholder="user UUID"
              value={userId}
              disabled={busy}
              onChange={event => setUserId(event.target.value)}
            />
            <select
              aria-label="授权权限"
              value={permission}
              disabled={busy}
              onChange={event => setPermission(event.target.value as SkillGrantPermission)}
            >
              {PERMS.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
            <button type="button" disabled={busy || !userId.trim()} onClick={() => {
              const id = userId.trim();
              setGrants(prev => [...prev.filter(g => !(g.userId === id && g.permission === permission)),
                { userId: id, permission }]);
              setUserId('');
            }}>添加</button>
          </div>
          <ul className="skill-grant-list">
            {grants.length === 0 ? <li className="skill-empty-hint">尚未添加授权行</li> : null}
            {grants.map(grant => <li key={`${grant.userId}:${grant.permission}`}>
              <span>{grant.userId} · {grant.permission}</span>
              <button type="button" disabled={busy} onClick={() => {
                setGrants(prev => prev.filter(g =>
                  !(g.userId === grant.userId && g.permission === grant.permission)));
              }}>移除</button>
            </li>)}
          </ul>
        </fieldset>
        <button type="submit" disabled={busy}>保存权限</button>
      </form>
    )}
  </section>;
}
