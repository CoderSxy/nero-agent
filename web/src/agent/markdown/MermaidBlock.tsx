import { useEffect, useState } from 'react';

let diagramId = 0;

export function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setSvg(null);
    setError(false);
    void import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false });
      const result = await mermaid.render(`nero-mermaid-${++diagramId}`, code);
      if (active) setSvg(result.svg);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [code]);

  if (error) return <pre className="chart-source" role="alert">流程图语法无效，显示原始内容：{'\n'}{code}</pre>;
  return <figure className="agent-chart" data-chart="mermaid">
    <div role="img" aria-label="Mermaid 流程图" className="agent-chart__diagram"
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined} />
    <details><summary>查看流程图代码</summary><pre className="chart-source">{code}</pre></details>
  </figure>;
}
