import { describe, expect, it } from 'vitest';

import { recordsText, scoreView } from './score.js';
import type { PersonalRecords } from './records.js';

const NONE: PersonalRecords = { highscore: 0, maxAreaPct: 0, longestSurvivalSec: 0 };
const SOME: PersonalRecords = { highscore: 18187, maxAreaPct: 35.5, longestSurvivalSec: 305 };

describe('scoreView (spec §2.5: the live score beside the personal record)', () => {
  it('shows the running score and the stored highscore', () => {
    const view = scoreView(3286, SOME);
    expect(view.scoreText).toBe('3.286');
    expect(view.recordText).toBe('Rekord 18.187');
    expect(view.beatingRecord).toBe(false);
  });

  it('marks the moment the running life passes the highscore', () => {
    // "man merkt, ob man den Highscore knackt" — equalling it is not yet
    // beating it, one point more is.
    expect(scoreView(18187, SOME).beatingRecord).toBe(false);
    expect(scoreView(18188, SOME).beatingRecord).toBe(true);
  });

  it('has no record to beat on a first-ever run', () => {
    const view = scoreView(42, NONE);
    expect(view.scoreText).toBe('42');
    expect(view.recordText).toBe('Rekord —');
    // Any score at all is the first record: the first run must feel like one.
    expect(view.beatingRecord).toBe(true);
    expect(scoreView(0, NONE).beatingRecord).toBe(false);
  });
});

describe('recordsText (the records line on the join card)', () => {
  it('summarises all three records in one line, each with its unit', () => {
    // Bare numbers side by side would not say which is which — the score
    // panel's own big number is labelled by its heading instead.
    expect(recordsText(SOME)).toBe('Rekorde: 18.187 Punkte · 35,50 % der Karte · 5:05 min');
  });

  it('says so plainly when there is nothing yet', () => {
    expect(recordsText(NONE)).toBe('Noch keine Rekorde — viel Erfolg!');
  });
});
