/**
 * Keyboard steering (spec §3): A/D or arrow keys produce the steer intent.
 * Pure key-string bookkeeping — DOM events are unwrapped in `main.ts`, which
 * keeps this testable headless.
 */

import type { TurnSignal } from '@paintclash/shared';

const LEFT_KEYS = new Set(['a', 'arrowleft']);
const RIGHT_KEYS = new Set(['d', 'arrowright']);

export class KeyTracker {
  private left = 0;
  private right = 0;

  down(key: string): void {
    this.set(key, true);
  }

  up(key: string): void {
    this.set(key, false);
  }

  /** Current steer intent; opposing keys cancel out. */
  turn(): TurnSignal {
    return Math.sign(this.right - this.left) as TurnSignal;
  }

  private set(key: string, held: boolean): void {
    const k = key.toLowerCase();
    if (LEFT_KEYS.has(k)) this.left = held ? 1 : 0;
    if (RIGHT_KEYS.has(k)) this.right = held ? 1 : 0;
  }
}
