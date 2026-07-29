import { describe, expect, it } from 'vitest';

import { formatDuration, formatPercent, formatScore } from './format.js';

describe('formatScore (German grouping)', () => {
  it('groups thousands with a dot, like every other number on the HUD', () => {
    expect(formatScore(0)).toBe('0');
    expect(formatScore(116)).toBe('116');
    expect(formatScore(3286)).toBe('3.286');
    expect(formatScore(18187)).toBe('18.187');
    expect(formatScore(1234567)).toBe('1.234.567');
  });

  it('rounds and never prints a negative or non-finite score', () => {
    expect(formatScore(2.6)).toBe('3');
    expect(formatScore(-4)).toBe('0');
    expect(formatScore(NaN)).toBe('0');
    expect(formatScore(Infinity)).toBe('0');
  });
});

describe('formatDuration', () => {
  it('reads as minutes and seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9.4)).toBe('0:09');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(305)).toBe('5:05');
    expect(formatDuration(3600)).toBe('60:00');
  });

  it('never prints a negative or non-finite duration', () => {
    expect(formatDuration(-5)).toBe('0:00');
    expect(formatDuration(NaN)).toBe('0:00');
  });
});

describe('formatPercent', () => {
  it('prints a share the way the leaderboard and the records line both need it', () => {
    expect(formatPercent(0)).toBe('0,00 %');
    expect(formatPercent(0.09)).toBe('0,09 %');
    expect(formatPercent(35.5)).toBe('35,50 %');
    expect(formatPercent(100)).toBe('100,00 %');
  });

  it('never prints a negative or non-finite share', () => {
    expect(formatPercent(-1)).toBe('0,00 %');
    expect(formatPercent(NaN)).toBe('0,00 %');
  });
});
