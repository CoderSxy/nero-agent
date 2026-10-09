export const DEFAULT_ATTACHMENT_PROMPT = '请查看附件';
const ATTACHMENT_BLOCK_START = '[[nero-attachments]]';
const ATTACHMENT_BLOCK_END = '[[/nero-attachments]]';

export type AgentAttachmentMeta = {
  attachmentId: string;
  name: string;
  mimeType: string;
};

export function buildAgentAttachmentMessage(userText: string, attachments: AgentAttachmentMeta[]): string {
  const visible = userText.trim() || (attachments.length ? DEFAULT_ATTACHMENT_PROMPT : '');
  if (!attachments.length) return visible;
  const lines = attachments.map(item =>
    `id=${item.attachmentId}|name=${item.name}|mime=${item.mimeType}`);
  return [
    visible,
    '',
    ATTACHMENT_BLOCK_START,
    ...lines,
    ATTACHMENT_BLOCK_END,
    '',
    '请使用 read_attached_file({ attachmentId }) 读取以上附件。',
  ].join('\n');
}

export function stripAttachmentProtocol(text: string): string {
  const start = text.indexOf(ATTACHMENT_BLOCK_START);
  if (start < 0) return text;
  const end = text.indexOf(ATTACHMENT_BLOCK_END, start);
  if (end < 0) return text.slice(0, start).replace(/\s+$/, '');
  const after = text.slice(end + ATTACHMENT_BLOCK_END.length)
    .replace(/^\s*请使用 read_attached_file\(\{ attachmentId \}\) 读取以上附件。\s*/, '')
    .trim();
  const before = text.slice(0, start).replace(/\s+$/, '');
  return [before, after].filter(Boolean).join('\n').trim();
}

export function userVisibleText(text: string): string {
  return stripAttachmentProtocol(text).trim() || DEFAULT_ATTACHMENT_PROMPT;
}

export function parseAttachmentIdsFromText(text: string): string[] {
  const start = text.indexOf(ATTACHMENT_BLOCK_START);
  const end = text.indexOf(ATTACHMENT_BLOCK_END, start);
  if (start < 0 || end < 0) return [];
  const block = text.slice(start + ATTACHMENT_BLOCK_START.length, end);
  const ids: string[] = [];
  for (const line of block.split('\n')) {
    const match = /^id=([^|]+)\|/.exec(line.trim());
    if (match?.[1]) ids.push(match[1]);
  }
  return ids;
}
