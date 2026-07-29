/**
 * The client's `localStorage` seam. Everything the browser remembers without
 * an account — personal records (spec §2.5) and settings (spec §3) — goes
 * through here, so the "storage may be denied" rule is written once: a browser
 * in private mode must degrade to session-only state, never to a broken HUD.
 *
 * Injected in tests, which is what keeps the modules above this headless.
 */

/** The slice of the Web Storage API the client actually uses. */
export type LocalStore = Pick<Storage, 'getItem' | 'setItem'>;

/** `localStorage` where it exists — absent in node (tests) and in workers. */
export function browserStore(): LocalStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Access itself can throw when storage is blocked by policy.
    return null;
  }
}

/** Read a key, treating denied storage and absent keys alike. */
export function readStored(store: LocalStore | null, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Write a key; a full or denied store leaves the value session-only. */
export function writeStored(store: LocalStore | null, key: string, value: string): void {
  try {
    store?.setItem(key, value);
  } catch {
    // Nothing to do — the caller's in-memory state stands for this session.
  }
}
