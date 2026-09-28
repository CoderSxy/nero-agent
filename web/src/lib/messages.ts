export type HistoryItem = { id: string; role: 'user' | 'assistant'; text: string };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (!part || typeof part !== 'object') return '';
    const item = part as { type?: string; text?: string };
    return item.type === 'text' && typeof item.text === 'string' ? item.text : '';
  }).join('');
}

export function historyFromMessages(messages: unknown[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  messages.forEach((message, index) => {
    if (!message || typeof message !== 'object') return;
    const record = message as { id?: string; role?: string; content?: unknown; parts?: unknown };
    if (record.role !== 'user' && record.role !== 'assistant') return;
    const text = textOf(record.content) || textOf(record.parts);
    if (!text) return;
    items.push({ id: record.id || String(index), role: record.role, text });
  });
  return items;
}
