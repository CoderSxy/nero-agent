import { useId, useState, type ReactNode } from 'react';
import { Check, MessageCircleQuestion, ShieldAlert } from 'lucide-react';

export type ApprovalStatus = 'approved' | 'declined';

export function ChineseToolApproval({ toolName, children, status, disabled, onApprove, onDecline }: {
  toolName: string;
  children?: ReactNode;
  status?: ApprovalStatus;
  disabled?: boolean;
  onApprove: () => void;
  onDecline: () => void;
}) {
  return <section className="tool-approval" aria-label="工具执行审批">
    <header className="tool-approval__header">
      <ShieldAlert size={16} aria-hidden="true" />
      <strong>需要确认</strong>
    </header>
    <p className="tool-approval__lead">智能体请求{toolName}，确认后才会继续。</p>
    {children && <div className="tool-approval__detail">{children}</div>}
    {status ? <p className="tool-approval__status" role="status">
      {status === 'approved' ? '已批准执行' : '已拒绝执行'}
    </p> : <div className="tool-approval__actions">
      <button type="button" className="tool-approval__decline" disabled={disabled}
        onClick={onDecline}>拒绝</button>
      <button type="button" className="tool-approval__approve" disabled={disabled}
        onClick={onApprove}>批准执行</button>
    </div>}
  </section>;
}

export type AskUserSelectionMode = 'single_select' | 'multi_select';
export type AskUserAnswer = string | string[];
export type AskUserPayload = {
  question: string;
  options?: { label: string; description?: string }[];
  selectionMode?: AskUserSelectionMode;
};
export type AskUserResult = { content: string; isError?: boolean };

export function ChineseAskUser({ payload, result, isAnswered = false, isSubmitting = false, onSubmit }: {
  payload: AskUserPayload;
  result?: AskUserResult;
  isAnswered?: boolean;
  isSubmitting?: boolean;
  onSubmit: (answer: AskUserAnswer) => void;
}) {
  const fieldId = useId();
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const options = payload.options?.filter(option => option.label) ?? [];

  if (result || isAnswered) {
    return <section className="ask-user" data-testid="ask-user">
      <header className="ask-user__header"><MessageCircleQuestion size={15} aria-hidden="true" /><span>问题</span></header>
      <div className="ask-user__body">
        <p className="ask-user__question">{payload.question}</p>
        {result ? <p className={result.isError ? 'ask-user__result is-error' : 'ask-user__result'}>
          {result.content}</p> : <p className="ask-user__result">已回答</p>}
      </div>
    </section>;
  }

  if (options.length === 0) {
    const submit = () => {
      const answer = text.trim();
      if (answer && !isSubmitting) onSubmit(answer);
    };
    return <section className="ask-user" data-testid="ask-user">
      <header className="ask-user__header"><MessageCircleQuestion size={15} aria-hidden="true" /><span>问题</span></header>
      <div className="ask-user__body">
        <label className="ask-user__question" htmlFor={fieldId}>{payload.question}</label>
        <div className="ask-user__text-row">
          <input id={fieldId} className="ask-user__input" value={text} disabled={isSubmitting}
            placeholder="输入回答…" onChange={event => setText(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }} />
          <button type="button" className="ask-user__submit" disabled={isSubmitting || !text.trim()}
            onClick={submit}>提交</button>
        </div>
        {isSubmitting && <p className="ask-user__pending" role="status">提交中…</p>}
      </div>
    </section>;
  }

  const isMulti = payload.selectionMode === 'multi_select';
  return <section className="ask-user" data-testid="ask-user">
    <header className="ask-user__header"><MessageCircleQuestion size={15} aria-hidden="true" /><span>问题</span></header>
    <div className="ask-user__body">
      <p className="ask-user__question" id={fieldId}>{payload.question}</p>
      {isMulti ? <div role="group" aria-labelledby={fieldId} className="ask-user__options">
        {options.map(option => <label key={option.label} className="ask-user__option">
          <input type="checkbox" disabled={isSubmitting} checked={selected.includes(option.label)}
            onChange={() => setSelected(current => current.includes(option.label)
              ? current.filter(label => label !== option.label)
              : [...current, option.label])} />
          <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
        </label>)}
        <button type="button" className="ask-user__submit" disabled={isSubmitting || selected.length === 0}
          onClick={() => onSubmit(selected)}>提交</button>
      </div> : <div role="radiogroup" aria-labelledby={fieldId} className="ask-user__options">
        {options.map(option => <label key={option.label} className="ask-user__option">
          <input type="radio" name={fieldId} value={option.label} disabled={isSubmitting}
            onChange={() => { setSelected([option.label]); onSubmit(option.label); }} />
          <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
        </label>)}
      </div>}
      {isSubmitting && <p className="ask-user__pending" role="status"><Check size={13} aria-hidden="true" />提交中…</p>}
    </div>
  </section>;
}
