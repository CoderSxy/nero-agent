import type { SkillVersionSummary } from './types';

export type SkillVersionsProps = {
  versions: SkillVersionSummary[];
  publishedVersion: number | null;
  draftVersion: number | null;
  enabled: boolean;
  canEdit: boolean;
  canPublish: boolean;
  canManage: boolean;
  busy: boolean;
  onCreateDraft: () => void;
  onPublish: (version: number) => void;
  onRollback: (version: number) => void;
  onEnable: () => void;
  onDisable: () => void;
};

export function SkillVersions({
  versions,
  publishedVersion,
  draftVersion,
  enabled,
  canEdit,
  canPublish,
  canManage,
  busy,
  onCreateDraft,
  onPublish,
  onRollback,
  onEnable,
  onDisable,
}: SkillVersionsProps) {
  return <section className="skill-versions" aria-label="技能版本">
    <header className="skill-panel-header">
      <div>
        <h2>版本与发布</h2>
        <p className="skill-version-meta">
          工作版 {draftVersion ?? '无'}
          <span aria-hidden="true"> · </span>
          发布版 {publishedVersion ?? '未发布'}
          <span aria-hidden="true"> · </span>
          {enabled ? '已启用' : '未启用'}
        </p>
      </div>
      <div className="skill-panel-actions">
        {canEdit && !draftVersion ? (
          <button type="button" disabled={busy || publishedVersion == null} onClick={onCreateDraft}>
            创建草稿
          </button>
        ) : null}
        {canManage ? (
          enabled
            ? <button type="button" disabled={busy} onClick={onDisable}>禁用</button>
            : <button type="button" disabled={busy || publishedVersion == null} onClick={onEnable}>启用</button>
        ) : null}
      </div>
    </header>
    {versions.length === 0 ? <p className="skill-empty-hint">暂无版本</p> : (
      <ul className="skill-version-list">
        {versions.map(item => {
          const isPublishedPtr = publishedVersion === item.version;
          const isDraft = item.state === 'draft';
          return <li key={item.version}>
            <div>
              <strong>v{item.version}</strong>
              <span className="skill-version-badges">
                {item.state}
                {isPublishedPtr ? ' · 当前发布' : ''}
                {isDraft ? ' · 工作版' : ''}
              </span>
              <p>{item.description || '—'}</p>
              {item.storageHealth ? <p>存储 {item.storageHealth}</p> : null}
            </div>
            <div className="skill-version-actions">
              {canPublish && isDraft ? (
                <button type="button" disabled={busy} onClick={() => {
                  if (window.confirm(`确认发布 v${item.version}？保存草稿不会自动发布。`)) {
                    onPublish(item.version);
                  }
                }}>发布</button>
              ) : null}
              {canPublish && item.state === 'published' && !isPublishedPtr ? (
                <button type="button" disabled={busy} onClick={() => {
                  if (window.confirm(`确认回滚到 v${item.version}？`)) {
                    onRollback(item.version);
                  }
                }}>回滚</button>
              ) : null}
            </div>
          </li>;
        })}
      </ul>
    )}
  </section>;
}
