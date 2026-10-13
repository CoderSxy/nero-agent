type MemoryThread = {
  get: () => Promise<{ resourceId: string; metadata?: unknown }>;
  update: (params: { metadata: Record<string, unknown> }) => Promise<unknown>;
};
const pending = new Map<string, Promise<unknown>>();

export function updateOwnedThreadMetadata(threadId: string, thread: MemoryThread, resourceId: string,
  transform: (metadata: unknown) => Record<string, unknown>): Promise<Record<string, unknown>> {
  const prior = pending.get(threadId) ?? Promise.resolve();
  const current = prior.catch(() => undefined).then(async () => {
    const saved = await thread.get();
    if (saved.resourceId !== resourceId) throw new Error('会话不存在或无权访问');
    const metadata = transform(saved.metadata);
    await thread.update({ metadata });
    return metadata;
  });
  pending.set(threadId, current);
  void current.finally(() => { if (pending.get(threadId) === current) pending.delete(threadId); }).catch(() => undefined);
  return current;
}
