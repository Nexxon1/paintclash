/**
 * Steering (spec §3): the full input matrix of the base version — keyboard,
 * pointer-follow (mouse or finger), virtual joystick, and steer-L/R by screen
 * half. Every mode ends in the SAME legal steer intent the walking skeleton
 * sent (−1/0/1, CONTEXT: Steuer-Intent): no mode may claim a position, a
 * heading or a speed, so the input matrix adds no trust boundary (spec §6.4).
 *
 * Pure bookkeeping in screen coordinates — DOM events are unwrapped in
 * `main.ts`, which keeps all of this headless-testable. The modes themselves
 * and their persistence live in `settings.ts`.
 */

import { BALANCE, TICK_DT_SEC } from '@paintclash/shared';

import { groundDirFromScreenDir, groundOffsetFromNdc, viewportNdc } from './camera.js';
import { angleDiff } from './interpolator.js';

import type { TurnSignal } from '@paintclash/shared';
import type { ControlMode } from './settings.js';

const LEFT_KEYS = new Set(['a', 'arrowleft']);
const RIGHT_KEYS = new Set(['d', 'arrowright']);

/**
 * Aim error the head accepts as "pointing there". One tick turns at most
 * `turnRateDegPerSec × dt` (16° at the §10 start values), so steering on
 * anything below half a tick's turn could only overshoot and come back —
 * a head buzzing around its aim instead of running at it.
 */
const AIM_DEADZONE_RAD = ((BALANCE.movement.turnRateDegPerSec * TICK_DT_SEC) / 2) * (Math.PI / 180);

/**
 * How close to the head the pointer may come before its direction stops
 * meaning anything: one head across (2 × the collision radius). Inside this the
 * head keeps its heading rather than chasing pixel noise around its own nose.
 */
const AIM_MIN_DISTANCE_WU = 2 * BALANCE.trail.collisionRadiusWU;

/** Radius of the virtual joystick's ring in CSS pixels — also its full deflection. */
export const JOYSTICK_RADIUS_PX = 60;

/** Deflection below this fraction of the ring is a resting thumb, not a push. */
const JOYSTICK_DEADZONE = 0.25;

/** One pointer event, stripped to what steering needs. */
export interface PointerSample {
  /** `PointerEvent.pointerId` — tells fingers apart. */
  id: number;
  /** Viewport coordinates (`clientX`/`clientY`). */
  x: number;
  y: number;
  /** Anything but a mouse: a finger or pen has no position once it is lifted. */
  touch: boolean;
}

/** Where the joystick draws itself, in viewport pixels. */
export interface JoystickView {
  baseX: number;
  baseY: number;
  knobX: number;
  knobY: number;
}

/** Turn intent that brings `heading` onto `desired` the shorter way. */
function turnToward(heading: number, desired: number): TurnSignal {
  const diff = angleDiff(heading, desired);
  if (Math.abs(diff) < AIM_DEADZONE_RAD) return 0;
  return diff > 0 ? 1 : -1;
}

/**
 * Keyboard steering: A/D or the arrow keys. Module-private — everything above
 * goes through `Steering`, so there is one public way to produce an intent.
 */
class KeyTracker {
  private left = 0;
  private right = 0;

  down(key: string): void {
    this.set(key, true);
  }

  up(key: string): void {
    this.set(key, false);
  }

  /** Current steer intent; opposing keys cancel out. */
  turn(): TurnSignal {
    return Math.sign(this.right - this.left) as TurnSignal;
  }

  private set(key: string, held: boolean): void {
    const k = key.toLowerCase();
    if (LEFT_KEYS.has(k)) this.left = held ? 1 : 0;
    if (RIGHT_KEYS.has(k)) this.right = held ? 1 : 0;
  }
}

/**
 * Pointer-follow: the head steers toward the ground under the pointer. The
 * chase camera looks straight at the head, so the pointer's offset from the
 * screen center IS its offset from the head — no world position needed, only
 * the heading to compare against.
 */
class PointerAim {
  private point: { x: number; y: number } | null = null;

  move(sample: PointerSample): void {
    this.point = { x: sample.x, y: sample.y };
  }

  /** A lifted finger has no position; a mouse keeps the one it rests at. */
  release(sample: PointerSample): void {
    if (sample.touch) this.point = null;
  }

  turn(heading: number, width: number, height: number): TurnSignal {
    const point = this.point;
    if (!point || width <= 0 || height <= 0) return 0;
    const [ndcX, ndcY] = viewportNdc(point.x, point.y, width, height);
    const [dx, dy] = groundOffsetFromNdc(ndcX, ndcY, width / height);
    if (Math.hypot(dx, dy) < AIM_MIN_DISTANCE_WU) return 0;
    return turnToward(heading, Math.atan2(dy, dx));
  }
}

/**
 * Virtual joystick: the ring appears wherever the finger lands, the knob
 * follows it out to `JOYSTICK_RADIUS_PX`, and the head steers where the stick
 * points — un-squashed through the camera tilt, so it goes where the player
 * sees it point. One stick at a time; later fingers are not a second joystick.
 */
class Joystick {
  private id: number | null = null;
  private base = { x: 0, y: 0 };
  private knob = { x: 0, y: 0 };

  press(sample: PointerSample): void {
    if (this.id !== null) return;
    this.id = sample.id;
    this.base = { x: sample.x, y: sample.y };
    this.knob = { ...this.base };
  }

  move(sample: PointerSample): void {
    if (this.id !== sample.id) return;
    const dx = sample.x - this.base.x;
    const dy = sample.y - this.base.y;
    const distance = Math.hypot(dx, dy);
    const scale = distance > JOYSTICK_RADIUS_PX ? JOYSTICK_RADIUS_PX / distance : 1;
    this.knob = { x: this.base.x + dx * scale, y: this.base.y + dy * scale };
  }

  release(sample: PointerSample): void {
    if (this.id === sample.id) this.forget();
  }

  forget(): void {
    this.id = null;
  }

  view(): JoystickView | null {
    if (this.id === null) return null;
    return { baseX: this.base.x, baseY: this.base.y, knobX: this.knob.x, knobY: this.knob.y };
  }

  turn(heading: number): TurnSignal {
    if (this.id === null) return 0;
    const dx = this.knob.x - this.base.x;
    const dy = this.knob.y - this.base.y;
    if (Math.hypot(dx, dy) < JOYSTICK_RADIUS_PX * JOYSTICK_DEADZONE) return 0;
    const [gx, gy] = groundDirFromScreenDir(dx, dy);
    return turnToward(heading, Math.atan2(gy, gx));
  }
}

/**
 * Steer L/R: holding the left half of the screen turns left, the right half
 * right — the touch analog of A/D, down to opposing holds cancelling out. The
 * side is decided where the finger LANDS; sliding across the middle mid-hold
 * does not flip it (thumbs rest, they do not aim).
 */
class SideSteer {
  private readonly sides = new Map<number, -1 | 1>();

  press(sample: PointerSample, width: number): void {
    this.sides.set(sample.id, sample.x < width / 2 ? -1 : 1);
  }

  release(sample: PointerSample): void {
    this.sides.delete(sample.id);
  }

  forget(): void {
    this.sides.clear();
  }

  turn(): TurnSignal {
    let sum = 0;
    for (const side of this.sides.values()) sum += side;
    return Math.sign(sum) as TurnSignal;
  }
}

/**
 * The one thing `main.ts` steers through: it feeds raw device events in and
 * asks for a steer intent once per sim tick. Which devices are read is the
 * mode's business (spec §3: switchable at runtime, persisted in `settings.ts`).
 */
export class Steering {
  private active: ControlMode;
  private width = 0;
  private height = 0;
  private readonly keys = new KeyTracker();
  private readonly aim = new PointerAim();
  private readonly joystick = new Joystick();
  private readonly sides = new SideSteer();

  constructor(mode: ControlMode) {
    this.active = mode;
  }

  /**
   * Switch mode. Anything a finger was HOLDING is dropped — a stick or a held
   * half left standing would keep steering a mode that is no longer in force.
   * The last pointer position is not a hold and stays: switching to follow
   * mode should pick the cursor up where it already is, not wait for a jiggle.
   */
  setMode(mode: ControlMode): void {
    this.active = mode;
    this.joystick.forget();
    this.sides.forget();
  }

  /** Viewport size in CSS pixels — the head sits at its center. */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  keyDown(key: string): void {
    this.keys.down(key);
  }

  keyUp(key: string): void {
    this.keys.up(key);
  }

  pointerDown(sample: PointerSample): void {
    // A press is also a position: a finger that lands without moving still aims.
    this.aim.move(sample);
    this.joystick.press(sample);
    this.sides.press(sample, this.width);
  }

  pointerMove(sample: PointerSample): void {
    this.aim.move(sample);
    this.joystick.move(sample);
  }

  pointerUp(sample: PointerSample): void {
    this.aim.release(sample);
    this.joystick.release(sample);
    this.sides.release(sample);
  }

  /**
   * The steer intent for this tick. `heading` is the own head's heading as the
   * sim currently has it (null before the spawn) — the aiming modes need it to
   * know which way is shorter; the discrete ones do not.
   */
  turn(heading: number | null): TurnSignal {
    switch (this.active) {
      case 'keyboard':
        return this.keys.turn();
      case 'steer':
        return this.sides.turn();
      case 'pointer':
        return heading === null ? 0 : this.aim.turn(heading, this.width, this.height);
      case 'joystick':
        return heading === null ? 0 : this.joystick.turn(heading);
    }
  }

  /** Where to draw the joystick, or null when no finger holds it. */
  joystickView(): JoystickView | null {
    return this.active === 'joystick' ? this.joystick.view() : null;
  }
}
