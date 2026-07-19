# 02 — DO-CPU-Benchmark-Spike (provisorische Arena-Populationsgrenze)

**What to build:** Eine belastbare, provisorische Antwort auf „wie viele Spieler trägt eine single-threaded Arena-DO?", damit die **Arena-Populationsgrenze** und das Bot-Ziel real begründet statt geraten sind. Ein Benchmark fährt in einem echten Durable Object einen 20-Hz-Tick unter synthetischer, für Fill/Kollision repräsentativer Last mit steigender Entity-Zahl und misst CPU/Tick, bis Tick-Timing oder das 30-s-CPU-Budget/Invocation reißen. Erster Implementierungs-Spike; gibt Go/No-Go für ADR-0001.

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] Benchmark-Harness läuft gegen ein **echtes DO** (via `@cloudflare/vitest-pool-workers` oder Deploy), 20-Hz-Tick.
- [ ] Synthetische Last approximiert Polygon-Fill + Trail-Kollision für N Entities; Annahmen dokumentiert.
- [ ] Ergebnis: provisorische Zahl „max. Spieler/Arena" + Kurve CPU/Tick über N, als Findings-Dokument im Repo festgehalten.
- [ ] Explizites **Go/No-Go** zu ADR-0001 + Mitigationsliste (Fill **rastern** statt reiner Polygon-Geometrie; Arena-/Spielerzahl deckeln).
- [ ] Bewertung, ob das Bot-Ziel **8** (§2.7) CPU-seitig tragbar ist.
- [ ] Ergebnis wird von T15 (Populationsgrenze) und T16 (Re-Konfirmation gegen den echten Build) referenziert.

_Referenz: spec §7.2, §11, Wayfinder-Ticket 14; ADR-0001._
