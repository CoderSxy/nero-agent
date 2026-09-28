export function shouldSkipThreadLoad(skipThreadIds: ReadonlySet<string>, threadId: string): boolean {
  return skipThreadIds.has(threadId);
}

export function shouldApplyThreadUpdate(activeThreadId: string | undefined, updateThreadId: string): boolean {
  return activeThreadId === updateThreadId;
}
