import { describe, expect, it } from 'vitest';
import { replaceSkillSlash, resolveSkillSlash } from './skill-slash';

describe('resolveSkillSlash', () => {
  it('matches a lone slash at the caret', () => {
    expect(resolveSkillSlash('/', 1, 1)).toEqual({ start: 0, end: 1, query: '' });
  });

  it('matches a slash token after whitespace and keeps the full token end', () => {
    expect(resolveSkillSlash('请 /天气 分析', 5, 5)).toEqual({ start: 2, end: 5, query: '天气' });
  });

  it('takes the query only up to the caret while the end stays at the token boundary', () => {
    expect(resolveSkillSlash('请 /天气 分析', 4, 4)).toEqual({ start: 2, end: 5, query: '天' });
  });

  it.each([
    ['https://example.com', 8, 8],
    ['/usr/bin', 8, 8],
    ['a/b', 3, 3],
    ['请 分析', 2, 2],
    ['请 /天气', 0, 2],
    ['请 /天气', 99, 99],
    ['请 /天气', 1, 1],
  ])('does not match %j at %s..%s', (text, start, end) => {
    expect(resolveSkillSlash(text, start, end)).toBeNull();
  });

  it('uses UTF-16 offsets so an emoji prefix matches textarea indexes', () => {
    const text = '😀 /天气';
    const caret = text.length;
    expect(caret).toBe(6);
    expect(resolveSkillSlash(text, caret, caret)).toEqual({ start: 3, end: 6, query: '天气' });
  });
});

describe('replaceSkillSlash', () => {
  it('deletes only the token and leaves surrounding whitespace and text', () => {
    const match = resolveSkillSlash('请 /天气 分析', 5, 5);
    expect(match).not.toBeNull();
    expect(replaceSkillSlash('请 /天气 分析', match!)).toEqual({ text: '请  分析', caret: 2 });
  });
});
