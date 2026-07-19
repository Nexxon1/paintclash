/**
 * Seeded RNG (mulberry32) — the only randomness `sim-core` ever sees.
 * The generator state lives *in* the sim state and advances purely, so a
 * replay with the same seed reproduces every spawn bit-identically
 * (ADR-0003: no `Math.random`, no clock).
 */

/** Opaque RNG state — a uint32 word advanced on every draw. */
export type RngState = number;

/** Derive the initial RNG state from an arbitrary numeric seed. */
export function seedRng(seed: number): RngState {
  // Mix the seed once so small consecutive seeds don't start correlated.
  let h = (seed >>> 0) + 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
}

/** One mulberry32 draw: value in [0, 1) plus the advanced state. */
export function nextRandom(state: RngState): { value: number; state: RngState } {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, state: next };
}
