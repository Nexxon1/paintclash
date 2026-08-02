/**
 * The one place `sim-core` talks to a polygon boolean engine (ADR-0007). Two
 * reasons it is a module of its own rather than an import in `fill.ts`:
 *
 * - **The engine is a decision, not a detail.** It sits in the determinism
 *   path (ADR-0003) and it is the single most expensive thing a tick does, so
 *   swapping it must be one edit with one place to read about it.
 * - **Failure injection needs a seam.** `fill.ts` promises to forfeit a
 *   capture rather than crash the tick when the engine throws or returns
 *   corrupt topology (`fill-forfeit`, `fill-corrupt`). Those tests mock THIS
 *   module, so they keep testing the forfeit rather than a vendor's name.
 *
 * ## Engine: `polygon-clipping` (float Martinez), since ticket 23
 *
 * Previously `polyclip-ts`, the arbitrary-precision port of the same Martinez
 * sweep. It was chosen for robustness (ADR-0007) and it delivered that — but
 * its arithmetic is what a saturated arena pays for. Measured on 155 real ops
 * lifted out of a saturated 200 WU arena and replayed identically through both
 * engines: `union` 9,12 → 1,05 ms/op (**8,7×**), `difference` 9,63 → 0,94
 * ms/op (**10,2×**), zero failures on either side, identical vertex counts,
 * worst area disagreement 3,6e-12 WU². `union(territory, loop)` alone is ~70 %
 * of a fill, and its cost rides on the filler's whole accumulated vertex
 * count — which is why this factor, and not an algorithmic trick, was what
 * ticket 23 had left to find.
 *
 * **Determinism is unaffected.** ADR-0003 asks for "same inputs ⇒ same
 * outputs", not bit-exactness across machines, and float Martinez is a pure
 * function of its inputs: no clock, no RNG, no iteration over hash order.
 * Exact predicates buy robustness against near-degenerate geometry, not
 * reproducibility — and the robustness they bought is what the snap lattice
 * exists to provide (see `snapWU`).
 *
 * The swap was expected to rotate the golden replay hash — a different sweep
 * computing intersection points to different last bits, and those are stored
 * coordinates. **It did not.** Snapping the output back onto the lattice
 * lands both engines on the same points; over five minutes of a saturating
 * arena the flown path stays bit-identical (7 408 vertices, 1 368 closures, 1
 * death, unchanged). Only over hours do the paths part.
 *
 * **The lattice stays at 1e-7 WU.** ADR-0007's ticket-25 addendum instructs
 * whoever swaps the engine to re-measure the width rather than inherit it, and
 * warns that for `polygon-clipping` in the CLIENT 1e-7 was the slowest of the
 * widths tried. That instruction is answered here by argument rather than by a
 * stopwatch, because no timing could overrule the constraint: `fill.ts` seals
 * degenerate loops with a band of `SEAL_HALF_WIDTH_WU`, which must stay an
 * order above the lattice to survive snapping and yet far below the fill
 * floor. At 1e-7 the widest possible band is 4e-4 WU² against a floor of 0.01;
 * a 1e-6 lattice would make it 40 % of the floor — a rule change, not a
 * tuning knob. So the width is pinned by the seal, and what remained to check
 * was only that 1e-7 does not GRIND here: it does not, over 288 000 ticks of
 * a saturated arena. The client is free to use 1e-4 because it has no such
 * band — it draws grooves. And what the client's grinding really warned about
 * was unsnapped input; here every operand is on the lattice by construction.
 *
 * **The package is unmaintained**, which ticket 23 flagged as the risk to
 * weigh. Three things carry it, and none of them is optimism: the version is
 * pinned; this module is the single seam, so replacing the engine is one edit
 * (that is half of why the seam exists); and `polyclip-ts` stays installed as
 * a dev dependency, where `fill.test.ts` runs it as an independent oracle
 * against this one. If the engine ever has to go, Clipper2 as WASM is the
 * documented fallback — integer arithmetic, which suits a lattice that is
 * already an integer raster. It was not needed.
 *
 * The client runs the same engine for its trail carve (`client/render/carve`)
 * with its own, coarser lattice, and carries its own copy of the interop shim
 * below. Sharing it would mean putting a clipper dependency in
 * `@paintclash/shared` — the one package `protocol` and `server` also depend
 * on — to spare ten lines. The duplication is the cheaper of the two.
 */

import type { Territory } from '@paintclash/shared';
import * as polygonClipping from 'polygon-clipping';

/**
 * The slice of the engine this package uses, in the repo's own geometry types.
 * `Territory` (`Point[][][]`) is structurally the engine's `MultiPolygon`, so
 * operands and results pass verbatim — the reason `shared/types.ts` fixes the
 * shape it does.
 */
interface Clipper {
  union: (subject: Territory, ...clips: Territory[]) => Territory;
  difference: (subject: Territory, ...clips: Territory[]) => Territory;
}

/**
 * polygon-clipping ships mismatched builds: the ESM bundle (what Vite and
 * wrangler's esbuild resolve) has only a DEFAULT export, while the type
 * declarations and the CJS build (what Vitest resolves) expose named ones.
 * Unwrap whichever shape the active bundler produced — the same shim
 * `client/render/carve.ts` carries.
 *
 * A function, and exported, for one reason: any single test run only ever sees
 * ONE of the two shapes, so the branch that matters in production is the one a
 * test can never reach by importing this module. `clipper.test.ts` feeds it
 * both shapes directly instead.
 */
export function unwrapEngine(module: unknown): Clipper {
  const engine = module as Clipper & { default?: Clipper };
  return engine.default ?? engine;
}

export const { union, difference } = unwrapEngine(polygonClipping);
