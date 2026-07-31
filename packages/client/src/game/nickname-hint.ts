/**
 * The join card's nickname pre-check (spec §2.8, ticket 13). Pure text
 * derivation, so the German wording is unit-testable and `main.ts` stays a
 * DOM sink.
 *
 * **UX only, and it decides nothing.** Ticket 13: "Client nur UX-Vorprüfung,
 * **Server erzwingt**". The verdict comes from `shared`'s `checkNickname` — the
 * very function the server enforces with — and a refused name does not block
 * the join: the player joins and the server hands out `Gast-####`, exactly as
 * it would for a client that never ran this. All this module buys is that the
 * substitution is *announced* beforehand rather than discovered on the
 * leaderboard.
 *
 * The hard part is silence: a hint that fires on every keystroke is noise, so
 * whitespace tidying says nothing (see `nicknameContentChanged`). Only a name
 * that loses content, or is going to be replaced, is worth a line.
 */

import { checkNickname, nicknameContentChanged } from '@paintclash/shared';

export interface NicknameHint {
  /** Line for the join card, or `null` when there is nothing worth saying. */
  text: string | null;
  /**
   * The name is going to be replaced by a guest name. Drives the card's
   * emphasis only — never whether the game starts (the server decides that,
   * and it starts either way).
   */
  blocked: boolean;
}

const SILENT: NicknameHint = { text: null, blocked: false };

export function nicknameHint(raw: string): NicknameHint {
  // An empty (or mid-typing whitespace) field is the normal case — the player
  // simply gets a guest name, and nagging about it before they typed anything
  // would be the loudest line on the card.
  if (raw.trim().length === 0) return SILENT;
  const verdict = checkNickname(raw);
  if (!verdict.ok) {
    return verdict.reason === 'blocked'
      ? { text: 'Dieser Name ist nicht erlaubt — du spielst als Gast.', blocked: true }
      : // Typed something, and nothing displayable survived it: worth saying,
        // because the player is about to be given a name they did not choose.
        { text: 'Leerer Name — du spielst als Gast.', blocked: false };
  }
  return nicknameContentChanged(raw, verdict.name)
    ? { text: `Wird angezeigt als „${verdict.name}".`, blocked: false }
    : SILENT;
}
