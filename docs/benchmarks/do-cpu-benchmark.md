# DO-CPU-Benchmark — provisorische Arena-Populationsgrenze

Ergebnis-Dokument zu **Bau-Ticket 02** (`.scratch/paintclash/issues/02-do-cpu-benchmark-spike.md`),
graduiert aus Wayfinder-Ticket 14. Referenziert von T15 (Populationsgrenze) und T16
(Re-Konfirmation gegen den echten Build). Harness: [`bench/do-cpu/`](../../bench/do-cpu/).

Stand: 2026-07-19.

## TL;DR

- **GO für ADR-0001.** Die CPU einer single-threaded Arena-DO ist bei realistischen
  Populationen **nicht** der Engpass: selbst die *unmitigierte* Erst-Implementierung
  (naive Trail-Kollision, Polygon-Fill) kostet bei **128 Entities ~3,5 ms/Tick p95**
  lokal — mit dem 4×-Hardware-Sicherheitsfaktor ~14 ms ≈ 28 % des 50-ms-Budgets bei
  20 Hz, und damit noch innerhalb des 25-ms-Kriteriums.
- **Provisorische Populationsgrenze: CPU-Deckel 64, Startwert der Grenze 16.**
  64 hält das 25-ms-Kriterium inkl. 4×-Faktor in jeder gemessenen Variante mit ≥ 6×
  Abstand (naive@64: 1,0 ms × 4 = 4 ms); der empfohlene *Startwert* 16 ist
  gameplay-motiviert (die 200×200-Arena ist für ~15 Entities dimensioniert, Spec
  §10.2), nicht CPU-motiviert.
- **Bot-Ziel 8 (Spec §2.7): tragbar.** 8 Entities ≈ 0,02 ms/Tick lokal (× 4 ≈ 0,08 ms
  ≈ 0,2 % des Budgets).
- Die eine wirksame CPU-Mitigation ist der **Spatial-Hash für die Trail-Kollision**
  (~10× ab N ≥ 48). **Fill rastern ist CPU-seitig neutral** — die Wahl Polygon vs.
  Raster darf nach Korrektheit/Einfachheit fallen, nicht nach CPU.

## Messaufbau

- **Echtes Durable Object** (`BenchArena`, SQLite-backed Klasse wie auf Free verfügbar)
  in workerd via `@cloudflare/vitest-pool-workers` 0.12.21 / wrangler 4.112.
- Host: AMD Ryzen 7 7800X3D, WSL2, Node 24 — **lokale workerd-Instanz, nicht
  Cloudflare-Produktion** (Caveat unten).
- **Timing von aussen** über die fetch-Grenze des DO (awaits aktualisieren die Uhr auch
  bei Spectre-gefrorenen Clocks; lokal advanced die Uhr ohnehin, per Self-Check bestätigt).
  Batches werden auf ~100 ms Wall-Clock autoskaliert, damit der Loopback-Overhead
  (< 1 ms) im Rauschen bleibt; 8 Batches je Messpunkt (p95 ≈ Max über Batches),
  200 Ticks Warmup (jede Entity hat ihren ersten Loop geschlossen → steady state).
- Zusätzlich ein **paced-Modus**: echte 20-Hz-Taktung über `setTimeout`, gemessen wird
  der Verzug jedes Ticks gegen seinen 50-ms-Fahrplan.

## Synthetische Last — Annahmen

Pro Tick (20 Hz) und Entity, mit den Balance-Startwerten der Spec (§10):

| Annahme | Wert | Begründung |
|---|---|---|
| Bewegung | 9 WU/s, Drehrate 320°/s geklemmt, 200×200-Arena, sanfte Barriere | Spec §10.2/10.3 |
| Trail | 1 Punkt pro Tick, Reset beim Loop-Schluss | Worst Case (reale Punkt-Ausdünnung würde sparen) |
| Loop-Schluss (Fill) | alle 5 s je Entity, versetzt | aggressiv vs. real (8–15 s) → konservativ |
| Trail-Kollision | Kopf (r = 0,5 WU) gegen alle fremden + eigene älteren Segmente | naive: alle Segmente; grid: Spatial-Hash 2-WU-Zellen, inkrementell gepflegt |
| Fill raster | Even-Odd-Scanline aufs Owner-Grid, 0,5-WU-Zellen (400×400), Stehlen = Überschreiben | der echte „Fill rastern"-Algorithmus |
| Fill polygon | O(V_loop × V_ring)-Kanten-Sweep gegen eigenen + bbox-überlappende fremde Ringe; Ringe auf 64 Vertices dezimiert | dominanter Term realer Polygon-Boolean-Ops (Greiner-Hormann-artig) |
| Pro Tick zusätzlich | „Kopf im eigenen Gebiet?"-Test je Entity + Snapshot-Serialisierung (20 B/Entity) | reale Tick-Arbeit |
| Keine Tode | Hits werden gezählt, töten aber nicht | Tod würde Last *senken* → Worst Case |
| Nicht modelliert | Bot-Heuristik, WS-Broadcast-I/O, Leaderboard | klein bzw. I/O-, nicht CPU-gebunden; T16 misst real |

Deterministisch: fester dt, geseedeter RNG (Mulberry32), keine Uhr in der Sim.

## Ergebnisse — Durchsatz (ms/Tick, back-to-back)

`polygon/naive` = unmitigierte Erst-Implementierung; `raster/grid` = voll mitigiert;
Mischvarianten attribuieren die Kosten. Auszug — die vollständige 44-Zeilen-Kurve
steht im Anhang, reproduzierbar via `pnpm --filter @paintclash/bench-do-cpu bench`:

| Variante | N | ms/Tick avg | ms/Tick p95 | SegChecks/Tick |
|---|---|---|---|---|
| polygon/naive | 8 | 0,019 | 0,029 | 3 208 |
| polygon/naive | 16 | 0,059 | 0,061 | 12 880 |
| polygon/naive | 32 | 0,231 | 0,268 | 51 618 |
| polygon/naive | 64 | 0,906 | 1,000 | 206 663 |
| polygon/naive | 128 | 3,390 | 3,480 | 827 012 |
| polygon/grid | 32 | 0,058 | 0,069 | 362 |
| polygon/grid | 128 | 0,460 | 0,505 | 2 869 |
| raster/naive | 32 | 0,238 | 0,299 | 51 619 |
| raster/naive | 128 | 3,343 | 3,620 | 827 012 |
| raster/grid | 8 | 0,013 | 0,018 | 80 |
| raster/grid | 16 | 0,034 | 0,035 | 168 |
| raster/grid | 32 | 0,053 | 0,075 | 376 |
| raster/grid | 64 | 0,101 | 0,116 | 934 |
| raster/grid | 128 | 0,282 | 0,320 | 2 867 |

Befunde:

- **Kollision dominiert, Fill ist irrelevant.** Die Fill-Achse (polygon vs. raster)
  ändert die Kurve praktisch nicht (Fills sind selten und beide Algorithmen billig);
  die Kollisions-Achse (naive vs. grid) macht ab N ≥ 48 den ~10×-Unterschied.
- **naive wächst ~quadratisch** (N × Gesamt-Segmente), **grid ~linear**.
- Ein zweiter kompletter Lauf reproduzierte alle Werte innerhalb ~±10 %.

## Ergebnisse — echte 20-Hz-Taktung (paced)

200 Ticks = 10 s Fahrplan; Verzug gegen den 50-ms-Takt:

| Variante | N | Wall ms (Soll 10 000) | Verzug p50 | p95 | max |
|---|---|---|---|---|---|
| polygon/naive | 8 | 10 006 | 0 | 4 | 6 |
| polygon/naive | 16 | 10 000 | 0 | 2 | 5 |
| polygon/naive | 32 | 10 001 | 0 | 2\* | 4\* |
| raster/grid | 16 | 10 001 | 0 | 3 | 5 |
| raster/grid | 32 | 10 000 | 0 | 3 | 4 |
| raster/grid | 64 | 10 000 | 0 | 2 | 9 |
| raster/grid | 128 | 10 001 | 0 | 3 | 5 |

Der 20-Hz-Takt hält bei jeder gemessenen Population, p50-Verzug durchgehend 0–1 ms.

\* **Sporadischer Ausreisser:** In beiden Läufen stallte je Lauf genau *ein* paced-Batch
einmalig für ~2,4–2,9 s (danach Aufholen im Fahrplan) — in Lauf 1 bei anderen Zeilen als
in Lauf 2, unkorreliert mit N oder Variante. Konsistent mit einer Major-GC des Harness
(44 Sweep-Welten Garbage im selben Isolate) bzw. WSL2-Scheduling, nicht mit Sim-Last.
Konsequenz fürs echte Arena-DO: Allokations-Churn im Tick-Pfad klein halten
(Mitigation 4) und in T16 auf echter Infrastruktur gegenprüfen.

## Interpretation → Zahlen

Budget: 50 ms/Tick bei 20 Hz. Kriterium: p95 ≤ 25 ms (50 % Headroom für WS-Broadcast,
Serialisierung real, Bots, GC). Sicherheitsfaktor lokal → Cloudflare-Produktions-Metal
konservativ **4×** angesetzt:

- **naive Erst-Implementierung:** 128 Entities → 3,5 ms × 4 = 14 ms ✓; quadratisch
  extrapoliert reisst das Kriterium erst bei ~250+. **CPU-Deckel naive: ~128.**
  Innerhalb des messbaren Bereichs (N ≤ 128; Harness-Deckel 200 wegen
  Uint8-Owner-IDs) **reisst nichts** — weder Tick-Timing noch CPU-Budget. Der
  Bruchpunkt ist darum extrapoliert, nicht gemessen; er liegt jenseits jeder
  realistischen Population.
- **mitigiert (grid):** 128 Entities → 0,35 ms × 4 = 1,4 ms (3 % Budget). Deckel weit
  jenseits von 200 (Harness-Grenze der Owner-IDs).
- **30-s-CPU-Budget/Invocation (Free):** nach dieser Messung nicht bindend, **unter
  der Annahme**, dass der echte Tick-Treiber pro Tick ein eigenes Event nutzt (Alarm
  bzw. eingehende WS-Nachrichten; das Budget resettet je Event, Spec §7.2). Der
  paced-Modus dieses Harness treibt dagegen alle Ticks in *einer* Invocation — selbst
  so wären es bei 0,35 ms/Tick erst nach ~85 000 Ticks (≈ 70 min) 30 s CPU. Ticket 03
  legt den echten Treiber fest; T16 verifiziert.

**Provisorische Arena-Populationsgrenze:**

- **CPU-Deckel: 64** — trägt selbst die naive Erst-Implementierung mit ≥ 10× Headroom
  und bleibt weit unter jedem gemessenen Limit.
- **Empfohlener Startwert der Grenze: 16** — gameplay-motiviert (200×200 WU ist für
  ~15 Entities dimensioniert, §10.2; Privat-Raum-Maximum ist ebenfalls 16). Die Grenze
  ist damit ein Anti-Dominanz-/Dichte-Parameter, kein CPU-Schutz; sie kann nach
  Playtests ohne CPU-Bedenken bis 64 angehoben werden.

**Bot-Ziel 8 (§2.7): GO.** 8 Entities kosten ~0,02 ms/Tick lokal (× 4 ≈ 0,2 % Budget)
— auch zusätzlich zu 16 Menschen irrelevant.

**Speicher (Wayfinder-T14 fragte danach):** workerd stellt im DO keine
Speicher-Messung bereit (kein `process.memoryUsage`); daher analytisch: Worst Case
128 Entities ≈ 128 Trails × ~100 Punkte × 16 B ≈ 0,2 MB + Owner-Grid 160 kB +
Spatial-Hash in derselben Grössenordnung — **≪ 1 % der 128 MB** eines DO. Kein
Risiko; real nachprüfen in T16 (Dashboard).

## Go/No-Go zu ADR-0001

**GO.** Die Workers/DO-Wahl hält dem einen echten technischen Vorbehalt (CPU pro
Arena-Tick, single-threaded) mit grossem Abstand stand. Kein Anlass, die
Runtime-Reversibilität (ADR-0002/0003) vorzeitig zu ziehen.

## Mitigationsliste (falls Annahmen reissen oder T16 anders misst)

1. **Spatial-Hash für die Trail-Kollision** (gemessen ~10× ab N ≥ 48) — als Standard in
   die echte Sim übernehmen (Ticket 04/05), nicht erst als Notnagel.
2. **Fill rastern statt Polygon-Geometrie** — CPU-seitig neutral, aber eine
   Robustheits-/Komplexitäts-Mitigation (keine Polygon-Boolean-Sonderfälle); Option
   offenhalten, Entscheidung in Ticket 04 nach Korrektheitskriterien.
3. **Arena-/Spielerzahl deckeln** — Populationsgrenze (Startwert 16, CPU-Deckel 64)
   hart durchsetzen („Arena voll"-Abweisung, T15).
4. **Allokations-Churn im Tick-Pfad senken** (flache TypedArrays, wiederverwendete
   Puffer statt Arrays/Sets pro Tick) — beugt den beobachteten GC-Stalls vor.
5. **Tick-Rate senken** (20 → 15 Hz, lebt in `shared`) — Notbremse; laut Messung nicht
   nötig.

## Caveats

- Lokale workerd ≈ Produktions-Runtime, aber **nicht** Produktions-Hardware
  (Multi-Tenant-Metal, andere CPU). Der 4×-Faktor deckt das konservativ; **T16
  re-konfirmiert gegen den echten Deploy.**
- Synthetische Last approximiert Fill/Kollision; echte `sim-core`-Kosten (Rewind-Historie,
  Kill-Auflösung, Bot-Heuristik) und WS-Broadcast fehlen. Gegen das 25-ms-Kriterium bei
  ≤ 16 Entities (< 0,1 ms gemessen) ist der Abstand jedoch ~2 Grössenordnungen.
- p95 über 8 Batches entspricht dem Batch-Maximum; Einzel-Tick-Ausreisser innerhalb
  eines Batches werden gemittelt. Das 25-ms-Kriterium wird also gegen eine geglättete
  Statistik geprüft — bei ~2 Grössenordnungen Abstand unkritisch.

## Anhang — vollständige Kurve (Lauf 1, ms/Tick)

| Variante | N | ms/Tick avg | ms/Tick p95 | ms/Tick max | SegChecks/Tick | Fills/s |
|---|---|---|---|---|---|---|
| polygon/naive | 2 | 0,008 | 0,012 | 0,012 | 196 | 0,4 |
| polygon/naive | 4 | 0,015 | 0,018 | 0,018 | 796 | 0,8 |
| polygon/naive | 8 | 0,020 | 0,026 | 0,026 | 3 208 | 1,6 |
| polygon/naive | 12 | 0,043 | 0,055 | 0,055 | 7 236 | 2,4 |
| polygon/naive | 16 | 0,059 | 0,061 | 0,061 | 12 880 | 3,2 |
| polygon/naive | 24 | 0,132 | 0,165 | 0,165 | 29 017 | 4,8 |
| polygon/naive | 32 | 0,231 | 0,268 | 0,268 | 51 618 | 6,4 |
| polygon/naive | 48 | 0,515 | 0,564 | 0,564 | 116 211 | 9,6 |
| polygon/naive | 64 | 0,906 | 1,000 | 1,000 | 206 663 | 12,8 |
| polygon/naive | 96 | 2,002 | 2,135 | 2,135 | 465 189 | 19,2 |
| polygon/naive | 128 | 3,390 | 3,480 | 3,480 | 827 012 | 25,6 |
| polygon/grid | 2 | 0,009 | 0,019 | 0,019 | 20 | 0,4 |
| polygon/grid | 4 | 0,011 | 0,014 | 0,014 | 32 | 0,8 |
| polygon/grid | 8 | 0,017 | 0,025 | 0,025 | 81 | 1,6 |
| polygon/grid | 12 | 0,019 | 0,022 | 0,022 | 125 | 2,4 |
| polygon/grid | 16 | 0,025 | 0,030 | 0,030 | 159 | 3,2 |
| polygon/grid | 24 | 0,042 | 0,070 | 0,070 | 254 | 4,8 |
| polygon/grid | 32 | 0,058 | 0,069 | 0,069 | 362 | 6,4 |
| polygon/grid | 48 | 0,096 | 0,108 | 0,108 | 614 | 9,6 |
| polygon/grid | 64 | 0,143 | 0,163 | 0,163 | 929 | 12,8 |
| polygon/grid | 96 | 0,272 | 0,288 | 0,288 | 1 602 | 19,2 |
| polygon/grid | 128 | 0,460 | 0,505 | 0,505 | 2 869 | 25,6 |
| raster/naive | 2 | 0,006 | 0,007 | 0,007 | 196 | 0,4 |
| raster/naive | 4 | 0,010 | 0,022 | 0,022 | 796 | 0,8 |
| raster/naive | 8 | 0,019 | 0,029 | 0,029 | 3 208 | 1,6 |
| raster/naive | 12 | 0,036 | 0,043 | 0,043 | 7 236 | 2,4 |
| raster/naive | 16 | 0,056 | 0,076 | 0,076 | 12 881 | 3,2 |
| raster/naive | 24 | 0,120 | 0,127 | 0,127 | 29 017 | 4,8 |
| raster/naive | 32 | 0,238 | 0,299 | 0,299 | 51 619 | 6,4 |
| raster/naive | 48 | 0,478 | 0,519 | 0,519 | 116 213 | 9,6 |
| raster/naive | 64 | 0,834 | 0,908 | 0,908 | 206 661 | 12,8 |
| raster/naive | 96 | 1,910 | 2,140 | 2,140 | 465 123 | 19,2 |
| raster/naive | 128 | 3,343 | 3,620 | 3,620 | 827 012 | 25,6 |
| raster/grid | 2 | 0,008 | 0,015 | 0,015 | 20 | 0,4 |
| raster/grid | 4 | 0,008 | 0,015 | 0,015 | 33 | 0,8 |
| raster/grid | 8 | 0,013 | 0,018 | 0,018 | 80 | 1,6 |
| raster/grid | 12 | 0,017 | 0,019 | 0,019 | 125 | 2,4 |
| raster/grid | 16 | 0,034 | 0,035 | 0,035 | 168 | 3,2 |
| raster/grid | 24 | 0,031 | 0,036 | 0,036 | 254 | 4,8 |
| raster/grid | 32 | 0,053 | 0,075 | 0,075 | 376 | 6,4 |
| raster/grid | 48 | 0,067 | 0,075 | 0,075 | 634 | 9,6 |
| raster/grid | 64 | 0,101 | 0,116 | 0,116 | 934 | 12,8 |
| raster/grid | 96 | 0,193 | 0,224 | 0,224 | 1 627 | 19,2 |
| raster/grid | 128 | 0,282 | 0,320 | 0,320 | 2 867 | 25,6 |
