/**
 * `sim-client` — headless test client that drives `sim-core` and speaks the
 * real binary protocol without rendering. Several sim-clients drive a real
 * server over the wire in scenario tests (spec §9.1).
 *
 * @see spec §5.1, §9.1, CONTEXT.md
 */
export { SimClient, type Snapshot, type TerritoryUpdate } from './sim-client.js';
