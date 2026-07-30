/**
 * DOM HUD (spec §2.5/§3): the live leaderboard — top rows plus the own,
 * highlighted one, each with a swatch of that player's territory color — the
 * own score panel beside the personal record, the control-mode picker, the mute
 * toggle (spec §4.4) and the virtual joystick. Pure data sinks like the scene:
 * they paint what the session sampled and never touch game logic. Excluded from
 * unit coverage; the Playwright E2E exercises them (the display rules
 * themselves live in `game/leaderboard.ts`, `game/score.ts` and
 * `game/settings.ts` and are unit-tested there).
 */

import { leaderboardView, type LeaderboardRowView } from '../game/leaderboard.js';
import { scoreView } from '../game/score.js';
import { controlModeLabel } from '../game/settings.js';

import type { JoystickView } from '../game/input.js';
import type { PersonalRecords } from '../game/records.js';
import type { ControlMode } from '../game/settings.js';
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

/**
 * The control-mode picker (spec §3): a disclosure button plus one chip per mode
 * this device offers, the active one marked.
 *
 * Collapsed by default and parked at the top edge, because the panel shares the
 * screen with the steering itself: an always-open row in a bottom corner is
 * exactly where a thumb rests in "Lenken L/R" and where a joystick wants to be
 * planted — a resting thumb would switch mode instead of steering. It stays
 * reachable while the join card is up (the mode is a pre-game choice too) and
 * mid-game (spec §3: switchable at runtime).
 */
export class ControlsHud {
  private readonly toggle: HTMLButtonElement;
  private readonly list: HTMLDivElement;
  private readonly chips = new Map<ControlMode, HTMLButtonElement>();

  constructor(
    root: HTMLElement,
    modes: readonly ControlMode[],
    coarsePointer: boolean,
    onPick: (mode: ControlMode) => void,
  ) {
    this.toggle = document.createElement('button');
    this.toggle.type = 'button';
    this.toggle.className = 'control-toggle';
    this.toggle.textContent = 'Steuerung';
    this.toggle.addEventListener('click', () => {
      this.open(this.list.hidden);
      this.toggle.blur();
    });
    this.list = document.createElement('div');
    this.list.className = 'control-modes';
    this.list.hidden = true;
    for (const mode of modes) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'mode';
      chip.dataset.mode = mode;
      chip.textContent = controlModeLabel(mode, coarsePointer);
      chip.addEventListener('click', () => {
        onPick(mode);
        // Picked = done: an open list over the arena is one more thing between
        // the player and their thumb.
        this.open(false);
        // Leaving focus behind would let a later Space/Enter — or the game's
        // own keys — re-fire this button instead of steering.
        chip.blur();
      });
      this.chips.set(mode, chip);
      this.list.append(chip);
    }
    root.append(this.toggle, this.list);
  }

  /** Mark the mode in force. */
  update(mode: ControlMode): void {
    for (const [candidate, chip] of this.chips) {
      const active = candidate === mode;
      chip.classList.toggle('active', active);
      chip.setAttribute('aria-pressed', String(active));
    }
  }

  private open(open: boolean): void {
    this.list.hidden = !open;
    this.toggle.setAttribute('aria-expanded', String(open));
  }
}

/**
 * The mute toggle (spec §4.4: sound is ON, the toggle is binary and persisted).
 *
 * Shares the top bar with the control picker — same pill, one grid cell over —
 * for the same reason that panel sits there: the bottom corners belong to the
 * steering thumb, and a resting thumb must not mute the game. It is reachable
 * on the join card too, so a player who wants silence can have it before the
 * first sound ever plays.
 *
 * The button owns what it shows; `main.ts` owns what the toggle MEANS (persist
 * the setting, tell the engine).
 */
export class SoundHud {
  private readonly button: HTMLButtonElement;
  private muted: boolean;

  constructor(root: HTMLElement, muted: boolean, onToggle: (muted: boolean) => void) {
    this.muted = muted;
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'sound-toggle';
    this.button.addEventListener('click', () => {
      this.update(!this.muted);
      onToggle(this.muted);
      // Same reason as the mode chips: a focused button would answer the next
      // Space/Enter — or a steering key — instead of the game.
      this.button.blur();
    });
    root.append(this.button);
    this.update(muted);
  }

  /** Paint the state the sound is actually in. */
  update(muted: boolean): void {
    this.muted = muted;
    // The glyph says what IS (muted = crossed-out speaker), the label says
    // what a click would DO — a lone icon is ambiguous to a screen reader.
    this.button.textContent = muted ? '🔇' : '🔊';
    this.button.setAttribute('aria-label', muted ? 'Ton einschalten' : 'Ton ausschalten');
    this.button.setAttribute('aria-pressed', String(muted));
    this.button.title = muted ? 'Ton aus' : 'Ton an';
  }
}

/**
 * The virtual joystick (spec §3): ring plus knob, wherever the finger holds
 * it. Purely a mirror of the input state — it never produces intent itself.
 */
export class JoystickHud {
  private readonly root: HTMLElement;
  private readonly knob: HTMLElement;
  /** What is on screen — the DOM only moves when the stick does. */
  private painted = '';

  constructor(root: HTMLElement) {
    this.root = root;
    this.knob = document.createElement('span');
    this.knob.className = 'knob';
    this.root.append(this.knob);
  }

  update(view: JoystickView | null): void {
    const key = view
      ? `${String(view.baseX)},${String(view.baseY)},${String(view.knobX)},${String(view.knobY)}`
      : '';
    if (key === this.painted) return;
    this.painted = key;
    this.root.hidden = view === null;
    if (!view) return;
    this.root.style.transform = `translate(${String(view.baseX)}px, ${String(view.baseY)}px)`;
    this.knob.style.transform = `translate(${String(view.knobX - view.baseX)}px, ${String(view.knobY - view.baseY)}px)`;
  }
}
