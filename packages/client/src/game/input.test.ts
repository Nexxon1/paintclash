import { describe, expect, it } from 'vitest';

import { KeyTracker } from './input.js';

describe('keyboard steering (spec §3: A/D or arrow keys)', () => {
  it('steers right while D or ArrowRight is held', () => {
    const keys = new KeyTracker();
    keys.down('d');
    expect(keys.turn()).toBe(1);
    keys.up('d');
    keys.down('ArrowRight');
    expect(keys.turn()).toBe(1);
  });

  it('steers left while A or ArrowLeft is held', () => {
    const keys = new KeyTracker();
    keys.down('a');
    expect(keys.turn()).toBe(-1);
    keys.up('a');
    keys.down('ArrowLeft');
    expect(keys.turn()).toBe(-1);
  });

  it('goes straight with no key or both directions held', () => {
    const keys = new KeyTracker();
    expect(keys.turn()).toBe(0);
    keys.down('a');
    keys.down('d');
    expect(keys.turn()).toBe(0);
  });

  it('is case-insensitive and ignores unrelated keys', () => {
    const keys = new KeyTracker();
    keys.down('A');
    expect(keys.turn()).toBe(-1);
    keys.down('w');
    keys.down(' ');
    expect(keys.turn()).toBe(-1);
    keys.up('A');
    expect(keys.turn()).toBe(0);
  });

  it('releasing one of two held directions resumes the other', () => {
    const keys = new KeyTracker();
    keys.down('a');
    keys.down('ArrowRight');
    expect(keys.turn()).toBe(0);
    keys.up('a');
    expect(keys.turn()).toBe(1);
  });
});
