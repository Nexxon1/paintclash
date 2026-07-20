/**
 * Enemy interpolation (spec §6.1): other players render a small delay behind
 * the freshest snapshot, lerped between the two bracketing snapshots — smooth
 * despite 20 Hz updates.
 */

import type { SnapshotPlayer } from '@paintclash/protocol';

/**
 * Snapshots kept for bracketing; ~6.4 s of history at 20 Hz. Must comfortably
 * cover the render clock's catch-up window after a stall — if the buffer
 * slides out from under the (rate-limited) render tick, the clamp drags
 * enemies forward in one visible leap.
 */
const BUFFER_SIZE = 128;
const TWO_PI = 2 * Math.PI;

/** Signed shortest-arc difference b − a in (−π, π]. */
export function angleDiff(a: number, b: number): number {
  let diff = (b - a) % TWO_PI;
  if (diff > Math.PI) diff -= TWO_PI;
  if (diff < -Math.PI) diff += TWO_PI;
  return diff;
}

/** Shortest-arc angle lerp, result wrapped into [0, 2π). */
export function lerpAngle(a: number, b: number, t: number): number {
  const result = (a + angleDiff(a, b) * t) % TWO_PI;
  return result < 0 ? result + TWO_PI : result;
}

export class Interpolator {
  private buffer: { tick: number; players: SnapshotPlayer[] }[] = [];

  add(tick: number, players: SnapshotPlayer[]): void {
    this.buffer.push({ tick, players });
    if (this.buffer.length > BUFFER_SIZE) this.buffer.shift();
  }

  latestTick(): number | null {
    return this.buffer[this.buffer.length - 1]?.tick ?? null;
  }

  /**
   * Players at fractional server tick `tickFloat` (clamped to the buffer),
   * lerped between the bracketing snapshots. Players missing from the newer
   * snapshot are gone; freshly appeared ones stand at their newest position.
   */
  sample(tickFloat: number, excludeId?: number): SnapshotPlayer[] {
    const newest = this.buffer[this.buffer.length - 1];
    if (!newest) return [];
    let older = this.buffer[0];
    let newer = newest;
    for (let i = this.buffer.length - 1; i > 0; i--) {
      const b = this.buffer[i];
      const a = this.buffer[i - 1];
      if (a && b && a.tick <= tickFloat) {
        older = a;
        newer = b;
        break;
      }
    }
    if (!older) return [];
    const span = newer.tick - older.tick;
    const t = span > 0 ? Math.min(1, Math.max(0, (tickFloat - older.tick) / span)) : 1;
    const result: SnapshotPlayer[] = [];
    for (const now of newer.players) {
      if (now.id === excludeId) continue;
      const was = older.players.find((p) => p.id === now.id);
      if (!was) {
        result.push({ ...now });
        continue;
      }
      result.push({
        ...now,
        x: was.x + (now.x - was.x) * t,
        y: was.y + (now.y - was.y) * t,
        heading: lerpAngle(was.heading, now.heading, t),
      });
    }
    return result;
  }
}
