import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export type SkillEditorProps = {
  skillMd: string;
  onChange: (next: string) => void;
  canEdit: boolean;
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
  onSave: () => void;
  onReload: () => void;
  workingVersion: number | null;
  publishedVersion: number | null;
  canConfigureShortcut?: boolean;
  onConfigureShortcut?: () => void;
};

export function SkillEditor({
  skillMd,
  onChange,
  canEdit,
  dirty,
  saving,
  conflict,
  onSave,
  onReload,
  workingVersion,
  publishedVersion,
  canConfigureShortcut = false,
  onConfigureShortcut,
}: SkillEditorProps) {
  const [preview, setPreview] = useState(false);
  return <section className="skill-editor" aria-label="技能正文编辑">
    <header className="skill-panel-header">
      <div>
        <h2>SKILL.md</h2>
        <p className="skill-version-meta">
          工作版 {workingVersion ?? '—'}
          <span aria-hidden="true"> · </span>
          当前发布版 {publishedVersion ?? '未发布'}
          {dirty ? <span className="skill-dirty-mark"> · 未保存</span> : null}
        </p>
      </div>
      <div className="skill-panel-actions">
        <div className="workspace-preview-switch" role="group" aria-label="正文视图">
          <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>源码</button>
          <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>预览</button>
        </div>
        {conflict ? <button type="button" onClick={onReload}>重新加载</button> : null}
        <button type="button" disabled={!canEdit || !dirty || saving} onClick={onSave}>
          {saving ? '保存中…' : '保存草稿'}
        </button>
        {canConfigureShortcut ? <button type="button" onClick={onConfigureShortcut}>快捷入口</button> : null}
      </div>
    </header>
    {conflict ? <p role="alert" className="skill-conflict">版本冲突：已保留本地未保存正文，可重新加载或再次保存。</p> : null}
    {!canEdit ? <p role="status" className="skill-readonly-note">当前无编辑权限，正文只读。</p> : null}
    <div className="skill-editor-body">
      {preview ? (
        <div className="workspace-markdown-preview skill-md-preview">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{skillMd}</ReactMarkdown>
        </div>
      ) : (
        <textarea
          aria-label="技能正文"
          className="skill-md-textarea"
          value={skillMd}
          readOnly={!canEdit}
          onChange={event => { if (canEdit) onChange(event.target.value); }}
        />
      )}
    </div>
  </section>;
}
