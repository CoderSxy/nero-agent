import { useEffect, useId, useState, type ReactNode } from 'react';
import { Brain, ChevronDown, ChevronRight, Eye } from 'lucide-react';
import type { OmMarkerData } from '@mastra/playground-ui/domains/chat/tools/badges/observation-marker-badge';
import { ObservationRenderer } from '@mastra/playground-ui/domains/chat/tools/badges/observation-renderer';
import { MarkdownRenderer } from '@mastra/playground-ui/components/MarkdownRenderer';

function tokens(value: number | undefined) {
  if (value === undefined) return '?';
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));
}

function Detail({ title, children, initiallyOpen = false }: {
  title: string; children: ReactNode; initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const id = useId();
  return <div className="observation-complete__section">
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
      {title}
    </button>
    <div id={id}>{open && children}</div>
  </div>;
}

export function ChineseObservationComplete({ data }: { data: OmMarkerData }) {
  const entries = Object.entries(data.extractedValues ?? {}).filter(([, value]) =>
    value !== undefined && value !== null && value !== '');
  const failures = data.extractionFailures ?? [];
  const hasExtractions = entries.length > 0 || failures.length > 0;
  const [open, setOpen] = useState(hasExtractions);
  useEffect(() => { if (hasExtractions) setOpen(true); }, [hasExtractions]);
  const id = useId();
  const reflection = data.operationType === 'reflection';
  const buffered = data._state === 'buffering-complete';
  const activated = data._state === 'activated';
  const input = buffered ? data.tokensBuffered : activated ? data.tokensActivated : data.tokensObserved;
  const output = buffered ? data.bufferedTokens : data.observationTokens;
  const ratio = input && output && output > 0 ? Math.round(input / output) : null;
  const label = buffered ? (reflection ? '已缓冲反思' : '已缓冲观察') : reflection ? '已反思' : '已观察';
  const Icon = reflection ? Brain : Eye;
  return <div className="observation-complete" data-om-badge={data.cycleId ?? ''}
    data-om-state={data._state} data-om-type={reflection ? 'reflection' : 'observation'}
    data-om-no-highlight={activated ? 'true' : undefined}>
    <button type="button" className="observation-pill" aria-expanded={open} aria-controls={id}
      onClick={event => {
        const viewport = event.currentTarget.closest('[data-radix-scroll-area-viewport]') ?? document.documentElement;
        const top = viewport.scrollTop;
        setOpen(value => !value);
        requestAnimationFrame(() => { viewport.scrollTop = top; });
      }}>
      {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
      <Icon size={13} aria-hidden="true" />
      <span>{label} {tokens(input)}→{tokens(output)} tokens{ratio ? ` (-${ratio}x)` : ''}</span>
    </button>
    <div id={id}>{open && <div className="observation-complete__body">
      <div className="observation-complete__stats">
        {input !== undefined && <span>输入：{tokens(input)}</span>}
        {output !== undefined && <span>输出：{tokens(output)}</span>}
        {ratio !== null && ratio > 1 && <span>压缩：{ratio}x</span>}
        {data.durationMs !== undefined && <span><span>耗时：</span>{(data.durationMs / 1000).toFixed(1)} 秒</span>}
      </div>
      {data.observations && <Detail title={reflection ? '反思内容' : '观察内容'} initiallyOpen>
        <ObservationRenderer observations={data.observations} maxHeight={buffered ? '240px' : '500px'} useInheritedTextColor />
      </Detail>}
      {data.currentTask && <Detail title="当前任务"><MarkdownRenderer>{data.currentTask}</MarkdownRenderer></Detail>}
      {data.suggestedResponse && <Detail title="建议回复"><MarkdownRenderer>{data.suggestedResponse}</MarkdownRenderer></Detail>}
      {(entries.length > 0 || failures.length > 0) && <Detail
        title={`提取结果（${entries.length}）${failures.length ? ` · ${failures.length} 项失败` : ''}`}>
        {entries.map(([key, value]) => <div key={key}><strong>{key}</strong>
          {typeof value === 'object' ? <pre>{JSON.stringify(value, null, 2)}</pre>
            : <MarkdownRenderer>{String(value)}</MarkdownRenderer>}
        </div>)}
        {failures.map((failure, index) => <p className="error" key={`${failure.slug}-${index}`}>
          {failure.slug}：<span>{failure.error}</span>
        </p>)}
      </Detail>}
    </div>}</div>
  </div>;
}
