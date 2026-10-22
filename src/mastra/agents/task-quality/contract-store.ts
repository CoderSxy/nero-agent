import type { TaskContract } from './types';
const contracts = new WeakMap<object, TaskContract>();
export function setTaskContract(context: object, contract: TaskContract) { contracts.set(context, contract); }
export function getTaskContract(context?: object): TaskContract | undefined { return context ? contracts.get(context) : undefined; }
