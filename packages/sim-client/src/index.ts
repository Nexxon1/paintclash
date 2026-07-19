/**
 * `sim-client` — headless test client that drives `sim-core` and speaks the
 * real binary protocol without rendering. Several sim-clients drive a real
 * server over the wire in scenario tests (spec §9.1). Real client lands later.
 *
 * @see spec §5.1, §9.1, CONTEXT.md
 */
export const SIM_CLIENT_PACKAGE = 'sim-client';

/** Trivial marker exercised by the toolchain until the real client lands. */
export function simClientReady(): boolean {
  return true;
}
