import { useState } from 'react';
import { FileText } from 'lucide-react';
import {
  isTerminalArtifactState,
  type TurnArtifacts as TurnArtifactsValue,
  type WorkspaceArtifact,
} from './turn-artifacts';
import './turn-artifacts.css';

const DEFAULT_VISIBLE = 3;

export function TurnArtifacts({
  value,
  onOpenArtifact,
}: {
  value: TurnArtifactsValue;
  onOpenArtifact: (file: WorkspaceArtifact) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!isTerminalArtifactState(value.state)) return null;
  if (value.artifacts.length === 0 && value.collectionStatus === 'complete') return null;

  const title = value.state === 'completed'
    ? `本轮产物 · ${value.artifacts.length} 个文件`
    : `本轮保留文件 · ${value.artifacts.length} 个文件`;
  const visible = expanded ? value.artifacts : value.artifacts.slice(0, DEFAULT_VISIBLE);
  const remaining = value.artifacts.length - DEFAULT_VISIBLE;
  const nameCounts = new Map<string, number>();
  for (const file of value.artifacts) {
    nameCounts.set(file.name, (nameCounts.get(file.name) ?? 0) + 1);
  }

  return (
    <div className="turn-artifacts" data-run-id={value.runId}>
      <div className="turn-artifacts__title">{title}</div>
      {value.collectionStatus === 'partial' && (
        <p className="turn-artifacts__hint" role="status">部分文件未完成采集</p>
      )}
      {value.artifacts.length === 0 && value.collectionStatus === 'partial' ? null : (
        <ul className="turn-artifacts__list">
          {visible.map((file) => {
            const ambiguous = (nameCounts.get(file.name) ?? 0) > 1;
            const parent = file.path.includes('/')
              ? file.path.slice(0, file.path.lastIndexOf('/'))
              : '';
            return (
              <li key={file.path}>
                <button
                  type="button"
                  className="turn-artifacts__item"
                  title={file.path}
                  aria-label={`打开 ${file.path}`}
                  onClick={() => onOpenArtifact(file)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onOpenArtifact(file);
                    }
                  }}
                >
                  <FileText size={16} aria-hidden="true" />
                  <span className="turn-artifacts__name">
                    {file.name}
                    {ambiguous && parent ? <span className="turn-artifacts__parent"> · {parent}</span> : null}
                  </span>
                  <span className="turn-artifacts__change">
                    {file.change === 'created' ? '新增' : '更新'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {remaining > 0 && (
        <button
          type="button"
          className="turn-artifacts__more"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收起' : `展开其余 ${remaining} 个`}
        </button>
      )}
    </div>
  );
}
