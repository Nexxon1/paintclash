import { expect, test, type Page } from '@playwright/test';

/**
 * Curated E2E (ticket 10, spec §3): the control modes on REAL input devices —
 * a mouse and a touchscreen — which is the one thing only a browser can check
 * (spec §9.1). The steering rules themselves are unit-tested headless
 * (`game/input.test.ts`, `game/camera.test.ts`), so what is asserted here is
 * the wiring: DOM events → steer intent → the head actually turning, plus the
 * mode surviving a reload in localStorage.
 *
 * Every assertion is relative to where the head currently points, never to a
 * fixed compass direction: spawns are random, and a head pinned against a wall
 * still turns its heading (the soft barrier clamps position, not heading).
 */

/** The tilt the chase camera squashes the sim's y axis by (game/camera.ts). */
const CAMERA_ELEVATION_RAD = (52 * Math.PI) / 180;

/** Shortest signed arc from `a` to `b`, in radians. */
function arc(a: number, b: number): number {
  const TWO_PI = 2 * Math.PI;
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return d;
}

async function join(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.fill('#name', name);
  await page.click('#join-form button');
  await page.waitForSelector('#overlay', { state: 'hidden', timeout: 15_000 });
}

function chip(page: Page, mode: string) {
  return page.locator(`.control-modes [data-mode="${mode}"]`);
}

/** The modes this device is offered, in panel order (spec §3, device split). */
function offeredModes(page: Page): Promise<string[]> {
  return page
    .locator('.control-modes .mode')
    .evaluateAll((chips) =>
      chips.map((c) => (c instanceof HTMLElement ? (c.dataset.mode ?? '') : '')),
    );
}

/** Open the picker, take a mode, and let it close itself again. */
async function pick(page: Page, mode: string): Promise<void> {
  await page.click('.control-toggle');
  await chip(page, mode).click();
  await expect(chip(page, mode)).toHaveClass(/active/);
  // Collapsed again: the picker must not sit over the arena while playing.
  await expect(chip(page, mode)).toBeHidden();
}

/** The heading the page is currently DRAWING the own head at. */
function heading(page: Page): Promise<number> {
  return page.evaluate(() => {
    const self = window.__paintclash?.lastRender?.self;
    if (!self) throw new Error('no rendered self yet');
    return self.heading;
  });
}

/**
 * A screen point (or stick deflection) that means "go this way in the world":
 * the ground direction `angle`, squashed by the camera tilt, `pixels` out from
 * `origin`. Any positive length reads as the same direction, so the exact
 * distance only has to clear the input deadzones.
 */
function screenOffset(angle: number, pixels: number): { dx: number; dy: number } {
  return {
    dx: Math.cos(angle) * pixels,
    dy: Math.sin(angle) * Math.sin(CAMERA_ELEVATION_RAD) * pixels,
  };
}

/** Assert that steering `side` (−1 left, +1 right) really swung the head. */
function expectSwing(before: number, after: number, side: number): void {
  const swing = arc(before, after);
  expect(Math.sign(swing)).toBe(side);
  // A ½ s hold turns up to 160° at the §10 start values; anything under 20° is
  // noise rather than a steered head.
  expect(Math.abs(swing)).toBeGreaterThan((20 * Math.PI) / 180);
}

/**
 * Assert the head is running STRAIGHT now — measured over a window that starts
 * after the let-go transient: the client's own prediction stops turning with
 * the release, but the rendered heading still carries the reconciliation glide
 * of the ticks that were in flight (≤ 100 ms of decay, spec §6.1). A turn that
 * is still held moves 128° through this window, so the margin is not thin.
 */
async function expectStraight(page: Page): Promise<void> {
  await page.waitForTimeout(250);
  const settled = await heading(page);
  await page.waitForTimeout(400);
  expect(Math.abs(arc(settled, await heading(page)))).toBeLessThan((10 * Math.PI) / 180);
}

test('the mouse steers the head in follow mode, and the mode outlives a reload', async ({
  page,
}) => {
  // The picker works BEFORE joining too (it sits above the join overlay).
  await page.goto('/');
  await page.click('.control-toggle');
  // Desktop offers exactly keyboard + Maus folgen (spec §3), keyboard active.
  expect(await offeredModes(page)).toEqual(['keyboard', 'pointer']);
  await expect(chip(page, 'pointer')).toHaveText('Maus folgen');
  await expect(chip(page, 'keyboard')).toHaveClass(/active/);
  await page.click('.control-toggle');

  await join(page, 'Maus-E2E');
  await pick(page, 'pointer');

  const size = page.viewportSize();
  if (!size) throw new Error('no viewport');
  // The head is at the screen center (the camera looks straight at it).
  const center = { x: size.width / 2, y: size.height / 2 };
  for (const side of [1, -1]) {
    const before = await heading(page);
    // Park the cursor 90° off the head's current heading; the head must swing
    // that way — the shorter way, which is what the sign asserts.
    const { dx, dy } = screenOffset(before + (side * Math.PI) / 2, 250);
    await page.mouse.move(center.x + dx, center.y + dy);
    await page.waitForTimeout(500);
    expectSwing(before, await heading(page), side);
  }

  // Persisted (localStorage): the reload comes back on the chosen mode.
  await page.reload();
  await expect(chip(page, 'pointer')).toHaveClass(/active/);
  expect(await page.evaluate(() => localStorage.getItem('paintclash.settings.v1'))).toBe(
    JSON.stringify({ version: 1, controlMode: 'pointer' }),
  );
});

test.describe('on a touchscreen', () => {
  // A real phone: touch events AND a coarse primary pointer, which is what the
  // mobile default hangs off.
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  /** Raw touch injection — Playwright's touchscreen can only tap, not drag. */
  async function touchDriver(
    page: Page,
  ): Promise<(type: string, x: number, y: number) => Promise<void>> {
    const cdp = await page.context().newCDPSession(page);
    return async (type, x, y) => {
      await cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
      });
    };
  }

  test('a finger steers the head, and lifting it lets go', async ({ page }) => {
    await join(page, 'Finger-E2E');
    await page.click('.control-toggle');
    // Mobile offers exactly the three touch modes (spec §3), "Finger folgen"
    // active and named after the device.
    expect(await offeredModes(page)).toEqual(['pointer', 'joystick', 'steer']);
    await expect(chip(page, 'pointer')).toHaveClass(/active/);
    await expect(chip(page, 'pointer')).toHaveText('Finger folgen');
    await page.click('.control-toggle');
    const touch = await touchDriver(page);

    const before = await heading(page);
    const center = { x: 195, y: 422 };
    const aim = screenOffset(before + Math.PI / 2, 150);
    await touch('touchStart', center.x + aim.dx, center.y + aim.dy);
    await touch('touchMove', center.x + aim.dx, center.y + aim.dy);
    await page.waitForTimeout(500);
    const steered = await heading(page);
    expectSwing(before, steered, 1);

    // A lifted finger has no position — the head runs on straight instead of
    // circling the spot the finger left behind.
    await touch('touchEnd', center.x + aim.dx, center.y + aim.dy);
    await expectStraight(page);
  });

  test('the joystick appears under the finger and steers where it points', async ({ page }) => {
    await join(page, 'Joystick-E2E');
    await pick(page, 'joystick');
    const touch = await touchDriver(page);
    const stick = page.locator('#joystick');
    await expect(stick).toBeHidden();

    const before = await heading(page);
    const base = { x: 120, y: 650 };
    await touch('touchStart', base.x, base.y);
    // The ring shows up where the finger landed, knob and all.
    await expect(stick).toBeVisible();
    const push = screenOffset(before - Math.PI / 2, 70);
    await touch('touchMove', base.x + push.dx, base.y + push.dy);
    await page.waitForTimeout(500);
    expectSwing(before, await heading(page), -1);

    await touch('touchEnd', base.x + push.dx, base.y + push.dy);
    await expect(stick).toBeHidden();
  });

  test('a thumb on a screen half steers in Lenken L/R', async ({ page }) => {
    await join(page, 'Lenken-E2E');
    await pick(page, 'steer');
    const touch = await touchDriver(page);

    // Holding the left half turns left, the right half right — and only while
    // held: the release must stop the turn, not reverse or continue it. Both
    // spots are where a thumb actually rests, which is also the check that the
    // picker is not sitting in that zone.
    for (const [side, x] of [
      [-1, 70],
      [1, 320],
    ] as const) {
      const before = await heading(page);
      await touch('touchStart', x, 780);
      await page.waitForTimeout(500);
      const held = await heading(page);
      await touch('touchEnd', x, 780);
      expectSwing(before, held, side);
      await expectStraight(page);
    }
  });
});
