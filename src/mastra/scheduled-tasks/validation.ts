import { Cron, CronDate, CronPattern } from 'croner';
import type { AuthUser } from '../auth/service';
import { listEnabledPublic } from '../models/repository';
import { findAuthorizedModel } from '../models/service';
import { ModelCatalogError, parseModelRef, toModelRef, type ModelRef } from '../models/types';
import type { TaskInput } from './types';

export type ScheduledTaskErrorCode =
  | 'forbidden'
  | 'not_found'
  | 'invalid_input'
  | 'conflict'
  | 'upstream';

export class ScheduledTaskError extends Error {
  readonly code: ScheduledTaskErrorCode;

  constructor(code: ScheduledTaskErrorCode, message: string) {
    super(message);
    this.name = 'ScheduledTaskError';
    this.code = code;
  }
}

export function assertAdmin(owner: AuthUser): void {
  if (!owner.roles.includes('admin')) {
    throw new ScheduledTaskError('forbidden', '仅管理员可管理定时任务');
  }
}

function asRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ScheduledTaskError('invalid_input', '任务配置无效');
  }
  return input as Record<string, unknown>;
}

function requireString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new ScheduledTaskError('invalid_input', `${field} 无效`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) {
    throw new ScheduledTaskError('invalid_input', `${field} 无效`);
  }
  return trimmed;
}

function optionalTimestamp(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new ScheduledTaskError('invalid_input', `${field} 无效`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ScheduledTaskError('invalid_input', `${field} 无效`);
  return date.toISOString();
}

export function isValidIanaTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function assertValidCron(cron: string, timezone: string): void {
  try {
    const job = new Cron(cron, { timezone, paused: true });
    if (!job.nextRun()) throw new Error('no next run');
  } catch {
    throw new ScheduledTaskError('invalid_input', 'Cron 表达式或时区无效');
  }
}

export function computeNextFireAt(cron: string, timezone: string, from = new Date()): string | null {
  try {
    const next = new Cron(cron, { timezone, paused: true }).nextRun(from);
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}

/** Planned occurrence key for a cron fire in the task timezone (not delivery firedAt). */
export function cronOccurrenceKey(cron: string, timezone: string, around: Date): string {
  const job = new Cron(cron, { timezone, paused: true });
  // previousRun() reports this Cron instance's last actual execution; it does
  // not accept a reference date. CronDate.decrement computes the planned slot.
  const reference = job.match(around) ? new Date(around.getTime() + 1000) : around;
  const slot = new CronDate(reference, timezone)
    .decrement(new CronPattern(cron, timezone), { timezone })?.getDate();
  if (!slot) throw new ScheduledTaskError('invalid_input', '无法计算 Cron 触发时段');
  return slot.toLocaleString('sv-SE', { timeZone: timezone }).replace(' ', 'T');
}

export async function resolveDefaultModelRefs(): Promise<{
  chatModelRef: ModelRef;
  memoryModelRef: ModelRef;
}> {
  const models = await listEnabledPublic();
  const fallback = models.find((model) => model.isDefault) ?? models[0];
  if (!fallback) throw new ScheduledTaskError('invalid_input', '请先配置公共默认模型');
  const ref = toModelRef('public', fallback.id);
  return { chatModelRef: ref, memoryModelRef: ref };
}

export async function validateTaskInput(
  input: unknown,
  owner: AuthUser,
  deps: {
    findAuthorizedModel?: typeof findAuthorizedModel;
    resolveDefaultModelRefs?: typeof resolveDefaultModelRefs;
    fallbackModelRefs?: { chatModelRef: ModelRef; memoryModelRef: ModelRef };
  } = {},
): Promise<TaskInput & { chatModelRef: string; memoryModelRef: string }> {
  assertAdmin(owner);
  const body = asRecord(input);
  const name = requireString(body.name, '任务名称', 120);
  const cron = requireString(body.cron, 'Cron', 120);
  const timezone = requireString(body.timezone, '时区', 80);
  const prompt = requireString(body.prompt, '提示词', 20_000);
  if (!isValidIanaTimezone(timezone)) {
    throw new ScheduledTaskError('invalid_input', '时区无效');
  }
  assertValidCron(cron, timezone);

  const startsAt = optionalTimestamp(body.startsAt, '开始时间');
  const endsAt = optionalTimestamp(body.endsAt, '结束时间');
  if (startsAt && endsAt && new Date(endsAt).getTime() < new Date(startsAt).getTime()) {
    throw new ScheduledTaskError('invalid_input', '结束时间不能早于开始时间');
  }

  const defaults = deps.fallbackModelRefs
    ?? await (deps.resolveDefaultModelRefs ?? resolveDefaultModelRefs)();
  let chatModelRef = defaults.chatModelRef;
  let memoryModelRef = defaults.memoryModelRef;

  if (body.chatModelRef !== undefined && body.chatModelRef !== null && body.chatModelRef !== '') {
    if (!parseModelRef(body.chatModelRef)) {
      throw new ScheduledTaskError('invalid_input', '聊天模型无效');
    }
    chatModelRef = body.chatModelRef as ModelRef;
  }
  if (body.memoryModelRef !== undefined && body.memoryModelRef !== null && body.memoryModelRef !== '') {
    if (!parseModelRef(body.memoryModelRef)) {
      throw new ScheduledTaskError('invalid_input', '记忆模型无效');
    }
    memoryModelRef = body.memoryModelRef as ModelRef;
  }

  const authorize = deps.findAuthorizedModel ?? findAuthorizedModel;
  try {
    await authorize(chatModelRef, owner);
    await authorize(memoryModelRef, owner);
  } catch (error) {
    if (error instanceof ModelCatalogError || (error as { name?: string }).name === 'ModelCatalogError') {
      throw new ScheduledTaskError('invalid_input', '模型不可用或无权限');
    }
    throw error;
  }

  return {
    name,
    cron,
    timezone,
    prompt,
    chatModelRef,
    memoryModelRef,
    startsAt: startsAt === undefined ? null : startsAt,
    endsAt: endsAt === undefined ? null : endsAt,
  };
}
