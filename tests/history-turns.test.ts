import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeHistoryCursor, encodeHistoryCursor } from '../src/mastra/history/cursor';
import {
  HISTORY_MAX_MESSAGES,
  HISTORY_TARGET_BYTES,
  type HistoryCursorPayload,
  type HistoryMetadata,
} from '../src/mastra/history/types';
import { isHistoryUserMessage, selectHistorySlice } from '../src/mastra/history/turns';

function meta(
  id: string,
  role: string,
  createdAt: string,
  contentBytes = 16,
  extra: Partial<HistoryMetadata> = {},
): HistoryMetadata {
  return { id, createdAt, role, contentBytes, ...extra };
}

function turnPair(n: number, text = `q${n}`): HistoryMetadata[] {
  const t = `2026-10-01T00:${String(n).padStart(2, '0')}:00.000Z`;
  return [
    meta(`u${n}`, 'user', t, text.length),
    meta(`a${n}`, 'assistant', t.replace(':00.000Z', ':01.000Z'), 8),
  ];
}

test('selectHistorySlice latest keeps the newest 8 of 10 turns', () => {
  const rows = Array.from({ length: 10 }, (_, i) => turnPair(i + 1)).flat();
  const slice = selectHistorySlice(rows, 'latest', undefined, { reachedStart: false, reachedEnd: true });
  assert.equal(slice.turns.length, 8);
  assert.deepEqual(
    slice.turns.map((turn) => turn.turnId),
    ['u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10'],
  );
  assert.equal(slice.hasBefore, true);
  assert.equal(slice.hasAfter, false);
  assert.equal(slice.ids.length, 16);
});

test('identical short follow-ups still count as distinct turns', () => {
  const rows = [
    ...turnPair(1, 'hello'),
    ...turnPair(2, '好的'),
    ...turnPair(3, '好的'),
    ...turnPair(4, '好的'),
  ];
  const slice = selectHistorySlice(rows, 'latest', undefined, { reachedStart: true, reachedEnd: true });
  assert.equal(slice.turns.length, 4);
  assert.deepEqual(
    slice.turns.map((turn) => turn.turnId),
    ['u1', 'u2', 'u3', 'u4'],
  );
  assert.equal(slice.hasBefore, false);
});

test('short sessions return every turn', () => {
  const rows = [...turnPair(1), ...turnPair(2), ...turnPair(3)];
  const slice = selectHistorySlice(rows, 'latest', undefined, { reachedStart: true, reachedEnd: true });
  assert.equal(slice.turns.length, 3);
  assert.equal(slice.ids.length, 6);
  assert.equal(slice.hasBefore, false);
  assert.equal(slice.hasAfter, false);
});

test('isHistoryUserMessage matches signal priority fixtures from isUserMessage', () => {
  assert.equal(isHistoryUserMessage(meta('a', 'user', '2026-10-01T00:00:00.000Z')), true);
  assert.equal(
    isHistoryUserMessage(
      meta('b', 'signal', '2026-10-01T00:00:00.000Z', 1, {
        type: 'notification',
        signalType: 'user',
      }),
    ),
    true,
  );
  assert.equal(
    isHistoryUserMessage(
      meta('c', 'signal', '2026-10-01T00:00:00.000Z', 1, { type: 'user-message' }),
    ),
    true,
  );
  assert.equal(
    isHistoryUserMessage(
      meta('d', 'signal', '2026-10-01T00:00:00.000Z', 1, {
        type: 'notification',
        signalType: 'notification',
      }),
    ),
    false,
  );
  assert.equal(isHistoryUserMessage(meta('e', 'assistant', '2026-10-01T00:00:00.000Z')), false);
});

test('legacy leading assistant messages form a legacy turn only at thread start', () => {
  const rows = [
    meta('old-a', 'assistant', '2026-10-01T00:00:00.000Z'),
    meta('old-b', 'tool', '2026-10-01T00:00:01.000Z'),
    meta('u1', 'user', '2026-10-01T00:00:02.000Z'),
    meta('a1', 'assistant', '2026-10-01T00:00:03.000Z'),
  ];
  const formal = selectHistorySlice(rows, 'latest', undefined, { reachedStart: true, reachedEnd: true });
  assert.equal(formal.turns[0]?.turnId, 'legacy:old-a');
  assert.equal(formal.turns[0]?.provisional, false);
  assert.equal(formal.turns[1]?.turnId, 'u1');

  const partial = selectHistorySlice(rows.slice(0, 2), 'latest', undefined, {
    reachedStart: false,
    reachedEnd: false,
    snapshotUpperId: 'upper',
  });
  assert.equal(partial.turns[0]?.provisional, true);
  assert.match(partial.turns[0]!.turnId, /^partial:upper:/);
});

test('stable ordering uses id tie-break when createdAt matches', () => {
  const rows = [
    meta('u-b', 'user', '2026-10-01T00:00:00.000000Z'),
    meta('u-a', 'user', '2026-10-01T00:00:00.000000Z'),
    meta('a1', 'assistant', '2026-10-01T00:00:01.000000Z'),
  ];
  const slice = selectHistorySlice(rows, 'latest', undefined, { reachedStart: true, reachedEnd: true });
  assert.deepEqual(
    slice.ids,
    ['u-a', 'u-b', 'a1'],
  );
  assert.equal(slice.turns[0]?.turnId, 'u-a');
  assert.equal(slice.turns[1]?.turnId, 'u-b');
});

test('budget pressure drops earlier turns instead of returning an empty page', () => {
  const rows: HistoryMetadata[] = [];
  for (let i = 1; i <= 8; i++) {
    rows.push(meta(`u${i}`, 'user', `2026-10-01T00:${String(i).padStart(2, '0')}:00.000Z`, 80_000));
    rows.push(
      meta(`a${i}`, 'assistant', `2026-10-01T00:${String(i).padStart(2, '0')}:01.000Z`, 80_000),
    );
  }
  const slice = selectHistorySlice(rows, 'latest', undefined, { reachedStart: true, reachedEnd: true });
  assert.ok(slice.ids.length > 0);
  assert.ok(slice.turns.length >= 1);
  assert.ok(slice.turns.length < 8);
  const bytes = slice.ids.reduce((sum, id) => {
    const row = rows.find((item) => item.id === id)!;
    return sum + row.contentBytes;
  }, 0);
  assert.ok(bytes <= HISTORY_TARGET_BYTES || slice.turns.length === 1);
});

test('single oversized message still returns that message', () => {
  const rows = [
    meta('u1', 'user', '2026-10-01T00:00:00.000Z', HISTORY_TARGET_BYTES + 10),
    meta('a1', 'assistant', '2026-10-01T00:00:01.000Z', 10),
  ];
  const slice = selectHistorySlice(rows, 'latest', undefined, { reachedStart: true, reachedEnd: true });
  assert.ok(slice.ids.includes('u1'));
  assert.equal(slice.oversizedMessage, true);
});

test('a 500-message turn returns at most 200 newest messages with partialBefore', () => {
  const rows: HistoryMetadata[] = [meta('u1', 'user', '2026-10-01T00:00:00.000Z')];
  for (let i = 1; i <= 499; i++) {
    rows.push(
      meta(
        `t${i}`,
        'assistant',
        `2026-10-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`,
      ),
    );
  }
  // Fix monotonic timestamps
  for (let i = 1; i < rows.length; i++) {
    rows[i] = meta(rows[i]!.id, rows[i]!.role, `2026-10-01T01:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`);
  }
  rows[0] = meta('u1', 'user', '2026-10-01T00:00:00.000Z');

  const slice = selectHistorySlice(rows, 'latest', undefined, {
    reachedStart: true,
    reachedEnd: true,
    snapshotUpperId: rows[rows.length - 1]!.id,
  });
  assert.ok(slice.ids.length <= HISTORY_MAX_MESSAGES);
  assert.equal(slice.ids.length, HISTORY_MAX_MESSAGES);
  assert.equal(slice.turns.length, 1);
  assert.equal(slice.turns[0]?.partialBefore, true);
  assert.equal(slice.turns[0]?.provisional, true);
  assert.equal(slice.ids.includes('u1'), false);
  assert.match(slice.turns[0]!.turnId, /^partial:/);
});

test('continuation reuses openTurn until origin is found, then replacesTurnIds', () => {
  const early: HistoryMetadata[] = [];
  for (let i = 0; i < 50; i++) {
    early.push(meta(`m${i}`, 'assistant', `2026-10-01T00:00:${String(i).padStart(2, '0')}.000Z`));
  }
  const first = selectHistorySlice(early, 'before', undefined, {
    snapshotUpperId: 'upper',
    reachedStart: false,
    reachedEnd: false,
  });
  assert.equal(first.turns[0]?.provisional, true);
  const openId = first.turns[0]!.turnId;

  const withOrigin: HistoryMetadata[] = [
    meta('u-origin', 'user', '2026-09-30T23:59:00.000Z'),
    ...early.slice(0, 20),
  ];
  const second = selectHistorySlice(withOrigin, 'before', undefined, {
    snapshotUpperId: 'upper',
    openTurnId: openId,
    reachedStart: true,
    reachedEnd: false,
  });
  assert.equal(second.turns[0]?.turnId, 'u-origin');
  assert.equal(second.turns[0]?.provisional, false);
  assert.ok(second.turns[0]?.replacesTurnIds?.includes(openId));
});

test('encode/decode rejects malformed cursors and preserves microsecond timestamps', () => {
  const payload: HistoryCursorPayload = {
    version: 1,
    userId: 'user-a',
    threadId: 'thread-a',
    direction: 'before',
    boundary: { createdAt: '2026-10-01T12:34:56.789123Z', id: 'msg-1' },
    snapshotUpper: { createdAt: '2026-10-02T00:00:00.000001Z', id: 'msg-9' },
    openTurn: { turnId: 'partial:msg-9:msg-8' },
  };
  const encoded = encodeHistoryCursor(payload);
  const decoded = decodeHistoryCursor(encoded, { userId: 'user-a', threadId: 'thread-a' });
  assert.equal(decoded.boundary.createdAt, '2026-10-01T12:34:56.789123Z');
  assert.equal(decoded.snapshotUpper.createdAt, '2026-10-02T00:00:00.000001Z');
  assert.equal(decoded.openTurn?.turnId, 'partial:msg-9:msg-8');

  assert.throws(() => decodeHistoryCursor('not-json', { userId: 'user-a', threadId: 'thread-a' }));
  assert.throws(() =>
    decodeHistoryCursor(encodeHistoryCursor(payload), { userId: 'other', threadId: 'thread-a' }),
  );
  assert.throws(() =>
    decodeHistoryCursor(encodeHistoryCursor(payload), { userId: 'user-a', threadId: 'other' }),
  );
  assert.throws(() => encodeHistoryCursor({ ...payload, version: 2 } as HistoryCursorPayload));
  assert.throws(() =>
    encodeHistoryCursor({
      ...payload,
      boundary: { createdAt: 'not-a-date', id: 'x' },
    }),
  );
  assert.throws(() =>
    encodeHistoryCursor({
      ...payload,
      boundary: { createdAt: '2026-10-01T00:00:00.000Z', id: '' },
    }),
  );
  assert.throws(() =>
    encodeHistoryCursor({
      ...payload,
      direction: 'sideways' as HistoryCursorPayload['direction'],
    }),
  );
  assert.throws(() => decodeHistoryCursor('a'.repeat(5000), { userId: 'user-a', threadId: 'thread-a' }));
});

test('after selects the earliest contiguous prefix, including the probe-side first row', () => {
  const rows = Array.from({length:201}, (_,i) => meta(`m${String(i).padStart(3,'0')}`, 'user', new Date(Date.UTC(2026,9,1,0,0,i)).toISOString()));
  const result = selectHistorySlice(rows, 'after', undefined, {reachedEnd:false});
  assert.deepEqual(result.ids, rows.slice(0,8).map(r=>r.id));
  const long = rows.map(r=>({...r,role:'assistant'}));
  const segment = selectHistorySlice(long, 'after', undefined, {reachedStart:false,reachedEnd:false});
  assert.deepEqual(segment.ids, long.slice(0,200).map(r=>r.id));
});

test('around never drops an oversized target or an edge target under message pressure', () => {
  const rows=[meta('target','user','2026-10-01T00:00:00Z',600000),meta('later','user','2026-10-01T00:00:01Z')];
  assert.ok(selectHistorySlice(rows,'around','target',{reachedStart:true,reachedEnd:true}).ids.includes('target'));
  const many=Array.from({length:201},(_,i)=>meta(`x${i}`,i===0||i===1?'user':'assistant',new Date(Date.UTC(2026,9,1,0,0,i)).toISOString()));
  assert.ok(selectHistorySlice(many,'around','x0').ids.includes('x0'));
});

test('backward continuation aliases the boundary-adjacent turn, not an older user turn', () => {
  const rows=[...turnPair(1),...turnPair(2)];
  const result=selectHistorySlice(rows,'before',undefined,{openTurnId:'partial:upper:a2',reachedStart:true,reachedEnd:false});
  assert.deepEqual(result.turns[0]?.replacesTurnIds??[],[]);
  assert.ok(result.turns[1]?.replacesTurnIds?.includes('partial:upper:a2'));
});

test('splits a large single turn at message boundaries within the byte budget', () => {
 const rows=Array.from({length:200},(_,i)=>meta(`m${i}`,i===0?'user':'assistant',new Date(Date.UTC(2026,9,1,0,0,i)).toISOString(),256*1024));
 for(const mode of ['latest','after','around'] as const){
  const result=selectHistorySlice(rows,mode,mode==='around'?'m100':undefined,{reachedStart:true,reachedEnd:true});
  const bytes=result.ids.reduce((n,id)=>n+rows.find(r=>r.id===id)!.contentBytes,0);
  assert.ok(bytes<=HISTORY_TARGET_BYTES, `${mode}: ${bytes}`);
  assert.ok(result.ids.length>0);
  if(mode==='around')assert.ok(result.ids.includes('m100'));
 }
});
test('formalizing a legacy turn replaces the continued provisional identity', () => {
 const rows=[meta('a','assistant','2026-10-01T00:00:00Z'),meta('b','assistant','2026-10-01T00:00:01Z')];
 const result=selectHistorySlice(rows,'before',undefined,{reachedStart:true,reachedEnd:false,openTurnId:'partial:upper:c'});
 assert.ok(result.turns[0]?.replacesTurnIds?.includes('partial:upper:c'));
});
