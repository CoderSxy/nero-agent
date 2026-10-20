import { useRef, useState } from 'react';
import type { SkillFileRecord } from './types';

export type SkillFilesProps = {
  files: SkillFileRecord[];
  version: number | null;
  canEdit: boolean;
  busy: boolean;
  onUpload: (path: string, file: File) => void;
  onDelete: (path: string) => void;
  onDownload: (path: string, isText: boolean) => void;
};

export function SkillFiles({
  files,
  version,
  canEdit,
  busy,
  onUpload,
  onDelete,
  onDownload,
}: SkillFilesProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploadPath, setUploadPath] = useState('references/');

  return <section className="skill-files" aria-label="技能资源树">
    <header className="skill-panel-header">
      <div>
        <h2>资源文件</h2>
        <p className="skill-version-meta">版本 {version ?? '—'}</p>
      </div>
    </header>
    {canEdit ? <div className="skill-files-upload">
      <label>
        上传路径
        <input
          aria-label="上传路径"
          value={uploadPath}
          onChange={event => setUploadPath(event.target.value)}
          disabled={busy}
        />
      </label>
      <input
        ref={inputRef}
        type="file"
        hidden
        aria-label="选择上传文件"
        onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          const base = uploadPath.trim().replace(/\/?$/, '/');
          const path = uploadPath.includes('.') && !uploadPath.endsWith('/')
            ? uploadPath.trim()
            : `${base}${file.name}`;
          onUpload(path.replace(/^\//, ''), file);
        }}
      />
      <button type="button" disabled={busy || !version} onClick={() => inputRef.current?.click()}>
        上传文件
      </button>
    </div> : null}
    {files.length === 0 ? <p className="skill-empty-hint">暂无资源文件</p> : (
      <ul className="skill-file-list">
        {files.map(file => <li key={file.path}>
          <span className="skill-file-path" title={file.path}>{file.path}</span>
          <span className="skill-file-meta">{file.isText ? '文本' : '二进制'} · {file.size} B</span>
          <div className="skill-file-actions">
            <button type="button" disabled={busy} onClick={() => onDownload(file.path, file.isText)}>
              下载
            </button>
            {canEdit ? <button type="button" className="danger" disabled={busy}
              onClick={() => onDelete(file.path)}>删除</button> : null}
          </div>
        </li>)}
      </ul>
    )}
  </section>;
}
