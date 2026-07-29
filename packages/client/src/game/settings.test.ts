import { describe, expect, it } from 'vitest';

import {
  CONTROL_MODES,
  controlModeLabel,
  controlModesFor,
  defaultControlMode,
  Settings,
  SETTINGS_STORAGE_KEY,
} from './settings.js';

import type { LocalStore } from './storage.js';

function fakeStore(seed: Record<string, string> = {}): LocalStore & { data: typeof seed } {
  const data = { ...seed };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

describe('control-mode defaults (spec §3)', () => {
  it('starts on the keyboard with a mouse and on finger-follow with a touchscreen', () => {
    expect(defaultControlMode(false)).toBe('keyboard');
    expect(defaultControlMode(true)).toBe('pointer');
  });

  it('names the follow mode after the device, and every mode has a label', () => {
    expect(controlModeLabel('pointer', false)).toBe('Maus folgen');
    expect(controlModeLabel('pointer', true)).toBe('Finger folgen');
    expect(controlModeLabel('keyboard', true)).toBe('Tastatur');
    for (const mode of CONTROL_MODES) {
      expect(controlModeLabel(mode, false).length).toBeGreaterThan(0);
      expect(controlModeLabel(mode, true).length).toBeGreaterThan(0);
    }
  });

  it('offers all five spec modes over the four implementations', () => {
    // Desktop keyboard + mouse-follow, mobile finger-follow + joystick +
    // steer L/R — mouse-follow and finger-follow ARE one mode (pointer
    // events), told apart only by the label above.
    expect([...CONTROL_MODES]).toEqual(['keyboard', 'pointer', 'joystick', 'steer']);
  });

  it('splits the modes by device the way the spec does, default first', () => {
    expect([...controlModesFor(false)]).toEqual(['keyboard', 'pointer']);
    expect([...controlModesFor(true)]).toEqual(['pointer', 'joystick', 'steer']);
    // No mode is offered that the device cannot work — a "Tastatur" chip on a
    // keyboard-less phone would strand whoever picked it.
    for (const coarse of [false, true]) {
      expect(controlModesFor(coarse)[0]).toBe(defaultControlMode(coarse));
    }
  });
});

describe('persisted settings (spec §3: the chosen mode survives a reload)', () => {
  it('writes the chosen mode under one versioned key', () => {
    const store = fakeStore();
    const settings = new Settings(false, store);
    settings.controlMode = 'joystick';
    expect(settings.controlMode).toBe('joystick');
    expect(JSON.parse(store.data[SETTINGS_STORAGE_KEY] ?? '{}')).toEqual({
      version: 1,
      controlMode: 'joystick',
    });
  });

  it('reads a stored mode back, device default or not', () => {
    const store = fakeStore({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({ version: 1, controlMode: 'joystick' }),
    });
    const settings = new Settings(true, store);
    expect(settings.controlMode).toBe('joystick');
    expect([...settings.modes]).toEqual([...controlModesFor(true)]);
  });

  it('drops a stored mode this device does not offer', () => {
    // A phone that once ran on a docked keyboard must not come back stranded
    // in a mode it has no device for.
    const store = fakeStore({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({ version: 1, controlMode: 'keyboard' }),
    });
    expect(new Settings(true, store).controlMode).toBe('pointer');
  });

  it('falls back to the device default for anything untrustworthy', () => {
    for (const raw of [
      'not json',
      'null',
      '[]',
      JSON.stringify({ version: 1, controlMode: 'telepathy' }),
      JSON.stringify({ version: 99, controlMode: 'joystick' }),
      JSON.stringify({ controlMode: 'joystick' }),
      JSON.stringify({ version: 1 }),
    ]) {
      const store = fakeStore({ [SETTINGS_STORAGE_KEY]: raw });
      expect(new Settings(true, store).controlMode).toBe('pointer');
    }
  });

  it('stays usable when the browser denies storage', () => {
    const hostile: LocalStore = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const settings = new Settings(false, hostile);
    expect(settings.controlMode).toBe('keyboard');
    settings.controlMode = 'pointer';
    expect(settings.controlMode).toBe('pointer');
  });

  it('works with no storage at all (session-only)', () => {
    const settings = new Settings(true, null);
    settings.controlMode = 'keyboard';
    expect(settings.controlMode).toBe('keyboard');
  });
});
