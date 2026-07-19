/**
 * Worker entry (spec §5.2): exports the Arena-DO class for the runtime and
 * the stateless router as the fetch handler. Pure wiring — the testable
 * pieces live in `router.ts` (node) and `arena.ts` (node) / `arena-do.ts`
 * (scenario tests).
 */

export { ArenaDO } from './arena-do.js';
export { handleFetch, healthPayload, type Env } from './router.js';

import { handleFetch } from './router.js';

export default {
  fetch: handleFetch,
};
