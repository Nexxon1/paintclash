import { describe, expect, it } from 'vitest';

import { LocalRecords, RECORDS_STORAGE_KEY } from './records.js';

import type { LocalStore } from './storage.js';

/** In-memory stand-in for `localStorage` (tests run headless). */
function fakeStorage(seed: Record<string, string> = {}): LocalStore & { data: typeof seed } {
  const data = { ...seed };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

/** Deterministic id source — the real one is `crypto.randomUUID`. */
function ids(...values: string[]): () => string {
  let i = 0;
  return () => values[i++] ?? 'exhausted';
}

describe('LocalRecords (spec §2.5 local records, ADR-0006 seam 4)', () => {
  it('starts empty, minted with a fresh player id, and persists it', () => {
    const storage = fakeStorage();
    const records = new LocalRecords(storage, ids('player-a'));
    expect(records.playerId).toBe('player-a');
    expect(records.records).toEqual({ highscore: 0, maxAreaPct: 0, longestSurvivalSec: 0 });
    // Persisted eagerly: the identity must survive even a session that never
    // finishes a life, or every visit would be a new "player".
    const stored: unknown = JSON.parse(storage.data[RECORDS_STORAGE_KEY] ?? 'null');
    expect(stored).toEqual({
      version: 1,
      playerId: 'player-a',
      records: { highscore: 0, maxAreaPct: 0, longestSurvivalSec: 0 },
    });
  });

  it('keeps the identity and the records across sessions', () => {
    const storage = fakeStorage();
    const first = new LocalRecords(storage, ids('player-a'));
    first.commit({ score: 1200, peakPct: 8.5, survivalSec: 42 });
    // A second visit reads the same envelope — never a second identity.
    const second = new LocalRecords(storage, ids('player-b'));
    expect(second.playerId).toBe('player-a');
    expect(second.records).toEqual({
      highscore: 1200,
      maxAreaPct: 8.5,
      longestSurvivalSec: 42,
    });
  });

  it('folds each life in, keeping the best of every record independently', () => {
    const records = new LocalRecords(fakeStorage(), ids('p'));
    records.commit({ score: 1200, peakPct: 8.5, survivalSec: 42 });
    // A worse score that nevertheless lasted longer lifts only that record.
    records.commit({ score: 900, peakPct: 3, survivalSec: 90 });
    expect(records.records).toEqual({
      highscore: 1200,
      maxAreaPct: 8.5,
      longestSurvivalSec: 90,
    });
    records.commit({ score: 5000, peakPct: 20, survivalSec: 91 });
    expect(records.records).toEqual({
      highscore: 5000,
      maxAreaPct: 20,
      longestSurvivalSec: 91,
    });
  });

  it('ignores a life with nothing to record, and repeating one changes nothing', () => {
    const records = new LocalRecords(fakeStorage(), ids('p'));
    records.commit({ score: 0, peakPct: 0, survivalSec: 0 });
    expect(records.records.highscore).toBe(0);
    // Committing the same life twice must be harmless: a disconnect right
    // after a death would otherwise double-count (see ClientSession.currentLife).
    const life = { score: 700, peakPct: 4, survivalSec: 30 };
    records.commit(life);
    records.commit(life);
    expect(records.records).toEqual({ highscore: 700, maxAreaPct: 4, longestSurvivalSec: 30 });
  });

  it('mints a fresh envelope over junk, a foreign version or missing fields', () => {
    for (const junk of [
      'not json at all',
      '42',
      'null',
      '{"version":99,"playerId":"x","records":{"highscore":9}}',
      '{"version":1,"playerId":"","records":{}}',
      '{"version":1,"playerId":"x"}',
    ]) {
      const records = new LocalRecords(
        fakeStorage({ [RECORDS_STORAGE_KEY]: junk }),
        ids('player-fresh'),
      );
      expect(records.playerId).toBe('player-fresh');
      expect(records.records).toEqual({ highscore: 0, maxAreaPct: 0, longestSurvivalSec: 0 });
    }
  });

  it('drops non-finite or negative stored numbers instead of showing them', () => {
    const records = new LocalRecords(
      fakeStorage({
        [RECORDS_STORAGE_KEY]: JSON.stringify({
          version: 1,
          playerId: 'p',
          records: { highscore: -5, maxAreaPct: 'lots', longestSurvivalSec: 12 },
        }),
      }),
      ids('unused'),
    );
    // The identity is sound, so it is kept; only the bad values reset.
    expect(records.playerId).toBe('p');
    expect(records.records).toEqual({ highscore: 0, maxAreaPct: 0, longestSurvivalSec: 12 });
  });

  it('mints a local player id and survives having no storage at all', () => {
    // The real defaults, exercised headlessly: no `localStorage` in node, so
    // the records are session-only — and the minted id is the migration
    // handle, hence the recognizable prefix rather than a bare UUID.
    const records = new LocalRecords();
    expect(records.playerId).toMatch(/^local-.+/);
    expect(records.records).toEqual({ highscore: 0, maxAreaPct: 0, longestSurvivalSec: 0 });
    records.commit({ score: 10, peakPct: 1, survivalSec: 1 });
    expect(records.records.highscore).toBe(10);
    // Two players never share an id.
    expect(new LocalRecords().playerId).not.toBe(records.playerId);
  });

  it('keeps working when storage is unavailable or throws', () => {
    // Safari private mode / disabled storage: records live for the session
    // and simply do not persist — never a broken HUD.
    const hostile: LocalStore = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const records = new LocalRecords(hostile, ids('p'));
    expect(records.playerId).toBe('p');
    records.commit({ score: 700, peakPct: 4, survivalSec: 30 });
    expect(records.records.highscore).toBe(700);
  });
});
