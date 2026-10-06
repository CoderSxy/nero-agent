import { useState } from 'react';
import Editor from '@monaco-editor/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PreviewKind } from '../workspace-files';
import './monaco-setup';

const languageByExtension: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', json: 'json',
  py: 'python', md: 'markdown', html: 'html', htm: 'html', css: 'css', scss: 'css',
  yml: 'yaml', yaml: 'yaml', xml: 'xml', sh: 'shell', sql: 'sql', go: 'go', java: 'java',
};

export function TextEditor({ path, kind, value, onChange }: {
  path: string; kind: PreviewKind; value: string; onChange(value: string): void;
}) {
  const [preview, setPreview] = useState(false);
  const extension = path.split('.').at(-1)?.toLowerCase() ?? '';
  const language = languageByExtension[extension] ?? 'plaintext';
  return <div className="workspace-text-editor">
    {(kind === 'markdown' || kind === 'html') && <div className="workspace-preview-switch">
      <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>源码</button>
      <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>预览</button>
    </div>}
    {preview && kind === 'html' ? <iframe title={`${path} 预览`} sandbox="allow-scripts allow-forms"
      srcDoc={value} className="workspace-html-preview" />
      : preview && kind === 'markdown' ? <div className="workspace-markdown-preview">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
      </div>
        : <Editor height="100%" path={path} language={language} value={value} theme={document.documentElement.classList.contains('light') ? 'vs' : 'vs-dark'}
          options={{ automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 13 }}
          onChange={next => onChange(next ?? '')} />}
  </div>;
}
