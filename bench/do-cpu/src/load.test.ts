import { describe, expect, it } from 'vitest';

import {
  ARENA_EDGE_WU,
  RASTER_CELLS_PER_WU,
  STEP_WU,
  countEdgeIntersections,
  createRng,
  createWorld,
  rasterizeRing,
  runTick,
} from './load.js';

describe('createRng', () => {
  it('same seed yields the identical sequence (replay determinism, ADR-0003)', () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('different seeds diverge and values stay in [0, 1)', () => {
    const a = createRng(1);
    const b = createRng(2);
    const seqA = Array.from({ length: 100 }, () => a());
    const seqB = Array.from({ length: 100 }, () => b());
    expect(seqA).not.toEqual(seqB);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('runTick - Bewegung, sanfte Barriere, Trail', () => {
  it('moves every Kopf by at most one step (9 WU/s at 20 Hz = 0.45 WU) per tick', () => {
    const world = createWorld({ seed: 7, entities: 8, fill: 'raster', collision: 'naive' });
    for (let tick = 0; tick < 50; tick++) {
      const before = world.entities.map((e) => [e.x, e.y]);
      runTick(world);
      world.entities.forEach((e, i) => {
        const [bx, by] = before[i] as [number, number];
        const dist = Math.hypot(e.x - bx, e.y - by);
        expect(dist).toBeLessThanOrEqual(STEP_WU + 1e-9);
        expect(dist).toBeGreaterThan(0);
      });
    }
  });

  it('keeps every Kopf inside the arena over many ticks (sanfte Barriere, kein Rand-Tod)', () => {
    const world = createWorld({ seed: 1234, entities: 16, fill: 'raster', collision: 'naive' });
    for (let tick = 0; tick < 2000; tick++) {
      runTick(world);
      for (const e of world.entities) {
        expect(e.x).toBeGreaterThanOrEqual(0);
        expect(e.x).toBeLessThanOrEqual(ARENA_EDGE_WU);
        expect(e.y).toBeGreaterThanOrEqual(0);
        expect(e.y).toBeLessThanOrEqual(ARENA_EDGE_WU);
      }
    }
  });

  it('grows each trail by one point per tick while no loop closes', () => {
    const world = createWorld({ seed: 3, entities: 4, fill: 'raster', collision: 'naive' });
    const before = world.entities.map((e) => e.trail.length);
    for (let tick = 0; tick < 10; tick++) runTick(world);
    world.entities.forEach((e, i) => {
      expect(e.trail.length).toBe((before[i] ?? 0) + 10 * 2);
    });
  });
});

describe('runTick - Trail-Kollision', () => {
  it('detects a Kopf sitting on a foreign trail segment (radius 0.5 WU)', () => {
    const world = createWorld({ seed: 5, entities: 2, fill: 'raster', collision: 'naive' });
    const [a, b] = world.entities as [(typeof world.entities)[0], (typeof world.entities)[0]];
    // Entity b owns a long horizontal trail through (50..150, 100); entity a's
    // head sits on its middle. One step (<= 0.45 WU) cannot escape the 0.5-WU
    // hit radius of that segment.
    b.trail = [50, 100, 150, 100];
    a.x = 100;
    a.y = 100;
    const stats = runTick(world);
    expect(stats.hits).toBeGreaterThanOrEqual(1);
  });

  it('naive and spatial-grid collision report identical hits tick for tick', () => {
    const naive = createWorld({ seed: 99, entities: 24, fill: 'raster', collision: 'naive' });
    const grid = createWorld({ seed: 99, entities: 24, fill: 'raster', collision: 'grid' });
    let sawAHit = false;
    for (let tick = 0; tick < 300; tick++) {
      const sn = runTick(naive);
      const sg = runTick(grid);
      expect(sg.hits).toBe(sn.hits);
      if (sn.hits > 0) sawAHit = true;
      // The whole point of the grid: strictly fewer distance evaluations.
      expect(sg.segmentChecks).toBeLessThanOrEqual(sn.segmentChecks);
    }
    // Guard against a vacuously green test: the scenario must produce hits.
    expect(sawAHit).toBe(true);
  });
});

describe('rasterizeRing - Scanline-Fill aufs Owner-Grid', () => {
  it('claims exactly the cells whose centers lie inside an axis-aligned square', () => {
    const gridEdge = ARENA_EDGE_WU * RASTER_CELLS_PER_WU;
    const owner = new Uint8Array(gridEdge * gridEdge);
    // Square (20,20)-(30,30) WU: at 2 cells/WU that is a 20x20-cell interior.
    const ring = [20, 20, 30, 20, 30, 30, 20, 30];
    const claimed = rasterizeRing(ring, owner, 7);
    expect(claimed).toBe(20 * 20);
    let count = 0;
    for (const v of owner) if (v === 7) count++;
    expect(count).toBe(20 * 20);
    // Spot checks: inside vs. outside.
    const at = (xWu: number, yWu: number) =>
      owner[
        Math.floor(yWu * RASTER_CELLS_PER_WU) * gridEdge + Math.floor(xWu * RASTER_CELLS_PER_WU)
      ];
    expect(at(25, 25)).toBe(7);
    expect(at(19, 25)).toBe(0);
    expect(at(25, 31)).toBe(0);
  });

  it('overwrites foreign cells (stealing) rather than skipping them', () => {
    const gridEdge = ARENA_EDGE_WU * RASTER_CELLS_PER_WU;
    const owner = new Uint8Array(gridEdge * gridEdge);
    rasterizeRing([20, 20, 30, 20, 30, 30, 20, 30], owner, 1);
    rasterizeRing([25, 25, 35, 25, 35, 35, 25, 35], owner, 2);
    const at = (xWu: number, yWu: number) =>
      owner[
        Math.floor(yWu * RASTER_CELLS_PER_WU) * gridEdge + Math.floor(xWu * RASTER_CELLS_PER_WU)
      ];
    expect(at(26, 26)).toBe(2); // stolen
    expect(at(21, 21)).toBe(1); // untouched remainder
  });
});

describe('runTick - Fill bei Loop-Schluss', () => {
  it('closes each loop once per interval, resets the trail and claims cells (raster)', () => {
    const world = createWorld({ seed: 11, entities: 5, fill: 'raster', collision: 'grid' });
    let fills = 0;
    let filledCells = 0;
    for (let t = 0; t < 110; t++) {
      const s = runTick(world);
      fills += s.fills;
      filledCells += s.filledCells;
    }
    // Staggered: every entity closed exactly one loop within interval + stagger.
    expect(fills).toBe(5);
    expect(filledCells).toBeGreaterThan(0);
    for (const e of world.entities) {
      expect(e.trail.length).toBeLessThan(2 * 102);
    }
  });

  it('executes clip work against own and overlapping foreign rings (polygon)', () => {
    const world = createWorld({ seed: 11, entities: 5, fill: 'polygon', collision: 'grid' });
    let fills = 0;
    let clipOps = 0;
    for (let t = 0; t < 110; t++) {
      const s = runTick(world);
      fills += s.fills;
      clipOps += s.clipOps;
    }
    expect(fills).toBe(5);
    expect(clipOps).toBeGreaterThan(0);
  });

  it('serializes a snapshot every tick (>= 12 bytes per entity)', () => {
    const world = createWorld({ seed: 2, entities: 6, fill: 'raster', collision: 'grid' });
    const s = runTick(world);
    expect(s.snapshotBytes).toBeGreaterThanOrEqual(6 * 12);
  });
});

describe('countEdgeIntersections - Polygon-Clip-Kostenmodell', () => {
  it('finds the two boundary crossings of two overlapping squares', () => {
    const a = [0, 0, 2, 0, 2, 2, 0, 2];
    const b = [1, 1, 3, 1, 3, 3, 1, 3];
    expect(countEdgeIntersections(a, b)).toBe(2);
  });

  it('finds none for disjoint squares', () => {
    const a = [0, 0, 2, 0, 2, 2, 0, 2];
    const b = [10, 10, 12, 10, 12, 12, 10, 12];
    expect(countEdgeIntersections(a, b)).toBe(0);
  });
});
