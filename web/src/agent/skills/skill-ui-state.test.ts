import { describe, expect, it } from 'vitest';
import { SkillApiError } from './skills-api';
import { toSkillUiState } from './skill-ui-state';

describe('toSkillUiState', () => {
  it('maps a disabled skills error by code and status, not the English message', () => {
    const error = new SkillApiError(503, 'SKILLS_DISABLED', 'Agent skills are disabled');
    expect(toSkillUiState(error)).toEqual({
      kind: 'disabled',
      message: '技能功能未启用，请联系管理员配置',
      retryable: false,
    });
    expect(error.message).toBe('Agent skills are disabled');
    expect(error.code).toBe('SKILLS_DISABLED');
  });

  it('keeps unauthorized and forbidden states distinct', () => {
    expect(toSkillUiState(new SkillApiError(401, 'UNAUTHORIZED', 'Invalid or expired token'))).toEqual({
      kind: 'unauthenticated',
      message: '登录状态已失效，请重新登录',
      retryable: false,
    });
    expect(toSkillUiState(new SkillApiError(403, 'FORBIDDEN', 'forbidden'))).toEqual({
      kind: 'forbidden',
      message: '暂无技能访问权限',
      retryable: false,
    });
  });

  it('maps ordinary and network errors to a retryable generic failure', () => {
    expect(toSkillUiState(new Error('boom'))).toEqual({
      kind: 'error',
      message: '技能加载失败，请重试',
      retryable: true,
    });
    expect(toSkillUiState(new TypeError('Failed to fetch'))).toEqual({
      kind: 'error',
      message: '技能加载失败，请重试',
      retryable: true,
    });
  });
});
