import { useRef, type ReactNode } from 'react';
import { HistoryTurnShell } from './HistoryTurnShell';
import type { HistoryTurn } from '../history-window-types';

export function HistoryTurnList({
  items,
  turns = [],
}: {
  items: { id: string; user: boolean; node: ReactNode; pin: boolean }[];
  turns?: HistoryTurn[];
}) {
  const keys = useRef(new Map<string, string>());
  const groups: { ids: string[]; nodes: ReactNode[]; pin: boolean }[] = [];
  for (const item of items) {
    if (item.user || !groups.length) groups.push({ ids: [], nodes: [], pin: false });
    const group = groups.at(-1)!;
    group.ids.push(item.id);
    group.nodes.push(item.node);
    group.pin ||= item.pin;
  }
  const nextKeys = new Map<string, string>();
  const content = groups.map((group, index) => {
    // Reuse a key from any overlapping message when a provisional turn gains its origin.
    const key = group.ids.map((id) => keys.current.get(id)).find(Boolean) ?? group.ids[0]!;
    for (const id of group.ids) nextKeys.set(id, key);
    const info = turns.find((turn) => turn.messageIds.some((id) => group.ids.includes(id)));
    return (
      <HistoryTurnShell
        key={key}
        turnId={info?.turnId ?? group.ids[0]!}
        pinned={group.pin || index >= groups.length - 2}
      >
        {info?.partialBefore && (
          <p className="muted" role="status">
            本轮还有较早内容，点击上方按钮加载{info.turnContext ? `：${info.turnContext.preview}` : ''}
          </p>
        )}
        {group.nodes}
      </HistoryTurnShell>
    );
  });
  keys.current = nextKeys;
  return <>{content}</>;
}
