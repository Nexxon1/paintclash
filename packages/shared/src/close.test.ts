import { describe, expect, it } from 'vitest';

import { ARENA_CLOSE, ROOM_CLOSE } from './close.js';

/**
 * The one property the two tables have to hold jointly (see `close.ts`): every
 * code is distinct and inside the application range. A collision would not
 * break a build — it would tell a player "der Raum ist voll" when the arena was.
 */
describe('close codes (spec §2.6, §8.3)', () => {
  const codes = [...Object.values(ROOM_CLOSE), ...Object.values(ARENA_CLOSE)];

  it('gives every refusal its own code', () => {
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('stays inside the range reserved for applications', () => {
    // Outside 4000–4999 a code would either be rejected by the WebSocket API or
    // be confused with a transport close (1006 and friends).
    for (const code of codes) {
      expect(code, `close code ${String(code)}`).toBeGreaterThanOrEqual(4000);
      expect(code, `close code ${String(code)}`).toBeLessThanOrEqual(4999);
    }
  });
});
