/**
 * Shared numeric tolerances for the §9.2 invariant tests.
 *
 * They live in one place because they encode one physical fact about the
 * boolean-geometry lattice (ADR-0007), not three independent judgement calls —
 * three hand-tuned epsilons is how the invariant they guard silently drifts.
 */

/**
 * How far apart two lattice-snapped boundaries may sit, expressed as the area
 * that disagreement can amount to.
 *
 * Since ticket 22 a fill carves foreign land with the region it just GAINED
 * rather than with the winner's whole capture (`fill.ts`, `gainedRegion`).
 * The two are the same land, but they are compacted from different polygons,
 * so a shared boundary vertex may sit up to half a lattice cell apart (7e-8
 * WU) and leave a sliver both players hold. Measured worst case over 3 000
 * randomized loops: **5,3e-7 WU²** (before that change it was exactly 0).
 *
 * The bound is 20× the measured worst case, which keeps the invariant tests
 * from turning intermittent — the failure mode the scenario suite's rules
 * exist to prevent — while staying far too small to hide a real break:
 *
 * - 1e-3 of the 0,01 WU² sliver floor a fill must clear (`minFillAreaWU2`)
 * - 1e-7 of the ≈ 4 WU² that one leaderboard digit resolves in the 200 WU
 *   arena (0,01 % of 40 000 WU²)
 *
 * A genuine disjointness break — a steal that failed to carve, a spawn block
 * laid over foreign land — is orders of magnitude larger and still fails.
 */
export const LATTICE_NOISE_WU2 = 1e-5;
