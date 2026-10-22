import { Wrench, X } from 'lucide-react';
import type { SkillSummary } from './types';

export function SkillSelectionChips({ value, catalog, disabled = false, preserveMissing = false, phase, tone = 'plain', onRemove }: {
  value: string[];
  catalog: SkillSummary[];
  disabled?: boolean;
  preserveMissing?: boolean;
  phase: 'loading' | 'ready' | 'error';
  tone?: 'plain' | 'composer';
  onRemove: (id: string) => void;
}) {
  if (value.length === 0) return null;
  const byId = new Map(catalog.map(item => [item.id, item]));
  return <div className={`skill-picker-chips${tone === 'composer' ? ' is-composer' : ''}`} aria-label="已选技能" data-preserve-missing={preserveMissing ? 'true' : 'false'}>
    {value.map(id => {
      const skill = byId.get(id);
      const invalid = phase === 'ready' && !skill;
      const label = invalid ? '失效' : (skill?.name ?? id);
      return <span key={id} className={`skill-chip${invalid ? ' is-invalid' : ''}`} data-skill-id={id}>
        {tone === 'composer' ? <>
          <span className="skill-chip-icon" aria-hidden="true"><Wrench size={14} /></span>
          <span className="skill-chip-copy">
            <small>Skill</small>
            <strong>{label}</strong>
          </span>
        </> : label}
        <button type="button" aria-label={`移除技能 ${invalid ? id : label}`} disabled={disabled}
          onClick={() => onRemove(id)}>
          <X size={12} aria-hidden="true" />
        </button>
      </span>;
    })}
  </div>;
}
