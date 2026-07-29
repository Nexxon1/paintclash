/**
 * How numbers look on the HUD — one module, because the leaderboard row and
 * the score panel must print a share of the map identically (spec §2.5: the
 * metric is one thing, wherever it appears).
 *
 * Locale-independent on purpose: `toLocaleString` would make a CI box and a
 * player's browser disagree about the same number. German conventions —
 * comma decimals, dot thousands — like the rest of the UI.
 */

import { BALANCE } from '@paintclash/shared';

/** A non-negative integer with dot-grouped thousands (`18.187`). */
export function formatScore(value: number): string {
  const rounded = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  // Dot every three digits from the right.
  return String(rounded).replace(/\B(?=(?:\d{3})+$)/g, '.');
}

/** `m:ss` — survival times are seconds-to-minutes, never hours. */
export function formatDuration(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const secs = total % 60;
  return `${String(Math.floor(total / 60))}:${String(secs).padStart(2, '0')}`;
}

/**
 * Share of the map, at the resolution the wire carries and the ranking is
 * decided at (`BALANCE.leaderboard.percentDecimals`) — so a leaderboard row,
 * a records line and a score's peak share can never print the same share
 * differently.
 */
export function formatPercent(areaPct: number): string {
  const value = Number.isFinite(areaPct) ? Math.max(0, areaPct) : 0;
  return `${value.toFixed(BALANCE.leaderboard.percentDecimals).replace('.', ',')} %`;
}
