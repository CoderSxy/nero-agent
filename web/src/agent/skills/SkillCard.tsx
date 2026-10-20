import type { MouseEvent } from 'react';
import { RichMarkdownRenderer } from '../markdown/markdown-renderer';
import type { SkillManageListItem } from './types';

function visibilityLabel(value: SkillManageListItem['visibility']): string {
  if (value === 'global') return '全局';
  if (value === 'restricted') return '受限';
  return '私有';
}

function statusLabel(item: SkillManageListItem): string {
  if (item.publishedVersion == null) return '草稿';
  return item.enabled ? `已发布 v${item.publishedVersion}` : `停用 · 已发布 v${item.publishedVersion}`;
}

export function SkillCard({
  item,
  groupLabel,
  expanded,
  preview,
  previewLoading,
  previewError,
  busy,
  onToggle,
  onEdit,
  onPublish,
  onEnable,
  onDisable,
  onOpenVersions,
  onOpenPermissions,
}: {
  item: SkillManageListItem;
  groupLabel: string;
  expanded: boolean;
  preview: string | null;
  previewLoading: boolean;
  previewError: string | null;
  busy: boolean;
  onToggle: () => void;
  onEdit?: () => void;
  onPublish?: () => void;
  onEnable?: () => void;
  onDisable?: () => void;
  onOpenVersions?: () => void;
  onOpenPermissions?: () => void;
}) {
  function stop(event: MouseEvent, run?: () => void) {
    event.stopPropagation();
    run?.();
  }
  return <article className="skill-card" data-skill-id={item.id}>
    <button type="button" className="skill-card-main" aria-expanded={expanded} onClick={onToggle}>
      <strong>{item.canonicalName}</strong>
      <span>{(item.description ?? '').trim() || '暂无描述'}</span>
      <small>{statusLabel(item)} · {visibilityLabel(item.visibility)} · {groupLabel}</small>
    </button>
    <div className="skill-card-actions">
      {onEdit ? <button type="button" aria-label={`编辑 ${item.canonicalName}`} disabled={busy}
        onClick={event => stop(event, onEdit)}>编辑</button> : null}
      {onOpenVersions ? <button type="button" aria-label={`版本 ${item.canonicalName}`} disabled={busy}
        onClick={event => stop(event, onOpenVersions)}>版本</button> : null}
      {onOpenPermissions ? <button type="button" aria-label={`权限 ${item.canonicalName}`} disabled={busy}
        onClick={event => stop(event, onOpenPermissions)}>权限</button> : null}
      {onPublish ? <button type="button" aria-label={`发布 ${item.canonicalName}`} disabled={busy} onClick={event => stop(event, onPublish)}>发布</button> : null}
      {onEnable ? <button type="button" disabled={busy} onClick={event => stop(event, onEnable)}>启用</button> : null}
      {onDisable ? <button type="button" disabled={busy} onClick={event => stop(event, onDisable)}>停用</button> : null}
    </div>
    {expanded ? <div className="skill-card-preview">
      {previewLoading ? <p role="status">正在加载预览…</p> : null}
      {previewError ? <p role="alert">{previewError}</p> : null}
      {preview != null ? <RichMarkdownRenderer>{preview}</RichMarkdownRenderer> : null}
    </div> : null}
  </article>;
}
