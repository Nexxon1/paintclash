/**
 * HUD view of the own score (spec §2.5): the live estimate beside the personal
 * record, plus the records line the join card shows. Every display decision is
 * made here — `render/hud.ts` only stamps the strings out.
 */

import { formatDuration, formatPercent, formatScore } from './format.js';

import type { PersonalRecords } from './records.js';

/** One HUD score panel. */
export interface ScoreView {
  /** The running life's score, grouped. */
  scoreText: string;
  /** The personal highscore beside it — an em dash when there is none. */
  recordText: string;
  /** The running life is beating the highscore (spec §2.5: you notice). */
  beatingRecord: boolean;
}

/** The live score panel for one frame. */
export function scoreView(liveScore: number, records: PersonalRecords): ScoreView {
  return {
    scoreText: formatScore(liveScore),
    recordText: records.highscore > 0 ? `Rekord ${formatScore(records.highscore)}` : 'Rekord —',
    beatingRecord: liveScore > records.highscore,
  };
}

/** One line with all three local records — shown on the join card. */
export function recordsText(records: PersonalRecords): string {
  if (records.highscore <= 0 && records.maxAreaPct <= 0 && records.longestSurvivalSec <= 0) {
    return 'Noch keine Rekorde — viel Erfolg!';
  }
  // Highscore · largest share · longest life — the three the spec names.
  const parts = [
    formatScore(records.highscore),
    formatPercent(records.maxAreaPct),
    formatDuration(records.longestSurvivalSec),
  ];
  return `Rekorde: ${parts.join(' · ')}`;
}
