/**
 * three.js scene (spec §4.1/4.3): arena floor, start blocks, heads — rendered
 * with the "Paper.io Modern" perspective tilt (~52° elevation). Pure data
 * sink: `update()` consumes the session's RenderState and never touches game
 * logic. Excluded from unit coverage; the Playwright E2E exercises it.
 *
 * Sim coords map to three as (x, y_sim) → (x, 0, z=y_sim).
 */

import { BALANCE } from '@paintclash/shared';
import * as THREE from 'three';

import type { RenderState } from '../game/session.js';

const CAMERA_ELEVATION_RAD = (52 * Math.PI) / 180;
const CAMERA_DISTANCE = 40;
const BLOCK_SIZE = BALANCE.spawn.startBlockWU;
/** Reserved mesh key for the own player (rendered from the predicted pose). */
const SELF_KEY = -1;

function playerColor(id: number): THREE.Color {
  // Stable, well-spread hues until `appearance` lands (ADR-0006 seam).
  const hue = (id * 0.618034) % 1;
  return new THREE.Color().setHSL(hue, 0.65, 0.55);
}

interface PlayerMeshes {
  head: THREE.Mesh;
  block: THREE.Mesh;
}

export class ArenaScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly players = new Map<number, PlayerMeshes>();
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

    const seen = new Set<number>();
    for (const p of state.others) {
      seen.add(p.id);
      this.pose(p.id, false, p.x, p.y, p.heading, { cx: p.blockCx, cy: p.blockCy });
    }
    if (state.self) {
      seen.add(SELF_KEY);
      this.pose(SELF_KEY, true, state.self.x, state.self.y, state.self.heading, state.selfBlock);
    }
    for (const [id, meshes] of this.players) {
      if (!seen.has(id)) {
        this.scene.remove(meshes.head, meshes.block);
        this.players.delete(id);
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

  /** Non-finite poses that were blocked from rendering (debug/diagnosis). */
  poseAnomalies = 0;

  /** Place (and lazily create) one player's head + start block. */
  private pose(
    key: number,
    self: boolean,
    x: number,
    y: number,
    heading: number,
    block: { cx: number; cy: number } | null,
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
    let meshes = this.players.get(key);
    meshes ??= this.spawnMeshes(key, self);
    meshes.head.position.set(x, 0.6, y);
    // +z-pointing cone rotated so heading 0 = +x, heading π/2 = +z (=y_sim).
    meshes.head.rotation.y = Math.PI / 2 - heading;
    meshes.block.visible = block !== null;
    if (block) meshes.block.position.set(block.cx, 0.05, block.cy);
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

  private spawnMeshes(id: number, self: boolean): PlayerMeshes {
    const color = self ? new THREE.Color(0x2f7fe8) : playerColor(id);
    const head = new THREE.Mesh(
      new THREE.ConeGeometry(0.5, 1.4, 12),
      new THREE.MeshLambertMaterial({ color }),
    );
    head.rotation.order = 'YXZ';
    head.geometry.rotateX(Math.PI / 2); // cone points along +z = heading 0 … rotated by heading
    // Flat, muted ground plate — clearly "owned floor", not a solid object.
    const block = new THREE.Mesh(
      new THREE.BoxGeometry(BLOCK_SIZE, 0.1, BLOCK_SIZE),
      new THREE.MeshLambertMaterial({
        color: color.clone().offsetHSL(0, -0.3, 0.22),
        transparent: true,
        opacity: 0.9,
      }),
    );
    this.scene.add(head, block);
    const meshes = { head, block };
    this.players.set(id, meshes);
    return meshes;
  }
}
