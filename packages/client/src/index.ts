/**
 * `client` — browser runtime: three.js rendering, input, client-side
 * prediction (runs `sim-core` locally), reconciliation, interpolation, HUD and
 * sound. Rendering is excluded from coverage; the prediction/reconciliation
 * logic is tested headless. Real client lands in later build tickets.
 *
 * @see spec §5.1, §4.3, §9.1
 */
export const CLIENT_PACKAGE = 'client';

/** Trivial marker exercised by the toolchain until the real client lands. */
export function clientReady(): boolean {
  return true;
}
