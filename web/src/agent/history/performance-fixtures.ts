import type { MastraDBMessage } from '@mastra/core/agent/message-list';

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function message(id: string, role: MastraDBMessage['role'], text: string, createdAt: string): MastraDBMessage {
  return {
    id,
    role,
    createdAt: new Date(createdAt),
    content: { format: 2, parts: [{ type: 'text', text }] },
  };
}

export function shortSessionFixture(seed = 1): MastraDBMessage[] {
  const rand = mulberry32(seed);
  return Array.from({ length: 20 }, (_, i) => {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    return message(
      `s${i}`,
      role,
      `msg-${i}-${rand().toFixed(4)}`,
      new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
    );
  });
}

export function longSessionFixture(seed = 2): MastraDBMessage[] {
  const rand = mulberry32(seed);
  const out: MastraDBMessage[] = [];
  for (let turn = 0; turn < 100; turn++) {
    out.push(
      message(`u${turn}`, 'user', `q${turn}-${rand().toFixed(3)}`, new Date(Date.UTC(2026, 9, 1, turn, 0, 0)).toISOString()),
    );
    out.push(
      message(`a${turn}`, 'assistant', `a${turn}-${rand().toFixed(3)}`, new Date(Date.UTC(2026, 9, 1, turn, 0, 1)).toISOString()),
    );
  }
  return out;
}

export function longTurnFixture(seed = 3): MastraDBMessage[] {
  const rand = mulberry32(seed);
  const out: MastraDBMessage[] = [
    message('long-user', 'user', 'start', new Date(Date.UTC(2026, 9, 2, 0, 0, 0)).toISOString()),
  ];
  for (let i = 0; i < 500; i++) {
    out.push(
      message(
        `tool-${i}`,
        'assistant',
        `t${i}-${rand().toFixed(2)}`,
        new Date(Date.UTC(2026, 9, 2, 0, 0, i + 1)).toISOString(),
      ),
    );
  }
  return out;
}

export function oversizedBodyFixture(): MastraDBMessage[] {
  return [
    message('huge', 'assistant', 'x'.repeat(2 * 1024 * 1024), new Date(Date.UTC(2026, 9, 3, 0, 0, 0)).toISOString()),
  ];
}
