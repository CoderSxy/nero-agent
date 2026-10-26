import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { getPool } from '../src/mastra/auth/db';
import { createHistoryRepository, type HistoryRepository } from '../src/mastra/history/repository';
import { loadHistoryWindow } from '../src/mastra/history/service';
import { HISTORY_MAX_MESSAGES, type HistoryMetadata, type HistoryPoint } from '../src/mastra/history/types';
import { encodeHistoryCursor } from '../src/mastra/history/cursor';

function safeDatabase(): boolean {
  try {
    const parsed = new URL(process.env.DATABASE_URL ?? '');
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

function point(id: string, createdAt: string): HistoryPoint {
  return { id, createdAt };
}

function meta(id: string, role: string, createdAt: string, bytes = 8): HistoryMetadata {
  return { id, role, createdAt, contentBytes: bytes };
}

function spyRepo(seed: {
  upper: HistoryPoint;
  metadata: HistoryMetadata[];
  messages?: Map<string, { id: string; role: string; createdAt: string; threadId: string; resourceId: string; content: unknown }>;
  userId?: string;
  threadId?: string;
}): HistoryRepository & { calls: string[] } {
  const userId = seed.userId ?? 'user-a';
  const threadId = seed.threadId ?? 'thread-a';
  const calls: string[] = [];
  const byId = new Map(seed.metadata.map((row) => [row.id, row]));
  const messages =
    seed.messages ??
    new Map(
      seed.metadata.map((row) => [
        row.id,
        {
          id: row.id,
          role: row.role,
          createdAt: row.createdAt,
          threadId,
          resourceId: userId,
          content: { format: 2, parts: [{ type: 'text', text: row.id }] },
        },
      ]),
    );

  const compare = (a: HistoryPoint, b: HistoryPoint) => {
    if (a.createdAt < b.createdAt) return -1;
    if (a.createdAt > b.createdAt) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  };

  const repo: HistoryRepository & { calls: string[] } = {
    calls,
    async withReadTransaction(fn) {
      calls.push('tx');
      return fn({} as never);
    },
    async getThread(scope) {
      calls.push('getThread');
      if (scope.userId !== userId || scope.threadId !== threadId) return null;
      return { id: threadId, resourceId: userId, updatedAt: seed.upper.createdAt };
    },
    async getUpper(scope) {
      calls.push('getUpper');
      if (scope.userId !== userId || scope.threadId !== threadId) return null;
      return seed.upper;
    },
    async readMetadata(scope, options) {
      calls.push(`readMetadata:${options.limit}:${options.before?.id ?? ''}:${options.after?.id ?? ''}`);
      assert.ok(!('offset' in options));
      assert.ok(options.limit <= HISTORY_MAX_MESSAGES + 1);
      let rows = seed.metadata.filter((row) => compare(row, options.upper) <= 0);
      if (options.before) rows = rows.filter((row) => compare(row, options.before!) < 0);
      if (options.after) rows = rows.filter((row) => compare(row, options.after!) > 0);
      rows = [...rows].sort(compare);
      if (!options.ascending) {
        rows = rows.reverse().slice(0, options.limit).reverse();
      } else {
        rows = rows.slice(0, options.limit);
      }
      return rows;
    },
    async readMessages(scope, ids) {
      calls.push(`readMessages:${ids.length}`);
      return ids.map((id) => messages.get(id)!).filter(Boolean);
    },
    async findTarget(scope, messageId) {
      calls.push(`findTarget:${messageId}`);
      const row = byId.get(messageId);
      if (!row) return null;
      return { id: row.id, createdAt: row.createdAt, threadId, resourceId: userId };
    },
    async findTurnContext(scope, p, scanLimit) {
      calls.push(`findTurnContext:${scanLimit}`);
      const rows = seed.metadata
        .filter((row) => compare(row, p) <= 0)
        .sort((a, b) => compare(b, a))
        .slice(0, scanLimit);
      for (const row of rows) {
        if (row.role === 'user') {
          return { messageId: row.id, preview: row.id, point: point(row.id, row.createdAt) };
        }
      }
      return null;
    },
  };
  return repo;
}

test('loadHistoryWindow latest does not count/offset or fetch unselected content', async () => {
  const metadata: HistoryMetadata[] = [];
  for (let i = 1; i <= 40; i++) {
    const ts = `2026-10-01T00:${String(i).padStart(2, '0')}:00.000000`;
    metadata.push(meta(`u${i}`, 'user', ts));
    metadata.push(meta(`a${i}`, 'assistant', ts.replace(':00.000000', ':01.000000')));
  }
  const upper = point('a40', metadata[metadata.length - 1]!.createdAt);
  const repo = spyRepo({ upper, metadata });
  const window = await loadHistoryWindow(repo, { userId: 'user-a', threadId: 'thread-a' }, {});
  assert.equal(window.turns.length, 8);
  assert.ok(window.messages.length <= HISTORY_MAX_MESSAGES);
  assert.ok(repo.calls.every((call) => !/COUNT|OFFSET/i.test(call)));
  const readMessages = repo.calls.filter((call) => call.startsWith('readMessages:'));
  assert.equal(readMessages.length, 1);
  assert.equal(readMessages[0], `readMessages:${window.messages.length}`);
  assert.ok(window.messages.length < metadata.length);
});

test('around includes the target and returns bidirectional cursors', async () => {
  const metadata: HistoryMetadata[] = [];
  for (let i = 1; i <= 30; i++) {
    const ts = `2026-10-01T01:${String(i).padStart(2, '0')}:00.000000`;
    metadata.push(meta(`u${i}`, 'user', ts));
    metadata.push(meta(`a${i}`, 'assistant', ts.replace(':00.000000', ':01.000000')));
  }
  const upper = point('a30', metadata[metadata.length - 1]!.createdAt);
  const repo = spyRepo({ upper, metadata });
  const window = await loadHistoryWindow(repo, { userId: 'user-a', threadId: 'thread-a' }, { around: 'u15' });
  assert.ok(window.messages.some((message) => (message as { id: string }).id === 'u15'));
  assert.ok(window.previousCursor, 'earlier turns outside the around window need a before cursor');
  assert.ok(window.nextCursor, 'later turns outside the around window need an after cursor');
});

test('findTurnContext stops at scanLimit', async () => {
  const metadata = Array.from({ length: 30 }, (_, i) =>
    meta(`m${i}`, 'assistant', `2026-10-01T02:00:${String(i).padStart(2, '0')}.000000`),
  );
  const upper = point('m29', metadata[29]!.createdAt);
  const repo = spyRepo({ upper, metadata });
  const result = await repo.findTurnContext(
    { userId: 'user-a', threadId: 'thread-a' },
    upper,
    10,
  );
  assert.equal(result, null);
  assert.ok(repo.calls.some((call) => call === 'findTurnContext:10'));
});

test('snapshot upper stays fixed when newer messages exist after cursor creation', async () => {
  const metadata: HistoryMetadata[] = [];
  for (let i = 1; i <= 12; i++) {
    const ts = `2026-10-01T03:${String(i).padStart(2, '0')}:00.000000`;
    metadata.push(meta(`u${i}`, 'user', ts));
    metadata.push(meta(`a${i}`, 'assistant', ts.replace(':00.000000', ':01.000000')));
  }
  const frozenUpper = point('a10', metadata.find((row) => row.id === 'a10')!.createdAt);
  const repo = spyRepo({ upper: point('a12', metadata[metadata.length - 1]!.createdAt), metadata });
  const before = encodeHistoryCursor({
    version: 1,
    userId: 'user-a',
    threadId: 'thread-a',
    direction: 'before',
    boundary: point('u5', metadata.find((row) => row.id === 'u5')!.createdAt),
    snapshotUpper: frozenUpper,
  });
  const window = await loadHistoryWindow(repo, { userId: 'user-a', threadId: 'thread-a' }, { before });
  assert.ok(window.messages.every((message) => {
    const id = (message as { id: string }).id;
    const n = Number(id.slice(1));
    return n <= 10;
  }));
});

const dbSkip = safeDatabase() ? false : 'needs loopback DATABASE_URL';

test('history repository DB integration pages without duplicates or gaps', { skip: dbSkip }, async () => {
  const pool = getPool();
  const repo = createHistoryRepository(pool);
  const userId = randomUUID();
  const threadId = `hist-${randomUUID()}`;
  const client = await pool.connect();
  const ids: string[] = [];
  try {
    await client.query(
      `INSERT INTO app_users (id, email, display_name, password_hash) VALUES ($1, $2, 'H', 'x')`,
      [userId, `hist-${userId}@example.test`],
    );
    await client.query(
      `INSERT INTO mastra_threads (id, ${`"resourceId"`}, title, metadata, ${`"createdAt"`}, ${`"updatedAt"`}, ${`"createdAtZ"`}, ${`"updatedAtZ"`})
       VALUES ($1, $2, 'history', '{}'::jsonb, NOW(), NOW(), NOW(), NOW())`,
      [threadId, userId],
    );

    async function insertMessage(row: {
      id: string;
      role: string;
      type: string;
      content: unknown;
      createdAt: string;
    }) {
      await client.query(
        `INSERT INTO mastra_messages (id, thread_id, ${`"resourceId"`}, role, type, content, ${`"createdAt"`}, ${`"createdAtZ"`})
         VALUES ($1,$2,$3,$4,$5,$6,$7::timestamp,$7::timestamptz)`,
        [row.id, threadId, userId, row.role, row.type, JSON.stringify(row.content), row.createdAt],
      );
      ids.push(row.id);
    }

    // 100 turns / 200 messages + one long turn of 500 tool messages + same-createdAt pair
    for (let i = 0; i < 100; i++) {
      const base = new Date(Date.UTC(2026, 9, 1, 0, 0, i));
      await insertMessage({
        id: `u-${i}`,
        role: 'user',
        type: 'v2',
        content: { format: 2, parts: [{ type: 'text', text: `q${i}` }] },
        createdAt: base.toISOString(),
      });
      await insertMessage({
        id: `a-${i}`,
        role: 'assistant',
        type: 'v2',
        content: { format: 2, parts: [{ type: 'text', text: `a${i}` }] },
        createdAt: new Date(base.getTime() + 1000).toISOString(),
      });
    }

    const longStart = new Date(Date.UTC(2026, 9, 2, 0, 0, 0));
    await insertMessage({
      id: 'long-user',
      role: 'user',
      type: 'v2',
      content: { format: 2, parts: [{ type: 'text', text: 'long' }] },
      createdAt: longStart.toISOString(),
    });
    for (let i = 0; i < 500; i++) {
      await insertMessage({
        id: `long-${i}`,
        role: 'assistant',
        type: 'v2',
        content: { format: 2, parts: [{ type: 'text', text: `t${i}` }] },
        createdAt: new Date(longStart.getTime() + (i + 1) * 1000).toISOString(),
      });
    }

    const sameTs = new Date(Date.UTC(2026, 9, 3, 0, 0, 0)).toISOString();
    for (const id of ['same-b', 'same-a']) {
      await insertMessage({
        id,
        role: 'user',
        type: 'v2',
        content: { format: 2, parts: [{ type: 'text', text: id }] },
        createdAt: sameTs,
      });
    }

    await insertMessage({
      id: 'sig-user',
      role: 'signal',
      type: 'notification',
      content: {
        format: 2,
        metadata: { signal: { type: 'user' } },
        parts: [{ type: 'text', text: 'signal hello' }],
      },
      createdAt: new Date(Date.UTC(2026, 9, 3, 1, 0, 0)).toISOString(),
    });
    await insertMessage({
      id: 'sig-answer',
      role: 'assistant',
      type: 'v2',
      content: { format: 2, parts: [{ type: 'text', text: 'ok' }] },
      createdAt: new Date(Date.UTC(2026, 9, 3, 1, 0, 1)).toISOString(),
    });

    const explain = await client.query(
      `EXPLAIN SELECT id FROM mastra_messages WHERE thread_id = $1 AND ${`"resourceId"`} = $2
       ORDER BY ${`"createdAt"`} DESC, id DESC LIMIT 201`,
      [threadId, userId],
    );
    console.log(
      'history EXPLAIN:',
      explain.rows.map((row: { 'QUERY PLAN'?: string }) => row['QUERY PLAN']).join('\n'),
    );

    const collected = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const window = await loadHistoryWindow(
        repo,
        { userId, threadId },
        cursor ? { before: cursor } : {},
      );
      pages += 1;
      for (const message of window.messages as Array<{ id: string }>) {
        assert.equal(collected.has(message.id), false, `duplicate ${message.id}`);
        collected.add(message.id);
      }
      if (!window.previousCursor) break;
      cursor = window.previousCursor;
      assert.ok(pages < 50, 'pagination should terminate');
    }

    // Latest-first paging may miss nothing across full walk when long turn is segmented.
    for (const id of ids) assert.ok(collected.has(id), `missing ${id}`);
    assert.equal(collected.size, ids.length);

    const firstWindow = await loadHistoryWindow(repo, {userId,threadId}, {around:ids[0]!});
    const forward = new Set(firstWindow.messages.map((message:any)=>message.id));
    let next = firstWindow.nextCursor;
    let forwardPages=0;
    while(next){
      const window=await loadHistoryWindow(repo,{userId,threadId},{after:next});
      for(const message of window.messages as any[]) {
        assert.ok(!forward.has(message.id), `forward duplicate ${message.id}`);
        forward.add(message.id);
      }
      next=window.nextCursor;
      assert.ok(++forwardPages<100, 'forward pagination terminates');
    }
    assert.deepEqual([...forward].sort(), [...ids].sort(), 'forward walk includes every message');
    const signalWindow=await loadHistoryWindow(repo,{userId,threadId},{around:'sig-user'});
    assert.ok(signalWindow.turns.some(turn=>turn.originMessageId==='sig-user'));

  } finally {
    await client.query(`DELETE FROM mastra_messages WHERE thread_id = $1`, [threadId]);
    await client.query(`DELETE FROM mastra_threads WHERE id = $1`, [threadId]);
    await client.query(`DELETE FROM app_users WHERE id = $1`, [userId]);
    client.release();
    await pool.end();
  }
});

test('metadata and context queries do not transfer complete content columns', async () => {
  const sqls:string[]=[];
  const fake={query:async(sql:string)=>{sqls.push(sql);return {rows:[]};}};
  const repo=createHistoryRepository({connect:async()=>({...fake,release(){}})} as any);
  const scope={userId:'u',threadId:'t'};
  const upper={id:'last',createdAt:'2026-10-01T00:00:00Z'};
  await repo.readMetadata(scope,{upper,limit:100});
  await repo.findTurnContext(scope,upper,200);
  for(const sql of sqls) assert.doesNotMatch(sql,/\bAS "createdAt", content\b|\bSELECT[^;]*, content\s*(?:,|FROM)/i);
});
