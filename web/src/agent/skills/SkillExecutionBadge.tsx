import type { SkillActivationView } from '../message-parts';

function label(item: SkillActivationView): string {
  const version = item.version != null ? ` v${item.version}` : '';
  const hash = item.hashPrefix ? ` ${item.hashPrefix}` : '';
  if (item.status === 'failed') {
    const code = item.errorCode ? ` ${item.errorCode}` : '';
    return `加载失败 ${item.name}${version}${hash}${code}`;
  }
  return `已加载 ${item.name}${version}${hash}`;
}

export function SkillExecutionBadge({ activations }: { activations: SkillActivationView[] }) {
  if (!activations.length) return null;
  return <ul className="skill-execution-badges" aria-label="技能加载结果">
    {activations.map(item => <li key={[item.serverExecutionId, item.skillId, item.version ?? '', item.status].join('/')}
      className={`skill-execution-badge${item.status === 'failed' ? ' is-failed' : ''}`}
      data-status={item.status}>{label(item)}</li>)}
  </ul>;
}
