# 22 — Fill-Kosten sprengen das Tick-Budget, sobald die Karte volläuft

**What to build:** Der polygonbasierte Fill (`sim-core/fill.ts` → `closeLoop`) ist die
**einzige** superlineare Kostenstelle im Tick, und er reißt das 50-ms-Budget bei normalem
Spiel. Ziel: ein Tick bleibt unter dem Budget, auch wenn 8 Entities die Karte über Minuten
voll malen — ohne die Fill-Semantik (Capture, Stehlen, Disjunktheit, Determinismus) zu
verändern.

**Blocked by:** — (unabhängig; Ticket 16 misst danach die Populationsgrenze gegen den echten
Build, nicht mehr gegen die synthetische Kurve)

**Status:** ready-for-agent

## Befund (Messung 2026-07-30, nach Ticket 12)

Anlass: Der User berichtete „das Spiel friert lokal nach einer Weile ein" auf
`pnpm dev:small` (50 WU) nach ~30 s. Reproduziert und aufgeschlüsselt (Node 24, WSL2, echter
`sim-core`, 8 Bots, `ARENA_SEED=20260730`):

**Kosten pro Tick, nach Phase in `step()`:**

| Phase | t=5 s | t=40 s |
|---|---|---|
| **Fill** (`trackTrail` → `closeLoop`) | 1,06 ms | **12,00 ms** |
| Kollision (`detectDeaths` inkl. Rewind) | 0,03 ms | 0,01 ms |
| Spawn (`rollSpawn` bei Tod) | 0,00 ms | 0,06 ms |
| Bot-Heuristik (8 Pilots) | 0,048 ms | 0,027 ms |

Fill ist **~99 %** der Tick-Zeit. Bei ~0,15 Fills/Tick heißt das: **ein einzelner Fill kostet
bis zu ~90 ms** — fast zwei Tick-Budgets. Der Max-Tick *ist* ein Fill.

**Verlauf (50 WU, 8 Bots):** ab **t≈10 s** reißen einzelne Ticks das 50-ms-Budget, Spitze
**114 ms bei t≈30 s** (deckt sich exakt mit dem Bericht). **200-WU-Arena:** dieselbe Kurve,
langsamer — 27,6 ms Durchschnitt und **325 ms**-Spitzen bei t≈300 s. Die Kosten folgen der
**Vertex-Zahl der Gebiete** (350 → 6 078 Vertices) bzw. dem Sättigungsgrad der Karte, nicht
der Spielerzahl. Nicht monoton: Tode setzen Gebiete zurück, die Kurve fällt dann wieder.

**Warum es einfriert (und nicht nur ruckelt):** `arena-do.ts` re-ankert seinen Fahrplan nach
einem Überlauf bewusst, statt verpasste Ticks nachzuholen (ein Nachhol-Burst sähe wie ein
Teleport aus). Ein überlaufender Tick pausiert die Welt also für **alle**; dauerhafter
Überlauf liest sich als „eingefroren".

**Kein Bot-Problem.** Die Pilots kosten 0,03 ms (0,3 %). Bots sind der *Auslöser*, nicht die
Ursache: sie malen unermüdlich (~3 Fills/s) und treiben die Karte in Minuten in die
Sättigung — acht gute Menschen tun dasselbe, nur langsamer und nicht unbeaufsichtigt.

## Wo die Kosten liegen

`closeLoop` carved die Capture aus **jedem** fremden Gebiet heraus, damit Gebiete paarweise
disjunkt bleiben — bedingungslos, `N−1` polyclip-`difference`-Ops pro Fill. Und es carved mit
`captured`, dem **gesamten** Gebiet des Spielers (dem Union-Ergebnis), nicht mit dem neu
gewonnenen Streifen. Jede Op ist also „mein ganzer Fleck gegen deinen ganzen Fleck", und
polyclips Martinez-Sweep skaliert mit der Gesamt-Vertex-Zahl.

**Gemessen (5-s-Fenster bei t=35 s):** 308 Carve-Ops, **960 ms von 1 084 ms Fill-Zeit (89 %)**
— davon ändern **42 (14 %)** überhaupt Land, und **148 (48 %)** betreffen Gebiete, deren
**Bounding-Boxen sich nicht einmal berühren**.

## Wichtig vorab: konstanter Faktor ≠ Wachstum

Die drei Ansätze unten sind **nicht austauschbar**, und die Reihenfolge ist nach
(Wirkung/Risiko) sortiert, **nicht** nach Endgültigkeit:

- **1 und 2 sind konstante Faktoren.** Sie senken die Kosten *pro Fill* deutlich, ändern aber
  nichts daran, dass die Kosten mit der Vertex-Zahl **weiter wachsen**. Sie kaufen Zeit
  (schätzungsweise 2–5× länger bis zum Budget-Überlauf), keine Immunität. Auf einer
  always-on-Arena (ADR-0004) heißt das: die Kurve steigt weiter, nur später.
- **3 greift das Wachstum selbst an.** Nur eine Deckelung der Vertex-Zahl macht die Kosten pro
  Fill *beschränkt* und die Kurve flach.

Praktisch entschärft die Sägezahn-Natur des Spiels viel: Tode setzen Gebiete auf Startblöcke
zurück, die gemessene Kurve fällt danach wieder (t=45 s: 4 182 → 3 135 Vertices). Eine belebte
Arena pendelt also eher, als dass sie divergiert. **Wer den Fund dauerhaft schließen will,
braucht 3**; wer nur den berichteten Freeze wegbekommen will, kommt mit 1 (+2) weit.

## Lösungsansätze, nach (Wirkung, Risiko) sortiert

- [ ] **1. Bounding-Box-Vorfilter im Carve-Loop.** Überlappen die Boxen nicht, kann
      `difference(other, captured)` das Gebiet nicht ändern → Op überspringen und die
      Eingabe-Referenz behalten. **Semantisch beweisbar identisch** (genau das tut der Code
      heute schon, wenn nichts gestohlen wurde) ⇒ **Hash-neutral, keine Golden-Replay-Rotation**.
      Erwartung: −48 % der Carve-Ops ⇒ ~−43 % der Fill-Zeit. Kleiner Diff, geringes Risiko.
      **Achtung, das ist eine Hochrechnung aus Op-ZÄHLUNGEN, keine Messung** — sie nimmt an,
      dass eine übersprungene Op durchschnittlich so teuer ist wie eine behaltene (plausibel:
      der Martinez-Sweep verarbeitet ohnehin alle Kanten beider Polygone). Erste Aufgabe des
      Tickets: die Zahl **messen**, nicht übernehmen.
- [ ] **2. Gegen den NEUEN Streifen carven, nicht gegen das ganze Union.** `other` ist von dem
      *alten* Gebiet des Spielers bereits disjunkt (dokumentierte Invariante, `fill.ts`-Kopf),
      also genügt die neu gewonnene Fläche als Carve-Region — drastisch kleineres Polygon.
      Größere Wirkung, braucht die Disjunktheits-Invariante exakt und Property-Absicherung;
      die Zusatz-Op zur Bestimmung des Streifens darf den Gewinn nicht auffressen.
- [ ] **3. Vertex-Zahl der Gebiete deckeln.** `compactRing` entfernt nur *exakt* kollineare
      Vertices; eine Toleranz-Simplifikation (Douglas-Peucker auf Lattice-Skala) würde das
      unbegrenzte Wachstum stoppen. Verändert Geometrie minimal ⇒ **rotiert den Replay-Hash**
      und braucht eine Balance-Entscheidung zur Toleranz.
- [ ] Akzeptanz: Repro-Harness (8 Bots, 200 WU **und** 50 WU, 5 min) hält jeden Tick unter dem
      Budget; als Test verankert, nicht nur einmal gemessen.
- [ ] Property-Tests aus §9.2 bleiben grün (Summe + neutral = 100 %, Disjunktheit, kein Loch);
      Golden-Replay bewusst rotiert **nur** falls Ansatz 3 gefahren wird.

## Nebenbefund: Ticket 02 muss korrigiert werden

Der DO-CPU-Benchmark schloss: *„Kern-Befund: Kollision dominiert (Spatial-Hash ~10×),
Fill-Rastern ist CPU-neutral"* und leitete daraus ab, die Wahl Polygon vs. Raster dürfe
*„nach Korrektheit/Einfachheit fallen, nicht nach CPU"*. Gegen echten Code ist es **umgekehrt**:
Fill ist ~99 %, Kollision 0,01 ms. Die synthetische Last modellierte den Fill als
Kanten-Sweep über auf 64 Vertices **dezimierte** Ringe — genau die Dezimierung, die der echte
Code nicht macht (Ansatz 3). Damit ist „Raster statt Polygon" wieder eine **offene
CPU-Frage**, und der Nachtrag in
[`docs/benchmarks/do-cpu-benchmark.md`](../../../docs/benchmarks/do-cpu-benchmark.md) ist um
diese Zahlen zu ergänzen.

_Referenz: spec §2.2 (polygonbasierter Fill), §6.2 (20-Hz-Tick), §9.2 (Invarianten); ADR-0003
(Determinismus), ADR-0007 (Boolean-Engine + Snap-Gitter). Aufgedeckt bei Ticket 12._
