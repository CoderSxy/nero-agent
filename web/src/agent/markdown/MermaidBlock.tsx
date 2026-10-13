import { useEffect, useState } from 'react';

let diagramId = 0;

export function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<'load' | 'syntax' | null>(null);
  const [view, setView] = useState<'chart' | 'source'>('chart');

  useEffect(() => {
    let active = true;
    setSvg(null);
    setError(null);
    void import('mermaid').then(async ({ default: mermaid }) => {
      try {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false });
        const result = await mermaid.render(`nero-mermaid-${++diagramId}`, code);
        if (active) setSvg(result.svg);
      } catch {
        if (active) setError('syntax');
      }
    }).catch(() => { if (active) setError('load'); });
    return () => { active = false; };
  }, [code]);

  if (error) return <div className="chart-fallback" role="alert">
    <p>{error === 'load' ? '流程图模块加载失败，请刷新页面重试。' : '流程图语法无效，显示原始内容：'}</p>
    <pre className="chart-source">{code}</pre>
  </div>;
  return <figure className="agent-chart" data-chart="mermaid">
    <div className="agent-chart__toolbar" role="group" aria-label="流程图查看方式">
      <button type="button" aria-pressed={view === 'chart'} onClick={() => setView('chart')}>图形</button>
      <button type="button" aria-pressed={view === 'source'} onClick={() => setView('source')}>源码</button>
    </div>
    {view === 'chart'
      ? <div role="img" aria-label="Mermaid 流程图" className="agent-chart__diagram"
          dangerouslySetInnerHTML={svg ? { __html: svg } : undefined} />
      : <pre className="chart-source">{code}</pre>}
  </figure>;
}
