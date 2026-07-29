import { describe, expect, it } from 'vitest';

import {
  CAMERA_ELEVATION_RAD,
  groundDirFromScreenDir,
  groundOffsetFromNdc,
  viewportNdc,
} from './camera.js';

/** Where a ground offset lands on screen — the inverse of the projection. */
function screenDirOf(offset: readonly [number, number]): [number, number] {
  return [offset[0], offset[1] * Math.sin(CAMERA_ELEVATION_RAD)];
}

describe('chase-camera ground projection (spec §3: steering toward a screen point)', () => {
  it('maps the screen center to the head itself', () => {
    expect(groundOffsetFromNdc(0, 0, 16 / 9)).toEqual([0, 0]);
  });

  it('maps up the screen to away from the camera and down to toward it', () => {
    const [upX, upY] = groundOffsetFromNdc(0, 0.5, 16 / 9);
    expect(upX).toBeCloseTo(0, 6);
    expect(upY).toBeLessThan(-1);
    const [downX, downY] = groundOffsetFromNdc(0, -0.5, 16 / 9);
    expect(downX).toBeCloseTo(0, 6);
    expect(downY).toBeGreaterThan(1);
  });

  it('mirrors left and right around the head', () => {
    const [rightX, rightY] = groundOffsetFromNdc(0.5, -0.2, 16 / 9);
    const [leftX, leftY] = groundOffsetFromNdc(-0.5, -0.2, 16 / 9);
    expect(rightX).toBeGreaterThan(0);
    expect(leftX).toBeCloseTo(-rightX, 6);
    expect(leftY).toBeCloseTo(rightY, 6);
  });

  it('widens with the aspect ratio — the same pixel column is further out', () => {
    const [wide] = groundOffsetFromNdc(0.5, 0, 21 / 9);
    const [narrow] = groundOffsetFromNdc(0.5, 0, 4 / 3);
    expect(wide).toBeGreaterThan(narrow);
  });

  it('foreshortens: the far half of the screen covers more ground than the near half', () => {
    const far = groundOffsetFromNdc(0, 0.9, 16 / 9);
    const near = groundOffsetFromNdc(0, -0.9, 16 / 9);
    // Same pixel distance from the center, but the tilt puts far ground there.
    expect(Math.abs(far[1])).toBeGreaterThan(Math.abs(near[1]) * 2);
  });

  it('never hits the horizon or beyond — the tilt keeps it off screen', () => {
    // Top edge, widest supported aspect: still real ground in FRONT of the head.
    for (const aspect of [0.5, 1, 16 / 9, 32 / 9]) {
      const [, y] = groundOffsetFromNdc(0, 1, aspect);
      expect(Number.isFinite(y)).toBe(true);
      expect(y).toBeLessThan(0);
    }
  });

  it('reads a screen direction back as the ground direction that looks like it', () => {
    // A 45° drag down-right must produce a ground direction that PROJECTS to
    // 45° on screen again — otherwise a joystick would not go where it points.
    const ground = groundDirFromScreenDir(1, 1);
    const [sx, sy] = screenDirOf(ground);
    expect(Math.atan2(sy, sx)).toBeCloseTo(Math.PI / 4, 6);
    // Pure screen axes stay axes: down the screen is +y in sim coords.
    expect(groundDirFromScreenDir(0, 1)[0]).toBe(0);
    expect(groundDirFromScreenDir(0, 1)[1]).toBeGreaterThan(0);
  });

  it('turns viewport pixels into NDC with the head at the center', () => {
    const [midX, midY] = viewportNdc(400, 300, 800, 600);
    expect(midX).toBeCloseTo(0, 6);
    expect(midY).toBeCloseTo(0, 6);
    const [x, y] = viewportNdc(600, 150, 800, 600);
    expect(x).toBeCloseTo(0.5, 6);
    expect(y).toBeCloseTo(0.5, 6); // up the screen is +y in NDC
  });

  it('clamps pointers dragged outside the viewport into the frustum', () => {
    expect(viewportNdc(-500, 2000, 800, 600)).toEqual([-1, -1]);
    expect(viewportNdc(5000, -900, 800, 600)).toEqual([1, 1]);
  });

  it('survives a degenerate viewport instead of producing NaN', () => {
    const [x, y] = viewportNdc(10, 10, 0, 0);
    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(y)).toBe(true);
  });
});
