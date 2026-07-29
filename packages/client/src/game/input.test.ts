import { BALANCE, TICK_DT_SEC } from '@paintclash/shared';
import { describe, expect, it } from 'vitest';

import { JOYSTICK_RADIUS_PX, Steering } from './input.js';

import type { PointerSample } from './input.js';
import type { ControlMode } from './settings.js';

/** Sim headings: 0 = screen right, +π/2 = screen down (see game/camera.ts). */
const RIGHT = 0;
const DOWN = Math.PI / 2;

/** A viewport with the head at its center, as the chase camera guarantees. */
const WIDTH = 800;
const HEIGHT = 600;
const CENTER = { x: WIDTH / 2, y: HEIGHT / 2 };

function steering(mode: ControlMode): Steering {
  const controls = new Steering(mode);
  controls.resize(WIDTH, HEIGHT);
  return controls;
}

/** One pointer sample; a mouse keeps its position after the button goes up. */
function at(x: number, y: number, touch = true): PointerSample {
  return { id: 1, x, y, touch };
}

describe('keyboard steering (spec §3: A/D or arrow keys)', () => {
  /** The keyboard needs no head pose — it IS the steer intent. */
  const keys = (): Steering => steering('keyboard');

  it('steers right while D or ArrowRight is held', () => {
    const controls = keys();
    controls.keyDown('d');
    expect(controls.turn(null)).toBe(1);
    controls.keyUp('d');
    controls.keyDown('ArrowRight');
    expect(controls.turn(null)).toBe(1);
  });

  it('steers left while A or ArrowLeft is held', () => {
    const controls = keys();
    controls.keyDown('a');
    expect(controls.turn(null)).toBe(-1);
    controls.keyUp('a');
    controls.keyDown('ArrowLeft');
    expect(controls.turn(null)).toBe(-1);
  });

  it('goes straight with no key or both directions held', () => {
    const controls = keys();
    expect(controls.turn(null)).toBe(0);
    controls.keyDown('a');
    controls.keyDown('d');
    expect(controls.turn(null)).toBe(0);
  });

  it('is case-insensitive and ignores unrelated keys', () => {
    const controls = keys();
    controls.keyDown('A');
    expect(controls.turn(null)).toBe(-1);
    controls.keyDown('w');
    controls.keyDown(' ');
    expect(controls.turn(null)).toBe(-1);
    controls.keyUp('A');
    expect(controls.turn(null)).toBe(0);
  });

  it('releasing one of two held directions resumes the other', () => {
    const controls = keys();
    controls.keyDown('a');
    controls.keyDown('ArrowRight');
    expect(controls.turn(null)).toBe(0);
    controls.keyUp('a');
    expect(controls.turn(null)).toBe(1);
  });
});

describe('pointer-follow steering (spec §3: Maus folgen / Finger folgen)', () => {
  it('turns the shorter way toward the pointer, whichever side it is on', () => {
    const controls = steering('pointer');
    controls.pointerMove(at(CENTER.x, HEIGHT - 20)); // below the head = sim +y
    expect(controls.turn(RIGHT)).toBe(1);
    controls.pointerMove(at(CENTER.x, 20)); // above the head = sim −y
    expect(controls.turn(RIGHT)).toBe(-1);
  });

  it('goes straight once the head points at the pointer', () => {
    const controls = steering('pointer');
    controls.pointerMove(at(WIDTH - 20, CENTER.y));
    expect(controls.turn(RIGHT)).toBe(0);
    // The same pointer while facing 90° off is a full turn command again.
    expect(controls.turn(DOWN)).toBe(-1);
  });

  it('holds the deadzone the sim can actually resolve', () => {
    const controls = steering('pointer');
    // One tick turns at most 16° at the §10 start values; steering on error
    // below half of that would only make the head buzz around the aim.
    const tick = BALANCE.movement.turnRateDegPerSec * TICK_DT_SEC;
    const off = ((tick / 2 - 1) * Math.PI) / 180;
    controls.pointerMove(at(WIDTH - 20, CENTER.y));
    expect(controls.turn(off)).toBe(0);
    expect(controls.turn(((tick / 2 + 4) * Math.PI) / 180)).toBe(-1);
  });

  it('goes straight while the pointer sits on the head — no direction to read', () => {
    const controls = steering('pointer');
    controls.pointerMove(at(CENTER.x, CENTER.y));
    expect(controls.turn(RIGHT)).toBe(0);
    expect(controls.turn(DOWN)).toBe(0);
  });

  it('goes straight until a pointer has been seen at all', () => {
    expect(steering('pointer').turn(RIGHT)).toBe(0);
  });

  it('forgets a lifted finger but not a mouse — one still has a position', () => {
    const controls = steering('pointer');
    controls.pointerDown(at(CENTER.x, HEIGHT - 20));
    expect(controls.turn(RIGHT)).toBe(1);
    controls.pointerUp(at(CENTER.x, HEIGHT - 20));
    expect(controls.turn(RIGHT)).toBe(0);

    controls.pointerMove(at(CENTER.x, HEIGHT - 20, false));
    controls.pointerUp(at(CENTER.x, HEIGHT - 20, false));
    expect(controls.turn(RIGHT)).toBe(1);
  });

  it('cannot steer before the head exists', () => {
    const controls = steering('pointer');
    controls.pointerMove(at(CENTER.x, HEIGHT - 20));
    expect(controls.turn(null)).toBe(0);
  });

  it('survives a viewport it was never told about', () => {
    const fresh = new Steering('pointer');
    fresh.pointerMove(at(10, 10));
    expect(fresh.turn(RIGHT)).toBe(0);
  });
});

describe('joystick steering (spec §3: mobile Joystick)', () => {
  it('shows no stick until a finger presses, and steers nowhere', () => {
    const controls = steering('joystick');
    expect(controls.joystickView()).toBeNull();
    expect(controls.turn(RIGHT)).toBe(0);
  });

  it('steers in the direction the stick is pushed', () => {
    const controls = steering('joystick');
    controls.pointerDown(at(200, 400));
    controls.pointerMove(at(200, 460)); // pushed down the screen = sim +y
    expect(controls.turn(RIGHT)).toBe(1);
    controls.pointerMove(at(200, 340)); // pushed up = sim −y
    expect(controls.turn(RIGHT)).toBe(-1);
  });

  it('places the stick where the finger landed and clamps the knob to the ring', () => {
    const controls = steering('joystick');
    controls.pointerDown(at(200, 400));
    expect(controls.joystickView()).toEqual({
      baseX: 200,
      baseY: 400,
      knobX: 200,
      knobY: 400,
    });
    controls.pointerMove(at(200 + 10 * JOYSTICK_RADIUS_PX, 400));
    expect(controls.joystickView()).toEqual({
      baseX: 200,
      baseY: 400,
      knobX: 200 + JOYSTICK_RADIUS_PX,
      knobY: 400,
    });
  });

  it('ignores a nudge inside the deadzone, and a second finger entirely', () => {
    const controls = steering('joystick');
    controls.pointerDown(at(200, 400));
    controls.pointerMove(at(203, 402));
    expect(controls.turn(RIGHT)).toBe(0);
    controls.pointerDown({ id: 2, x: 600, y: 100, touch: true });
    expect(controls.joystickView()?.baseX).toBe(200);
    controls.pointerUp({ id: 2, x: 600, y: 100, touch: true });
    expect(controls.joystickView()).not.toBeNull();
  });

  it('cannot steer before the head exists, and draws nothing in another mode', () => {
    const controls = steering('joystick');
    controls.pointerDown(at(200, 400));
    controls.pointerMove(at(200, 460));
    expect(controls.turn(null)).toBe(0);
    controls.setMode('keyboard');
    expect(controls.joystickView()).toBeNull();
  });

  it('lets go on release: the stick vanishes and the head runs straight', () => {
    const controls = steering('joystick');
    controls.pointerDown(at(200, 400));
    controls.pointerMove(at(200, 460));
    controls.pointerUp(at(200, 460));
    expect(controls.joystickView()).toBeNull();
    expect(controls.turn(RIGHT)).toBe(0);
  });
});

describe('side steering (spec §3: mobile Lenken L/R)', () => {
  it('steers by the screen half the finger holds', () => {
    const controls = steering('steer');
    controls.pointerDown({ id: 1, x: 100, y: 300, touch: true });
    expect(controls.turn(RIGHT)).toBe(-1);
    controls.pointerUp({ id: 1, x: 100, y: 300, touch: true });
    expect(controls.turn(RIGHT)).toBe(0);
    controls.pointerDown({ id: 2, x: 700, y: 300, touch: true });
    expect(controls.turn(RIGHT)).toBe(1);
  });

  it('cancels out with both halves held, and resumes on release', () => {
    const controls = steering('steer');
    controls.pointerDown({ id: 1, x: 100, y: 300, touch: true });
    controls.pointerDown({ id: 2, x: 700, y: 300, touch: true });
    expect(controls.turn(RIGHT)).toBe(0);
    controls.pointerUp({ id: 1, x: 100, y: 300, touch: true });
    expect(controls.turn(RIGHT)).toBe(1);
  });

  it('needs no head pose — it is a pure steer intent like the keyboard', () => {
    const controls = steering('steer');
    controls.pointerDown({ id: 1, x: 700, y: 300, touch: true });
    expect(controls.turn(null)).toBe(1);
  });
});

describe('switching mode at runtime (spec §3: umschaltbar)', () => {
  it('reads only the devices of the mode in force', () => {
    const controls = steering('keyboard');
    controls.pointerMove(at(CENTER.x, HEIGHT - 20));
    controls.keyDown('a');
    expect(controls.turn(RIGHT)).toBe(-1);

    controls.setMode('pointer');
    // The held key no longer steers; the pointer does.
    expect(controls.turn(RIGHT)).toBe(1);

    controls.setMode('keyboard');
    expect(controls.turn(RIGHT)).toBe(-1);
    controls.keyUp('a');
    expect(controls.turn(RIGHT)).toBe(0);
  });

  it('drops the stick and the held halves when the mode changes', () => {
    const controls = steering('joystick');
    controls.pointerDown(at(200, 400));
    controls.pointerMove(at(200, 460));
    controls.setMode('steer');
    // A finger held down through the switch must not keep steering.
    expect(controls.turn(RIGHT)).toBe(0);
    controls.setMode('joystick');
    expect(controls.joystickView()).toBeNull();
    expect(controls.turn(RIGHT)).toBe(0);
  });
});
