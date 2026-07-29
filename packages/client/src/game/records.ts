/**
 * Local personal records (spec §2.5, CONTEXT: Rekord) — max share, longest
 * life, highscore. No account exists, so they live in `localStorage`.
 *
 * MIGRATABLE BY CONSTRUCTION (ADR-0006 seam 4): the stored envelope is
 * `{ version, playerId, records }` — plain JSON, versioned, and hung off a
 * player id rather than off the browser. Today that id is a locally minted
 * one (the server's per-connection id is recycled and would re-key the
 * records on every visit); when the auth layer lands, the upgrade is to read
 * this envelope, re-key `playerId` to the account id and upload `records`
 * verbatim — no shape change, no lost history.
 *
 * Storage is injected so this is unit-testable headlessly, and every access
 * is guarded: a browser that denies storage (private mode) must degrade to
 * session-only records, never to a broken HUD.
 */

/** The one localStorage key — the version lives inside the envelope. */
export const RECORDS_STORAGE_KEY = 'paintclash.player.v1';

const STORAGE_VERSION = 1;

/** What the game remembers about one player, without an account. */
export interface PersonalRecords {
  /** Best score ever reached (spec §10.5 formula). */
  highscore: number;
  /** Largest share of the map ever held, in percent. */
  maxAreaPct: number;
  /** Longest single life, in seconds. */
  longestSurvivalSec: number;
}

/** One finished life, as the score is made of it. */
export interface FinishedLife {
  score: number;
  peakPct: number;
  survivalSec: number;
}

/** The slice of the Web Storage API this needs (injected in tests). */
export type RecordStorage = Pick<Storage, 'getItem' | 'setItem'>;

interface Envelope {
  version: number;
  playerId: string;
  records: PersonalRecords;
}

/**
 * The envelope as it comes BACK out of storage: same shape, every field
 * `unknown`. Another tab, an older build or a poke in devtools can put
 * anything here, so nothing is believed before it is checked.
 */
interface Stored {
  version?: unknown;
  playerId?: unknown;
  records?: unknown;
}

interface StoredRecords {
  highscore?: unknown;
  maxAreaPct?: unknown;
  longestSurvivalSec?: unknown;
}

const EMPTY: PersonalRecords = { highscore: 0, maxAreaPct: 0, longestSurvivalSec: 0 };

/** A stored number is only believed if it is finite and non-negative. */
function sane(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** `localStorage` where it exists — absent in node (tests) and in workers. */
function browserStorage(): RecordStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Access itself can throw when storage is blocked by policy.
    return null;
  }
}

function randomPlayerId(): string {
  try {
    return `local-${crypto.randomUUID()}`;
  } catch {
    // No crypto (ancient/locked-down browser): a good-enough local handle.
    return `local-${Math.random().toString(36).slice(2)}${String(Date.now())}`;
  }
}

export class LocalRecords {
  private readonly storage: RecordStorage | null;
  private envelope: Envelope;

  constructor(storage: RecordStorage | null = browserStorage(), newPlayerId = randomPlayerId) {
    this.storage = storage;
    this.envelope = this.load() ?? {
      version: STORAGE_VERSION,
      playerId: newPlayerId(),
      records: { ...EMPTY },
    };
    // Persist right away: an identity minted but never written would make
    // every visit a different player and every record the first one.
    this.save();
  }

  /** The id the records hang off — the account-migration handle. */
  get playerId(): string {
    return this.envelope.playerId;
  }

  get records(): PersonalRecords {
    return this.envelope.records;
  }

  /**
   * Fold one finished life into the records, keeping the best of each
   * independently — a short-but-huge life and a long-but-poor one both leave
   * their mark. Idempotent for a life that beats nothing, so committing the
   * same life twice cannot corrupt anything.
   */
  commit(life: FinishedLife): void {
    const current = this.envelope.records;
    this.envelope.records = {
      highscore: Math.max(current.highscore, sane(life.score)),
      maxAreaPct: Math.max(current.maxAreaPct, sane(life.peakPct)),
      longestSurvivalSec: Math.max(current.longestSurvivalSec, sane(life.survivalSec)),
    };
    this.save();
  }

  /** Read the envelope, or null when there is nothing trustworthy stored. */
  private load(): Envelope | null {
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(RECORDS_STORAGE_KEY) ?? null;
    } catch {
      return null; // storage denied — session-only records
    }
    if (raw === null) return null;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null; // corrupted — mint a fresh envelope over it
    }
    // Everything read back is untrusted (another tab, an older build, a user
    // poking at devtools): validate field by field rather than trusting a cast.
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { version, playerId, records } = parsed as Stored;
    // A foreign version is for a future migration to read, not for this one
    // to guess at; without a usable id the records could not be migrated.
    if (version !== STORAGE_VERSION) return null;
    if (typeof playerId !== 'string' || playerId === '') return null;
    if (typeof records !== 'object' || records === null) return null;
    const { highscore, maxAreaPct, longestSurvivalSec } = records as StoredRecords;
    return {
      version: STORAGE_VERSION,
      playerId,
      records: {
        highscore: sane(highscore),
        maxAreaPct: sane(maxAreaPct),
        longestSurvivalSec: sane(longestSurvivalSec),
      },
    };
  }

  private save(): void {
    try {
      this.storage?.setItem(RECORDS_STORAGE_KEY, JSON.stringify(this.envelope));
    } catch {
      // Full or denied storage: the records still hold for this session.
    }
  }
}
