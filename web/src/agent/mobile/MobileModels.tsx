import { Layers3, RefreshCw } from 'lucide-react';
import type { SafeModel } from '../model-catalog-client';

export function MobileModels({ models, loading, error, onRetry }: {
  models: SafeModel[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const groups = [
    { title: '我的模型', items: models.filter(model => model.scope === 'private') },
    { title: '公共模型', items: models.filter(model => model.scope === 'public') },
  ].filter(group => group.items.length > 0);
  return <section className="mobile-models" aria-label="模型列表">
    <header className="mobile-page-heading"><h1>模型管理</h1>
      <button type="button" className="mobile-icon-button" aria-label="刷新模型" onClick={onRetry}><RefreshCw size={19} /></button>
    </header>
    <div className="mobile-models-body">
      {loading && models.length === 0 && <p role="status">正在加载模型…</p>}
      {error && <div role="alert" className="mobile-page-error">{error}<button type="button" onClick={onRetry}>重新加载</button></div>}
      {!loading && !error && models.length === 0 && <p>暂无可用模型</p>}
      {groups.map(group => <section key={group.title} className="mobile-model-group"><h2>{group.title}</h2>
        <ul>{group.items.map(model => <li key={model.ref} className="mobile-model-row">
          <span className="mobile-model-icon" aria-hidden="true"><Layers3 size={21} /></span>
          <span className="mobile-model-copy"><strong>{model.displayName}</strong>
            <small>{model.catalogMetadata?.providerName || model.providerId} · {model.supportsVision ? '支持图片' : '文本'}</small>
          </span>
          {model.isDefault && <span className="mobile-model-default">默认</span>}
        </li>)}</ul>
      </section>)}
    </div>
  </section>;
}
