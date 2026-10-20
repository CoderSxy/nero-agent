import { useMemo, useState } from 'react';
import { commitSkillSync, exportSkillZip, previewSkillSync } from './skills-api';
import type { SkillDiffEntry, SkillSyncDiff, SkillVersionSummary } from './types';

export type SkillSyncDialogProps = {
  open: boolean;
  skillId: string;
  expectedRevision: string;
  canEdit: boolean;
  /** Maintainers may export any version. use-only is limited to the enabled release. */
  canMaintain: boolean;
  enabledVersion: number | null;
  versions: SkillVersionSummary[];
  onClose: () => void;
  onCommitted?: () => void;
};

export function SkillSyncDialog({
  open,
  skillId,
  expectedRevision,
  canEdit,
  canMaintain,
  enabledVersion,
  versions,
  onClose,
  onCommitted,
}: SkillSyncDialogProps) {
  const [diff, setDiff] = useState<SkillSyncDiff | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [exportVersion, setExportVersion] = useState<number | null>(
    canMaintain ? (versions[0]?.version ?? enabledVersion) : enabledVersion,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const includeDeletes = useMemo(() => {
    if (!diff) return false;
    return diff.entries.some(entry => entry.kind === 'delete' && picked.has(entry.path));
  }, [diff, picked]);

  if (!open) return null;

  function toggle(entry: SkillDiffEntry) {
    if (entry.kind === 'unchanged') return;
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  }

  async function onFile(file: File | undefined) {
    if (!file || !canEdit) return;
    setBusy(true);
    setError(null);
    try {
      const result = await previewSkillSync(skillId, file, expectedRevision);
      setDiff(result.diff);
      setPicked(new Set(result.diff.entries.filter(entry => entry.selected).map(entry => entry.path)));
    } catch (cause) {
      setDiff(null);
      setError(cause instanceof Error ? cause.message : '预览失败');
    } finally {
      setBusy(false);
    }
  }

  async function onCommit() {
    if (!diff || !canEdit) return;
    setBusy(true);
    setError(null);
    try {
      await commitSkillSync(skillId, diff.syncId, {
        expectedRevision,
        selectedPaths: [...picked],
        includeDeletes,
      });
      onCommitted?.();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '同步失败');
    } finally {
      setBusy(false);
    }
  }

  async function onExport() {
    if (exportVersion == null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await exportSkillZip(skillId, exportVersion);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '导出失败');
    } finally {
      setBusy(false);
    }
  }

  return <div className="skill-sync-dialog" role="dialog" aria-label="同步与导出">
    <header className="skill-panel-header">
      <div>
        <h2>同步与导出</h2>
        <p>同步只更新草稿。删除项默认不选，勾选后才会删除。不会自动发布。</p>
      </div>
      <button type="button" onClick={onClose}>关闭</button>
    </header>
    <section aria-label="版本拉取">
      {canMaintain ? (
        <label>拉取版本
          <select aria-label="拉取版本" value={exportVersion ?? ''}
            onChange={event => setExportVersion(Number(event.target.value))}>
            {versions.map(item => (
              <option key={item.version} value={item.version}>v{item.version} {item.state}</option>
            ))}
          </select>
        </label>
      ) : (
        <p>仅可导出当前启用版本 {enabledVersion ?? '无'}</p>
      )}
      <button type="button" disabled={busy || exportVersion == null} onClick={() => void onExport()}>
        拉取 ZIP
      </button>
    </section>
    {canEdit ? (
      <label>同步 ZIP
        <input aria-label="同步 ZIP" type="file" accept=".zip,application/zip" disabled={busy}
          onChange={event => void onFile(event.target.files?.[0])} />
      </label>
    ) : <p>当前无编辑权限，不能提交同步。</p>}
    {error ? <p role="alert">{error}</p> : null}
    {diff ? (
      <table className="skill-diff-table">
        <thead><tr><th>选择</th><th>路径</th><th>变更</th></tr></thead>
        <tbody>
          {diff.entries.map(entry => (
            <tr key={entry.path}>
              <td>
                <input
                  type="checkbox"
                  aria-label={`选择 ${entry.path}`}
                  checked={picked.has(entry.path)}
                  disabled={entry.kind === 'unchanged'}
                  onChange={() => toggle(entry)}
                />
              </td>
              <td>{entry.path}</td>
              <td>{entry.kind}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : null}
    {canEdit && diff ? (
      <button type="button" disabled={busy} onClick={() => void onCommit()}>提交选中文件到草稿</button>
    ) : null}
  </div>;
}
