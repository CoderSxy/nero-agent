export type ThreadSummary = {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatThreadTime(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function threadTitle(thread: ThreadSummary): string {
  const custom = thread.metadata?.customTitle;
  if (typeof custom === 'string' && custom.trim()) return custom;
  if (thread.title?.trim()) return thread.title;
  return '新对话';
}

export function threadSubtitle(thread: ThreadSummary): string {
  return formatThreadTime(thread.updatedAt || thread.createdAt);
}

export function sortThreads(threads: ThreadSummary[]): ThreadSummary[] {
  return [...threads].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
