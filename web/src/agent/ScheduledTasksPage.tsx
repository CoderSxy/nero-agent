import { useOutletContext } from 'react-router-dom';
import type { AgentShellContextValue } from './AgentShell';

/** Task 8 expands this into the full management UI. */
export function ScheduledTasksPage() {
  const { user } = useOutletContext<AgentShellContextValue>();
  if (!user.roles.includes('admin')) {
    return <section className="agent-center scheduled-tasks-page">
      <div className="empty-chat" role="alert">无权限访问定时任务管理</div>
    </section>;
  }
  return <section className="agent-center scheduled-tasks-page">
    <header className="scheduled-tasks-header">
      <h1>定时任务</h1>
      <p className="muted">管理你的 Cron 定时任务与执行日志</p>
    </header>
    <div className="empty-chat">任务列表将在此显示</div>
  </section>;
}
