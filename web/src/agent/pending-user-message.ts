import type { MastraDBMessage } from '@mastra/core/agent/message-list';

export type PendingUserMessage = {
  id: string;
  text: string;
  createdAt: Date;
  occurrence: number;
};

export function isUserMessage(message: MastraDBMessage): boolean {
  if (message.role === 'user') return true;
  if (message.role !== 'signal') return false;
  const signal = message.content?.metadata?.signal;
  const type = signal && typeof signal === 'object' && 'type' in signal ? signal.type : message.type;
  return type === 'user' || type === 'user-message';
}

function userText(message: MastraDBMessage): string | null {
  if (!isUserMessage(message)) return null;
  return message.content.parts.filter(part => part.type === 'text')
    .map(part => 'text' in part ? part.text : '').join('');
}

export function nextPendingUserMessage(text: string, messages: MastraDBMessage[],
  pending: PendingUserMessage[]): PendingUserMessage {
  const inMessages = messages.filter(message => userText(message) === text).length;
  const inPending = pending.filter(message => message.text === text)
    .reduce((max, message) => Math.max(max, message.occurrence), 0);
  return { id: `pending-${crypto.randomUUID()}`, text, createdAt: new Date(),
    occurrence: Math.max(inMessages, inPending) + 1 };
}

export function withPendingUserMessages(messages: MastraDBMessage[],
  pending: PendingUserMessage[]): MastraDBMessage[] {
  const visible = [...messages];
  for (const item of pending) {
    if (visible.filter(message => userText(message) === item.text).length >= item.occurrence) continue;
    const message: MastraDBMessage = { id: item.id, role: 'user', createdAt: item.createdAt,
      content: { format: 2, parts: [{ type: 'text', text: item.text }] } };
    const index = visible.findIndex(existing => new Date(existing.createdAt).getTime() > item.createdAt.getTime());
    visible.splice(index < 0 ? visible.length : index, 0, message);
  }
  return visible;
}
