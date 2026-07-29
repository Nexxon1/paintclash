/**
 * Player settings (spec §3): which control mode steers the head. Persisted in
 * `localStorage`, so the choice survives a reload — there is no account
 * (CONTEXT: Spieler-ID).
 *
 * The five modes the spec names collapse to FOUR implementations: desktop
 * "Maus folgen" and mobile "Finger folgen" are the same rule over the same
 * pointer events (steer toward the pointer), and only their label differs by
 * device.
 *
 * Which of them a player is offered follows the spec's own split — keyboard
 * and follow on desktop, follow, joystick and steer-L/R on a touchscreen.
 * Nothing technical forces that (pointer events drive a joystick from a mouse
 * just as well), but a "Tastatur" chip on a keyboard-less phone is a trap:
 * picking it leaves the player unable to steer at all.
 *
 * What a mode DOES lives in `input.ts`; this module owns the vocabulary, the
 * device default and the storage envelope.
 */

import { browserStore, readStored, writeStored, type LocalStore } from './storage.js';

/** How the player steers (CONTEXT: Steuerungs-Modus). */
export type ControlMode = 'keyboard' | 'pointer' | 'joystick' | 'steer';

/** Every mode that exists — the vocabulary a stored setting is checked against. */
export const CONTROL_MODES: readonly ControlMode[] = ['keyboard', 'pointer', 'joystick', 'steer'];

/**
 * The modes offered on this device, in the order the panel lists them, default
 * first (spec §3: desktop keyboard + Maus folgen; mobile Finger folgen,
 * Joystick, Lenken L/R).
 */
export function controlModesFor(coarsePointer: boolean): readonly ControlMode[] {
  return coarsePointer ? ['pointer', 'joystick', 'steer'] : ['keyboard', 'pointer'];
}

/** The one localStorage key — the version lives inside the envelope. */
export const SETTINGS_STORAGE_KEY = 'paintclash.settings.v1';

const STORAGE_VERSION = 1;

/**
 * Spec §3 defaults: keyboard on desktop, "Finger folgen" on mobile. Decided by
 * the PRIMARY pointer being coarse rather than by a user-agent sniff — that is
 * the same question the default is about ("is this a finger?"), and it gets a
 * touch laptop right (fine pointer, so: keyboard).
 */
export function defaultControlMode(coarsePointer: boolean): ControlMode {
  return coarsePointer ? 'pointer' : 'keyboard';
}

/** The mode's name in the settings panel — the follow mode names the device. */
export function controlModeLabel(mode: ControlMode, coarsePointer: boolean): string {
  switch (mode) {
    case 'keyboard':
      return 'Tastatur';
    case 'pointer':
      return coarsePointer ? 'Finger folgen' : 'Maus folgen';
    case 'joystick':
      return 'Joystick';
    case 'steer':
      return 'Lenken L/R';
  }
}

function isControlMode(value: unknown): value is ControlMode {
  return CONTROL_MODES.includes(value as ControlMode);
}

export class Settings {
  private readonly store: LocalStore | null;
  private readonly offered: readonly ControlMode[];
  private mode: ControlMode;

  constructor(coarsePointer: boolean, store: LocalStore | null = browserStore()) {
    this.store = store;
    this.offered = controlModesFor(coarsePointer);
    // A mode this device does not offer is not steering the player: the phone
    // that stored "Tastatur" on a docked keyboard would be stuck otherwise.
    const stored = this.load();
    this.mode =
      stored !== null && this.offered.includes(stored) ? stored : defaultControlMode(coarsePointer);
  }

  /** The modes the picker shows here (spec §3, device split). */
  get modes(): readonly ControlMode[] {
    return this.offered;
  }

  get controlMode(): ControlMode {
    return this.mode;
  }

  set controlMode(mode: ControlMode) {
    this.mode = mode;
    writeStored(
      this.store,
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, controlMode: mode }),
    );
  }

  /** The stored mode, or null when there is nothing trustworthy stored. */
  private load(): ControlMode | null {
    const raw = readStored(this.store, SETTINGS_STORAGE_KEY);
    if (raw === null) return null;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null; // corrupted — the device default writes over it
    }
    // Another tab, an older build or a poke in devtools can put anything here:
    // check the fields rather than trusting a cast (as `records.ts` does).
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { version, controlMode } = parsed as { version?: unknown; controlMode?: unknown };
    // A foreign version is for a future migration to read, not for this one to
    // guess at — a settings key is cheap to re-choose.
    if (version !== STORAGE_VERSION) return null;
    return isControlMode(controlMode) ? controlMode : null;
  }
}
