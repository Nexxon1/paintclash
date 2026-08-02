/**
 * Loop closing → polygon fill (spec §2.2, strictly server-only per §6.1 —
 * only the authoritative tick ever calls this; clients merely receive the
 * result). Boolean geometry runs on a Martinez sweep behind `clipper.ts`
 * (ADR-0007): deterministic pure math, verified in the ticket-04 spike
 * against shared edges, chord overlaps, bowties and garbage rings.
 *
 * Capture semantics (stealing since ticket 06):
 *
 *   1. union(territory, loop polygon)   — loop = trail + straight chord,
 *                                         sealed with a hair-thin band when
 *                                         the trail is straight (ticket 26)
 *   2. fill the union's holes           — everything enclosed is captured:
 *                                         neutral pockets AND foreign land
 *                                         (überfärbt/gestohlen, spec §2.2)
 *   2b. fill its BAYS as well           — an enclosure the clipper left open
 *                                         through a neck of a few lattice
 *                                         cells is no hole, and step 2 walks
 *                                         straight past it (ticket 30)
 *   3. carve the capture out of every   — territories stay pairwise
 *      overlapped foreign territory       disjoint; a foreign territory
 *                                         reduced to nothing is the step's
 *                                         total-loss verdict
 *
 * Steps 2 and 2b are the same question asked twice, and they have to be, since
 * only the second one can be asked on the lattice: the hole-fill reads the
 * union's raw output, where "enclosed" is topological, while `sealCapture`
 * reads the snapped output and asks what the player is actually asking — is
 * this land walled in? A channel four lattice cells wide is a way out to the
 * first question and not to the second, and the difference was a patch of
 * neutral ground inside a player's own colour that nothing ever painted.
 *
 * Step 3 is where a tick's cost lives (ticket 22): one clipper op per foreign
 * player per fill, each sweeping both territories entirely, so it grew with
 * the map's saturation until single ticks blew the 20 Hz budget — and since
 * an overrun pauses the world for everyone, that read as a freeze rather than
 * a stutter. Two bounds keep it in budget, both exact rather than
 * approximations: `skipsCarve` drops the pairs that provably cannot meet, and
 * the op that survives carves with the region this fill GAINED instead of the
 * player's whole accumulated land (see `skipsCarve`'s preamble for why those
 * are the same result). Measured over 8 bots × 5 min: max 189 → 36–43 ms per
 * tick. What remains grows with the territories' vertex count — ticket 23.
 *
 * The whole capture is atomic: if any boolean op fails or returns corrupt
 * topology, the entire fill — steal included — is forfeited deterministically
 * instead of crashing the tick or leaving half-applied land. Stored
 * territories stay hole-free: every fill's own output is hole-filled, spawn
 * blocks are carved to AVOID foreign land (never to hole it), and a steal
 * removes a connected, boundary-touching bite. That invariant matters —
 * step 2 fills every hole of the union, so a hole backed by foreign land
 * would be stolen without being enclosed; none can exist. A carve or a spawn
 * block may still leave a BAY behind, and those are deliberately left alone:
 * there the pocket is land the winner just took and holds, so filling it for
 * the loser would hand the same ground to two players.
 */

import { BALANCE, type Point, type Ring, type Territory } from '@paintclash/shared';

import { difference, union } from './clipper.js';
import {
  boundsSeparated,
  polylineBand,
  ringArea,
  sealEnclosedBays,
  snapWU,
  squareRing,
  territoryArea,
  territoryBounds,
  validPolyTopology,
  type Bounds,
} from './geometry.js';

/**
 * Rings below this area are float debris from the clipper, not land — and, the
 * same fact read from the other side, too thin to bound a region at all, which
 * is what decides whether a loop ring needs the seal band (`loopPolygons`).
 */
const DEBRIS_AREA_WU2 = 1e-9;

/**
 * Half-width of the seal band a degenerate loop ring is closed with
 * (`loopPolygons`, ticket 26). Two facts fix the order of magnitude:
 *
 * - **Above the snap lattice** (1e-7 WU, ADR-0007) by 10×, so the band is real
 *   geometry to the clipper and cannot be snapped flat.
 * - **Far below the fill floor** in the only way that matters: a band is at
 *   most `2 × this × trail length` of land, so even a trail spanning the whole
 *   200 WU arena carries 4e-4 WU² — a fortieth of `minFillAreaWU2`. Sealing a
 *   crossing can therefore never, on its own, lift a capture over the floor;
 *   it only lets the clipper see a crossing that was always there.
 *
 * It is emphatically NOT the rendered trail width (`BALANCE.trail.widthWU` =
 * 1 WU). Unioning the trail as the 1-WU band it looks like would hand every
 * fill a half-width margin along its whole path — a balance change, and a big
 * one. This is a numerical seal, sized to be invisible.
 */
const SEAL_HALF_WIDTH_WU = 1e-6;

/**
 * How wide a channel out of an enclosure may be before the fill accepts it as
 * a way out (`sealEnclosedBays`, ticket 30). Three facts fix the value at
 * 1e-4 WU:
 *
 * - **Three orders above the snap lattice** (1e-7, ADR-0007), which is what it
 *   has to clear: the necks the clipper leaves behind measure four to eight
 *   lattice cells, and matching them exactly — asking for a repeated vertex —
 *   would have caught 6 of the 140 pockets a ten-minute arena produced.
 * - **Four orders below anything playable.** A head is 1 WU wide and steps
 *   `MIN_TRAIL_STEP_WU` = 0,1 WU per tick, so the narrowest gap a player can
 *   aim at, drive through or even see is a thousand times this. Nothing that
 *   loses a capture here was ever a channel.
 * - **It is where the client already stops resolving geometry** — the carve
 *   lattice is 1e-4 WU (ticket 25). A neck the renderer cannot draw apart is
 *   not a neck to the player looking at it.
 */
const SEALED_NECK_WU = 1e-4;

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
 * pose back inside; the implicit chord back to the start closes the ring. A
 * dead-straight excursion is a loop like any other — see `loopPolygons`.
 *
 * Returns `null` when nothing is captured: the enclosed area is below the
 * sliver floor, the trail is not even a segment, or any boolean op
 * fails/corrupts (verified failure mode: massive self-overlap) — then the
 * capture is forfeited deterministically, steal included, instead of
 * crashing the tick or leaving half-applied land. Callers reset the trail
 * either way.
 */
export function closeLoop(
  territory: Territory,
  trail: readonly Point[],
  others: readonly Territory[],
): FillOutcome | null {
  const loop = loopPolygons(trail);
  if (loop === null) return null;
  let captured: Territory | null;
  const updatedOthers: Territory[] = [];
  try {
    const merged = union(territory, loop);
    // Fill every hole: everything enclosed is captured — neutral pockets and
    // foreign land alike (spec §2.2: überfärbt/gestohlen). The holes are kept
    // as well: they are the part of the capture the loop itself does not
    // cover, and the carve below needs them (see `gained`).
    const filled: Territory = [];
    const rawPockets: Territory = [];
    for (const poly of merged) {
      const outer = poly[0];
      if (outer !== undefined) filled.push([outer]);
      for (const hole of poly.slice(1)) rawPockets.push([hole]);
    }
    const cleaned = cleanClipperOutput(filled);
    if (cleaned === null) return null;
    // Second pass over the same question, now that the output sits on the
    // lattice: an enclosure the clipper left open through a sub-visible neck
    // is no hole and survived the fill above (ticket 30).
    const sealed = sealCapture(cleaned);
    captured = sealed.territory;
    // Compacted, not vetted: each pocket becomes a single-ring polygon, and
    // the topology check only has something to say about holes.
    const pockets = [...compactTerritory(rawPockets), ...sealed.bays];
    const gained = gainedRegion(loop, pockets);
    const gainedBounds = territoryBounds(gained);
    for (const other of others) {
      // Nothing to carve, or provably nothing in reach: keep the input
      // reference — exactly what the area check below would conclude, minus
      // the sweep. See `skipsCarve`.
      if (other.length === 0 || skipsCarve(gainedBounds, other)) {
        updatedOthers.push(other);
        continue;
      }
      const carvedOther = cleanClipperOutput(difference(other, gained));
      if (carvedOther === null) return null;
      // Same area ⇒ same land (the difference only ever removes): keep the
      // input reference so untouched territories stay bit-identical.
      const stolen = territoryArea(other) - territoryArea(carvedOther);
      updatedOthers.push(stolen < DEBRIS_AREA_WU2 ? other : carvedOther);
    }
  } catch {
    // The clipper could not resolve the geometry. Deterministic for identical
    // inputs — replay-safe.
    return null;
  }
  const gainedArea = territoryArea(captured) - territoryArea(territory);
  if (!(gainedArea >= BALANCE.trail.minFillAreaWU2)) return null;
  return { territory: captured, gainedArea, others: updatedOthers };
}

/**
 * The trail as polygons for the clipper: its own ring — the trail plus the
 * implicit chord back to the start — and, when that ring is degenerate, a
 * hair-thin band along the trail. `null` when the trail is not even a segment;
 * everything else the area check at the end of `closeLoop` decides, which is
 * the only question that was ever being asked (a capture below the sliver floor
 * is no capture).
 *
 * The band is what makes a DEAD-STRAIGHT crossing count (ticket 26). Driving
 * straight is exactly collinear tick after tick — same heading, same step — so
 * `appendTrailPoint` folds the whole excursion into two points, deliberately
 * (straight runs cost O(1) vertices instead of one per tick). But two points
 * are a line, not a region: `union(territory, loop)` adds nothing, no hole
 * appears, and the hole-fill finds nothing to capture. Driving straight is also
 * precisely how one crosses a small gap, so the mechanic failed exactly where
 * players reached for it, and 0,05 WU of steering — a fifth of a head's width —
 * decided between a capture and nothing.
 *
 * A zero-area ring is not a rule about the move, though. Geometrically the run
 * IS a closed loop: the trail seals the gap, and the pocket's remaining sides
 * are the player's own border. The band gives that seal the one property the
 * boolean pipeline needs from it — a thickness — and nothing else.
 *
 * The ring is kept ALONGSIDE the band rather than replaced by it, because
 * "zero signed area" is not the same as "covers nothing": a trail that crosses
 * itself into two counter-oriented lobes cancels to ~0 while covering real
 * land, and the clipper resolves such a ring to exactly that land (the spiral
 * case in `fill.test.ts`). Adding the band can only ever add; replacing the
 * ring could silently drop a capture. A degenerate ring costs the clipper
 * nothing — it resolves to the empty set, verified for both the two-point and
 * the collinear-three-point case, on both engines ADR-0007 has run.
 *
 * The chord needs no seal of its own: a ring this thin has its chord lying
 * along the trail it closes, so the band already covers it.
 */
function loopPolygons(trail: readonly Point[]): Territory | null {
  if (trail.length < 2) return null;
  // All clipper inputs live on the snap lattice (see geometry.ts) — raw float
  // trails go on it here; territories are prior lattice outputs.
  const ring: Ring = trail.map((p): Point => [snapWU(p[0]), snapWU(p[1])]);
  if (Math.abs(ringArea(ring)) >= DEBRIS_AREA_WU2) return [[ring]];
  return [[ring], ...polylineBand(ring, SEAL_HALF_WIDTH_WU).map((quad): Ring[] => [quad])];
}

/**
 * Fill the enclosures the hole-fill could not see, and report them as pockets.
 *
 * The hole-fill above reads the union's RAW output, where an enclosure only
 * counts if the clipper called it a hole ring. It does not when the boundary
 * leaves it open through a channel of a few lattice cells — geometry says
 * "bay", the player sees a walled-in island of neutral ground that no later
 * fill ever paints. `sealEnclosedBays` asks the same question of the
 * lattice-snapped ring instead, where that channel is a rounding artefact
 * rather than a way out; see its preamble for why 1e-4 WU is the line.
 *
 * The cut-out bays join the union's hole rings as `pockets`, for the same
 * reason those exist: they are part of what this fill GAINED, so the steal
 * has to carve foreign land out of them (spec §2.2). Skipping that would let
 * a pocket backed by an opponent's land be owned twice.
 */
function sealCapture(captured: Territory): { territory: Territory; bays: Territory } {
  const territory: Territory = [];
  const bays: Territory = [];
  for (const poly of captured) {
    const outer = poly[0];
    if (outer === undefined) continue;
    const sealed = sealEnclosedBays(outer, SEALED_NECK_WU);
    if (sealed.bays.length === 0) {
      territory.push(poly);
      continue;
    }
    // Cutting bays out can only ever grow the ring's area, so a piece that
    // survived `compactPoly` still has one — but its vertices are gone if the
    // whole piece WAS a bay's rim, and a two-point remainder is not a ring.
    if (sealed.ring.length >= 3) territory.push([sealed.ring, ...poly.slice(1)]);
    for (const bay of sealed.bays) {
      if (Math.abs(ringArea(bay)) >= DEBRIS_AREA_WU2) bays.push([bay]);
    }
  }
  return { territory, bays };
}

/**
 * The land this fill ADDED: the loop plus the pockets it enclosed. Carving
 * foreign territory with THIS instead of the whole capture is an identity,
 * not an approximation (ticket 22):
 *
 *     captured         = territory ∪ loop ∪ pockets     (that IS the hole-fill)
 *     other − captured = (other − territory) − (loop ∪ pockets)
 *                      = other − (loop ∪ pockets)       ⟸ other ∩ territory = ∅
 *
 * The last step is the pairwise-disjointness invariant (spec §9.2): a foreign
 * territory never overlaps the filler's OLD land, so subtracting that land
 * again removes nothing. What remains — loop plus enclosed pockets — is a
 * handful of vertices, while `captured` carries every vertex the player ever
 * accumulated. That is the difference between a carve that scales with the
 * winner's history and one that scales with the move they just made; it is
 * pinned by the differential property test in `fill.test.ts`, since the
 * golden replay never steals and so cannot see a carve change.
 *
 * Both operands come free: the loop is already built, and the pockets are the
 * union's hole rings, which the hole-fill discards anyway.
 *
 * The identity is exact in LAND, but not bit-exact in stored coordinates, and
 * that has one measurable consequence. `captured` is the lattice-compacted
 * union output, so where snapping nudged a union-computed intersection point
 * outward (≤ 7e-8 WU, half a lattice cell), the winner's boundary steps a
 * hair past the raw loop edge the loser was carved against. Carving with
 * `captured` left the two provably flush; carving with the gained region
 * leaves a sliver both hold. Measured over 3 000 randomized loops: worst
 * overlap **5,3e-7 WU²**, against exactly **0** before.
 *
 * That is accepted deliberately. It is smaller than one lattice cell's worth
 * of area — below the resolution at which ADR-0007 claims to represent
 * geometry at all — and seven orders of magnitude below the 0,01 % the
 * leaderboard resolves a share to (≈ 4 WU² in the public arena). The
 * disjointness property test in `fill.test.ts` carries the bound explicitly
 * rather than silently absorbing it.
 *
 * Should the invariant ever be BROKEN, this stops being an identity and the
 * two disagree by the overlapping area — unbounded in principle. The one path
 * that can break it is `spawnTerritory`: if the clipper throws OR returns
 * corrupt topology while carving a start block, it keeps the raw block ("a
 * live spawn beats a perfect invariant"), which may overlap foreign land.
 * Carving with `captured` used to scrub such an overlap on the next fill that
 * happened to cover it; carving with the gained region leaves it until
 * someone paints over it. No known trigger on lattice inputs — but this is
 * the reason to keep it that way.
 */
function gainedRegion(loop: Territory, pockets: Territory): Territory {
  return [...loop, ...pockets];
}

/**
 * May the carve be skipped outright? Only when the two bounding boxes are
 * separated: then no part of the gained region lies in `other`, the
 * difference IS `other`, and the area check above would keep the input
 * reference anyway. The prefilter just declines to pay a Martinez sweep over
 * both vertex sets to learn that.
 *
 * This is where the tick budget was going (ticket 22, measured over 8 bots ×
 * 60 s, seed 20260730): at 200 WU **97,5 %** of all carve ops were of this
 * kind and they burned **93,3 %** of the time spent carving; at 50 WU it was
 * 75,6 % of ops and 53,3 % of the time. The carve loop is unconditional and
 * quadratic in the population, while territories are local — most pairs never
 * touch, and every pair that doesn't used to cost a full sweep.
 *
 * One behavioural difference, deliberately accepted: a clipper throw or a
 * corrupt result on such a pair used to forfeit the entire fill. It cannot
 * any more, because the op no longer runs. Forfeiting a capture over garbage
 * derived from land on the other side of the map was never the intent — the
 * forfeit guards geometry the fill actually touches.
 */
function skipsCarve(gainedBounds: Bounds, other: Territory): boolean {
  return boundsSeparated(gainedBounds, territoryBounds(other));
}

/**
 * Compact raw clipper output and vet its topology. `null` means the output
 * was corrupt and must not be stored — corrupt "holes" outside their outer
 * ring would turn even-odd containment inside out (verified pre-lattice
 * failure mode; no lattice-snapped input is known to still trigger it).
 */
function cleanClipperOutput(raw: Territory): Territory | null {
  const cleaned = compactTerritory(raw);
  return cleaned.every(validPolyTopology) ? cleaned : null;
}

/** Snap raw clipper output back onto the lattice and drop debris rings. */
function compactTerritory(raw: Territory): Territory {
  return raw.map(compactPoly).filter((poly) => poly.length > 0);
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
