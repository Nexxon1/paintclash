/**
 * Synthetic per-tick load for the DO-CPU benchmark (build ticket 02).
 *
 * Approximates what an Arena-DO tick at 20 Hz will cost for N entities:
 * movement integration, trail growth, trail collision (naive vs. spatial
 * grid) and fill on loop close (raster scanline vs. polygon-clip cost
 * model). Pure & deterministic: fixed dt, seeded RNG, no clock — the same
 * discipline `sim-core` will follow (ADR-0003).
 *
 * Assumptions are documented in docs/benchmarks/do-cpu-benchmark.md.
 */

// ---------------------------------------------------------------------------
// Balance values frozen from spec §10 (the shared BALANCE module lands with
// build ticket 03; until then these literals are the benchmark's contract).
// ---------------------------------------------------------------------------

/** Arena edge length (spec §10.2). */
export const ARENA_EDGE_WU = 200;
/** Simulation rate (spec §10.1). */
export const TICK_HZ = 20;
/** Constant head speed (spec §10.3). */
export const SPEED_WU_PER_S = 9;
/** Turn rate clamp (spec §10.3). */
export const TURN_RATE_DEG_PER_S = 320;
/** Head/collision radius (spec §10.4). */
export const HEAD_RADIUS_WU = 0.5;
/** Distance travelled per tick: 9 WU/s at 20 Hz. */
export const STEP_WU = SPEED_WU_PER_S / TICK_HZ;
/** Maximum heading change per tick. */
export const MAX_TURN_PER_TICK_RAD = (TURN_RATE_DEG_PER_S * Math.PI) / 180 / TICK_HZ;

/**
 * Load assumption, not a spec value: every entity closes a loop (fill) every
 * 5 s, staggered across entities. Aggressive versus real play (8-15 s
 * observed in splix-likes) => numbers err on the safe side.
 */
export const FILL_INTERVAL_TICKS = 100;

/** Mulberry32 — tiny, fast, deterministic PRNG; plenty for synthetic load. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// World model
// ---------------------------------------------------------------------------

export type FillMode = 'raster' | 'polygon';
export type CollisionMode = 'naive' | 'grid';

export interface LoadOptions {
  readonly seed: number;
  readonly entities: number;
  readonly fill: FillMode;
  readonly collision: CollisionMode;
}

/** One synthetic player/bot. Trails and rings are flat [x0,y0,x1,y1,...]. */
export interface BenchEntity {
  x: number;
  y: number;
  heading: number;
  /** Trail polyline since the last loop close; one point appended per tick. */
  trail: number[];
  /** Polygon-variant territory ring (raster variant uses the owner grid). */
  ring: number[];
  /** Tick at which this entity next closes its loop (staggered). */
  nextFillTick: number;
}

export interface BenchWorld {
  readonly opts: LoadOptions;
  readonly rng: () => number;
  tickCount: number;
  readonly entities: BenchEntity[];
  /** Spatial hash (collision 'grid'): cell key -> flat [entityIdx, segIdx, ...]. */
  readonly segGrid: Map<number, number[]>;
  /** Owner grid (fill 'raster'): cell -> entity id (index + 1), 0 = neutral. */
  readonly owner: Uint8Array | null;
  /** Scratch buffer for the per-tick snapshot serialization. */
  readonly snapshot: Float32Array;
}

// ---------------------------------------------------------------------------
// Fill primitives
// ---------------------------------------------------------------------------

/**
 * Raster resolution of the owner grid. 0.5-WU cells (half the trail width)
 * -> 400x400 = 160k cells for the public arena.
 */
export const RASTER_CELLS_PER_WU = 2;

/**
 * Even-odd scanline rasterization of a closed ring (flat [x,y,...] in WU)
 * onto the owner grid; cells are claimed for `id`, foreign cells are simply
 * overwritten (stealing, spec §2.2). Returns the number of cells claimed.
 * This is the real "Fill rastern" mitigation algorithm, not a stand-in.
 */
export function rasterizeRing(ring: number[], owner: Uint8Array, id: number): number {
  const gridEdge = ARENA_EDGE_WU * RASTER_CELLS_PER_WU;
  const n = ring.length / 2;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const y = ring[i * 2 + 1]!;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const row0 = Math.max(0, Math.floor(minY * RASTER_CELLS_PER_WU));
  const row1 = Math.min(gridEdge - 1, Math.ceil(maxY * RASTER_CELLS_PER_WU));
  const crossings: number[] = [];
  let claimed = 0;
  for (let row = row0; row <= row1; row++) {
    const cy = (row + 0.5) / RASTER_CELLS_PER_WU;
    crossings.length = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const y1 = ring[i * 2 + 1]!;
      const y2 = ring[j * 2 + 1]!;
      if (y1 <= cy === y2 <= cy) continue;
      const x1 = ring[i * 2]!;
      const x2 = ring[j * 2]!;
      crossings.push(x1 + ((cy - y1) / (y2 - y1)) * (x2 - x1));
    }
    crossings.sort((a, b) => a - b);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const col0 = Math.max(0, Math.floor(crossings[k]! * RASTER_CELLS_PER_WU - 0.5) + 1);
      const col1 = Math.min(
        gridEdge - 1,
        Math.ceil(crossings[k + 1]! * RASTER_CELLS_PER_WU - 0.5) - 1,
      );
      for (let col = col0; col <= col1; col++) {
        owner[row * gridEdge + col] = id;
        claimed++;
      }
    }
  }
  return claimed;
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/**
 * Cost model for the pure-polygon fill variant: the dominant term of a real
 * polygon boolean operation (union/difference a la Greiner-Hormann) is the
 * pairwise edge-intersection sweep between the two rings. We execute exactly
 * that O(na*nb) work; the returned crossing count is a testable byproduct.
 * Proper crossings only — touching/collinear edges are not counted.
 */
export function countEdgeIntersections(a: number[], b: number[]): number {
  const na = a.length / 2;
  const nb = b.length / 2;
  let count = 0;
  for (let i = 0; i < na; i++) {
    const i2 = (i + 1) % na;
    const ax1 = a[i * 2]!;
    const ay1 = a[i * 2 + 1]!;
    const ax2 = a[i2 * 2]!;
    const ay2 = a[i2 * 2 + 1]!;
    for (let j = 0; j < nb; j++) {
      const j2 = (j + 1) % nb;
      const bx1 = b[j * 2]!;
      const by1 = b[j * 2 + 1]!;
      const bx2 = b[j2 * 2]!;
      const by2 = b[j2 * 2 + 1]!;
      const d1 = orient(ax1, ay1, ax2, ay2, bx1, by1);
      const d2 = orient(ax1, ay1, ax2, ay2, bx2, by2);
      const d3 = orient(bx1, by1, bx2, by2, ax1, ay1);
      const d4 = orient(bx1, by1, bx2, by2, ax2, ay2);
      if (
        ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
        ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
      ) {
        count++;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Trail collision
// ---------------------------------------------------------------------------

/** A head cannot cut its own most recent segments (turn radius 1.6 WU makes
 * that physically impossible in the real game) — exclude them everywhere. */
const SELF_SKIP_SEGMENTS = 3;

/** Spatial-hash cell edge in WU. Must exceed headRadius + step (0.95) so a
 * 3x3 neighborhood query is exhaustive. */
const GRID_CELL_WU = 2;

const HIT_RADIUS_SQ = HEAD_RADIUS_WU * HEAD_RADIUS_WU;

/** Packs a cell coordinate pair into one Map key. Stride 4096 ≫ the ~101
 * possible cell indices per axis (arena 200 WU / 2-WU cells, plus the -1
 * query border), so keys are collision-free. */
function cellKey(cx: number, cy: number): number {
  return cx * 4096 + cy;
}

function cellOf(v: number): number {
  return Math.floor(v / GRID_CELL_WU);
}

/** Squared distance from point (px,py) to segment (ax,ay)-(bx,by). */
export function segDistSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

/** Register the segment ending at trail point index `segIdx + 1` in the hash. */
function gridInsertSegment(world: BenchWorld, entityIdx: number, segIdx: number): void {
  const trail = world.entities[entityIdx]!.trail;
  const ax = trail[segIdx * 2]!;
  const ay = trail[segIdx * 2 + 1]!;
  const bx = trail[segIdx * 2 + 2]!;
  const by = trail[segIdx * 2 + 3]!;
  const cx0 = cellOf(Math.min(ax, bx));
  const cx1 = cellOf(Math.max(ax, bx));
  const cy0 = cellOf(Math.min(ay, by));
  const cy1 = cellOf(Math.max(ay, by));
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cy = cy0; cy <= cy1; cy++) {
      const key = cellKey(cx, cy);
      let bucket = world.segGrid.get(key);
      if (!bucket) {
        bucket = [];
        world.segGrid.set(key, bucket);
      }
      bucket.push(entityIdx, segIdx);
    }
  }
}

/** Drop every hashed segment of one entity (its loop just closed). */
function gridRemoveEntity(world: BenchWorld, entityIdx: number): void {
  for (const [key, bucket] of world.segGrid) {
    let w = 0;
    for (let r = 0; r < bucket.length; r += 2) {
      if (bucket[r] !== entityIdx) {
        bucket[w++] = bucket[r]!;
        bucket[w++] = bucket[r + 1]!;
      }
    }
    if (w === 0) world.segGrid.delete(key);
    else bucket.length = w;
  }
}

function checkSegment(
  e: BenchEntity,
  other: BenchEntity,
  isSelf: boolean,
  segIdx: number,
  stats: TickStats,
): void {
  const segCount = other.trail.length / 2 - 1;
  if (isSelf && segIdx >= segCount - SELF_SKIP_SEGMENTS) return;
  const t = other.trail;
  stats.segmentChecks++;
  const dSq = segDistSq(
    e.x,
    e.y,
    t[segIdx * 2]!,
    t[segIdx * 2 + 1]!,
    t[segIdx * 2 + 2]!,
    t[segIdx * 2 + 3]!,
  );
  if (dSq <= HIT_RADIUS_SQ) stats.hits++;
}

function collideNaive(world: BenchWorld, stats: TickStats): void {
  for (const e of world.entities) {
    for (const other of world.entities) {
      const isSelf = e === other;
      const segCount = other.trail.length / 2 - 1;
      for (let s = 0; s < segCount; s++) checkSegment(e, other, isSelf, s, stats);
    }
  }
}

function collideGrid(world: BenchWorld, stats: TickStats): void {
  world.entities.forEach((e, ei) => {
    const hcx = cellOf(e.x);
    const hcy = cellOf(e.y);
    // A segment may be hashed into several cells of the 3x3 neighborhood —
    // dedupe so hit/check counts match the naive variant exactly.
    const seen = new Set<number>();
    for (let cx = hcx - 1; cx <= hcx + 1; cx++) {
      for (let cy = hcy - 1; cy <= hcy + 1; cy++) {
        const bucket = world.segGrid.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (let r = 0; r < bucket.length; r += 2) {
          const oi = bucket[r]!;
          const segIdx = bucket[r + 1]!;
          // Pack (entityIdx, segIdx) into one number: 2^20 ≫ max segments per
          // trail (~1 per tick, reset every 100 ticks), entityIdx ≤ 200.
          const ref = oi * 1_048_576 + segIdx;
          if (seen.has(ref)) continue;
          seen.add(ref);
          checkSegment(e, world.entities[oi]!, oi === ei, segIdx, stats);
        }
      }
    }
  });
}

/** Per-runTick counters; the DO accumulates them across a batch. */
export interface TickStats {
  segmentChecks: number;
  hits: number;
  fills: number;
  filledCells: number;
  clipOps: number;
  snapshotBytes: number;
}

/** Square ring (flat polygon) around a center, clamped to the arena. */
function squareRing(cx: number, cy: number, half: number): number[] {
  const lo = (v: number) => Math.max(0, v - half);
  const hi = (v: number) => Math.min(ARENA_EDGE_WU, v + half);
  return [lo(cx), lo(cy), hi(cx), lo(cy), hi(cx), hi(cy), lo(cx), hi(cy)];
}

export function createWorld(opts: LoadOptions): BenchWorld {
  if (opts.entities < 1 || opts.entities > 200) {
    throw new RangeError('entities must be within 1..200 (owner grid ids are Uint8)');
  }
  const rng = createRng(opts.seed);
  const entities: BenchEntity[] = [];
  for (let i = 0; i < opts.entities; i++) {
    // Uniform spread with margin; the 25-WU spawn distance rule is a game
    // rule, not a load factor — plain uniform placement is representative.
    const x = 10 + rng() * (ARENA_EDGE_WU - 20);
    const y = 10 + rng() * (ARENA_EDGE_WU - 20);
    entities.push({
      x,
      y,
      heading: rng() * 2 * Math.PI,
      trail: [x, y],
      ring: squareRing(x, y, 3), // 6x6 WU Startblock (spec §10.4)
      // Stagger loop closes evenly across entities.
      nextFillTick: 1 + Math.floor(((i + 1) / opts.entities) * FILL_INTERVAL_TICKS),
    });
  }
  const gridEdge = ARENA_EDGE_WU * RASTER_CELLS_PER_WU;
  const owner = opts.fill === 'raster' ? new Uint8Array(gridEdge * gridEdge) : null;
  if (owner) {
    entities.forEach((e, i) => rasterizeRing(e.ring, owner, i + 1));
  }
  return {
    opts,
    rng,
    tickCount: 0,
    entities,
    segGrid: new Map(),
    owner,
    snapshot: new Float32Array(opts.entities * 5),
  };
}

// ---------------------------------------------------------------------------
// Fill on loop close + per-tick territory membership
// ---------------------------------------------------------------------------

/** Polygon-variant territory rings are decimated to this vertex cap — a real
 * implementation would simplify similarly to keep clip cost bounded. */
const RING_MAX_VERTICES = 64;

/** Even-odd point-in-polygon test against a flat ring. */
function pointInRing(px: number, py: number, ring: number[]): boolean {
  const n = ring.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2]!;
    const yi = ring[i * 2 + 1]!;
    const xj = ring[j * 2]!;
    const yj = ring[j * 2 + 1]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function ringBBox(ring: number[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    const x = ring[i]!;
    const y = ring[i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function decimateRing(ring: number[]): number[] {
  const n = ring.length / 2;
  if (n <= RING_MAX_VERTICES) return ring.slice();
  const out: number[] = [];
  const stride = n / RING_MAX_VERTICES;
  for (let k = 0; k < RING_MAX_VERTICES; k++) {
    const i = Math.floor(k * stride);
    out.push(ring[i * 2]!, ring[i * 2 + 1]!);
  }
  return out;
}

/** Close the loop of entity `i`: fill, steal, reset its trail. */
function closeLoop(world: BenchWorld, i: number, stats: TickStats): void {
  const e = world.entities[i]!;
  const loop = e.trail; // implicit closure last->first point
  stats.fills++;
  if (world.owner) {
    stats.filledCells += rasterizeRing(loop, world.owner, i + 1);
  } else {
    // Polygon variant: union with the own ring, difference against every
    // bbox-overlapping foreign ring (stealing) — we execute the dominant
    // O(na*nb) edge-sweep work of those boolean ops.
    stats.clipOps += (loop.length / 2) * (e.ring.length / 2);
    countEdgeIntersections(loop, e.ring);
    const [lx0, ly0, lx1, ly1] = ringBBox(loop);
    world.entities.forEach((other, j) => {
      if (j === i) return;
      const [ox0, oy0, ox1, oy1] = ringBBox(other.ring);
      if (ox1 < lx0 || ox0 > lx1 || oy1 < ly0 || oy0 > ly1) return;
      stats.clipOps += (loop.length / 2) * (other.ring.length / 2);
      countEdgeIntersections(loop, other.ring);
    });
    e.ring = decimateRing(loop);
  }
  if (world.opts.collision === 'grid') gridRemoveEntity(world, i);
  e.trail = [e.x, e.y];
  e.nextFillTick = world.tickCount + FILL_INTERVAL_TICKS;
}

/** The real game asks "is this Kopf inside its own Gebiet?" every tick. */
function territoryMembershipCheck(world: BenchWorld, i: number): void {
  const e = world.entities[i]!;
  if (world.owner) {
    const gridEdge = ARENA_EDGE_WU * RASTER_CELLS_PER_WU;
    const col = Math.min(gridEdge - 1, Math.floor(e.x * RASTER_CELLS_PER_WU));
    const row = Math.min(gridEdge - 1, Math.floor(e.y * RASTER_CELLS_PER_WU));
    // The comparison result feeds nothing further — the lookup is the load.
    void (world.owner[row * gridEdge + col] === i + 1);
  } else {
    void pointInRing(e.x, e.y, e.ring);
  }
}

/** Serialize x/y/heading (+ 2 words of trail-delta headroom) per entity. */
function serializeSnapshot(world: BenchWorld, stats: TickStats): void {
  const buf = world.snapshot;
  world.entities.forEach((e, i) => {
    buf[i * 5] = e.x;
    buf[i * 5 + 1] = e.y;
    buf[i * 5 + 2] = e.heading;
    buf[i * 5 + 3] = e.trail.length;
    buf[i * 5 + 4] = e.nextFillTick;
  });
  stats.snapshotBytes += buf.byteLength;
}

/** Wander + soft barrier: heading jitters within the legal turn rate; the
 * position is clamped to the wall so the head glides along it. */
function stepEntity(e: BenchEntity, rng: () => number): void {
  e.heading += (rng() * 2 - 1) * MAX_TURN_PER_TICK_RAD;
  e.x += Math.cos(e.heading) * STEP_WU;
  e.y += Math.sin(e.heading) * STEP_WU;
  if (e.x < 0) e.x = 0;
  else if (e.x > ARENA_EDGE_WU) e.x = ARENA_EDGE_WU;
  if (e.y < 0) e.y = 0;
  else if (e.y > ARENA_EDGE_WU) e.y = ARENA_EDGE_WU;
}

export function runTick(world: BenchWorld): TickStats {
  const stats: TickStats = {
    segmentChecks: 0,
    hits: 0,
    fills: 0,
    filledCells: 0,
    clipOps: 0,
    snapshotBytes: 0,
  };
  world.tickCount++;
  world.entities.forEach((e, i) => {
    stepEntity(e, world.rng);
    e.trail.push(e.x, e.y);
    if (world.opts.collision === 'grid') {
      gridInsertSegment(world, i, e.trail.length / 2 - 2);
    }
  });
  if (world.opts.collision === 'grid') collideGrid(world, stats);
  else collideNaive(world, stats);
  for (let i = 0; i < world.entities.length; i++) {
    territoryMembershipCheck(world, i);
    if (world.entities[i]!.nextFillTick <= world.tickCount) {
      closeLoop(world, i, stats);
    }
  }
  serializeSnapshot(world, stats);
  return stats;
}
