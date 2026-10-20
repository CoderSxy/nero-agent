import { SkillApiError } from './skills-api';

export type SkillUiState = {
  kind: 'disabled' | 'unauthenticated' | 'forbidden' | 'error';
  message: string;
  retryable: boolean;
};

/** Display mapping only. Callers keep the original SkillApiError shape. */
export function toSkillUiState(error: unknown): SkillUiState {
  if (error instanceof SkillApiError && error.code === 'SKILLS_DISABLED') {
    return { kind: 'disabled', message: '技能功能未启用，请联系管理员配置', retryable: false };
  }
  if (error instanceof SkillApiError && error.status === 401) {
    return { kind: 'unauthenticated', message: '登录状态已失效，请重新登录', retryable: false };
  }
  if (error instanceof SkillApiError && error.status === 403) {
    return { kind: 'forbidden', message: '暂无技能访问权限', retryable: false };
  }
  return { kind: 'error', message: '技能加载失败，请重试', retryable: true };
}
