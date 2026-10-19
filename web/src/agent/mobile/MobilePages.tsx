import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate, useOutletContext } from 'react-router-dom';
import { HistorySearchDialog } from '../HistorySearchDialog';
import type { AgentShellContextValue } from '../AgentShell';
import { WorkspaceFileTree } from '../WorkspaceFileTree';
import { WorkspaceFileOverlay } from '../WorkspaceFileOverlay';
import { getSelectableModels, type SafeModel } from '../model-catalog-client';
import { MobileHistory } from './MobileHistory';
import { MobileModels } from './MobileModels';
import { useMobileLayout } from './useMobileLayout';

export function MobileHistoryPage() {
  const { list, visibleThreads, threadSource, setThreadSource, historySearch } = useOutletContext<AgentShellContextValue>();
  const mobile = useMobileLayout();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchOpen, setSearchOpen] = useState(() => Boolean((location.state as { openSearch?: boolean } | null)?.openSearch));
  if (!mobile) return <Navigate to="/agent/new" replace />;
  return <>
    <MobileHistory threads={visibleThreads} source={threadSource} onSourceChange={source => {
      setThreadSource(source); void list.refresh();
    }} onOpenThread={id => navigate(`/agent/${encodeURIComponent(id)}`, { state: { mobileReturnTo: '/history' } })}
      onSearch={() => setSearchOpen(true)} loading={list.loading} error={list.error} />
    <HistorySearchDialog open={searchOpen} search={historySearch} onClose={() => setSearchOpen(false)}
      onSelect={result => { setSearchOpen(false); navigate(`/agent/${encodeURIComponent(result.threadId)}?targetMessageId=${encodeURIComponent(result.userMessageId)}`, { state: { mobileReturnTo: '/history' } }); }}
      threadCount={visibleThreads.length} />
  </>;
}

export function MobileFilesPage() {
  const mobile = useMobileLayout();
  const [fileRequest, setFileRequest] = useState<{ path: string; id: number } | null>(null);
  const [version, setVersion] = useState(0);
  if (!mobile) return <Navigate to="/agent/new" replace />;
  return <section className="mobile-files" aria-label="文件管理页面">
    <WorkspaceFileTree source="personal" refreshVersion={version}
      onOpenFile={path => setFileRequest(current => ({ path, id: (current?.id ?? 0) + 1 }))}
      onFilesChanged={() => setVersion(value => value + 1)} />
    {fileRequest && <WorkspaceFileOverlay request={fileRequest} source="personal"
      onClosed={() => setFileRequest(null)} onSaved={() => setVersion(value => value + 1)} />}
  </section>;
}

export function MobileModelsPage() {
  const mobile = useMobileLayout();
  const [models, setModels] = useState<SafeModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!mobile) return;
    let active = true;
    setLoading(true);
    void getSelectableModels().then(items => { if (active) { setModels(items); setError(null); } })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '加载模型失败'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [mobile, version]);
  if (!mobile) return <Navigate to="/agent/new" replace />;
  return <MobileModels models={models} loading={loading} error={error} onRetry={() => setVersion(value => value + 1)} />;
}
