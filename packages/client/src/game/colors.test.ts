import { LIMITS } from '@paintclash/shared';
import { describe, expect, it } from 'vitest';

import {
  displayColor,
  PALETTE_SLOTS,
  PALETTE_STRIDE,
  playerColor,
  playerCssColor,
  sameShownColor,
  SELF_COLOR_CSS,
  SELF_HUE,
  SELF_LIGHTNESS,
  SELF_SATURATION,
} from './colors.js';

/** The hue of an enemy id — the palette's public surface carries it. */
const playerHue = (id: number): number => playerColor(id).hue;

/** Distance on the color wheel (hue wraps at 1). */
function hueGap(a: number, b: number): number {
  const raw = Math.abs(a - b);
  return Math.min(raw, 1 - raw);
}

/**
 * The id range the palette promises to keep distinct. Not a hard bound on what
 * `allocatePlayerId` can produce — churn inside one tick blocks ids faster than
 * the tick-end drain frees them — but the range worth guaranteeing; beyond it
 * the palette repeats and spec §2.5's discriminator takes over.
 */
const ALL_IDS = Array.from({ length: LIMITS.maxConnections }, (_, i) => i + 1);
/** The ids that can be live AT THE SAME TIME (spec §8.3 cap + the bot ceiling). */
const POOL_IDS = Array.from({ length: PALETTE_SLOTS }, (_, i) => i + 1);

function pairsOf(ids: readonly number[]): [number, number][] {
  return ids.flatMap((a, i) => ids.slice(i + 1).map((b): [number, number] => [a, b]));
}

/** Neighbouring entries of an already-sorted list. */
function adjacent<T>(items: readonly T[]): [T, T][] {
  const pairs: [T, T][] = [];
  let previous: T | undefined;
  for (const item of items) {
    if (previous !== undefined) pairs.push([previous, item]);
    previous = item;
  }
  return pairs;
}

describe('player colors', () => {
  it('is stable per id and stays inside the hue circle', () => {
    for (const id of ALL_IDS) {
      const hue = playerHue(id);
      expect(hue).toBe(playerHue(id));
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(1);
    }
  });

  it('never hands an enemy a hue confusable with the reserved own-blue', () => {
    for (const id of ALL_IDS) {
      expect(hueGap(playerHue(id), SELF_HUE)).toBeGreaterThanOrEqual(0.05);
    }
  });

  it('spreads consecutive ids far apart — neighbours join in id order', () => {
    for (let id = 1; id < LIMITS.maxConnections; id++) {
      expect(hueGap(playerHue(id), playerHue(id + 1))).toBeGreaterThan(0.1);
    }
  });

  /**
   * The defect this palette replaces: the golden-ratio spread put ids 1 and 11
   * 0.1° apart, so two players' plateaus, heads and trails were one color in
   * the scene. Ids come from a lowest-free pool (`arena.ts allocatePlayerId`),
   * so 1 and 11 are both live as soon as eleven entities are.
   */
  it('gives every id that can be live at once its own slot on the wheel', () => {
    const hues = POOL_IDS.map(playerHue).sort((a, b) => a - b);
    const gaps = adjacent(hues).map(([lower, upper]) => upper - lower);
    // The wheel minus the reserved blue band, split evenly — nothing tighter.
    expect(Math.min(...gaps)).toBeCloseTo((1 - 2 * 0.09) / PALETTE_SLOTS, 6);
  });

  /**
   * At a full pool the even split lands ~12.3° apart, only just past the
   * "reads as one color" gap. Lightness alternates between wheel neighbours so
   * the two colors most likely to be confused differ on a second axis too.
   */
  it('alternates lightness between neighbours on the wheel', () => {
    const byHue = POOL_IDS.map((id) => playerColor(id)).sort((a, b) => a.hue - b.hue);
    for (const [lower, upper] of adjacent(byHue)) {
      expect(upper.lightness).not.toBeCloseTo(lower.lightness, 6);
    }
  });

  /**
   * A mass reconnect blocks ids in `pendingLeaves` while fresh sockets take
   * new ones, so ids past the pool are reachable and wrap onto a slot already
   * in use. Saturation is what keeps that wrap from being a collision.
   */
  it('never lets two ids read as the same color, wrap included', () => {
    for (const [a, b] of pairsOf(ALL_IDS)) {
      expect(sameShownColor(a, b, null), `ids ${String(a)} and ${String(b)}`).toBe(false);
    }
  });

  /**
   * Distinct is not the same as usable: a second axis that runs off its range
   * buys separation by making a player near-invisible on the light floor
   * (spec §3). Every id has to stay a color someone can actually see.
   */
  it('keeps every id readable on the light floor', () => {
    for (const id of ALL_IDS) {
      const { saturation, lightness } = playerColor(id);
      expect(lightness, `id ${String(id)} lightness`).toBeGreaterThanOrEqual(0.3);
      expect(lightness, `id ${String(id)} lightness`).toBeLessThanOrEqual(0.7);
      expect(saturation, `id ${String(id)} saturation`).toBeGreaterThanOrEqual(0.2);
      expect(saturation, `id ${String(id)} saturation`).toBeLessThanOrEqual(1);
    }
  });

  /**
   * The bijection rests on the stride being coprime to the slot count. Retuning
   * `maxPlayers` to 18 would make it 26 and hand ids duplicate hues in silence —
   * this is the assertion that makes that loud instead.
   */
  it('keeps the palette a bijection if the limits are ever retuned', () => {
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    expect(gcd(PALETTE_STRIDE, PALETTE_SLOTS)).toBe(1);
  });

  /**
   * `scene.ts` spawns the local head before the server has assigned an id and
   * passes a sentinel below 1. That must not land on a real player's slot —
   * it is the one path where the palette could still show two entities as one.
   */
  it('gives an id it does not know a color no player can hold', () => {
    for (const unknown of [0, -1, -2]) {
      expect(playerColor(unknown).saturation).toBe(0);
      for (const id of ALL_IDS) {
        expect(
          sameShownColor(unknown, id, null),
          `sentinel ${String(unknown)} vs id ${String(id)}`,
        ).toBe(false);
      }
    }
  });

  it('shows the own player in the reserved blue, whatever id it drew', () => {
    expect(playerCssColor(7, 7)).toBe(SELF_COLOR_CSS);
    expect(displayColor(7, 7)).toEqual({
      hue: SELF_HUE,
      saturation: SELF_SATURATION,
      lightness: SELF_LIGHTNESS,
    });
    expect(displayColor(7, 3)).toEqual(playerColor(7));
  });

  /**
   * The own color is authored as a hex (the scene feeds it to THREE.Color
   * directly), but `sameShownColor` has to compare it against generated HSL.
   * These constants describe that hex — if one moves without the other, the
   * blue silently stops matching itself.
   */
  it('describes the authored own-blue hex in HSL', () => {
    const hex = SELF_COLOR_CSS.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
      number,
      number,
      number,
    ];
    const [max, min] = [Math.max(r, g, b), Math.min(r, g, b)];
    const lightness = (max + min) / 2;
    const saturation = (max - min) / (1 - Math.abs(2 * lightness - 1));
    expect(lightness).toBeCloseTo(SELF_LIGHTNESS, 2);
    expect(saturation).toBeCloseTo(SELF_SATURATION, 2);
  });
});
