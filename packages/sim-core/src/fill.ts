/**
 * Loop closing → polygon fill (spec §2.2, strictly server-only per §6.1 —
 * only the authoritative tick ever calls this; clients merely receive the
 * result). Boolean geometry runs on polyclip-ts (Martinez sweep with exact
 * predicates): deterministic pure float math, verified in the ticket-04
 * spike against shared edges, chord overlaps, bowties and garbage rings.
 *
 * Capture semantics of the base version (no stealing until ticket 06):
 *
 *   1. union(territory, loop polygon)   — loop = trail + straight chord
 *   2. fill the union's holes           — pockets enclosed between loop and
 *                                         territory are captured land
 *   3. carve every foreign territory    — foreign land is never taken, and
 *                                         a fully encircled block re-appears
 *                                         as a hole (annulus capture)
 *
 * Step 3 re-carves any pre-existing hole still backed by foreign land, so
 * filling *all* holes in step 2 is sound. A hole orphaned by its owner
 * leaving stays neutral until some later fill consolidates it — deliberate:
 * enclosed neutral land is only ever taken by closing a loop.
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
}

/**
 * Close a trail loop against the player's territory. `trail` runs from the
 * last pose inside the territory over the outside excursion to the first
 * pose back inside; the implicit chord back to the start closes the ring.
 *
 * Returns `null` when nothing is captured: the enclosed area is below the
 * 1 WU² sliver floor, the trail is too short to enclose anything, or the
 * loop ring is so degenerate (heavy self-overlap) that the clipper fails —
 * then the capture is forfeited deterministically instead of crashing the
 * tick. Callers reset the trail either way.
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
  let captured: Territory;
  try {
    const merged = union(territory, loop);
    // Fill every hole: enclosed pockets are captured (step 3 re-carves any
    // hole that is actually foreign land).
    const filled: Territory = [];
    for (const poly of merged) {
      const outer = poly[0];
      if (outer !== undefined) filled.push([outer]);
    }
    const foreign = others.filter((t) => t.length > 0);
    captured = foreign.length > 0 ? difference(filled, ...foreign) : filled;
  } catch {
    // polyclip could not resolve the ring (verified failure mode: massive
    // self-overlap). Deterministic for identical inputs — replay-safe.
    return null;
  }
  const cleaned = cleanClipperOutput(captured);
  if (cleaned === null) return null;
  const gainedArea = territoryArea(cleaned) - territoryArea(territory);
  if (!(gainedArea >= BALANCE.trail.minFillAreaWU2)) return null;
  return { territory: cleaned, gainedArea };
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
