/**
 * Player colors — one mapping shared by the 3D scene and the HUD, so a
 * leaderboard swatch is the same color as the plateau it stands for
 * (spec §2.5). Placeholder until the `appearance` descriptor lands
 * (ADR-0006 skins seam); the id is the only identity we have today.
 *
 * The spread is a fixed PALETTE, not a sequence (ticket 21). A golden-ratio
 * walk of the hue circle is the right answer when the number of players is
 * unknown and unbounded — every prefix of it stays well spread. This arena
 * knows both: `arena.ts allocatePlayerId` hands out the smallest FREE id and
 * recycles ids of departed players, so the live ids are always a dense range
 * starting at 1. Optimising for the unbounded case while living in the
 * bounded one is what let ids 1 and 11 land 0.1° apart — two players whose
 * territory, head and trail were indistinguishable in the scene.
 */

import { BALANCE, LIMITS } from '@paintclash/shared';

/** Hue of the reserved own-player blue (0x2f7fe8 ≈ 214°). */
export const SELF_HUE = 0.594;
/** The own player's fixed color — reserved, never handed to an enemy. */
export const SELF_COLOR_CSS = '#2f7fe8';
/**
 * `SELF_COLOR_CSS` in HSL. The scene feeds the hex to THREE.Color directly, so
 * the hex stays authoritative for what is drawn — but `sameShownColor` has to
 * weigh the own color against generated ones, and that needs components. A
 * test pins these to the hex so the two cannot drift apart.
 */
export const SELF_SATURATION = 0.8;
export const SELF_LIGHTNESS = 0.55;
/** Saturation/lightness enemy colors vary around (readable on the light floor). */
const PLAYER_SATURATION = 0.65;
const PLAYER_LIGHTNESS = 0.55;

/** Enemy hues stay this far clear of the reserved own-blue, on both sides. */
const SELF_HUE_GUARD = 0.09;
/** The share of the wheel the own-blue reserves — unavailable to enemies. */
const RESERVED_BAND = 2 * SELF_HUE_GUARD;

/**
 * Hue slots: one per id that can be LIVE AT THE SAME TIME. The arena admits
 * `maxPlayers` connections (spec §8.3) and tops up to `maxBots` bots, and a
 * private room cannot exceed either (`playerLimitMax` = `maxPlayers`), so 24
 * ids is the whole pool. Splitting the usable wheel that many ways is the
 * theoretical best a hue-only palette can do — anything coarser wastes
 * separation, anything finer buys slots nobody can occupy.
 */
export const PALETTE_SLOTS = LIMITS.maxPlayers + BALANCE.bots.maxBots;
/**
 * Ids walk the slots in steps of this many, so players who join back to back
 * do not get neighbouring colors — the property that made the golden-ratio
 * spread worth keeping. 13 is the prime nearest `PALETTE_SLOTS / φ` (14.8);
 * being coprime to the slot count makes id → slot a bijection, so no two ids
 * in the pool can ever share a hue. A test guards the coprimality.
 */
export const PALETTE_STRIDE = 13;
/**
 * Saturation tiers, for ids PAST the pool. Those are reachable: a disconnect
 * blocks its id in `pendingLeaves` until the next tick while the freed slot
 * already admits a new socket, so a mass reconnect can push ids well past 24.
 * Such an id wraps onto a slot that is still in use, and only a second axis
 * keeps that wrap from being the very collision this palette removes.
 *
 * Sized by `maxConnections`, which is a PRACTICAL cover rather than a proof:
 * it bounds concurrent connections, not the id range, and churn inside a
 * single tick blocks ids faster than the drain frees them. Past
 * `PALETTE_SLOTS × PALETTE_TIERS` the palette repeats exactly, and spec §2.5's
 * discriminator is what covers that — which is the job it was given.
 *
 * Saturation rather than lightness: lightness already carries the alternation
 * below, and stacking both on one axis walks the outer tier off the readable
 * range (near-white on a light floor). These two axes stay independent.
 */
export const PALETTE_TIERS = Math.ceil(LIMITS.maxConnections / PALETTE_SLOTS);
/** How far a tier drops saturation — a muted twin, never a washed-out one. */
const TIER_SATURATION_STEP = 0.22;
/**
 * Neighbouring slots sit ~12.3° apart — past the "one color" gap, but not by
 * much. Alternating lightness gives the two colors most likely to be confused
 * a second difference. The slot count is even, so the alternation stays
 * consistent all the way around the wheel.
 */
const SLOT_LIGHTNESS_ALTERNATION = 0.06;

/**
 * Hue gap below which two swatches read as one color at a glance (≈11°) —
 * unless they differ on another axis, see `sameShownColor`.
 */
const SAME_COLOR_HUE_GAP = 0.03;
/** Lightness gap that tells two same-hue swatches apart. */
const SAME_COLOR_LIGHTNESS_GAP = 0.05;
/** Saturation gap that tells two same-hue swatches apart. */
const SAME_COLOR_SATURATION_GAP = 0.15;

/** Hue, saturation and lightness of one player's color. */
export interface PlayerColor {
  hue: number;
  saturation: number;
  lightness: number;
}

const frac = (x: number): number => x - Math.floor(x);

/**
 * A player whose id is not known yet. `scene.ts` spawns the local head before
 * the server has assigned one and passes a sentinel below 1; without an answer
 * of its own that id would land on a slot and read as a REAL player — the very
 * collision this palette exists to prevent, on a live path. Neutral grey says
 * "nobody yet" instead, and no real id can produce it (every slot carries
 * `PLAYER_SATURATION` or a tier of it, none of them zero).
 */
const UNKNOWN_COLOR: PlayerColor = Object.freeze({
  hue: 0,
  saturation: 0,
  lightness: PLAYER_LIGHTNESS,
});

/** Zero-based id, for the slot arithmetic. Only called with `id >= 1`. */
function paletteIndex(id: number): number {
  return Math.trunc(id) - 1;
}

/** Which slot on the wheel an id owns. Bijective over `PALETTE_SLOTS` ids. */
function paletteSlot(id: number): number {
  return (paletteIndex(id) * PALETTE_STRIDE) % PALETTE_SLOTS;
}

/** How often this id has wrapped past the pool — 0 for every ordinary game. */
function paletteTier(id: number): number {
  return Math.floor(paletteIndex(id) / PALETTE_SLOTS) % PALETTE_TIERS;
}

/**
 * Stable, well-spread hue for one player id: the slot's centre on the wheel,
 * skipping the band reserved for the own-blue.
 */
function playerHue(id: number): number {
  const offset = ((paletteSlot(id) + 0.5) / PALETTE_SLOTS) * (1 - RESERVED_BAND);
  return frac(SELF_HUE + SELF_HUE_GUARD + offset);
}

/** Full color for an enemy id: hue from the slot, plus the two guard axes. */
export function playerColor(id: number): PlayerColor {
  if (id < 1) return UNKNOWN_COLOR;
  const alternation = paletteSlot(id) % 2 === 0 ? -1 : 1;
  return {
    hue: playerHue(id),
    saturation: PLAYER_SATURATION - paletteTier(id) * TIER_SATURATION_STEP,
    lightness: PLAYER_LIGHTNESS + alternation * SLOT_LIGHTNESS_ALTERNATION,
  };
}

/** The color a player is actually SHOWN in — the own one is always the blue. */
export function displayColor(playerId: number, selfId: number | null): PlayerColor {
  return playerId === selfId
    ? { hue: SELF_HUE, saturation: SELF_SATURATION, lightness: SELF_LIGHTNESS }
    : playerColor(playerId);
}

/**
 * Do these two players look like the same color to a viewer? The swatch is
 * what tells non-unique nicknames apart (spec §2.8), so wherever it stops
 * doing that the HUD has to say so (spec §2.5's discriminator). The palette
 * is built so this never fires — it stays as the check that says whether that
 * is still true, not as dead weight.
 */
export function sameShownColor(a: number, b: number, selfId: number | null): boolean {
  const [left, right] = [displayColor(a, selfId), displayColor(b, selfId)];
  const rawGap = Math.abs(left.hue - right.hue);
  const hueGap = Math.min(rawGap, 1 - rawGap);
  if (hueGap >= SAME_COLOR_HUE_GAP) return false;
  return (
    Math.abs(left.lightness - right.lightness) < SAME_COLOR_LIGHTNESS_GAP &&
    Math.abs(left.saturation - right.saturation) < SAME_COLOR_SATURATION_GAP
  );
}

/** CSS color for a swatch, matching that player's meshes in the scene. */
export function playerCssColor(playerId: number, selfId: number | null): string {
  if (playerId === selfId) return SELF_COLOR_CSS;
  const { hue, saturation, lightness } = playerColor(playerId);
  return `hsl(${String(Math.round(hue * 360))}, ${String(Math.round(saturation * 100))}%, ${String(Math.round(lightness * 100))}%)`;
}
