import { useEffect, useMemo, useRef, useState } from 'react';
import { parseEChartsOption } from './echarts-option';

export function EChartsBlock({ code }: { code: string }) {
  const element = useRef<HTMLDivElement>(null);
  const option = useMemo(() => parseEChartsOption(code), [code]);
  const [error, setError] = useState<'load' | 'render' | null>(null);
  const [view, setView] = useState<'chart' | 'source'>('chart');

  useEffect(() => {
    if (!option || view !== 'chart' || !element.current) return;
    let active = true;
    let chart: import('echarts').ECharts | undefined;
    let observer: ResizeObserver | undefined;
    void import('echarts').then(echarts => {
      if (!active || !element.current) return;
      try {
        chart = echarts.init(element.current);
        chart.setOption(option);
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(() => chart?.resize());
          observer.observe(element.current);
        }
        setError(null);
      } catch {
        chart?.dispose();
        chart = undefined;
        if (active) setError('render');
      }
    }).catch(() => { if (active) setError('load'); });
    return () => { active = false; observer?.disconnect(); chart?.dispose(); };
  }, [option, view]);

  if (!option || error) return <div className="chart-fallback" role="alert">
    <p>{error === 'load' ? '图表模块加载失败，请刷新页面重试。' : '图表配置无效，显示原始内容：'}</p>
    <pre className="chart-source">{code}</pre>
  </div>;
  return <figure className="agent-chart" data-chart="echarts">
    <div className="agent-chart__toolbar" role="group" aria-label="图表查看方式">
      <button type="button" aria-pressed={view === 'chart'} onClick={() => setView('chart')}>图形</button>
      <button type="button" aria-pressed={view === 'source'} onClick={() => setView('source')}>源码</button>
    </div>
    {view === 'chart'
      ? <div ref={element} role="img" aria-label="ECharts 图表" className="agent-chart__canvas" />
      : <pre className="chart-source">{code}</pre>}
  </figure>;
}
