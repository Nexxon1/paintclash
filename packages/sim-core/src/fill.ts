/**
 * Loop closing → polygon fill (spec §2.2, strictly server-only per §6.1 —
 * only the authoritative tick ever calls this; clients merely receive the
 * result). Boolean geometry runs on polyclip-ts (Martinez sweep with exact
 * predicates): deterministic pure float math, verified in the ticket-04
 * spike against shared edges, chord overlaps, bowties and garbage rings.
 *
 * Capture semantics (stealing since ticket 06):
 *
 *   1. union(territory, loop polygon)   — loop = trail + straight chord
 *   2. fill the union's holes           — everything enclosed is captured:
 *                                         neutral pockets AND foreign land
 *                                         (überfärbt/gestohlen, spec §2.2)
 *   3. carve the capture out of every   — territories stay pairwise
 *      overlapped foreign territory       disjoint; a foreign territory
 *                                         reduced to nothing is the step's
 *                                         total-loss verdict
 *
 * The whole capture is atomic: if any boolean op fails or returns corrupt
 * topology, the entire fill — steal included — is forfeited deterministically
 * instead of crashing the tick or leaving half-applied land. Stored
 * territories stay hole-free: every fill's own output is hole-filled, spawn
 * blocks are carved to AVOID foreign land (never to hole it), and a steal
 * removes a connected, boundary-touching bite. That invariant matters —
 * step 2 fills every hole of the union, so a hole backed by foreign land
 * would be stolen without being enclosed; none can exist.
 */

import { BALANCE, type Point, type Ring, type Territory } from '@paintclash/shared';
import { difference, union } from 'polyclip-ts';

import { ringArea, snapWU, squareRing, territoryArea, validPolyTopology } from './geometry.js';

/** Rings below this area are float debris from the clipper, not land. */
const DEBRIS_AREA_WU2 = 1e-9;

export interface FillOutcome {
  /** The player's new territory, replacing the old one. */
  territory: Territory;
  /** Net captured area in WU² — always ≥ BALANCE.trail.minFillAreaWU2. */
  gainedArea: number;
  /**
   * The foreign territories after the steal, index-aligned with the `others`
   * input. An entry the loop did not touch keeps its input reference —
   * uninvolved players stay bit-identical (replay hash, no phantom syncs).
   * An entry reduced to `[]` lost everything: the total-loss verdict.
   */
  others: Territory[];
}

/**
 * Close a trail loop against the player's territory. `trail` runs from the
 * last pose inside the territory over the outside excursion to the first
 * pose back inside; the implicit chord back to the start closes the ring.
 *
 * Returns `null` when nothing is captured: the enclosed area is below the
 * sliver floor, the trail is too short to enclose anything, or any boolean
 * op fails/corrupts (verified failure mode: massive self-overlap) — then the
 * capture is forfeited deterministically, steal included, instead of
 * crashing the tick or leaving half-applied land. Callers reset the trail
 * either way.
 */
export function closeLoop(
  territory: Territory,
  trail: readonly Point[],
  others: readonly Territory[],
): FillOutcome | null {
  if (trail.length < 3) return null;
  // All clipper inputs live on the snap lattice (see geometry.ts) — raw
  // float trails go on it here; territories are prior lattice outputs.
  const loop: Territory = [[trail.map((p): Point => [snapWU(p[0]), snapWU(p[1])])]];
  let captured: Territory | null;
  const updatedOthers: Territory[] = [];
  try {
    const merged = union(territory, loop);
    // Fill every hole: everything enclosed is captured — neutral pockets and
    // foreign land alike (spec §2.2: überfärbt/gestohlen).
    const filled: Territory = [];
    for (const poly of merged) {
      const outer = poly[0];
      if (outer !== undefined) filled.push([outer]);
    }
    captured = cleanClipperOutput(filled);
    if (captured === null) return null;
    for (const other of others) {
      if (other.length === 0) {
        updatedOthers.push(other);
        continue;
      }
      const carvedOther = cleanClipperOutput(difference(other, captured));
      if (carvedOther === null) return null;
      // Same area ⇒ same land (the difference only ever removes): keep the
      // input reference so untouched territories stay bit-identical.
      const stolen = territoryArea(other) - territoryArea(carvedOther);
      updatedOthers.push(stolen < DEBRIS_AREA_WU2 ? other : carvedOther);
    }
  } catch {
    // polyclip could not resolve the geometry. Deterministic for identical
    // inputs — replay-safe.
    return null;
  }
  const gainedArea = territoryArea(captured) - territoryArea(territory);
  if (!(gainedArea >= BALANCE.trail.minFillAreaWU2)) return null;
  return { territory: captured, gainedArea, others: updatedOthers };
}

/**
 * Compact raw clipper output and vet its topology. `null` means the output
 * was corrupt and must not be stored — corrupt "holes" outside their outer
 * ring would turn even-odd containment inside out (verified pre-lattice
 * failure mode; no lattice-snapped input is known to still trigger it).
 */
function cleanClipperOutput(raw: Territory): Territory | null {
  const cleaned = raw.map(compactPoly).filter((poly) => poly.length > 0);
  return cleaned.every(validPolyTopology) ? cleaned : null;
}

/**
 * The spawn start block as a territory: a square around the (lattice-snapped)
 * spawn spot, minus everyone else's land — start blocks never overlap
 * existing territory, which keeps territories pairwise disjoint by
 * construction (the "areas + neutral = 100 %" invariant, spec §9.2). Under
 * pathological crowding the clipped block may come back smaller or even
 * empty — best effort, like the spawn spot itself (spec §2.3).
 */
export function spawnTerritory(
  cx: number,
  cy: number,
  half: number,
  others: readonly Territory[],
): Territory {
  const block: Territory = [[squareRing(snapWU(cx), snapWU(cy), snapWU(half))]];
  const foreign = others.filter((t) => t.length > 0);
  if (foreign.length === 0) return block;
  let carved: Territory;
  try {
    carved = difference(block, ...foreign);
  } catch {
    // Clipper failure (no known trigger on lattice inputs): keep the raw
    // block — a live spawn beats a perfect invariant here.
    return block;
  }
  return cleanClipperOutput(carved) ?? block;
}

/**
 * Drop debris rings and collapse exactly-collinear vertex chains (unions
 * along straight edges accumulate them). Purely cosmetic-scale cleanup —
 * boundaries move < 1e-9 WU — but it keeps vertex counts bounded over
 * hundreds of fills. Dropping a degenerate outer ring drops its holes too.
 */
function compactPoly(poly: Ring[]): Ring[] {
  const outer = poly[0];
  if (outer === undefined || Math.abs(ringArea(outer)) < DEBRIS_AREA_WU2) return [];
  const kept: Ring[] = [];
  for (const ring of poly) {
    const compacted = compactRing(ring);
    if (compacted.length >= 3 && Math.abs(ringArea(compacted)) >= DEBRIS_AREA_WU2) {
      kept.push(compacted);
    }
  }
  return kept;
}

/**
 * Snap output vertices back onto the lattice (clipper-computed intersection
 * points land off it), drop the duplicates that snapping creates, and remove
 * vertices sitting exactly on the segment between their neighbors.
 */
function compactRing(ring: Ring): Ring {
  const snapped: Ring = [];
  for (const p of ring) {
    const x = snapWU(p[0]);
    const y = snapWU(p[1]);
    const last = snapped[snapped.length - 1];
    if (last?.[0] !== x || last[1] !== y) snapped.push([x, y]);
  }
  const first = snapped[0];
  const last = snapped[snapped.length - 1];
  if (snapped.length > 1 && first !== undefined && last !== undefined) {
    if (first[0] === last[0] && first[1] === last[1]) snapped.pop();
  }
  const n = snapped.length;
  if (n < 3) return snapped;
  const kept: Ring = [];
  for (let i = 0; i < n; i++) {
    const prev = snapped[(i + n - 1) % n];
    const curr = snapped[i];
    const next = snapped[(i + 1) % n];
    if (prev === undefined || curr === undefined || next === undefined) continue;
    const cross =
      (curr[0] - prev[0]) * (next[1] - curr[1]) - (curr[1] - prev[1]) * (next[0] - curr[0]);
    const forward =
      (curr[0] - prev[0]) * (next[0] - curr[0]) + (curr[1] - prev[1]) * (next[1] - curr[1]) > 0;
    if (forward && Math.abs(cross) < 1e-12) continue;
    kept.push(curr);
  }
  return kept;
}
