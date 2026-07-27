import { LIMITS } from '@paintclash/shared';
import { describe, expect, it } from 'vitest';

import { displayHue, playerCssColor, playerHue, SELF_COLOR_CSS, SELF_HUE } from './colors.js';

/** Distance on the color wheel (hue wraps at 1). */
function hueGap(a: number, b: number): number {
  const raw = Math.abs(a - b);
  return Math.min(raw, 1 - raw);
}

describe('player colors', () => {
  it('is stable per id and stays inside the hue circle', () => {
    for (let id = 1; id <= LIMITS.maxConnections; id++) {
      const hue = playerHue(id);
      expect(hue).toBe(playerHue(id));
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(1);
    }
  });

  it('never hands an enemy a hue confusable with the reserved own-blue', () => {
    for (let id = 1; id <= LIMITS.maxConnections; id++) {
      expect(hueGap(playerHue(id), SELF_HUE)).toBeGreaterThanOrEqual(0.05);
    }
  });

  it('spreads consecutive ids far apart — neighbours join in id order', () => {
    for (let id = 1; id < LIMITS.maxConnections; id++) {
      expect(hueGap(playerHue(id), playerHue(id + 1))).toBeGreaterThan(0.1);
    }
  });

  it('shows the own player in the reserved blue, whatever id it drew', () => {
    expect(playerCssColor(7, 7)).toBe(SELF_COLOR_CSS);
    expect(displayHue(7, 7)).toBe(SELF_HUE);
    // 7 × 0.618034 = 4.326238 → hue 0.326238 (clear of the blue) → 117.4°.
    expect(playerCssColor(7, 3)).toBe('hsl(117, 65%, 55%)');
    expect(displayHue(7, 3)).toBe(playerHue(7));
  });
});
