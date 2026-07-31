/**
 * Every invisible character under test is written as an escape on purpose:
 * pasted literally they are unreadable in review and a stray editor
 * normalisation would silently change what the test asserts.
 */
import { describe, expect, it } from 'vitest';

import {
  NICKNAME,
  checkNickname,
  isBlockedNickname,
  nicknameContentChanged,
  sanitizeNickname,
  visibleLength,
} from './nickname.js';

const ACUTE = '́'; // COMBINING ACUTE ACCENT — hangs on the preceding base
const ZWSP = '\u200B';
const ZWJ = '\u200D';
const RLO = '\u202E'; // RIGHT-TO-LEFT OVERRIDE
const HANGUL_FILLER = '\u3164'; // a LETTER by category, renders as nothing
const NBSP = '\u00A0';
const NEL = '\u0085'; // C1 NEXT LINE — a line break JS's \s does not match

describe('NICKNAME budgets', () => {
  it('lets the code-point cap imply the byte cap', () => {
    // Why `truncate` counts code points and nothing else.
    // UTF-8 spends at most 4 bytes per code point, so as long as this holds, a
    // name inside `maxCodePoints` is inside `maxUtf8Bytes` for free. Raise
    // `maxCodePoints` without raising `maxUtf8Bytes` and this fails here —
    // rather than silently handing the encoder a name it has to cut.
    expect(NICKNAME.maxCodePoints * 4).toBeLessThanOrEqual(NICKNAME.maxUtf8Bytes);
  });

  it('never lets the visible cap outrun the code points available to it', () => {
    // A visible character costs at least one code point, so a `maxVisible`
    // above `maxCodePoints` would be a cap that can never be reached.
    expect(NICKNAME.maxVisible).toBeLessThanOrEqual(NICKNAME.maxCodePoints);
  });
});

describe('visibleLength', () => {
  it('counts plain characters one by one', () => {
    expect(visibleLength('Mino')).toBe(4);
  });

  it('counts an astral character once, not as its two UTF-16 units', () => {
    expect('😀'.length).toBe(2); // the trap this rule exists for
    expect(visibleLength('😀')).toBe(1);
  });

  it('does not count combining marks — they render on the base character', () => {
    expect(visibleLength(`e${ACUTE}`)).toBe(1);
    expect(visibleLength('é')).toBe(1); // precomposed: same visible length
  });
});

describe('sanitizeNickname', () => {
  it('passes an ordinary name through untouched', () => {
    expect(sanitizeNickname('Mino')).toBe('Mino');
  });

  it('keeps non-ASCII letters — Unicode is allowed, only filtered', () => {
    expect(sanitizeNickname('Ünal Öztürk')).toBe('Ünal Öztürk');
    expect(sanitizeNickname('日本語')).toBe('日本語');
    expect(sanitizeNickname('😀🎨')).toBe('😀🎨');
  });

  it('trims the ends and collapses inner whitespace runs to one space', () => {
    expect(sanitizeNickname('  Mi   no  ')).toBe('Mi no');
  });

  it('normalises exotic spaces to a plain space, so they cannot pad a name', () => {
    expect(sanitizeNickname(`Mi${NBSP}no`)).toBe('Mi no');
    expect(sanitizeNickname('\u3000Mino\u3000')).toBe('Mino'); // IDEOGRAPHIC SPACE
    expect(sanitizeNickname('Mi\u2028no')).toBe('Mi no'); // LINE SEPARATOR
    expect(sanitizeNickname('Mi\tno')).toBe('Mi no');
  });

  it('strips control characters', () => {
    expect(sanitizeNickname('Mi\u0000no')).toBe('Mino');
    expect(sanitizeNickname('Mi\u0007no')).toBe('Mino');
    expect(sanitizeNickname('Mi\u009Bno')).toBe('Mino'); // C1 control
  });

  it('turns newlines into a separator instead of gluing the words together', () => {
    expect(sanitizeNickname('Mi\nno')).toBe('Mi no');
    expect(sanitizeNickname('Mi\r\nno')).toBe('Mi no');
  });

  it('strips zero-width and formatting characters', () => {
    expect(sanitizeNickname(`Mi${ZWSP}no`)).toBe('Mino');
    expect(sanitizeNickname('Mi\u200Cno')).toBe('Mino'); // ZWNJ
    expect(sanitizeNickname(`Mi${ZWJ}no`)).toBe('Mino');
    expect(sanitizeNickname('Mi\uFEFFno')).toBe('Mino'); // ZWNBSP / BOM
    expect(sanitizeNickname('Mi\u00ADno')).toBe('Mino'); // SOFT HYPHEN
  });

  it('keeps the emoji variation selector — without it a heart is not a heart', () => {
    // U+FE0F is a MARK, not a control: stripping it would silently downgrade
    // the emoji ❤️ to the text-presentation ❤. It rides along, uncounted,
    // like any other combining mark.
    expect(sanitizeNickname('❤️')).toBe('❤️');
    expect(visibleLength('❤️')).toBe(1);
  });

  it('strips bidi controls — the display-order spoofing vector', () => {
    expect(sanitizeNickname(`Mi${RLO}no`)).toBe('Mino');
    expect(sanitizeNickname('\u2066Mino\u2069')).toBe('Mino'); // isolates
  });

  it('strips blank-rendering characters that are not control characters', () => {
    // The classic "invisible name": U+3164 is a LETTER by category and slips
    // through every naive filter, yet renders as nothing.
    expect(sanitizeNickname(HANGUL_FILLER)).toBe('');
    expect(sanitizeNickname('\u115F\u1160')).toBe(''); // Hangul choseong/jungseong filler
    expect(sanitizeNickname('\uFFA0')).toBe(''); // halfwidth Hangul filler
    expect(sanitizeNickname('\u2800')).toBe(''); // BRAILLE PATTERN BLANK
    expect(sanitizeNickname(`Mi${HANGUL_FILLER}no`)).toBe('Mino');
  });

  it('strips private-use characters — they render as the font is told to', () => {
    expect(sanitizeNickname('Mi\uE000no')).toBe('Mino');
  });

  it('strips lone surrogates rather than emitting broken text', () => {
    expect(sanitizeNickname('Mi\ud800no')).toBe('Mino');
  });

  it('drops marks with no base character to hang on', () => {
    expect(sanitizeNickname(`${ACUTE}Mino`)).toBe('Mino');
    expect(sanitizeNickname(ACUTE)).toBe('');
    // Mid-name the base is the preceding letter, so the mark stays.
    expect(sanitizeNickname(`Min${ACUTE}o`)).toBe(`Min${ACUTE}o`);
  });

  it('yields the empty string when nothing displayable remains', () => {
    expect(sanitizeNickname('')).toBe('');
    expect(sanitizeNickname('   ')).toBe('');
    expect(sanitizeNickname(ZWSP.repeat(3))).toBe('');
    expect(sanitizeNickname(`${NBSP}${HANGUL_FILLER}`)).toBe('');
  });

  it('keeps a name of exactly the visible cap', () => {
    const name = 'x'.repeat(NICKNAME.maxVisible);
    expect(sanitizeNickname(name)).toBe(name);
  });

  it('truncates beyond the visible cap', () => {
    const long = 'x'.repeat(NICKNAME.maxVisible + 5);
    expect(visibleLength(sanitizeNickname(long))).toBe(NICKNAME.maxVisible);
  });

  it('counts the length in visible characters, not UTF-16 units', () => {
    // 16 astral emoji: 32 UTF-16 units, 16 code points, 64 UTF-8 bytes —
    // exactly at every budget, so nothing may be cut.
    const emoji = '😀'.repeat(NICKNAME.maxVisible);
    expect(sanitizeNickname(emoji)).toBe(emoji);
  });

  it('never emits a name past the wire budgets it shares with the protocol', () => {
    const encoder = new TextEncoder();
    for (const raw of ['😀'.repeat(30), 'x'.repeat(30), '日'.repeat(30), `e${ACUTE}`.repeat(30)]) {
      const name = sanitizeNickname(raw);
      expect(visibleLength(name)).toBeLessThanOrEqual(NICKNAME.maxVisible);
      expect(Array.from(name).length).toBeLessThanOrEqual(NICKNAME.maxCodePoints);
      expect(encoder.encode(name).length).toBeLessThanOrEqual(NICKNAME.maxUtf8Bytes);
    }
  });

  it('spends a code point per mark, so a decomposed name gets fewer visible characters', () => {
    // The one place the wire's 16-code-point invariant shows through as a
    // DIVERGENCE from spec §2.8's "16 visible characters" — pinned rather than
    // left to be discovered. `é` written as `e` + ◌́ costs two code points, so
    // 16 of them yield 8 visible characters, not 16. Precomposed `é` is one
    // code point and gets the full 16. Both are inside the wire; neither is
    // ever LONGER than the spec allows.
    expect(visibleLength(sanitizeNickname(`e${ACUTE}`.repeat(16)))).toBe(8);
    expect(visibleLength(sanitizeNickname('é'.repeat(16)))).toBe(16);
    // Same effect for an emoji carrying a variation selector.
    expect(visibleLength(sanitizeNickname('❤️'.repeat(16)))).toBe(8);
  });

  it('does not leave a dangling space when the cut lands on one', () => {
    const cut = `${'x'.repeat(NICKNAME.maxVisible - 1)} yy`;
    expect(sanitizeNickname(cut)).toBe('x'.repeat(NICKNAME.maxVisible - 1));
  });

  it('is idempotent — sanitizing a sanitized name changes nothing', () => {
    const raws = [
      `  Mi${ZWSP} no  `,
      '😀'.repeat(30),
      `${ACUTE}Zo${ACUTE}e`,
      `${HANGUL_FILLER}x`,
      `${'x'.repeat(NICKNAME.maxVisible - 1)} yy`,
    ];
    for (const raw of raws) {
      const once = sanitizeNickname(raw);
      expect(sanitizeNickname(once)).toBe(once);
    }
  });
});

describe('nicknameContentChanged', () => {
  it('ignores whitespace tidying — the client must not preview on every space', () => {
    for (const raw of ['Ada ', ' Ada', 'Ada  Lovelace', 'Ada\tLovelace', `Ada${NEL}Lovelace`]) {
      expect(nicknameContentChanged(raw, sanitizeNickname(raw))).toBe(false);
    }
  });

  it('uses the policy’s own idea of whitespace, not JS’s `\\s`', () => {
    // The reason this lives in `shared`. `\s` disagrees with `SEPARATORS` at
    // both edges, and gets both cases backwards.
    //
    // U+0085: the policy folds it to a space, so nothing was lost and the
    // preview should stay quiet. `\s` does not match it, so a client comparing
    // with `\s` would spot a difference and preview a name for no reason.
    expect(/\s/u.test(NEL)).toBe(false);
    expect(nicknameContentChanged(`Ada${NEL}Lovelace`, 'Ada Lovelace')).toBe(false);
    //
    // U+FEFF: the policy DELETES it, which really does change the name, so the
    // preview must fire. `\s` matches it, so a client comparing with `\s`
    // would dismiss it as tidying and stay silent about a visible change.
    expect(/\s/u.test('\uFEFF')).toBe(true);
    expect(nicknameContentChanged('Ada\uFEFFLovelace', 'AdaLovelace')).toBe(true);
  });

  it('reports content that was filtered away', () => {
    expect(nicknameContentChanged(`A${ZWSP}da`, 'Ada')).toBe(true);
    expect(nicknameContentChanged(`${HANGUL_FILLER}x`, 'x')).toBe(true);
  });

  it('reports content that was truncated away', () => {
    const long = 'x'.repeat(NICKNAME.maxCodePoints + 1);
    expect(nicknameContentChanged(long, sanitizeNickname(long))).toBe(true);
  });

  it('reports nothing for a name that passed through untouched', () => {
    expect(nicknameContentChanged('Ada', 'Ada')).toBe(false);
  });
});

describe('isBlockedNickname', () => {
  it('blocks a listed term', () => {
    expect(isBlockedNickname('nazi')).toBe(true);
  });

  it('blocks it whatever the case', () => {
    expect(isBlockedNickname('NaZi')).toBe(true);
  });

  it('blocks it inside a longer name', () => {
    expect(isBlockedNickname('xX_nazi_Xx')).toBe(true);
  });

  it('sees through separators and punctuation', () => {
    expect(isBlockedNickname('n a z i')).toBe(true);
    expect(isBlockedNickname('n.a-z_i')).toBe(true);
  });

  it('lets ordinary names through', () => {
    for (const name of ['Mino', 'Ünal', '日本語', '😀', 'Gast-0001', 'Nazareth', '']) {
      expect(isBlockedNickname(name)).toBe(false);
    }
  });

  it('accepts leetspeak evasion as the documented residual risk (spec §8.3)', () => {
    // Pinned deliberately: the blocklist is a launch-grade filter, not a
    // moderation system. If this ever starts passing, that was a decision.
    expect(isBlockedNickname('n4z1')).toBe(false);
  });
});

describe('checkNickname', () => {
  it('accepts a good name and hands back its sanitized form', () => {
    expect(checkNickname('  Mino  ')).toEqual({ ok: true, name: 'Mino' });
  });

  it('reports an empty name rather than inventing one — the caller names guests', () => {
    expect(checkNickname('')).toEqual({ ok: false, reason: 'empty' });
    expect(checkNickname('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(checkNickname(`${ZWSP}${HANGUL_FILLER}`)).toEqual({ ok: false, reason: 'empty' });
  });

  it('reports a blocked name', () => {
    expect(checkNickname('nazi')).toEqual({ ok: false, reason: 'blocked' });
  });

  it('judges the blocklist on the SANITIZED name — zero-width padding cannot hide a term', () => {
    expect(checkNickname(`n${ZWSP}a${ZWSP}z${ZWSP}i`)).toEqual({ ok: false, reason: 'blocked' });
  });

  it('judges the blocklist after truncation — what is shown is what is checked', () => {
    // The term exists only past the cut, so the displayed name is clean.
    const beyondCut = `${'x'.repeat(NICKNAME.maxVisible)}nazi`;
    expect(checkNickname(beyondCut)).toEqual({ ok: true, name: 'x'.repeat(NICKNAME.maxVisible) });
  });
});
