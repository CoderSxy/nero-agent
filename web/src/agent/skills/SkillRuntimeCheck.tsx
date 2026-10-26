import { useEffect, useState } from 'react';
import { CheckCircle2, CircleHelp, AlertTriangle, XCircle } from 'lucide-react';
import { checkSkillRuntime } from './skills-api';
import type { SkillReadinessReport } from './types';

const labels = { ready: '可直接使用', 'instructions-only': '仅提供指令', blocked: '缺少依赖或能力', 'needs-declaration': '需要补充声明', failed: '检查失败' };
export function SkillRuntimeReport({ report }: { report: SkillReadinessReport }) {
  const ok = report.status === 'ready' || report.status === 'instructions-only';
  const Icon = ok ? CheckCircle2 : report.status === 'failed' ? XCircle : AlertTriangle;
  return <div className="skill-runtime-report" data-ready={ok}>
    <p className="skill-runtime-title"><Icon size={17} aria-hidden="true" /><strong>{labels[report.status]}</strong></p>
    <p>{report.message}</p>
    {report.items.length > 0 && <ul>{report.items.map((item, index) => <li key={`${item.kind}:${item.name}:${index}`}>
      {item.status === 'ok' ? <CheckCircle2 size={15} aria-hidden="true" /> : <XCircle size={15} aria-hidden="true" />}
      <span>{item.message}</span>
    </li>)}</ul>}
    <small>检查于 {new Date(report.checkedAt).toLocaleString()} · 发布时自动复检</small>
  </div>;
}
export function SkillRuntimeCheck({ skillId, version, revision, dirty }: { skillId: string; version: number; revision: string; dirty: boolean }) {
  const [report, setReport] = useState<SkillReadinessReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState(0);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (dirty) return;
    const controller = new AbortController();
    setBusy(true); setError(null); setReport(null); setExpired(false);
    void checkSkillRuntime(skillId, version, request > 0, controller.signal).then(result => {
      if (!controller.signal.aborted) setReport(result.report);
    }).catch(() => {
      if (!controller.signal.aborted) setError('运行环境检查失败，请稍后重新检查。');
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [skillId, version, revision, dirty, request]);
  useEffect(() => {
    if (!report) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, Date.parse(report.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [report]);
  return <section className="skill-runtime-check" aria-label="运行环境检查" aria-busy={busy && !dirty}>
    <header><h3>运行环境 · v{version}</h3><button type="button" disabled={(busy && !dirty) || dirty} onClick={() => setRequest(value => value + 1)}>重新检查</button></header>
    {dirty ? <p>有未保存的修改，保存修改后重新检查运行环境。</p>
      : busy ? <p role="status">正在检查沙箱运行环境…</p>
      : error ? <p role="status">{error}</p>
      : expired ? <p><CircleHelp size={16} aria-hidden="true" /> 检查结果已过期，请重新检查；发布时也会自动复检。</p>
      : report ? <SkillRuntimeReport report={report} /> : <p>尚未验证运行环境。</p>}
  </section>;
}
