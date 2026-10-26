export function HistoryBoundary(props: {
  hasBefore: boolean;
  hasAfter: boolean;
  gap?: boolean;
  around?: boolean;
  loadingBefore?: boolean;
  loadingAfter?: boolean;
  error?: string | null;
  onLoadBefore?: () => void;
  onLoadAfter?: () => void;
  onGoLatest?: () => void;
  onRetry?: () => void;
}) {
  return (
    <div className="history-boundary" data-testid="history-boundary">
      {props.hasBefore ? (
        <div className="history-boundary-row">
          <button
            type="button"
            className="history-boundary-action"
            disabled={props.loadingBefore}
            onClick={() => props.onLoadBefore?.()}
          >
            {props.loadingBefore ? '加载中…' : '加载更早的对话'}
          </button>
        </div>
      ) : (
        <div className="history-boundary-row history-boundary-row--muted" data-testid="history-complete">
          已加载全部历史
        </div>
      )}
      {props.gap || props.hasAfter || props.around ? (
        <div className="history-boundary-row" role="status">
          {props.gap && <span>中间还有未加载的消息</span>}
          {props.hasAfter && props.onLoadAfter ? (
            <button
              type="button"
              className="history-boundary-action"
              disabled={props.loadingAfter}
              onClick={() => props.onLoadAfter?.()}
            >
              {props.loadingAfter ? '加载中…' : '加载后续对话'}
            </button>
          ) : null}
          {props.onGoLatest ? (
            <button type="button" className="history-boundary-action" onClick={() => props.onGoLatest?.()}>
              回到最新消息
            </button>
          ) : null}
        </div>
      ) : null}
      {props.error ? (
        <div className="history-boundary-row" role="alert">
          <span>{props.error}</span>
          <button type="button" className="history-boundary-action" onClick={() => props.onRetry?.()}>
            重试
          </button>
        </div>
      ) : null}
    </div>
  );
}
