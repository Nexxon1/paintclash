/**
 * Player colors — one mapping shared by the 3D scene and the HUD, so a
 * leaderboard swatch is the same color as the plateau it stands for
 * (spec §2.5). Placeholder until the `appearance` descriptor lands
 * (ADR-0006 skins seam); the id is the only identity we have today.
 */

/** Hue of the reserved own-player blue (0x2f7fe8 ≈ 214°). */
export const SELF_HUE = 0.594;
/** The own player's fixed color — reserved, never handed to an enemy. */
export const SELF_COLOR_CSS = '#2f7fe8';
/** Saturation/lightness of every enemy color (readable on the light floor). */
export const PLAYER_SATURATION = 0.65;
export const PLAYER_LIGHTNESS = 0.55;

/** Golden-ratio step — consecutive ids land far apart on the color wheel. */
const HUE_STEP = 0.618034;
/** Enemy hues this close to the own-blue are pushed away from it. */
const SELF_HUE_GUARD = 0.09;
const SELF_HUE_BUMP = 0.18;

/**
 * Hue gap below which two swatches read as one color at a glance (≈11°).
 * The spread is a golden-ratio sequence, so ids 10, 21, 34 or 55 apart land
 * inside it — with up to `maxConnections` players in one arena that is a
 * collision players actually hit.
 */
const SAME_COLOR_HUE_GAP = 0.03;

/**
 * Stable, well-spread hue for one player id. Hues within `SELF_HUE_GUARD` of
 * the reserved own-blue are bumped past it — id 1 lands almost exactly on it,
 * and an enemy indistinguishable from yourself is a gameplay bug, not a
 * cosmetic one.
 */
export function playerHue(id: number): number {
  const hue = (id * HUE_STEP) % 1;
  return Math.abs(hue - SELF_HUE) < SELF_HUE_GUARD ? (hue + SELF_HUE_BUMP) % 1 : hue;
}

/** The hue a player is actually SHOWN in — the own one is always the blue. */
export function displayHue(playerId: number, selfId: number | null): number {
  return playerId === selfId ? SELF_HUE : playerHue(playerId);
}

/**
 * Do these two players look like the same color to a viewer? The swatch is
 * what tells non-unique nicknames apart (spec §2.8), so wherever it stops
 * doing that — colliding hues — the HUD has to say so (spec §2.5's
 * discriminator).
 */
export function sameShownColor(a: number, b: number, selfId: number | null): boolean {
  const gap = Math.abs(displayHue(a, selfId) - displayHue(b, selfId));
  return Math.min(gap, 1 - gap) < SAME_COLOR_HUE_GAP;
}

/** CSS color for a swatch, matching that player's meshes in the scene. */
export function playerCssColor(playerId: number, selfId: number | null): string {
  if (playerId === selfId) return SELF_COLOR_CSS;
  const hue = Math.round(playerHue(playerId) * 360);
  const saturation = Math.round(PLAYER_SATURATION * 100);
  const lightness = Math.round(PLAYER_LIGHTNESS * 100);
  return `hsl(${String(hue)}, ${String(saturation)}%, ${String(lightness)}%)`;
}
