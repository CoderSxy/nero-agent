export type SkillSlashMatch = { start: number; end: number; query: string };

function isWhitespace(value: string): boolean {
  return /\s/.test(value);
}

/** Slash token at a collapsed textarea caret. Paths and URLs stay ordinary text. */
export function resolveSkillSlash(
  text: string,
  selectionStart: number,
  selectionEnd: number,
): SkillSlashMatch | null {
  if (!Number.isInteger(selectionStart) || !Number.isInteger(selectionEnd)) return null;
  if (selectionStart !== selectionEnd) return null;
  if (selectionStart < 0 || selectionStart > text.length) return null;

  let tokenStart = selectionStart;
  while (tokenStart > 0 && !isWhitespace(text[tokenStart - 1] ?? '')) tokenStart -= 1;

  let tokenEnd = selectionStart;
  while (tokenEnd < text.length && !isWhitespace(text[tokenEnd] ?? '')) tokenEnd += 1;

  if (tokenStart === tokenEnd) return null;
  if (selectionStart <= tokenStart || selectionStart > tokenEnd) return null;
  if (text[tokenStart] !== '/') return null;
  const keyword = text.slice(tokenStart + 1, tokenEnd);
  if (keyword.includes('/')) return null;

  return {
    start: tokenStart,
    end: tokenEnd,
    query: text.slice(tokenStart + 1, selectionStart),
  };
}

/** Deletes only `[start, end)` and leaves every other character, including adjacent spaces. */
export function replaceSkillSlash(text: string, match: SkillSlashMatch): { text: string; caret: number } {
  return {
    text: text.slice(0, match.start) + text.slice(match.end),
    caret: match.start,
  };
}
