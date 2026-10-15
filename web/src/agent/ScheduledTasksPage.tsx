import { useCallback, useEffect, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import type { AgentShellContextValue } from './AgentShell';
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

const DEFAULT_TZ = 'Asia/Shanghai';

type EditorState = {
  id?: string;
  name: string;
  prompt: string;
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

function emptyEditor(): EditorState {
  return {
    name: '',
    prompt: '',
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
    timezone: task.timezone,
    presetKind: parsed.kind,
    hour: parsed.kind === 'custom' ? 9 : parsed.hour,
    minute: parsed.kind === 'custom' ? 0 : parsed.minute,
    weekday: parsed.kind === 'weekly' ? parsed.weekday : 1,
    day: parsed.kind === 'monthly' ? parsed.day : 1,
    customCron: parsed.kind === 'custom' ? parsed.expression : task.cron,
    startsAt: task.startsAt?.slice(0, 16) ?? '',
    endsAt: task.endsAt?.slice(0, 16) ?? '',
  };
}

function toInput(editor: EditorState): TaskInput {
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
    timezone: editor.timezone,
    cron: buildTaskCron(preset, editor.timezone),
    startsAt: editor.startsAt ? new Date(editor.startsAt).toISOString() : null,
    endsAt: editor.endsAt ? new Date(editor.endsAt).toISOString() : null,
  };
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  try { return new Date(value).toLocaleString('zh-CN'); }
  catch { return value; }
}

export function ScheduledTasksPage() {
  const { user } = useOutletContext<AgentShellContextValue>();
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

  const refresh = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true); setError(null);
    try {
      const result = await listTasks({ page, pageSize: 10, q: q.trim() || undefined });
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
      const input = toInput(editor);
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

  async function openLogs(task: TaskDto) {
    setLogTask(task);
    try {
      const result = await listTaskRuns(task.id, { page: 1, pageSize: 20 });
      setRuns(result.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载日志失败');
      setRuns([]);
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / 10));

  return <section className="agent-center scheduled-tasks-page">
    <header className="scheduled-tasks-header">
      <div>
        <h1>定时任务</h1>
        <p className="muted">共 {total} 个任务</p>
      </div>
      <div className="scheduled-tasks-actions">
        <button type="button" onClick={() => void refresh()} disabled={loading}>刷新</button>
        <button type="button" onClick={() => setEditor(emptyEditor())}>新增任务</button>
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
    {error && <p role="alert" className="error">{error}</p>}
    {loading && <p className="muted">加载中…</p>}
    <div className="scheduled-task-list">
      {tasks.map((task) => <article key={task.id} className="scheduled-task-card">
        <div className="scheduled-task-card-head">
          <h2>{task.name}</h2>
          <span className={`task-status task-status-${task.status}`}>{task.status === 'active' ? '运行中' : '已暂停'}</span>
        </div>
        <p className="muted">Cron：{cronLabel(task.cron)}（{task.timezone}）</p>
        <p className="muted">下次：{formatTime(task.nextFireAt)} · 上次：{formatTime(task.lastFireAt)} · 执行 {task.execCount} 次</p>
        <div className="scheduled-task-card-actions">
          <button type="button" onClick={() => setEditor(editorFromTask(task))}>编辑</button>
          {task.status === 'active'
            ? <button type="button" disabled={busyId === task.id}
              onClick={() => void withBusy(task.id, async () => { await pauseTask(task.id); })}>暂停</button>
            : <button type="button" disabled={busyId === task.id}
              onClick={() => void withBusy(task.id, async () => { await resumeTask(task.id); })}>恢复</button>}
          <button type="button" disabled={task.status !== 'active' || busyId === task.id}
            onClick={() => void withBusy(task.id, async () => { await runTask(task.id); })}>立即运行</button>
          <button type="button" onClick={() => void openLogs(task)}>日志</button>
          <button type="button" className="danger" disabled={busyId === task.id}
            onClick={() => {
              if (!window.confirm(`确定删除「${task.name}」？`)) return;
              void withBusy(task.id, async () => { await deleteTask(task.id); });
            }}>删除</button>
        </div>
      </article>)}
      {!loading && tasks.length === 0 && <p className="muted">暂无定时任务</p>}
    </div>
    <div className="scheduled-tasks-pagination">
      <button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button>
      <span>{page} / {pageCount}</span>
      <button type="button" disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)}>下一页</button>
    </div>

    {editor && <div className="thread-confirm-backdrop">
      <form className="thread-confirm scheduled-task-editor" role="dialog" aria-modal="true" aria-label="编辑定时任务"
        onSubmit={(event) => { event.preventDefault(); void saveEditor(); }}>
        <h2>{editor.id ? '编辑任务' : '新增任务'}</h2>
        <label>任务名<input required value={editor.name}
          onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></label>
        <label>提示词<textarea required rows={4} value={editor.prompt}
          onChange={(event) => setEditor({ ...editor, prompt: event.target.value })} /></label>
        <label>时区<input value={editor.timezone}
          onChange={(event) => setEditor({ ...editor, timezone: event.target.value })} /></label>
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
          : <>
            <label>小时<input type="number" min={0} max={23} value={editor.hour}
              onChange={(event) => setEditor({ ...editor, hour: Number(event.target.value) })} /></label>
            <label>分钟<input type="number" min={0} max={59} value={editor.minute}
              onChange={(event) => setEditor({ ...editor, minute: Number(event.target.value) })} /></label>
            {editor.presetKind === 'weekly' && <label>星期（0=日）<input type="number" min={0} max={6} value={editor.weekday}
              onChange={(event) => setEditor({ ...editor, weekday: Number(event.target.value) })} /></label>}
            {editor.presetKind === 'monthly' && <label>日期<input type="number" min={1} max={31} value={editor.day}
              onChange={(event) => setEditor({ ...editor, day: Number(event.target.value) })} /></label>}
          </>}
        <label>开始<input type="datetime-local" value={editor.startsAt}
          onChange={(event) => setEditor({ ...editor, startsAt: event.target.value })} /></label>
        <label>结束<input type="datetime-local" value={editor.endsAt}
          onChange={(event) => setEditor({ ...editor, endsAt: event.target.value })} /></label>
        <div className="thread-confirm-actions">
          <button type="button" disabled={saving} onClick={() => setEditor(null)}>取消</button>
          <button type="submit" disabled={saving}>{saving ? '保存中…' : '保存'}</button>
        </div>
      </form>
    </div>}

    {logTask && <div className="thread-confirm-backdrop">
      <div className="thread-confirm scheduled-task-logs" role="dialog" aria-modal="true" aria-label="执行日志">
        <h2>{logTask.name} · 执行日志</h2>
        <ul>
          {runs.map((run) => <li key={run.id}>
            <span>{formatTime(run.firedAt)} · {run.triggerKind} · {run.status}</span>
            {run.threadId
              ? <Link to={`/agent/${encodeURIComponent(run.threadId)}`}>打开会话</Link>
              : <span className="muted">会话已删除或不存在</span>}
            {run.errorSummary && <span className="error"> {run.errorSummary}</span>}
          </li>)}
          {runs.length === 0 && <li className="muted">暂无日志</li>}
        </ul>
        <div className="thread-confirm-actions">
          <button type="button" onClick={() => setLogTask(null)}>关闭</button>
        </div>
      </div>
    </div>}
  </section>;
}
