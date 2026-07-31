import { NICKNAME } from '@paintclash/shared';
import { describe, expect, it } from 'vitest';

import { nicknameHint } from './nickname-hint.js';

const ZWSP = '\u200B';
const HANGUL_FILLER = '\u3164';
const NEL = '\u0085';

describe('nicknameHint', () => {
  it('says nothing about an untouched field', () => {
    expect(nicknameHint('')).toEqual({ text: null, blocked: false });
  });

  it('says nothing about a name that survives untouched', () => {
    expect(nicknameHint('Ada')).toEqual({ text: null, blocked: false });
    expect(nicknameHint('Ünal Öztürk')).toEqual({ text: null, blocked: false });
  });

  it('warns that a blocked name will be replaced — without refusing the join', () => {
    // Ticket 13: the client only pre-checks, the server enforces. The hint's
    // job is to say what is coming, not to gate the button.
    expect(nicknameHint('nazi')).toEqual({
      text: 'Dieser Name ist nicht erlaubt — du spielst als Gast.',
      blocked: true,
    });
  });

  it('announces the guest fallback when a typed name leaves nothing behind', () => {
    expect(nicknameHint(`${ZWSP}${HANGUL_FILLER}`)).toEqual({
      text: 'Leerer Name — du spielst als Gast.',
      blocked: false,
    });
  });

  it('treats a field of pure whitespace as untouched, not as a mistake', () => {
    // Mid-typing state (a leading space); nagging about it would be noise.
    expect(nicknameHint('   ')).toEqual({ text: null, blocked: false });
  });

  it('previews the name when filtering changed it', () => {
    expect(nicknameHint(`A${ZWSP}da`)).toEqual({
      text: 'Wird angezeigt als „Ada".',
      blocked: false,
    });
  });

  it('previews the truncation past the cap', () => {
    const cut = 'x'.repeat(NICKNAME.maxCodePoints);
    expect(nicknameHint('x'.repeat(NICKNAME.maxCodePoints + 3)).text).toBe(
      `Wird angezeigt als „${cut}".`,
    );
  });

  it('does not nag about whitespace tidying while a name is being typed', () => {
    // All of these sanitize to a name that differs from the raw input only in
    // whitespace. Announcing that would make the hint flicker through the
    // whole name.
    for (const raw of ['Ada ', ' Ada', 'Ada Lovelace ', 'Ada  Lovelace', `Ada${NEL}Lovelace`]) {
      expect(nicknameHint(raw)).toEqual({ text: null, blocked: false });
    }
  });

  it('reports a blocked name even when filtering also changed it', () => {
    // The warning outranks the preview: a preview would otherwise advertise the
    // very name the server is about to throw away.
    expect(nicknameHint(`n${ZWSP}azi`)).toEqual({
      text: 'Dieser Name ist nicht erlaubt — du spielst als Gast.',
      blocked: true,
    });
  });
});
