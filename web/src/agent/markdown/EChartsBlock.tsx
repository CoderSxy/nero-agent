import { useEffect, useMemo, useRef, useState } from 'react';
import { parseEChartsResult, type EChartsParseResult } from './echarts-option';

// Share a single in-flight module load across charts; a failed load may be retried by new content.
let modulePromise: Promise<typeof import('echarts')> | undefined;
function loadECharts() {
  return modulePromise ??= import('echarts').catch(error => { modulePromise = undefined; throw error; });
}

type ChartError = { kind: 'load' | 'render'; message: string };

export function EChartsBlock({ code }: { code: string }) {
  const parsed = useMemo(() => parseEChartsResult(code), [code]);
  // A corrected option owns fresh view/error state and cannot inherit a failed canvas.
  return <ChartView key={code} code={code} parsed={parsed} />;
}

function CopySource({ code }: { code: string }) {
  const [status, setStatus] = useState('');
  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(code);
      setStatus('已复制');
    } catch { setStatus('复制失败，请手动选择源码。'); }
  }
  return <><button type="button" onClick={() => void copy()}>复制源码</button>
    {status && <span role="status">{status}</span>}</>;
}

function ChartView({ code, parsed }: { code: string; parsed: EChartsParseResult }) {
  const element = useRef<HTMLDivElement>(null);
  const draw = useRef<(() => void) | undefined>(undefined);
  const [error, setError] = useState<ChartError | null>(null);
  const [view, setView] = useState<'chart' | 'source'>('chart');
  const visible = useRef(true);
  visible.current = view === 'chart' && !error;

  useEffect(() => {
    if (!parsed.ok || !element.current) return;
    const container = element.current;
    let active = true;
    let failed = false;
    let module: typeof import('echarts') | undefined;
    let chart: import('echarts').ECharts | undefined;
    let optionApplied = false;
    const root = document.documentElement;
    let theme = root.classList.contains('light') ? undefined : 'dark';
    let frame: number | undefined;
    function dispose() {
      const instance = chart;
      chart = undefined;
      try { instance?.dispose(); } catch { /* Cleanup must not obscure the original error. */ }
    }
    function renderChart() {
      if (!active || failed || !module || !visible.current || container.clientWidth <= 0 || container.clientHeight <= 0) return;
      try {
        chart ??= module.init(container, theme);
        if (!optionApplied && parsed.ok) {
          chart.setOption({ ...parsed.option, backgroundColor: parsed.option.backgroundColor ?? 'transparent' });
          optionApplied = true;
        }
        chart.resize();
      } catch (cause) {
        failed = true;
        dispose();
        if (active) setError({ kind: 'render', message: cause instanceof Error ? cause.message.slice(0, 300) : '未知渲染错误' });
      }
    }
    draw.current = renderChart;
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(renderChart) : undefined;
    observer?.observe(container);
    window.addEventListener('resize', renderChart);
    const themeObserver = new MutationObserver(() => {
      const next = root.classList.contains('light') ? undefined : 'dark';
      if (next === theme) return;
      theme = next;
      optionApplied = false;
      dispose();
      renderChart();
    });
    themeObserver.observe(root, { attributes: true, attributeFilter: ['class'] });
    void loadECharts().then(echarts => {
      if (!active) return;
      module = echarts;
      renderChart();
      if (typeof window.requestAnimationFrame === 'function') frame = window.requestAnimationFrame(renderChart);
    }).catch(() => {
      failed = true;
      if (active) setError({ kind: 'load', message: '图表模块加载失败，请刷新页面重试。' });
    });
    return () => {
      active = false;
      draw.current = undefined;
      observer?.disconnect();
      themeObserver.disconnect();
      window.removeEventListener('resize', renderChart);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      dispose();
    };
  }, [parsed]);

  useEffect(() => { if (view === 'chart') draw.current?.(); }, [view]);

  if (!parsed.ok) return <div className="chart-fallback" role="alert" data-chart-error={parsed.kind}>
    <p>{parsed.message}</p><CopySource code={code} />
    <pre className="chart-source">{code}</pre>
  </div>;
  return <figure className="agent-chart" data-chart="echarts">
    <div className="agent-chart__toolbar" role="group" aria-label="图表查看方式">
      <button type="button" aria-pressed={view === 'chart' && !error} disabled={!!error} onClick={() => setView('chart')}>图形</button>
      <button type="button" aria-pressed={view === 'source' || !!error} onClick={() => setView('source')}>源码</button>
      <CopySource code={code} />
    </div>
    {error && <div className="chart-fallback" role="alert" data-chart-error={error.kind}>
      <p>{error.kind === 'load' ? error.message : `图表配置已解析，但渲染失败：${error.message}`}</p>
    </div>}
    <div ref={element} hidden={view !== 'chart' || !!error} role="img" aria-label="ECharts 图表" className="agent-chart__canvas" />
    {(view === 'source' || error) && <pre className="chart-source">{code}</pre>}
  </figure>;
}
