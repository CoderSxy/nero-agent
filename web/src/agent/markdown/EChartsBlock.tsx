import { useEffect, useMemo, useRef, useState } from 'react';
import type { EChartsOption } from 'echarts';

function parseOption(code: string): EChartsOption | null {
  if (code.length > 100_000) return null;
  try {
    const value: unknown = JSON.parse(code);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (JSON.stringify(value).match(/"(?:__proto__|prototype|constructor)"\s*:/)) return null;
    return value as EChartsOption;
  } catch {
    return null;
  }
}

export function EChartsBlock({ code }: { code: string }) {
  const element = useRef<HTMLDivElement>(null);
  const option = useMemo(() => parseOption(code), [code]);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!option || !element.current) return;
    let active = true;
    let chart: import('echarts').ECharts | undefined;
    let observer: ResizeObserver | undefined;
    void import('echarts').then(echarts => {
      if (!active || !element.current) return;
      chart = echarts.init(element.current);
      chart.setOption(option);
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() => chart?.resize());
        observer.observe(element.current);
      }
      setError(false);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; observer?.disconnect(); chart?.dispose(); };
  }, [option]);

  if (!option || error) return <pre className="chart-source" role="alert">图表配置无效，显示原始内容：{'\n'}{code}</pre>;
  return <figure className="agent-chart" data-chart="echarts">
    <div ref={element} role="img" aria-label="ECharts 图表" className="agent-chart__canvas" />
    <details><summary>查看图表配置</summary><pre className="chart-source">{code}</pre></details>
  </figure>;
}
