/**
 * `shared` — single source of truth for balance parameters (spec §10) and
 * cross-package constants/types (incl. the 20 Hz tick). The real frozen
 * `BALANCE` object lands in ticket 11; this is only the package stub.
 *
 * @see spec §5.1, ADR-0002
 */
export const SHARED_PACKAGE = 'shared';

/** Trivial marker exercised by the toolchain until real constants land. */
export function sharedReady(): boolean {
  return true;
}
