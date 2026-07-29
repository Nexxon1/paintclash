/**
 * The chase camera's geometry — and the screen→ground math that steering by
 * pointer needs (spec §3: the head steers toward the mouse/finger position).
 *
 * Lives in `game/` rather than in `render/` on purpose: it is pure geometry
 * that both sides read, and it belongs under unit coverage (render is exempt,
 * spec §9.3). `render/scene.ts` builds its three.js camera from these very
 * constants, so the projection inverted here can never drift from the one the
 * player actually looks at.
 *
 * Sim coords map to three as (x, y_sim) → (x, 0, z=y_sim); the camera sits
 * behind and above the head, looking straight at it with no yaw or roll. Two
 * consequences the math below leans on:
 *
 * - The head projects to the exact screen center, so a pointer's offset from
 *   the center IS its offset from the head — no world position needed.
 * - Screen right is +x, screen DOWN is +y (the +y axis runs toward the
 *   camera), squashed by the tilt.
 */

import type { Point } from '@paintclash/shared';

/** Vertical field of view, in degrees (three.js PerspectiveCamera fov). */
export const CAMERA_FOV_DEG = 55;
/** Elevation above the ground plane — the "Paper.io Modern" tilt (spec §4.1). */
export const CAMERA_ELEVATION_RAD = (52 * Math.PI) / 180;
/** Distance from the head, along the view direction, in WU. */
export const CAMERA_DISTANCE_WU = 40;

const TAN_HALF_FOV = Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);

/**
 * The ground point under a screen position, as a WU offset from the head.
 * `ndcX`/`ndcY` are normalized device coordinates (−1…1, y UP), `aspect` is
 * width/height.
 *
 * Ray-plane intersection in the camera's frame: right = (1,0,0), forward =
 * (0, −sinθ, −cosθ), up = (0, cosθ, −sinθ) for elevation θ, camera at height
 * D·sinθ and D·cosθ behind the head.
 */
export function groundOffsetFromNdc(ndcX: number, ndcY: number, aspect: number): Point {
  const sin = Math.sin(CAMERA_ELEVATION_RAD);
  const cos = Math.cos(CAMERA_ELEVATION_RAD);
  const right = ndcX * TAN_HALF_FOV * aspect;
  const up = ndcY * TAN_HALF_FOV;
  // Ray direction: y decides whether (and where) it meets the ground.
  const dirY = -sin + up * cos;
  const dirZ = -cos - up * sin;
  // At this tilt the horizon sits at NDC y ≈ 2.5 — off screen for any aspect,
  // so every visible pixel really is ground. Clamping instead of branching
  // keeps that a structural guarantee (and not an untested code path) should
  // the tilt ever be re-tuned flatter.
  const downward = Math.min(dirY, -1e-3);
  const t = (CAMERA_DISTANCE_WU * sin) / -downward;
  return [t * right, CAMERA_DISTANCE_WU * cos + t * dirZ];
}

/**
 * A screen-space DIRECTION (pixels, y down) as a ground direction — the tilt
 * squashes the sim's y axis on screen by sinθ, so undoing it is what makes a
 * joystick send the head where the stick visibly points. Not normalized: only
 * the angle is ever used.
 */
export function groundDirFromScreenDir(dx: number, dy: number): Point {
  return [dx, dy / Math.sin(CAMERA_ELEVATION_RAD)];
}

/**
 * Viewport pixels → NDC (y up), clamped to the frustum: a pointer captured
 * outside the window (a drag past the edge) still reads as the most extreme
 * on-screen direction instead of projecting past the horizon. A zero-sized
 * viewport (a minimized window) reads as the center rather than as NaN.
 */
export function viewportNdc(
  clientX: number,
  clientY: number,
  width: number,
  height: number,
): [number, number] {
  if (width <= 0 || height <= 0) return [0, 0];
  const clamp = (v: number): number => Math.min(1, Math.max(-1, v));
  return [clamp((clientX / width) * 2 - 1), clamp(-((clientY / height) * 2 - 1))];
}
