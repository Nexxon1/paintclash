/**
 * three.js scene (spec §4.1/4.3): arena floor, territory plateaus, ground
 * trails, heads — rendered with the "Paper.io Modern" perspective tilt
 * (~52° elevation). Pure data sink: `update()` consumes the session's
 * RenderState and never touches game logic. Excluded from unit coverage;
 * the Playwright E2E exercises it.
 *
 * Sim coords map to three as (x, y_sim) → (x, 0, z=y_sim).
 */

import { BALANCE, type Point, type Territory } from '@paintclash/shared';
import * as THREE from 'three';

import { playerHue, PLAYER_LIGHTNESS, PLAYER_SATURATION, SELF_COLOR_CSS } from '../game/colors.js';

import type { RenderState } from '../game/session.js';
import {
  boundsOverlap,
  CARVE_WIDTH_WU,
  PlateauCarver,
  pointsBounds,
  territoryBounds,
  type CarveInput,
} from './carve.js';

const CAMERA_ELEVATION_RAD = (52 * Math.PI) / 180;
const CAMERA_DISTANCE = 40;
/** Reserved mesh key for the own player (rendered from the predicted pose). */
const SELF_KEY = -1;

/** Plateau height — a flat, slightly raised surface, not a block (§4.1). */
const TERRITORY_HEIGHT = 0.35;
/** Trail ribbons hug the floor (§4.1: 2D line at ground height). */
const TRAIL_Y = 0.03;
const TRAIL_WIDTH = BALANCE.trail.widthWU;
/** Fill wave duration (§4.2: the territory "grows" as a height wave). */
const FILL_WAVE_MS = 450;
/**
 * Minimum time between carve updates of one plateau (§4.1 carve-through:
 * crossing trails cut a ground-level groove into the plateau geometry).
 * Each update clips only the trail growth since the last one (PlateauCarver)
 * plus a mesh rebuild — tick cadence is plenty; between updates the groove
 * front trails the head by < 0.5 WU, visually hidden under the head cone.
 */
const CARVE_THROTTLE_MS = 50;

/**
 * Meshes and HUD swatches share one color mapping (game/colors.ts) — and
 * must land in the same color SPACE to actually look alike. `setHSL` defaults
 * to the working space (linear-sRGB), so the authored sRGB values would come
 * out of the renderer's linear→sRGB pass washed out and pastel, while the own
 * blue (a CSS string, hence sRGB by default) stayed saturated. Say sRGB.
 */
function headColor(playerId: number, selfId: number | null): THREE.Color {
  return playerId === selfId
    ? new THREE.Color(SELF_COLOR_CSS)
    : new THREE.Color().setHSL(
        playerHue(playerId),
        PLAYER_SATURATION,
        PLAYER_LIGHTNESS,
        THREE.SRGBColorSpace,
      );
}

/** Ease-out with a slight overshoot — the plateau "pops" up once. */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

interface TerritoryMesh {
  mesh: THREE.Mesh;
  rev: number;
  /** Incremental groove state; its output reference keys mesh rebuilds. */
  carver: PlateauCarver;
  /** The carver output the current mesh was built from. */
  builtFrom: Territory;
  /** performance.now() of the last carver update (throttling). */
  carveCheckedAt: number;
  /** performance.now() of the fill that triggered the running wave. */
  waveStart: number | null;
}

/** A ground ribbon along a polyline, rebuilt in place with growing buffers. */
class TrailRibbon {
  readonly mesh: THREE.Mesh;
  private geometry = new THREE.BufferGeometry();
  private capacity = 0;
  /** Tiny per-player height offset — crossing ribbons must not z-fight. */
  readonly yOffset: number;

  constructor(color: THREE.Color, yOffset: number) {
    this.yOffset = yOffset;
    this.mesh = new THREE.Mesh(
      this.geometry,
      // DoubleSide: a collinear reversal twists the ribbon and flips the
      // local winding — single-sided, such segments simply vanish.
      new THREE.MeshLambertMaterial({
        color,
        transparent: true,
        opacity: 0.92,
        side: THREE.DoubleSide,
      }),
    );
    this.mesh.frustumCulled = false; // grows every frame; culling lags behind
  }

  update(points: Point[]): void {
    const n = points.length;
    if (n < 2) {
      this.geometry.setDrawRange(0, 0);
      return;
    }
    if (n > this.capacity) {
      this.capacity = Math.max(64, this.capacity * 2, n);
      this.geometry.dispose();
      this.geometry = new THREE.BufferGeometry();
      this.geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(this.capacity * 6), 3),
      );
      const indices = new Uint32Array((this.capacity - 1) * 6);
      this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
      this.mesh.geometry = this.geometry;
    }
    const position = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const index = this.geometry.getIndex();
    if (!index) return;
    let nx = 0;
    let nz = 1;
    for (let i = 0; i < n; i++) {
      const curr = points[i];
      const ahead = points[Math.min(i + 1, n - 1)];
      const behind = points[Math.max(i - 1, 0)];
      if (!curr || !ahead || !behind) continue;
      const dx = ahead[0] - behind[0];
      const dz = ahead[1] - behind[1];
      const len = Math.hypot(dx, dz);
      if (len > 1e-6) {
        // Perpendicular of the local direction; keep the previous one on
        // zero-length steps (head standing at the last trail point).
        nx = -dz / len;
        nz = dx / len;
      }
      const w = TRAIL_WIDTH / 2;
      // Always at ground height — over foreign plateaus the ribbon runs in
      // the carve-through groove (see updateTerritories).
      const y = TRAIL_Y + this.yOffset;
      position.setXYZ(i * 2, curr[0] + nx * w, y, curr[1] + nz * w);
      position.setXYZ(i * 2 + 1, curr[0] - nx * w, y, curr[1] - nz * w);
    }
    for (let i = 0; i < n - 1; i++) {
      // Wound so the face normal points UP (+y): (L, L+1, R), (R, L+1, R+1)
      // — the ribbon lies on the ground and is only ever seen from above.
      const a = i * 2;
      index.setX(i * 6, a);
      index.setX(i * 6 + 1, a + 2);
      index.setX(i * 6 + 2, a + 1);
      index.setX(i * 6 + 3, a + 1);
      index.setX(i * 6 + 4, a + 2);
      index.setX(i * 6 + 5, a + 3);
    }
    position.needsUpdate = true;
    index.needsUpdate = true;
    this.geometry.setDrawRange(0, (n - 1) * 6);
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

export class ArenaScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly heads = new Map<number, THREE.Mesh>();
  private readonly territories = new Map<number, TerritoryMesh>();
  private readonly trails = new Map<number, TrailRibbon>();
  private floor: THREE.Mesh | null = null;
  private arenaSize = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 600);
    this.scene.background = new THREE.Color(0xdfe7ef);
    this.scene.fog = new THREE.Fog(0xdfe7ef, 120, 320);
    const ambient = new THREE.AmbientLight(0xffffff, 0.75);
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(60, 120, 40);
    this.scene.add(ambient, sun);
    this.resize();
  }

  /** Release the GL context — a torn-down game must not hold the canvas. */
  dispose(): void {
    this.renderer.dispose();
  }

  resize(): void {
    const { innerWidth, innerHeight } = window;
    // A minimized/zero-height window would make the aspect NaN/Infinity and
    // corrupt the projection matrix (screen-filling smears) — skip.
    if (innerWidth <= 0 || innerHeight <= 0) return;
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  /** Render one frame from the session's sampled state. */
  update(state: RenderState): void {
    if (state.arenaSizeWU && state.arenaSizeWU !== this.arenaSize) {
      this.buildFloor(state.arenaSizeWU);
    }

    this.updateTerritories(state);
    this.updateTrails(state);

    const seenHeads = new Set<number>();
    for (const p of state.others) {
      seenHeads.add(p.id);
      this.poseHead(p.id, state.selfId, p.x, p.y, p.heading);
    }
    if (state.self) {
      seenHeads.add(SELF_KEY);
      this.poseHead(SELF_KEY, state.selfId, state.self.x, state.self.y, state.self.heading);
    }
    for (const [id, mesh] of this.heads) {
      if (!seenHeads.has(id)) {
        this.scene.remove(mesh);
        this.heads.delete(id);
      }
    }

    if (state.self) {
      const target = new THREE.Vector3(state.self.x, 0, state.self.y);
      const back = CAMERA_DISTANCE * Math.cos(CAMERA_ELEVATION_RAD);
      const up = CAMERA_DISTANCE * Math.sin(CAMERA_ELEVATION_RAD);
      this.camera.position.set(target.x, up, target.z + back);
      this.camera.lookAt(target);
    }
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Territory plateaus: rebuild on revision change or when the groove state
   * moved (carve-through, §4.1 — updated incrementally, rate-limited per
   * plateau), run the fill wave.
   */
  private updateTerritories(state: RenderState): void {
    const now = performance.now();
    const fills = new Set(state.fills);
    const seen = new Set<number>();
    const trailBounds = state.trails.map((trail) => ({
      trail,
      bounds: pointsBounds(trail.points),
    }));
    for (const view of state.territories) {
      seen.add(view.playerId);
      // Trails of OTHER players near this plateau carve it; the owner's own
      // trail never does (it only ever touches the plateau at its buried
      // exit seed — carving there would expose the ribbon start).
      const viewBounds = territoryBounds(view.territory);
      const bands: CarveInput[] = [];
      for (const { trail, bounds } of trailBounds) {
        if (trail.playerId === view.playerId || !bounds || !viewBounds) continue;
        if (!boundsOverlap(bounds, viewBounds, CARVE_WIDTH_WU / 2)) continue;
        bands.push(trail);
      }
      let entry = this.territories.get(view.playerId);
      const revChanged = entry?.rev !== view.rev;
      const carver = entry?.carver ?? new PlateauCarver();
      if (revChanged) carver.reset(view.territory);
      let target = entry?.builtFrom ?? view.territory;
      if (entry === undefined || revChanged || now - entry.carveCheckedAt >= CARVE_THROTTLE_MS) {
        target = carver.update(bands);
        if (entry) entry.carveCheckedAt = now;
      }
      if (entry === undefined || revChanged || target !== entry.builtFrom) {
        if (entry) this.removeMesh(entry.mesh);
        const mesh = this.buildTerritoryMesh(target, view.playerId, state.selfId);
        entry = {
          mesh,
          rev: view.rev,
          carver,
          builtFrom: target,
          carveCheckedAt: now,
          waveStart: entry?.waveStart ?? null,
        };
        this.territories.set(view.playerId, entry);
        this.scene.add(mesh);
      }
      if (fills.has(view.playerId)) entry.waveStart = now;
      this.animateWave(entry, now);
    }
    for (const [id, entry] of this.territories) {
      if (!seen.has(id)) {
        this.removeMesh(entry.mesh);
        this.territories.delete(id);
      }
    }
  }

  /** Detach a mesh and free its GPU resources. */
  private removeMesh(mesh: THREE.Mesh): void {
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }

  /** Height/color wave (§4.2): the plateau pops up and briefly glows. */
  private animateWave(entry: TerritoryMesh, now: number): void {
    const material = entry.mesh.material as THREE.MeshLambertMaterial;
    if (entry.waveStart === null) return;
    const t = (now - entry.waveStart) / FILL_WAVE_MS;
    if (t >= 1) {
      entry.mesh.scale.y = 1;
      material.emissiveIntensity = 0;
      entry.waveStart = null;
      return;
    }
    entry.mesh.scale.y = Math.max(0.15, easeOutBack(t));
    material.emissive = material.color;
    material.emissiveIntensity = 0.35 * (1 - t);
  }

  private buildTerritoryMesh(
    territory: Territory,
    playerId: number,
    selfId: number | null,
  ): THREE.Mesh {
    const shapes: THREE.Shape[] = [];
    for (const poly of territory) {
      const outer = poly[0];
      if (!outer || outer.length < 3) continue;
      const shape = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
      for (const hole of poly.slice(1)) {
        if (hole.length < 3) continue;
        shape.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))));
      }
      shapes.push(shape);
    }
    const geometry = new THREE.ExtrudeGeometry(shapes, {
      depth: TERRITORY_HEIGHT,
      bevelEnabled: false,
    });
    // Shape XY lies in sim coords; rotate onto the ground (y_sim → z_world,
    // extrusion → downward) and lift so the plateau sits ON the floor.
    geometry.rotateX(Math.PI / 2);
    geometry.translate(0, TERRITORY_HEIGHT, 0);
    const base = headColor(playerId, selfId);
    const material = new THREE.MeshLambertMaterial({
      color: base.clone().offsetHSL(0, -0.15, 0.12),
      transparent: true,
      opacity: 0.95,
    });
    return new THREE.Mesh(geometry, material);
  }

  /** Trail ribbons — one per player with a visible trail this frame. */
  private updateTrails(state: RenderState): void {
    const seen = new Set<number>();
    for (const { playerId, points } of state.trails) {
      seen.add(playerId);
      let ribbon = this.trails.get(playerId);
      if (!ribbon) {
        // Height staggered by id (own on top) so crossing ribbons never
        // z-fight; all offsets stay far below the plateau height.
        const yOffset = playerId === state.selfId ? 0.02 : ((playerId % 16) + 1) * 0.001;
        ribbon = new TrailRibbon(headColor(playerId, state.selfId), yOffset);
        this.trails.set(playerId, ribbon);
        this.scene.add(ribbon.mesh);
      }
      ribbon.update(points);
    }
    for (const [id, ribbon] of this.trails) {
      if (!seen.has(id)) {
        this.scene.remove(ribbon.mesh);
        ribbon.dispose();
        this.trails.delete(id);
      }
    }
  }

  /** Non-finite poses that were blocked from rendering (debug/diagnosis). */
  poseAnomalies = 0;

  /** Place (and lazily create) one player's head cone. */
  private poseHead(
    key: number,
    selfId: number | null,
    x: number,
    y: number,
    heading: number,
  ): void {
    // A single non-finite value smears mesh triangles across the whole
    // screen (huge single-color blobs). Never let one reach the GPU; count
    // and warn so a wild occurrence stays diagnosable.
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(heading)) {
      this.poseAnomalies += 1;
      if (this.poseAnomalies === 1 || this.poseAnomalies % 100 === 0) {
        console.warn('paintclash: non-finite pose blocked', { key, x, y, heading });
      }
      return;
    }
    let head = this.heads.get(key);
    head ??= this.spawnHead(key, selfId);
    head.position.set(x, 0.6, y);
    // +z-pointing cone rotated so heading 0 = +x, heading π/2 = +z (=y_sim).
    head.rotation.y = Math.PI / 2 - heading;
  }

  private buildFloor(size: number): void {
    this.arenaSize = size;
    if (this.floor) this.scene.remove(this.floor);
    const geometry = new THREE.PlaneGeometry(size, size);
    const material = new THREE.MeshLambertMaterial({ color: 0xf2f5f8 });
    this.floor = new THREE.Mesh(geometry, material);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.set(size / 2, 0, size / 2);
    this.scene.add(this.floor);
    const grid = new THREE.GridHelper(size, size / 10, 0xc3ccd6, 0xd7dee6);
    grid.position.set(size / 2, 0.01, size / 2);
    this.scene.add(grid);
    const walls = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(size, 2, size)),
      new THREE.LineBasicMaterial({ color: 0x8895a5 }),
    );
    walls.position.set(size / 2, 1, size / 2);
    this.scene.add(walls);
  }

  private spawnHead(key: number, selfId: number | null): THREE.Mesh {
    const color = key === SELF_KEY ? headColor(selfId ?? -2, selfId) : headColor(key, selfId);
    const head = new THREE.Mesh(
      new THREE.ConeGeometry(0.5, 1.4, 12),
      new THREE.MeshLambertMaterial({ color }),
    );
    head.rotation.order = 'YXZ';
    head.geometry.rotateX(Math.PI / 2); // cone points along +z = heading 0 … rotated by heading
    this.scene.add(head);
    this.heads.set(key, head);
    return head;
  }
}
