# 02 — DO-CPU-Benchmark-Spike (provisorische Arena-Populationsgrenze)

**What to build:** Eine belastbare, provisorische Antwort auf „wie viele Spieler trägt eine single-threaded Arena-DO?", damit die **Arena-Populationsgrenze** und das Bot-Ziel real begründet statt geraten sind. Ein Benchmark fährt in einem echten Durable Object einen 20-Hz-Tick unter synthetischer, für Fill/Kollision repräsentativer Last mit steigender Entity-Zahl und misst CPU/Tick, bis Tick-Timing oder das 30-s-CPU-Budget/Invocation reißen. Erster Implementierungs-Spike; gibt Go/No-Go für ADR-0001.

**Blocked by:** 01.

**Status:** done (2026-07-19)

- [x] Benchmark-Harness läuft gegen ein **echtes DO** (via `@cloudflare/vitest-pool-workers` oder Deploy), 20-Hz-Tick. → [`bench/do-cpu/`](../../../bench/do-cpu/), `BenchArena`-DO mit Durchsatz- und paced-20-Hz-Modus; zusätzlich `wrangler dev`-fähig.
- [x] Synthetische Last approximiert Polygon-Fill + Trail-Kollision für N Entities; Annahmen dokumentiert. → 2×2-Varianten (Fill polygon/raster × Kollision naive/grid), Annahmen-Tabelle im Findings-Dokument.
- [x] Ergebnis: provisorische Zahl „max. Spieler/Arena" + Kurve CPU/Tick über N, als Findings-Dokument im Repo festgehalten. → [`docs/benchmarks/do-cpu-benchmark.md`](../../../docs/benchmarks/do-cpu-benchmark.md): Startwert **16** (gameplay-motiviert), CPU-Deckel **64**.
- [x] Explizites **Go/No-Go** zu ADR-0001 + Mitigationsliste (Fill **rastern** statt reiner Polygon-Geometrie; Arena-/Spielerzahl deckeln). → **GO** (Nachtrag in ADR-0001); 5-Punkte-Mitigationsliste. Kern-Befund: Kollision dominiert (Spatial-Hash ~10×), Fill-Rastern ist CPU-neutral.
- [x] Bewertung, ob das Bot-Ziel **8** (§2.7) CPU-seitig tragbar ist. → **GO**: ~0,02 ms/Tick (0,04 % des Budgets).
- [x] Ergebnis wird von T15 (Populationsgrenze) und T16 (Re-Konfirmation gegen den echten Build) referenziert. → Findings-Dokument verlinkt beide; T16 prüft insbesondere den lokalen 4×-Hardware-Sicherheitsfaktor und die beobachteten GC-Stalls auf echter Infrastruktur nach.

_Referenz: spec §7.2, §11, Wayfinder-Ticket 14; ADR-0001._
