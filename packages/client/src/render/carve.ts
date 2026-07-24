/**
 * Trail carve-through (spec §4.1/4.2, ticket 06): where a trail crosses a
 * raised foreign plateau, the crossed strip sinks to ground level — the
 * ground ribbon then runs in a real trench. Implemented as actual geometry
 * (the trail's band subtracted from the plateau polygon) so trench walls
 * shade correctly; the scene throttles how often it recarves. Pure polygon
 * math, no three.js — render-only, never part of the simulation truth.
 */

import { BALANCE, type Point, type Ring, type Territory } from '@paintclash/shared';
import { difference } from 'polyclip-ts';

/**
 * Groove width: a shade wider than the ribbon, so the ribbon's edges never
 * touch (and z-fight) the trench walls.
 */
export const CARVE_WIDTH_WU = BALANCE.trail.widthWU + 0.2;

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Axis-aligned bounds of a polyline; null when empty. */
export function pointsBounds(points: readonly Point[]): Bounds | null {
  const first = points[0];
  if (first === undefined) return null;
  const bounds: Bounds = { minX: first[0], minY: first[1], maxX: first[0], maxY: first[1] };
  for (const [x, y] of points) {
    if (x < bounds.minX) bounds.minX = x;
    if (x > bounds.maxX) bounds.maxX = x;
    if (y < bounds.minY) bounds.minY = y;
    if (y > bounds.maxY) bounds.maxY = y;
  }
  return bounds;
}

/** Axis-aligned bounds of a territory (all rings); null when empty. */
export function territoryBounds(territory: Territory): Bounds | null {
  let bounds: Bounds | null = null;
  for (const poly of territory) {
    for (const ring of poly) {
      const ringBounds = pointsBounds(ring);
      if (!ringBounds) continue;
      if (!bounds) {
        bounds = ringBounds;
      } else {
        bounds.minX = Math.min(bounds.minX, ringBounds.minX);
        bounds.minY = Math.min(bounds.minY, ringBounds.minY);
        bounds.maxX = Math.max(bounds.maxX, ringBounds.maxX);
        bounds.maxY = Math.max(bounds.maxY, ringBounds.maxY);
      }
    }
  }
  return bounds;
}

/** Do two bounds come within `margin` of each other? */
export function boundsOverlap(a: Bounds, b: Bounds, margin: number): boolean {
  return (
    a.minX - margin <= b.maxX &&
    b.minX - margin <= a.maxX &&
    a.minY - margin <= b.maxY &&
    b.minY - margin <= a.maxY
  );
}

/**
 * The carve quad of one trail segment: its rectangle widened to the groove
 * width AND extended by half of it beyond both endpoints — consecutive
 * extended quads overlap at the joint, covering every direction change the
 * gentle sim turn rate can produce without any joint discs.
 */
function segmentQuad(a: Point, b: Point, half: number): Ring | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const ux = (dx / len) * half;
  const uy = (dy / len) * half;
  const ax = a[0] - ux;
  const ay = a[1] - uy;
  const bx = b[0] + ux;
  const by = b[1] + uy;
  return [
    [ax - uy, ay + ux],
    [bx - uy, by + ux],
    [bx + uy, by - ux],
    [ax + uy, ay - ux],
  ];
}

/**
 * Subtract the groove bands of the given trail polylines from a territory.
 * Only segments near the territory participate (bounds pre-filter); when
 * nothing is close — or the clipper fails on degenerate input — the input
 * reference comes back unchanged: an uncarved plateau always beats a crash,
 * this is cosmetics, not truth.
 */
export function carveTerritory(territory: Territory, trails: readonly Point[][]): Territory {
  const bounds = territoryBounds(territory);
  if (!bounds) return territory;
  const half = CARVE_WIDTH_WU / 2;
  const quads: Territory[] = [];
  for (const trail of trails) {
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1];
      const b = trail[i];
      if (!a || !b) continue;
      const segBounds = pointsBounds([a, b]);
      if (!segBounds || !boundsOverlap(segBounds, bounds, half)) continue;
      const quad = segmentQuad(a, b, half);
      if (quad) quads.push([[quad]]);
    }
  }
  if (quads.length === 0) return territory;
  try {
    return difference(territory, ...quads);
  } catch {
    return territory;
  }
}
