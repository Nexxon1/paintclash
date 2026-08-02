import * as polygonClipping from 'polygon-clipping';
import * as polyclipTs from 'polyclip-ts';
import { describe, expect, it } from 'vitest';

import { difference, union, unwrapEngine } from './clipper.js';
import { squareRing } from './geometry.js';

/**
 * The seam itself (ADR-0007, ticket 23). Not the sweep — that has its own
 * evidence in `fill.test.ts`, where every property is recomputed with a second
 * engine. What is tested here is the wiring, which no other test can see:
 * `fill.ts` would behave identically whether it got the fast engine, the slow
 * one, or a stale copy, so nothing else in the suite would notice the swap
 * silently coming undone.
 */
describe('unwrapEngine', () => {
  // A test run only ever observes one of these two shapes, so the branch that
  // decides production behaviour is unreachable from an ordinary import.
  const named = { union: (): [] => [], difference: (): [] => [] };

  it('takes the named exports when the bundler produced them (CJS, Vitest)', () => {
    expect(unwrapEngine(named)).toBe(named);
  });

  it('unwraps the default export when that is all there is (ESM, Vite/wrangler)', () => {
    expect(unwrapEngine({ default: named })).toBe(named);
  });

  it('prefers the default even when both are present', () => {
    // Node's CJS interop can hand over both; they are then the same object,
    // but the rule must be total rather than depend on that.
    const both = { ...named, default: named };
    expect(unwrapEngine(both)).toBe(named);
  });
});

describe('the engine the sim actually runs', () => {
  it('is polygon-clipping, not polyclip-ts', () => {
    // The swap is worth ~8× (ADR-0007). A revert to the arbitrary-precision
    // engine would keep every other test green and only show up as a slow
    // arena in production, so it is asserted here rather than left to a bench.
    const engine = unwrapEngine(polygonClipping);
    expect(union).toBe(engine.union);
    expect(difference).toBe(engine.difference);
    expect(union).not.toBe(polyclipTs.union);
  });

  it('takes an empty territory as an operand rather than throwing', () => {
    // `closeLoop` and `spawnTerritory` guard against this today, so it is a
    // property of the seam, not a caller's promise.
    const block = [[squareRing(5, 5, 1)]];
    expect(union([], block)).toEqual(block.map((poly) => poly.map(closed)));
    expect(difference(block, [])).toEqual(block.map((poly) => poly.map(closed)));
  });
});

/** The clipper repeats a ring's first vertex at the end; `compactRing` drops it. */
function closed(ring: readonly [number, number][]): [number, number][] {
  const first = ring[0];
  return first === undefined ? [] : [...ring, first];
}
