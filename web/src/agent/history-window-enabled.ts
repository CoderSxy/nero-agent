/** Build-time switch. Unset defaults to true; only explicit "false" uses the legacy full-load path. */
export function isThreadHistoryWindowEnabled(): boolean {
  const value = import.meta.env.VITE_THREAD_HISTORY_WINDOW_ENABLED;
  if (value === undefined || value === '') return true;
  return value !== 'false' && value !== '0';
}
