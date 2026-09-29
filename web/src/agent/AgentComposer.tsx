import { Composer, ComposerActions, ComposerBox, ComposerInput, ComposerRing } from '@mastra/playground-ui/components/Composer';

export function AgentComposer({ draft, onDraftChange, isRunning, onSend, onStop }: {
  draft: string; onDraftChange: (value: string) => void; isRunning: boolean;
  onSend: () => void; onStop: () => void;
}) {
  return <Composer className="agent-composer" onSubmit={event => { event.preventDefault(); if (!isRunning && draft.trim()) onSend(); }}>
    <ComposerRing busy={isRunning}><ComposerBox>
      <ComposerInput aria-label="发送消息" placeholder="向智能体发送消息…" value={draft}
        onChange={event => onDraftChange(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!isRunning && draft.trim()) onSend(); } }} />
      <ComposerActions>
        {isRunning ? <button type="button" onClick={onStop}>停止</button>
          : <button type="submit" disabled={!draft.trim()}>发送</button>}
      </ComposerActions>
    </ComposerBox></ComposerRing>
  </Composer>;
}
