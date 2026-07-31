/**
 * The lobby card (spec §2.6, ticket 14): the room code and the link to share,
 * who is waiting, the host's four settings and the start button. A pure data
 * sink like the rest of the HUD — it paints what the session received and asks
 * `main.ts` to send what the host changed. Excluded from unit coverage; the
 * display rules themselves live in `game/room.ts` and are tested there, and the
 * Playwright E2E drives this card in a real browser.
 */

import { BALANCE, defaultRoomConfig, type RoomConfig } from '@paintclash/shared';

import {
  mapSizeAfterLimitChange,
  roomFormConfig,
  typedNumber,
  type LobbyViewModel,
} from '../game/room.js';

/** What the card reports upward — the two things a host can do. */
export interface RoomHudHandlers {
  onSettings: (config: RoomConfig) => void;
  onStart: () => void;
  onLeave: () => void;
}

/** One labelled number input, the shape all three settings share. */
function numberField(
  label: string,
  attrs: { min: number; max: number; step?: number },
): { row: HTMLLabelElement; input: HTMLInputElement } {
  const row = document.createElement('label');
  row.className = 'room-field';
  const text = document.createElement('span');
  text.textContent = label;
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(attrs.min);
  input.max = String(attrs.max);
  input.step = String(attrs.step ?? 1);
  row.append(text, input);
  return { row, input };
}

export class RoomHud {
  private readonly root: HTMLElement;
  private readonly codeText: HTMLElement;
  private readonly linkInput: HTMLInputElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly countText: HTMLElement;
  private readonly list: HTMLUListElement;
  private readonly players: HTMLInputElement;
  private readonly mapSize: HTMLInputElement;
  private readonly bots: HTMLInputElement;
  private readonly lateJoin: HTMLInputElement;
  private readonly startButton: HTMLButtonElement;
  private readonly hint: HTMLElement;
  /** Revision on screen — the card only rebuilds when the lobby changed. */
  private paintedRev = -1;
  /** Last painted config, so a host's own edit is not fought by the echo. */
  private config: RoomConfig | null = null;

  constructor(root: HTMLElement, handlers: RoomHudHandlers) {
    this.root = root;
    const title = document.createElement('h2');
    title.textContent = 'Privater Raum';

    this.codeText = document.createElement('p');
    this.codeText.className = 'room-code';

    this.linkInput = document.createElement('input');
    this.linkInput.className = 'room-link';
    this.linkInput.readOnly = true;
    this.copyButton = document.createElement('button');
    this.copyButton.type = 'button';
    this.copyButton.className = 'room-copy';
    this.copyButton.textContent = 'Link kopieren';
    this.copyButton.addEventListener('click', () => {
      // `select()` + the clipboard write: the selection is the fallback that
      // still works where the Clipboard API is refused (insecure origin, a
      // denied permission) — the link is then one Ctrl+C away instead of lost.
      this.linkInput.select();
      try {
        void navigator.clipboard.writeText(this.linkInput.value).catch(() => {
          /* denied permission — the selection stands */
        });
      } catch {
        // No Clipboard API at all (an insecure origin): the selection above is
        // the fallback, so the link is one Ctrl+C away rather than lost.
      }
      this.copyButton.textContent = 'Kopiert';
    });
    const share = document.createElement('div');
    share.className = 'room-share';
    share.append(this.linkInput, this.copyButton);

    this.countText = document.createElement('p');
    this.countText.className = 'room-count';
    this.list = document.createElement('ul');
    this.list.className = 'room-members';

    const players = numberField('Spieler', {
      min: BALANCE.room.playerLimitMin,
      max: BALANCE.room.playerLimitMax,
    });
    this.players = players.input;
    const mapSize = numberField('Karte (WU)', {
      min: BALANCE.room.mapSizeMinWU,
      max: BALANCE.room.mapSizeMaxWU,
      step: 10,
    });
    this.mapSize = mapSize.input;
    const bots = numberField('Bots', { min: 0, max: BALANCE.room.playerLimitMax });
    this.bots = bots.input;

    const lateJoinRow = document.createElement('label');
    lateJoinRow.className = 'room-field room-toggle';
    this.lateJoin = document.createElement('input');
    this.lateJoin.type = 'checkbox';
    const lateJoinText = document.createElement('span');
    lateJoinText.textContent = 'Nachträglicher Beitritt';
    lateJoinRow.append(lateJoinText, this.lateJoin);

    const settings = document.createElement('div');
    settings.className = 'room-settings';
    settings.append(players.row, mapSize.row, bots.row, lateJoinRow);

    // The player limit drags the map size along while the size is still the
    // ladder's (spec §10.4) — see `mapSizeAfterLimitChange`.
    this.players.addEventListener('change', () => {
      const current = this.config ?? defaultRoomConfig();
      const next = typedNumber(this.players.value, current.playerLimit);
      if (Number.isFinite(next)) {
        this.mapSize.value = String(
          mapSizeAfterLimitChange(
            typedNumber(this.mapSize.value, current.mapSizeWU),
            current.playerLimit,
            next,
          ),
        );
      }
      handlers.onSettings(this.formConfig());
    });
    // `change`, not `input`: each committed edit is one row-write in the room's
    // storage (ADR-0004 — "selten geschrieben"), so a dragged spinner must not
    // become one write per pixel.
    for (const input of [this.mapSize, this.bots, this.lateJoin]) {
      input.addEventListener('change', () => {
        handlers.onSettings(this.formConfig());
      });
    }

    this.startButton = document.createElement('button');
    this.startButton.type = 'button';
    this.startButton.className = 'room-start';
    this.startButton.textContent = 'Spiel starten';
    this.startButton.addEventListener('click', () => {
      handlers.onStart();
    });
    const leave = document.createElement('button');
    leave.type = 'button';
    leave.className = 'room-leave';
    leave.textContent = 'Verlassen';
    leave.addEventListener('click', () => {
      handlers.onLeave();
    });
    const actions = document.createElement('div');
    actions.className = 'room-actions';
    actions.append(this.startButton, leave);

    this.hint = document.createElement('p');
    this.hint.className = 'room-hint';

    root.append(
      title,
      this.codeText,
      share,
      this.countText,
      this.list,
      settings,
      actions,
      this.hint,
    );
    root.hidden = true;
  }

  /** Show this lobby, or hide the card when there is none. */
  update(view: LobbyViewModel | null, rev: number): void {
    if (!view) {
      this.root.hidden = true;
      this.paintedRev = -1;
      return;
    }
    this.root.hidden = false;
    if (rev === this.paintedRev) return;
    this.paintedRev = rev;
    this.config = view.config;
    this.codeText.textContent = view.code;
    this.linkInput.value = view.link;
    this.countText.textContent = `${view.countText} Spieler`;
    this.list.replaceChildren(
      ...view.members.map((member) => {
        const item = document.createElement('li');
        item.className = member.isSelf ? 'member self' : 'member';
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = member.color;
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = member.label;
        item.append(swatch, name);
        if (member.isHost) {
          const badge = document.createElement('span');
          badge.className = 'host';
          badge.textContent = 'Host';
          item.append(badge);
        }
        return item;
      }),
    );
    // The settings show the room's truth for everyone; only the host may move
    // them (the server enforces that anyway — this is so the card does not
    // promise a control that does nothing).
    this.players.value = String(view.config.playerLimit);
    this.mapSize.value = String(view.config.mapSizeWU);
    // The ceiling is the ROOM's limit, not the highest limit a room may have
    // (spec §10.4: the clamp rule fills "bis zum Raumlimit") — a 12 typed into a
    // four-seat room would otherwise be silently answered with a 4.
    this.bots.max = String(view.config.playerLimit);
    this.bots.value = String(view.config.botTarget);
    this.lateJoin.checked = view.config.lateJoin;
    for (const input of [this.players, this.mapSize, this.bots, this.lateJoin]) {
      input.disabled = !view.isHost;
    }
    this.startButton.hidden = !view.isHost;
    this.hint.textContent = view.isHost
      ? 'Teile den Link — starte, sobald alle da sind.'
      : 'Warten auf den Host …';
  }

  /** The form as a legal config — the rule itself lives in `game/room.ts`. */
  private formConfig(): RoomConfig {
    return roomFormConfig(
      {
        playerLimit: this.players.value,
        mapSizeWU: this.mapSize.value,
        botTarget: this.bots.value,
        lateJoin: this.lateJoin.checked,
      },
      this.config ?? defaultRoomConfig(),
    );
  }
}
