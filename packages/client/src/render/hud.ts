/**
 * DOM HUD (spec §2.5): the live leaderboard — top rows plus the own,
 * highlighted one, each with a swatch of that player's territory color — and
 * the own score panel beside the personal record. Pure data sinks like the
 * scene: they paint what the session sampled and never touch game logic.
 * Excluded from unit coverage; the Playwright E2E exercises them (the display
 * rules themselves live in `game/leaderboard.ts` / `game/score.ts` and are
 * unit-tested there).
 */

import { leaderboardView, type LeaderboardRowView } from '../game/leaderboard.js';
import { scoreView } from '../game/score.js';

import type { PersonalRecords } from '../game/records.js';
import type { LeaderboardView } from '../game/session.js';

export class LeaderboardHud {
  private readonly root: HTMLElement;
  private readonly list: HTMLOListElement;
  /** Board revision currently painted — the DOM only rebuilds on change. */
  private paintedRev = -1;
  /** Own id the rows were painted for (it arrives after the first board). */
  private paintedSelfId: number | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.list = document.createElement('ol');
    this.list.className = 'leaderboard-rows';
    this.root.append(this.list);
  }

  /** Repaint if this board (or the own id) differs from what is on screen. */
  update(board: LeaderboardView, selfId: number | null): void {
    if (board.rev === this.paintedRev && selfId === this.paintedSelfId) return;
    this.paintedRev = board.rev;
    this.paintedSelfId = selfId;
    const rows = leaderboardView(board.rows, selfId);
    this.root.hidden = rows.length === 0;
    this.list.replaceChildren(...rows.map((row) => this.buildRow(row)));
  }

  private buildRow(row: LeaderboardRowView): HTMLLIElement {
    const item = document.createElement('li');
    item.className = row.isSelf ? 'row self' : 'row';
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = String(row.rank);
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = row.color;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = row.label;
    const percent = document.createElement('span');
    percent.className = 'percent';
    percent.textContent = row.percentText;
    item.append(rank, swatch, name, percent);
    return item;
  }
}

/**
 * The own score panel (spec §2.5): the running life's estimate above the
 * personal record, highlighted while the record is being beaten. Hidden until
 * the first score frame arrives — before the spawn there is no life to score.
 */
export class ScoreHud {
  private readonly root: HTMLElement;
  private readonly value: HTMLElement;
  private readonly record: HTMLElement;
  /** What is on screen — the DOM is only touched when the text changes. */
  private painted = '';

  constructor(root: HTMLElement) {
    this.root = root;
    this.value = document.createElement('span');
    this.value.className = 'score-value';
    this.record = document.createElement('span');
    this.record.className = 'score-record';
    this.root.append(this.value, this.record);
  }

  update(liveScore: number | null, records: PersonalRecords): void {
    if (liveScore === null) {
      this.root.hidden = true;
      return;
    }
    const view = scoreView(liveScore, records);
    // Unhide BEFORE the repaint gate: a life that ends and respawns can read
    // the same score again (both lives short), and gating visibility on
    // changed text would leave the panel hidden for that whole life.
    this.root.hidden = false;
    // One key over everything shown: the panel repaints on a real change, not
    // on every one of the ~60 frames per second.
    const key = `${view.scoreText}|${view.recordText}|${String(view.beatingRecord)}`;
    if (key === this.painted) return;
    this.painted = key;
    this.root.classList.toggle('record', view.beatingRecord);
    this.value.textContent = view.scoreText;
    this.record.textContent = view.recordText;
  }
}
