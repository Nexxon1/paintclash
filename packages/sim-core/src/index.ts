/**
 * `sim-core` — pure, deterministic game logic (movement, trail, loop-close,
 * fill, collision, rules). No network, no rendering, no wall clock and no
 * ambient RNG. The real `step(state, inputs, dt)` reducer lands in later build
 * tickets (03+); this is only the package stub.
 *
 * @see spec §5.1, ADR-0002, ADR-0003
 */
export const SIM_CORE_PACKAGE = 'sim-core';

/** Trivial marker exercised by the toolchain until real logic lands. */
export function simCoreReady(): boolean {
  return true;
}
