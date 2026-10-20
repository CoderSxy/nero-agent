import { useState } from 'react';
import { SkillApiError, commitSkillImport, previewSkillImport } from './skills-api';
import type { SkillImportReport } from './types';

export type SkillImportDialogProps = {
  open: boolean;
  onClose: () => void;
  onCommitted?: (skillId: string) => void;
};

export function SkillImportDialog({ open, onClose, onCommitted }: SkillImportDialogProps) {
  const [report, setReport] = useState<SkillImportReport | null>(null);
  const [acceptedName, setAcceptedName] = useState('');
  const [alias, setAlias] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const result = await previewSkillImport(file);
      setReport(result.report);
      setAcceptedName(result.report.requiresNameAcceptance
        ? result.report.suggestedCanonicalName
        : result.report.canonicalName);
    } catch (cause) {
      setReport(null);
      setError(cause instanceof Error ? cause.message : '预览失败');
    } finally {
      setBusy(false);
    }
  }

  async function onCommit() {
    if (!report || !acceptedName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await commitSkillImport(report.importId, {
        acceptedName: acceptedName.trim(),
        ...(alias.trim() ? { alias: alias.trim() } : {}),
      });
      onCommitted?.(result.skill.id);
      onClose();
    } catch (cause) {
      if (cause instanceof SkillApiError && (cause.status === 409 || cause.status === 410)) {
        setError(`${cause.message}（预览未写入草稿）`);
      } else {
        setError(cause instanceof Error ? cause.message : '导入失败');
      }
    } finally {
      setBusy(false);
    }
  }

  return <div className="skill-sync-dialog" role="dialog" aria-label="导入技能包">
    <header className="skill-panel-header">
      <div>
        <h2>导入技能包</h2>
        <p>只创建未启用的草稿，不会自动发布。</p>
      </div>
      <button type="button" onClick={onClose}>关闭</button>
    </header>
    <label>ZIP
      <input aria-label="导入 ZIP" type="file" accept=".zip,application/zip" disabled={busy}
        onChange={event => void onFile(event.target.files?.[0])} />
    </label>
    {error ? <p role="alert">{error}</p> : null}
    {report ? <>
      <p>来源名 {report.sourceName} · 建议规范名 {report.suggestedCanonicalName} · 兼容 {report.compatibility}</p>
      {report.warnings.map(warning => <p key={warning}>{warning}</p>)}
      {report.referenceRenameRisks.length > 0 ? (
        <ul className="skill-rename-risk" aria-label="改名引用风险">
          {report.referenceRenameRisks.map(risk => (
            <li key={`${risk.path}:${risk.message}`}><strong>{risk.path}</strong> {risk.message}</li>
          ))}
        </ul>
      ) : null}
      <ul aria-label="导入文件">
        {report.files.map(file => <li key={file.path}>{file.path}</li>)}
      </ul>
      <label>接受的规范名
        <input aria-label="接受的规范名" value={acceptedName} onChange={event => setAcceptedName(event.target.value)} />
      </label>
      <label>别名（可选）
        <input aria-label="导入别名" value={alias} onChange={event => setAlias(event.target.value)} />
      </label>
      <button type="button" disabled={busy || !acceptedName.trim()} onClick={() => void onCommit()}>
        确认导入草稿
      </button>
    </> : null}
  </div>;
}
