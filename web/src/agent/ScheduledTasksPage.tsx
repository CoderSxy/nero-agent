import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import type { AgentShellContextValue } from './AgentShell';
import { getSelectableModels, type SafeModel } from './model-catalog-client';
import {
  createTask,
  deleteTask,
  listTaskRuns,
  listTasks,
  pauseTask,
  resumeTask,
  runTask,
  updateTask,
  type RunDto,
  type TaskDto,
  type TaskInput,
} from './scheduled-tasks-api';
import { buildTaskCron, cronLabel, parseTaskCron, type CronPreset } from './task-cron';
import { fromTaskLocalTime, toTaskLocalTime } from './task-timezone';

const DEFAULT_TZ = 'Asia/Shanghai';

type EditorState = {
  id?: string;
  name: string;
  prompt: string;
  modelRef: string;
  timezone: string;
  presetKind: CronPreset['kind'];
  hour: number;
  minute: number;
  weekday: number;
  day: number;
  customCron: string;
  startsAt: string;
  endsAt: string;
};

function emptyEditor(defaultRef = ''): EditorState {
  return {
    name: '',
    prompt: '',
    modelRef: defaultRef,
    timezone: DEFAULT_TZ,
    presetKind: 'daily',
    hour: 9,
    minute: 0,
    weekday: 1,
    day: 1,
    customCron: '0 9 * * *',
    startsAt: '',
    endsAt: '',
  };
}

function editorFromTask(task: TaskDto & { prompt?: string }): EditorState {
  const parsed = parseTaskCron(task.cron);
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt ?? '',
    modelRef: task.chatModelRef,
    timezone: task.timezone,
    presetKind: parsed.kind,
    hour: parsed.kind === 'custom' ? 9 : parsed.hour,
    minute: parsed.kind === 'custom' ? 0 : parsed.minute,
    weekday: parsed.kind === 'weekly' ? parsed.weekday : 1,
    day: parsed.kind === 'monthly' ? parsed.day : 1,
    customCron: parsed.kind === 'custom' ? parsed.expression : task.cron,
    startsAt: task.startsAt ? toTaskLocalTime(task.startsAt, task.timezone) : '',
    endsAt: task.endsAt ? toTaskLocalTime(task.endsAt, task.timezone) : '',
  };
}

function toInput(editor: EditorState, defaultModelRef?: string): TaskInput {
  const preset: CronPreset = editor.presetKind === 'custom'
    ? { kind: 'custom', expression: editor.customCron }
    : editor.presetKind === 'daily'
      ? { kind: 'daily', hour: editor.hour, minute: editor.minute }
      : editor.presetKind === 'weekly'
        ? { kind: 'weekly', hour: editor.hour, minute: editor.minute, weekday: editor.weekday }
        : { kind: 'monthly', hour: editor.hour, minute: editor.minute, day: editor.day };
  return {
    name: editor.name,
    prompt: editor.prompt,
    chatModelRef: editor.modelRef || defaultModelRef,
    memoryModelRef: editor.modelRef || defaultModelRef,
    timezone: editor.timezone,
    cron: buildTaskCron(preset, editor.timezone),
    startsAt: editor.startsAt ? fromTaskLocalTime(editor.startsAt, editor.timezone) : null,
    endsAt: editor.endsAt ? fromTaskLocalTime(editor.endsAt, editor.timezone) : null,
  };
}

function defaultPublicRef(models: SafeModel[]): string | undefined {
  const publicModels = models.filter((model) => model.scope === 'public');
  return (publicModels.find((model) => model.isDefault) ?? publicModels[0])?.ref;
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  try { return new Date(value).toLocaleString('zh-CN'); }
  catch { return value; }
}

export function ScheduledTasksPage() {
  const { user, list } = useOutletContext<AgentShellContextValue>();
  const isAdmin = user.roles.includes('admin');
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [logTask, setLogTask] = useState<TaskDto | null>(null);
  const [runs, setRuns] = useState<RunDto[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [models, setModels] = useState<SafeModel[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const editorDialogRef = useRef<HTMLDivElement>(null);
  const logsDialogRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (editor) editorDialogRef.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [editor?.id, Boolean(editor)]);

  useEffect(() => {
    if (logTask) logsDialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [logTask?.id]);

  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    getSelectableModels().then((items) => {
      if (active) setModels(items.filter((item) => item.enabled));
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : '加载模型失败');
    });
    return () => { active = false; };
  }, [isAdmin]);

  const refresh = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true); setError(null);
    try {
      const result = await listTasks({ page, pageSize: 10, q: q.trim() || undefined });
      if (!Array.isArray(result?.items) || !Number.isFinite(result.total)) {
        throw new Error('定时任务列表响应格式错误');
      }
      setTasks(result.items);
      setTotal(result.total);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [isAdmin, page, q]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (!isAdmin) {
    return <section className="agent-center scheduled-tasks-page">
      <div className="empty-chat" role="alert">无权限访问定时任务管理</div>
    </section>;
  }

  async function saveEditor() {
    if (!editor || saving) return;
    setSaving(true); setError(null);
    try {
      const defaultModelRef = defaultPublicRef(models);
      if (editor.id && !editor.modelRef && !defaultModelRef) {
        throw new Error('公共默认模型尚未加载，请稍后重试');
      }
      const input = toInput(editor, defaultModelRef);
      if (editor.id) await updateTask(editor.id, input);
      else await createTask(input);
      setEditor(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function withBusy(id: string, work: () => Promise<void>) {
    if (busyId) return;
    setBusyId(id); setError(null);
    try { await work(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); }
    finally { setBusyId(null); }
  }

  async function watchManualRun(taskId: string, run: { id: string; threadId: string | null; status: RunDto['status'] }) {
    await list.refresh();
    if (run.threadId) return;
    const terminal = new Set<RunDto['status']>(['succeeded', 'failed', 'aborted', 'skipped']);
    for (let attempt = 0; attempt < 15 && mountedRef.current; attempt += 1) {
      try {
        const result = await listTaskRuns(taskId, { page: 1, pageSize: 20 });
        const current = result.items.find((item) => item.id === run.id);
        if (current?.threadId) {
          if (mountedRef.current) await list.refresh();
          return;
        }
        if (current && terminal.has(current.status)) return;
      } catch { return; }
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
    }
  }

  async function openLogs(task: TaskDto) {
    setError(null);
    setEditor(null);
    setLogTask(task);
    setRuns([]);
    setLogsLoading(true);
    try {
      const result = await listTaskRuns(task.id, { page: 1, pageSize: 20 });
      if (!Array.isArray(result?.items)) throw new Error('执行日志响应格式错误');
      setRuns(result.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载日志失败');
      setRuns([]);
    } finally {
      setLogsLoading(false);
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / 10));

  function openEditor(task?: TaskDto) {
    setError(null);
    setLogTask(null);
    setEditor(task ? editorFromTask(task) : emptyEditor(defaultPublicRef(models) ?? ''));
  }

  return <>
  <section className="agent-center scheduled-tasks-page" role="region" aria-label="定时任务列表">
    <header className="scheduled-tasks-header">
      <div>
        <h1>定时任务</h1>
        <p className="muted">共 {total} 个任务</p>
      </div>
      <div className="scheduled-tasks-actions">
        <button type="button" onClick={() => void refresh()} disabled={loading}>刷新</button>
        <button type="button" onClick={() => openEditor()}>新增任务</button>
      </div>
    </header>
    <form className="scheduled-tasks-search" onSubmit={(event) => {
      event.preventDefault();
      setPage(1);
      void refresh();
    }}>
      <input aria-label="搜索任务名" value={q} onChange={(event) => setQ(event.target.value)}
        placeholder="搜索任务名" />
      <button type="submit">搜索</button>
    </form>
    {error && !editor && !logTask && <p role="alert" className="error">{error}</p>}
    {loading && <p className="muted">加载中…</p>}
    <div className="scheduled-task-list">
      {tasks.map((task) => <article key={task.id} className="scheduled-task-card">
        <div className="scheduled-task-card-head">
          <h2>{task.name}</h2>
          <span className={`task-status task-status-${task.status}`}>{task.status === 'active' ? '运行中' : '已暂停'}</span>
        </div>
        <p className="scheduled-task-card-prompt">{task.prompt}</p>
        <p className="muted">Cron：{cronLabel(task.cron)}（{task.timezone}）</p>
        <p className="muted">下次：{formatTime(task.nextFireAt)} · 上次：{formatTime(task.lastFireAt)} · 执行 {task.execCount} 次</p>
        <div className="scheduled-task-card-actions">
          <button type="button" onClick={() => openEditor(task)}>编辑</button>
          {task.status === 'active'
            ? <button type="button" disabled={busyId === task.id}
              onClick={() => void withBusy(task.id, async () => { await pauseTask(task.id); })}>暂停</button>
            : <button type="button" disabled={busyId === task.id}
              onClick={() => void withBusy(task.id, async () => { await resumeTask(task.id); })}>恢复</button>}
          <button type="button" disabled={task.status !== 'active' || busyId === task.id}
            onClick={() => void withBusy(task.id, async () => {
              const result = await runTask(task.id);
              if (result.run?.id) void watchManualRun(task.id, result.run);
              else void list.refresh();
            })}>立即运行</button>
          <button type="button" onClick={() => void openLogs(task)}>日志</button>
          <button type="button" className="danger" disabled={busyId === task.id}
            onClick={() => {
              if (!window.confirm(`确定删除「${task.name}」？`)) return;
              void withBusy(task.id, async () => { await deleteTask(task.id); });
            }}>删除</button>
        </div>
      </article>)}
      {!loading && !error && tasks.length === 0 && <div className="scheduled-task-empty">
        <strong>暂无定时任务</strong><span>点击右上角“新增任务”开始配置。</span>
      </div>}
    </div>
    <div className="scheduled-tasks-pagination">
      <button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button>
      <span>{page} / {pageCount}</span>
      <button type="button" disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)}>下一页</button>
    </div>

  </section>
  {logTask && <div className="scheduled-task-modal-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) setLogTask(null);
  }}>
    <div ref={logsDialogRef} className="scheduled-task-modal scheduled-task-logs-modal"
      role="dialog" aria-modal="true" aria-label="执行日志"
      onKeyDown={(event) => { if (event.key === 'Escape') setLogTask(null); }}>
      <div className="scheduled-task-modal-header">
        <div><small>定时任务</small><h2>{logTask.name} · 执行日志</h2></div>
        <button type="button" aria-label="关闭" onClick={() => setLogTask(null)}>×</button>
      </div>
      <div className="scheduled-task-modal-body scheduled-task-logs">
        {error && <p role="alert" className="error">{error}</p>}
        {logsLoading && <p className="muted">加载中…</p>}
        {!logsLoading && !error && <ul>
          {runs.map((run) => <li key={run.id}>
            <span>{formatTime(run.firedAt)} · {run.triggerKind} · {run.status}</span>
            {run.threadId
              ? <Link to={`/agent/${encodeURIComponent(run.threadId)}`}>打开会话</Link>
              : <span className="muted">会话已删除或不存在</span>}
            {run.errorSummary && <span className="error"> {run.errorSummary}</span>}
          </li>)}
          {runs.length === 0 && <li className="muted">暂无日志</li>}
        </ul>}
      </div>
    </div>
  </div>}
  {editor && <div className="scheduled-task-modal-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !saving) setEditor(null);
  }}>
    <div ref={editorDialogRef} className="scheduled-task-modal" role="dialog" aria-modal="true"
      aria-label={editor.id ? '编辑定时任务' : '新增定时任务'}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) setEditor(null);
        if (event.key !== 'Tab') return;
        const focusable = Array.from(editorDialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)',
        ) ?? []);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first && last) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last && first) {
          event.preventDefault(); first.focus();
        }
      }}>
      <form className="scheduled-task-editor" role="form" aria-label="定时任务配置"
        onSubmit={(event) => { event.preventDefault(); void saveEditor(); }}>
        <div className="scheduled-task-modal-header">
          <div><small>定时任务</small><h2>{editor.id ? '编辑任务' : '新增任务'}</h2></div>
          <button type="button" aria-label="关闭弹窗" disabled={saving} onClick={() => setEditor(null)}>×</button>
        </div>
        <div className="scheduled-task-modal-body">
          {error && <p role="alert" className="error">{error}</p>}
          <label>任务名<input required value={editor.name}
            onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></label>
          <label>提示词<textarea required rows={5} value={editor.prompt}
            onChange={(event) => setEditor({ ...editor, prompt: event.target.value })} /></label>
          <div className="scheduled-task-editor-grid">
            <label>模型<select value={editor.modelRef}
              onChange={(event) => setEditor({ ...editor, modelRef: event.target.value })}>
              <option value="">公共默认模型</option>
              {models.map((model) => <option key={model.ref} value={model.ref}>{model.displayName}</option>)}
            </select></label>
            <label>时区<input value={editor.timezone} required
              onChange={(event) => setEditor({ ...editor, timezone: event.target.value })} /></label>
          </div>
          {editor.id && tasks.find((task) => task.id === editor.id)?.chatModelRef !==
            tasks.find((task) => task.id === editor.id)?.memoryModelRef &&
            <p className="muted scheduled-task-model-note">该任务原先分别配置了聊天和记忆模型。保存后两者将使用上方所选模型。</p>}
          <div className="scheduled-task-editor-grid">
            <label>频率<select value={editor.presetKind}
              onChange={(event) => setEditor({ ...editor, presetKind: event.target.value as CronPreset['kind'] })}>
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
              <option value="custom">自定义 Cron</option>
            </select></label>
            {editor.presetKind === 'custom'
              ? <label>Cron<input value={editor.customCron}
                onChange={(event) => setEditor({ ...editor, customCron: event.target.value })} /></label>
              : <div className="scheduled-task-editor-time">
                <label>小时<input type="number" min={0} max={23} value={editor.hour}
                  onChange={(event) => setEditor({ ...editor, hour: Number(event.target.value) })} /></label>
                <label>分钟<input type="number" min={0} max={59} value={editor.minute}
                  onChange={(event) => setEditor({ ...editor, minute: Number(event.target.value) })} /></label>
              </div>}
            {editor.presetKind === 'weekly' && <label>星期（0=日）<input type="number" min={0} max={6} value={editor.weekday}
              onChange={(event) => setEditor({ ...editor, weekday: Number(event.target.value) })} /></label>}
            {editor.presetKind === 'monthly' && <label>日期<input type="number" min={1} max={31} value={editor.day}
              onChange={(event) => setEditor({ ...editor, day: Number(event.target.value) })} /></label>}
          </div>
          <div className="scheduled-task-editor-grid">
            <label>开始<input type="datetime-local" value={editor.startsAt}
              onChange={(event) => setEditor({ ...editor, startsAt: event.target.value })} /></label>
            <label>结束<input type="datetime-local" value={editor.endsAt}
              onChange={(event) => setEditor({ ...editor, endsAt: event.target.value })} /></label>
          </div>
        </div>
        <div className="scheduled-task-modal-footer">
          <button type="button" disabled={saving} onClick={() => setEditor(null)}>取消</button>
          <button type="submit" disabled={saving}>{saving ? '保存中…' : '保存'}</button>
        </div>
      </form>
    </div>
  </div>}
  </>;
}
