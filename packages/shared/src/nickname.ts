/**
 * Nickname policy (spec §2.8, §8.3 point 5, ticket 13) — 1–16 **visible**
 * characters, Unicode allowed but filtered, plus a static blocklist.
 *
 * Lives in `shared` because client and server must reach the **same verdict**
 * on the same string: the server enforces (spec §8.3 — a manipulated client
 * gets no say), the client only pre-checks so a player learns of a rejection
 * in the join card instead of silently ending up as a guest. Two
 * implementations of one rule would drift, and every drift is a UX lie.
 *
 * A nickname is cosmetic and non-unique. It is **never** an authorization key
 * — all player data hangs off `playerId` (spec §2.8), so impersonation is
 * consequence-free by construction and this module can stay a display filter.
 *
 * ## Why not `Intl.Segmenter`
 *
 * "Visible characters" is really about grapheme clusters, and `Intl.Segmenter`
 * segments them properly. It is deliberately not used: its rules follow the
 * host's ICU version, so a browser and workerd can disagree about the length
 * of the same name — exactly the client/server drift this module exists to
 * prevent. Instead the rule is spelled out and identical everywhere: a visible
 * character is a code point that is not a combining mark. That undercounts
 * nothing that matters — a flag (two regional indicators) counts as two — and
 * the code-point cap below binds first for anything astral anyway.
 */

import { NICKNAME_BLOCKLIST } from './nickname-blocklist.js';

/**
 * The three budgets a display name must fit. `maxVisible` is the rule spec
 * §2.8 states; the other two are the wire's hard capacities (`protocol`
 * imports them, so the name policy and the frame format cannot drift apart).
 * A sanitized name is inside all three, so the encoder never has to cut one
 * itself — and never mangles a character doing it.
 *
 * `maxCodePoints` is the strictest of the three and the only one `truncate`
 * counts, because the other two follow from it: UTF-8 spends at most 4 bytes
 * per code point (16 × 4 = 64), and a visible character costs at least one
 * code point. `nickname.test.ts` pins both implications, so widening one cap
 * without the others fails loudly there instead of quietly handing the encoder
 * a name it has to cut.
 *
 * `maxCodePoints` is wire-fixed: `protocol`'s decoders reject a name above it,
 * on both the join and the leaderboard, so raising it is a breaking protocol
 * change (`PROTOCOL_VERSION`) and not a nickname-policy decision.
 */
export const NICKNAME = Object.freeze({
  /** Visible characters, per spec §2.8. */
  maxVisible: 16,
  /** Code points — what the wire's decoder re-checks. */
  maxCodePoints: 16,
  /** UTF-8 bytes — what the wire's length byte actually counts. */
  maxUtf8Bytes: 64,
});

/**
 * The verdict on a raw name. `empty` is not an error: it is the spec's
 * "leerer Name → Auto-Gastname" path, and the caller owns the guest name
 * (only the server knows the player id it is numbered by).
 */
export type NicknameVerdict =
  { ok: true; name: string } | { ok: false; reason: 'empty' | 'blocked' };

/**
 * Every separator becomes one plain space, so no exotic space can pad a name
 * into looking empty — and so a newline separates words instead of gluing
 * them. `\p{Z}` covers Zs/Zl/Zp; the ASCII breaks and the C1 NEL (U+0085) are
 * *controls*, so listing them here is what preserves the gap — `INVISIBLE`
 * below would otherwise delete them and glue the words together.
 */
const SEPARATORS = /[\p{Z}\t\n\r\f\v\u0085]/gu;

/**
 * Controls (Cc), formats (Cf — every zero-width joiner, bidi override and tag
 * character), lone surrogates (Cs) and private use (Co, which renders as
 * whatever a font is told to). None of it belongs in a display name; stripping
 * Cf also means an emoji ZWJ sequence degrades into its component emoji rather
 * than smuggling in bidi controls.
 *
 * Spelled out rather than written `\p{C}`, which would also pull in
 * **unassigned** (Cn) — and Cn is the one part of category C that *moves*: every
 * Unicode release assigns some of it. A browser one release ahead of workerd
 * would then strip a character the server keeps, and the client's preview would
 * stop matching the server's verdict — the very drift this module rejects
 * `Intl.Segmenter` over. These four are stable, so both ends always agree. An
 * unassigned code point survives as a `.notdef` box, bounded like everything
 * else by the code-point cap.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/gu;

/**
 * Characters that render as **nothing** yet sit outside category C, so no
 * category-based filter catches them — the classic "invisible nickname". Note
 * U+3164 and the Hangul fillers are `\p{L}`: letters, by Unicode's reckoning.
 */
const BLANK_GLYPHS = /[\u115F\u1160\u3164\uFFA0\u2800]/gu;

/**
 * Combining marks at the start of the name or right after a space have no
 * base character to hang on and render as debris on the gap. `$1` keeps the
 * separator; the collapse pass afterwards tidies up.
 */
const ORPHAN_MARKS = /(^| )\p{M}+/gu;

const RUNS_OF_SPACE = / {2,}/g;

/** Non-global: `.test()` on a global regex is stateful via `lastIndex`. */
const COMBINING_MARK = /\p{M}/u;

/** Everything the blocklist fold discards — see `nickname-blocklist.ts`. */
const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]/gu;

/**
 * Visible characters in `name` — code points that are not combining marks.
 * The length spec §2.8 counts ("Länge nach sichtbaren Zeichen"), and the one
 * a player counts by eye.
 *
 * Exported from this module but deliberately NOT from the package barrel: no
 * caller outside the policy needs it (`truncate` enforces the stricter
 * code-point cap). It exists because it is the *definition* of the unit
 * `NICKNAME.maxVisible` is stated in, and the tests hold the implementation to
 * it — including where the two caps disagree. A rule nobody can measure is a
 * rule nobody can check.
 */
export function visibleLength(name: string): number {
  let visible = 0;
  // for…of iterates code points, so an astral character counts once rather
  // than as its two UTF-16 units (`'😀'.length === 2`).
  for (const cp of name) {
    if (!COMBINING_MARK.test(cp)) visible += 1;
  }
  return visible;
}

/**
 * The name as it will be displayed: filtered, whitespace-normalised and cut
 * to every budget in `NICKNAME`. Returns `''` when nothing displayable is
 * left — the caller decides what an empty name becomes.
 *
 * Idempotent by construction: sanitizing a sanitized name is a no-op, which
 * is what lets the client pre-check show the exact string the server will
 * later derive from the same input.
 */
export function sanitizeNickname(raw: string): string {
  const filtered = raw
    .replace(SEPARATORS, ' ')
    .replace(INVISIBLE, '')
    .replace(BLANK_GLYPHS, '')
    .replace(ORPHAN_MARKS, '$1')
    .replace(RUNS_OF_SPACE, ' ')
    .trim();
  // A cut can land on the space between two words; nothing else can leave
  // trailing whitespace at this point.
  return truncate(filtered).trimEnd();
}

/**
 * Longest prefix of `name` inside the budgets, always cut *between* code
 * points — never through a character.
 *
 * Only `maxCodePoints` is counted, because it is the **strictest** of the
 * three and the other two follow from it (see `NICKNAME`): 16 code points are
 * at most 64 UTF-8 bytes, and at most 16 visible characters since a visible
 * character costs at least one code point. Checking any of them separately
 * would add a branch that cannot be taken. `nickname.test.ts` pins both
 * implications, so a future widening of one cap surfaces there rather than as
 * a silently over-long name.
 *
 * The one consequence worth knowing: a name written with combining marks
 * (`e` + ◌́ rather than `é`) spends two code points per visible character, so
 * it gets fewer than 16 visible characters. That is the wire's 16-code-point
 * invariant showing through, and it errs toward *shorter* than spec §2.8
 * promises — never longer.
 */
function truncate(name: string): string {
  let kept = '';
  let codePoints = 0;
  for (const cp of name) {
    if (codePoints + 1 > NICKNAME.maxCodePoints) break;
    kept += cp;
    codePoints += 1;
  }
  return kept;
}

/**
 * Does `name` hit the static blocklist? Matched against a fold to lowercase
 * letters and digits, so `n.a-z_i` cannot walk past an entry that `nazi`
 * trips. Leetspeak and homoglyph evasion stay out of scope by decision
 * (spec §8.3/§8.4).
 *
 * Call it on a **sanitized** name: that is the string players actually see,
 * and it is what `checkNickname` judges.
 */
export function isBlockedNickname(name: string): boolean {
  const folded = name.toLowerCase().replace(NOT_LETTER_OR_DIGIT, '');
  if (folded.length === 0) return false;
  return NICKNAME_BLOCKLIST.some((term) => folded.includes(term));
}

/** Every separator gone — `\p{Z}` includes the plain space, so all of it. */
function withoutSeparators(text: string): string {
  return text.replace(SEPARATORS, '');
}

/**
 * Did sanitizing change anything a player would notice? Only *content* counts:
 * whitespace tidying — a trailing space, a doubled space between two words —
 * does not, or the client's live preview would fire on half the keystrokes of
 * a two-word name.
 *
 * Lives here rather than in the client because "which characters are mere
 * whitespace" is a policy fact, and `SEPARATORS` is the policy's own answer to
 * it. The client asking JS's `\s` instead would disagree on the edges (it
 * misses U+0085, counts U+FEFF) and preview names the server never produces.
 */
export function nicknameContentChanged(raw: string, sanitized: string): boolean {
  return withoutSeparators(raw) !== withoutSeparators(sanitized);
}

/**
 * The whole policy in one call: sanitize, then judge. Both sides run exactly
 * this — the server to decide what it stores, the client to decide what to
 * tell the player before they press join.
 */
export function checkNickname(raw: string): NicknameVerdict {
  const name = sanitizeNickname(raw);
  if (name.length === 0) return { ok: false, reason: 'empty' };
  if (isBlockedNickname(name)) return { ok: false, reason: 'blocked' };
  return { ok: true, name };
}
