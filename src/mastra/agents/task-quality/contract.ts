import { inheritsVerifiedChart, type TurnPolicy } from '../turn-policy';
import type { TaskContract, TaskRequirement } from './types';

export type TaskContractInput = {
  runId: string;
  userText: string;
  turnPolicy: TurnPolicy;
  now: Date;
  targetTimezone?: string;
  hasAttachments: boolean;
  selectedSkillIds: string[];
  previousContract?: TaskContract;
};

const POLICY_VERSION = 'phase1-v1';

function calendarDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function shiftDate(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function requirement(id: string, importance: TaskRequirement['importance'], origin: TaskRequirement['origin'], check: TaskRequirement['check'], description: string): TaskRequirement {
  return { id, importance, origin, check, description };
}

export function resolveTaskContract(input: TaskContractInput): TaskContract {
  if (input.previousContract && inheritsVerifiedChart(input.userText, input.turnPolicy.deliveryMode === 'inline-chart' ? 'inline-chart' : input.previousContract.deliveryMode)) {
    return { ...input.previousContract, runId: input.runId, requirements: input.previousContract.requirements.map(item => ({ ...item })) };
  }
  const text = input.userText;
  const conceptOnly = /解释|什么是|如何|怎么|为什么/.test(text) && !/给我|生成|绘制|展示|画一|趋势/.test(text);
  const weather = !conceptOnly && /天气|气温|温度|降雨|降水|湿度/.test(text);
  const skills = input.selectedSkillIds.length > 0;
  const held = input.hasAttachments || skills;
  let deliveryMode = input.turnPolicy.deliveryMode;
  if (held && (deliveryMode === 'inline-chart' || deliveryMode === 'general')) deliveryMode = 'mixed';
  if (weather && deliveryMode === 'general' && !held) deliveryMode = 'inline-chart';
  const multi = /多个交付|分步|先.{0,16}再/.test(text);
  const profile = multi ? 'complex' : deliveryMode === 'inline-chart' && !held ? 'simple-chart' : 'general';
  const requirements: TaskRequirement[] = [];
  if (weather && deliveryMode !== 'html-artifact') {
    const zone = input.targetTimezone || 'UTC';
    const today = calendarDate(input.now, zone);
    const start = /从明天|明天起|明天开始/.test(text) ? shiftDate(today, 1) : today;
    const end = shiftDate(start, 6);
    const temperatureOnly = /只要气温|只要温度|只看气温|只看温度/.test(text);
    const dropPrecipitation = temperatureOnly || /不要降雨|不要降水|不用降雨|无需降雨/.test(text);
    requirements.push(
      requirement('weather.location', 'required', 'default', 'weather-data', '目标地点与时区'),
      requirement('weather.range', 'required', 'default', 'weather-data', `${start}/${end} inclusive`),
    );
    if (!temperatureOnly) requirements.push(requirement('weather.condition', 'required', 'default', 'weather-data', '每日天气状况'));
    requirements.push(requirement('weather.temperature', 'required', temperatureOnly ? 'explicit' : 'default', 'weather-data', '每日最高与最低气温'));
    if (!dropPrecipitation) requirements.push(requirement('weather.precipitation', 'required', 'default', 'weather-data', '每日降水概率或降水量'));
    if (!temperatureOnly || /湿度/.test(text)) {
      requirements.push(requirement('weather.humidity', /湿度/.test(text) ? 'required' : 'optional', /湿度/.test(text) ? 'explicit' : 'default', 'weather-data', '当地日均相对湿度'));
    }
    if (deliveryMode === 'inline-chart' || deliveryMode === 'mixed') {
      requirements.push(requirement('delivery.chart', 'required', 'default', 'chart', '内联天气图'));
    }
  } else if (deliveryMode === 'file-artifact') {
    requirements.push(requirement('delivery.file', 'required', 'explicit', 'file-exists', '保存请求的文件'));
  } else {
    requirements.push(requirement('generic.explicit.1', 'required', 'explicit', 'declared-only', text.slice(0, 200)));
  }
  return {
    version: 1,
    runId: input.runId,
    deliveryMode,
    profile,
    domain: weather && deliveryMode !== 'html-artifact' ? 'weather' : 'generic',
    requirements,
    policyVersion: POLICY_VERSION,
    referenceInstant: input.now.toISOString(),
  };
}
