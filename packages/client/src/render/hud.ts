/**
 * DOM HUD (spec §2.5): the live leaderboard — top rows plus the own,
 * highlighted one, each with a swatch of that player's territory color.
 * Pure data sink like the scene: it paints `LeaderboardView` and never
 * touches game logic. Excluded from unit coverage; the Playwright E2E
 * exercises it (the display rules themselves live in `game/leaderboard.ts`
 * and are unit-tested there).
 */

import { leaderboardView, type LeaderboardRowView } from '../game/leaderboard.js';

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
