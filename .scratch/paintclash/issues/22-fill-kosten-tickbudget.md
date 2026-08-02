# 22 — Fill-Kosten sprengen das Tick-Budget, sobald die Karte volläuft

**What to build:** Der polygonbasierte Fill (`sim-core/fill.ts` → `closeLoop`) ist die
**einzige** superlineare Kostenstelle im Tick, und er reißt das 50-ms-Budget bei normalem
Spiel. Ziel: ein Tick bleibt unter dem Budget, auch wenn 8 Entities die Karte über Minuten
voll malen — ohne die Fill-Semantik (Capture, Stehlen, Disjunktheit, Determinismus) zu
verändern.

**Blocked by:** — (unabhängig; Ticket 16 misst danach die Populationsgrenze gegen den echten
Build, nicht mehr gegen die synthetische Kurve)

**Status:** resolved (2026-07-31)

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

## Mess-Werkzeug: zwei Artefakte, nur eines bleibt

Die Zahlen oben stammen aus **Wegwerf-Instrumentierung**, die absichtlich **nicht** im Repo
liegt: temporäre `*.test.ts`-Proben unter `packages/server/src/` plus Zeitmess-Punkte direkt in
`sim-core/step.ts` und `fill.ts`. Alles wurde nach der Messung wieder entfernt (verifiziert:
`grep -rn "DEBUG-f713" --include=*.ts .` → 0 Treffer). Wer dieses Ticket bearbeitet, baut sie
neu — die Methode steht oben vollständig, und die Kurve ist mit gepinntem Seed reproduzierbar.

**Die beiden Artefakte nicht verwechseln:**

| | Diagnose-Instrumentierung | Budget-Test (Akzeptanz) |
|---|---|---|
| Zweck | Kosten *aufschlüsseln* (Phasen, Op-Zählungen, Sweeps) | Regression halten: kein Tick über Budget |
| Ort | temporär, wo es gerade passt — auch mitten in `sim-core` | dauerhaft, **`bench/`** (manuell, wie `bench/do-cpu`) |
| Danach | **wird gelöscht** | bleibt eingecheckt |

Regeln für die Wegwerf-Hälfte (aus dem Diagnose-Workflow):

- Jede temporäre Zeile mit **einem einheitlichen Präfix** taggen (z. B. `[DEBUG-<4 hex>]`),
  damit das Aufräumen **ein** `grep` ist statt Erinnerungsarbeit.
- Vor dem Commit: Präfix greppen (0 Treffer), temporäre Test-Dateien löschen, `git status`
  muss clean sein. Instrumentierung in `sim-core` ist besonders heikel — sie liegt im
  Determinismus-Pfad und darf nicht versehentlich bleiben.
- Der dauerhafte Budget-Test gehört **nicht** in die Unit-Suite: ein 8-Bot-Lauf über echte
  Sim-Zeit kostete in Ticket 12 lokal 4,7 s und auf dem CI-Runner 38,5 s und riss dessen
  30-s-Timeout. Messungen, die Minuten laufen, laufen manuell.

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

- [x] **1. Bounding-Box-Vorfilter im Carve-Loop.** Überlappen die Boxen nicht, kann
      `difference(other, captured)` das Gebiet nicht ändern → Op überspringen und die
      Eingabe-Referenz behalten. **Semantisch beweisbar identisch** (genau das tut der Code
      heute schon, wenn nichts gestohlen wurde) ⇒ **Hash-neutral, keine Golden-Replay-Rotation**.
      Erwartung: −48 % der Carve-Ops ⇒ ~−43 % der Fill-Zeit. Kleiner Diff, geringes Risiko.
      **Achtung, das ist eine Hochrechnung aus Op-ZÄHLUNGEN, keine Messung** — sie nimmt an,
      dass eine übersprungene Op durchschnittlich so teuer ist wie eine behaltene (plausibel:
      der Martinez-Sweep verarbeitet ohnehin alle Kanten beider Polygone). Erste Aufgabe des
      Tickets: die Zahl **messen**, nicht übernehmen.
- [x] **2. Gegen den NEUEN Streifen carven, nicht gegen das ganze Union.** `other` ist von dem
      *alten* Gebiet des Spielers bereits disjunkt (dokumentierte Invariante, `fill.ts`-Kopf),
      also genügt die neu gewonnene Fläche als Carve-Region — drastisch kleineres Polygon.
      Größere Wirkung, braucht die Disjunktheits-Invariante exakt und Property-Absicherung;
      die Zusatz-Op zur Bestimmung des Streifens darf den Gewinn nicht auffressen.
- [x] ~~**3. Vertex-Zahl der Gebiete deckeln.**~~ **Nicht gefahren — gemessen widerlegt.**
      Die Annahme, eine Toleranz-Simplifikation stoppe das Wachstum, hält der Messung nicht
      stand: bei einer Toleranz, die Geometrie ehrlich lässt (0,05 WU), bringt sie **1,11×**.
      Die Vertices sind nicht redundant, sondern echtes Kurvenfahren (`appendTrailPoint`
      faltet Geraden längst). Nur *zweiseitige* Vereinfachung bringt ~3× — und schiebt
      Grenzen nach aussen, also gegen die Disjunktheit, die derselbe Ticket-Punkt grün halten
      wollte. Vollständige Tabelle und die verbleibenden Auswege: **Ticket 23**.
- [x] Akzeptanz: Repro-Harness (8 Bots, 200 WU **und** 50 WU, 5 min) hält jeden Tick unter dem
      Budget; als Messung in `bench/` verankert, nicht nur einmal gemessen — und die
      Diagnose-Instrumentierung, die dahin geführt hat, ist restlos entfernt (s. oben).
      → [`bench/fill-budget`](../../../bench/fill-budget/); `grep -rn "DEBUG-a91c\|DEBUG-b4e2"`
      → 0 Treffer. **Mit der Einschränkung, dass die 200-WU-Kurve weiter steigt** (Ticket 23).
      **Seit Ticket 28 überholt:** die Zusicherung „jeder Tick unter dem Budget" gilt bei
      200 WU nicht mehr und galt dort nie über die 5 Minuten hinaus (s. Kasten unter der
      Zahlen-Tabelle); der Bench sichert dort jetzt die Vertex-Zahl zu.
- [x] Property-Tests aus §9.2 bleiben grün (Summe + neutral = 100 %, Disjunktheit, kein Loch);
      Golden-Replay **nicht** rotiert — Ansatz 3 wurde nicht gefahren, und 1 + 2 sind
      beweisbar semantik-identisch. **Aber:** der Golden-Replay ist hier *kein* Wächter
      (1 Fill, 0 Steals über 400 Ticks — er carved nie). Die Identität hängt an einem neuen
      **Differenz-Property-Test** in `fill.test.ts`, s. Answer.

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

## Answer

Der Freeze ist weg, und zwar mit **zwei beweisbar semantik-identischen** Änderungen in
`closeLoop` — kein Golden-Replay-Rotieren, keine Balance-Entscheidung, keine Geometrie
bewegt. Der **Fund selbst ist nicht geschlossen**: die Kurve ist abgeflacht, nicht flach.
Das ist Ticket 23, und es ist bewusst so entschieden, nicht übersehen.

### Was gebaut wurde

**1. Bounding-Box-Vorfilter** (`skipsCarve` in `fill.ts`, `territoryBounds` /
`boundsSeparated` in `geometry.ts`). Sind die Boxen getrennt, kann `difference` das Gebiet
nicht ändern — der Code behält dann ohnehin die Eingabe-Referenz, nur eben nach einem
vollen Martinez-Sweep. Der Sweep entfällt.

**2. Carve gegen die neu gewonnene Region** statt gegen das ganze `captured`. Das ist eine
**Identität**, keine Näherung:

```
captured         = territory ∪ loop ∪ pockets        (das IST die Loch-Füllung)
other − captured = (other − territory) − (loop ∪ pockets)
                 = other − (loop ∪ pockets)          ⟸ other ∩ territory = ∅  (§9.2)
```

Und beide Operanden sind **gratis**: der Loop liegt vor, die `pockets` sind genau die
Loch-Ringe der Union, die die Loch-Füllung sonst wegwirft. Die im Ticket befürchtete
Zusatz-Op („darf den Gewinn nicht auffressen") entfällt damit ersatzlos. Nebeneffekt: die
Box der gewonnenen Region ist viel kleiner als die von `captured`, was Ansatz 1
mitverstärkt — überlebende Carve-Ops fielen von 27,9 % auf **5,0 %**.

**Wie die Identität abgesichert ist.** Nicht durch den Golden-Replay: der enthält über
400 Ticks **einen** Fill und **null** Steals, carved also nie und kann eine
Carve-Änderung gar nicht sehen. Dass sein Hash gleich blieb, ist wahr, aber kein Beweis.
Der eigentliche Wächter ist ein neuer **Differenz-Property-Test**
(`fill.test.ts`, „carving with the gained region equals carving with the whole capture"):
er fährt zufällige Loops gegen zufällig platzierte Gegner und vergleicht jedes Ergebnis
gegen `difference(other, captured)` — die Definition, die ersetzt wurde — nach Fläche
**und** nach Lage (Schnittmenge). Er hat sich schon einmal bewährt: der erste Generator
platzierte Gegner, die das eigene Alt-Gebiet überlappten, und der Test fiel sofort — genau
die Vorbedingung, an der die Identität hängt. Der Generator wurde korrigiert, der Fund
steht als Kommentar dort.

### Zahlen (8 Bots, Seed 20260730, 5 min, `bench/fill-budget`)

| | 200 WU vorher | 200 WU nachher | 50 WU vorher | 50 WU nachher |
|---|---|---|---|---|
| mean | 6,89 ms | **1,69 ms** | 3,29 ms | **1,25 ms** |
| p95 | — | 12,4 ms | — | 6,4 ms |
| max | **189 ms** | **36–43 ms** | **106 ms** | **23–25 ms** |
| Ticks > 50 ms | 269 | **0** | 9 | **0** |

> **Überholt seit [Ticket 28](28-fill-kosten-regression-seit-t22.md) (2026-08-02).** Die
> „nachher"-Spalten beschreiben `main` nicht mehr: bei 200 WU liegt der Lauf heute bei
> mean 3,7 ms, p95 25,6 ms und **52–62 Ticks über Budget** ab t ≈ 172 s. Auch die
> 50-WU-Spalte ist überholt, wenn auch harmlos: der `max` streut dort heute über 27,7–49,5 ms
> statt 23–25 ms — 0 Ticks über Budget bleiben es trotzdem. Ursache sind
> **zwei erwünschte** Änderungen — Ticket 19 (Bots sterben nicht mehr am eigenen Trail:
> 6 → 1 Tode, Vertices +26,5 %) und Ticket 26 (31 der 66 leer ausgehenden Loop-Schlüsse
> greifen jetzt: Vertices +11,7 %) — deren Kosten nie gemessen wurden. Kein Rückbau.
>
> Damit ist auch die **Akzeptanz-Zusicherung selbst** hinfällig, und zwar rückwirkend:
> die „0 Ticks über Budget" bei 200 WU galten nur, weil der Lauf bei t = 300 s endet und
> der erste Überlauf damals bei t = 355 s lag (Ticket 23 mass über 30 min **1 860**
> Überläufe am selben Stand). Der Bench sichert seit Ticket 28 darum die **Vertex-Zahl**
> gegen eine aufgezeichnete Basislinie zu statt der Stoppuhr; die Budget-Frage bei 200 WU
> gehört Ticket 23. Aktuelle Zahlen: [`bench/fill-budget/README.md`](../../../bench/fill-budget/README.md).

Die Hochrechnung des Tickets für Ansatz 1 (−48 % der Ops ⇒ −43 % Zeit) war zu
vorsichtig: gemessen waren bei 200 WU **97,5 %** der Carve-Ops bbox-getrennt und trugen
**93,3 %** der Carve-Zeit. Die 48 % stammten aus einem 5-s-Fenster; über 60 s ist das
Verhältnis ein anderes.

Die Phasen-Aufschlüsselung verschob sich unterwegs zweimal, was die Reihenfolge der
Arbeit bestimmt hat: vor Ansatz 1 war Carve 86 % der Fill-Zeit, danach bei 60 s nur noch
27 % (Union dominierte) — aber bei **300 s** war Carve wieder **80 %**, weil `captured`
mit der Historie wächst. Nach Ansatz 2 ist Union mit ~70 % der grösste Posten, und das
ist der Grund, warum Ticket 23 dort ansetzt und nicht am Carve.

### Was NICHT gebaut wurde, und warum

Ansatz 3 (Vertex-Deckel) ist **gemessen** und **verworfen**, nicht ausgelassen. Die
Tabelle steht in Ticket 23; kurz: bei ehrlicher Toleranz 1,11×, und der einzige Weg zu ~3×
schiebt Gebietsgrenzen nach aussen — gegen §9.2, und gegen den Score, der der Kartenanteil
**ist** (§10.5). Die Annahme des Tickets, `compactRing` lasse redundante Vertices liegen,
stimmt nicht: `appendTrailPoint` faltet gerade Strecken bereits, was übrig bleibt, ist
echtes Kurvenfahren.

### Offen, bewusst notiert

1. **Die 200-WU-Kurve steigt weiter** (letztes 30-s-Fenster ~85 % des Budgets, Vertices
   linear wachsend). Ursache ist die Prämisse des Harness: Bots töten einander kaum
   (6 Tode in 5 min), und nur Tode setzen Gebiete zurück. Die 50-WU-Arena mit 96 Toden
   zeigt den im Ticket vermuteten Sägezahn und pendelt stabil — die Vermutung ist damit
   belegt, aber sie ist keine Schranke.
2. **Mit dem 4×-Hardware-Faktor ist das Budget nicht gehalten.** p95 landet bei ~50 ms
   von 50 ms, der **max** bei ~140–170 ms, also ~3× drüber. Der Harness druckt die Zeile
   selbst (`DO-derated (×4)`), damit niemand „lokal grün" für Produktions-Reserve hält.
   Ob der Faktor 4 für diese Last stimmt, weiss nur **T16** gegen echte Infrastruktur —
   er ist eine konservative Konvention aus T02, keine Messung dieser Last.
3. **Gebiete berühren sich jetzt auf Gitter-Ebene, statt exakt bündig zu sein.** Vorher
   wurde das Opfer mit genau dem Polygon geschnitten, das der Gewinner speichert — die
   Überlappung war **exakt 0**. Jetzt werden beide Ränder aus *verschiedenen* Polygonen
   kompaktiert, und wo das Snapping einen Schnittpunkt um ≤ 7e-8 WU nach aussen schob,
   teilen sich beide einen Splitter. Über 3 000 Zufallsloops gemessen: **5,3e-7 WU²** im
   schlimmsten Fall. Das ist kleiner als eine Gitterzelle und sieben Grössenordnungen
   unter den ~4 WU², die eine Leaderboard-Stelle auflöst — aber es ist nicht null, und die
   §9.2-Tests trugen bisher `1e-6`, also nur ~2× Luft. Statt die Grenze stillschweigend
   zu dehnen, liegt sie jetzt benannt und begründet in
   `sim-core/src/fixtures/tolerances.ts` (`LATTICE_NOISE_WU2`), von allen drei
   Invarianten-Tests geteilt; ein echter Disjunktheits-Bruch ist um Grössenordnungen
   grösser und fällt weiterhin durch.
4. **Eine Verhaltensänderung, bewusst akzeptiert:** ein Clipper-Fehler an einem Gebiet,
   das der Fill gar nicht berührt, verwirkt den Fill nicht mehr (die Op läuft nicht).
   Umgekehrt heilt ein Überlappungs-Rest aus dem `spawnTerritory`-Fallback („ein lebender
   Spawn schlägt eine perfekte Invariante") jetzt erst, wenn jemand darüber malt — und
   solange er besteht, ist die Identität oben keine mehr, die Abweichung ist dann
   prinzipiell unbeschränkt. Beides in `fill.ts` dokumentiert, beides ohne bekannten
   Auslöser auf Lattice-Eingaben; es ist der Grund, `spawnTerritory` nicht anzufassen.

Nebenbefund erledigt: der Kern-Befund von Ticket 02 ist im Benchmark-Dokument als
**widerlegt** markiert (TL;DR-Bullet durchgestrichen + Nachtrag mit Zahlen) — Fill ~99 %,
Kollision 0,01 ms, „Raster statt Polygon" wieder offen.

Lokal grün: typecheck (9 Projekte), lint (0 Fehler), format, **490** Unit/Property,
**19** Szenario (17 hermetisch + 2 Bots), **13** E2E, Coverage-Böden (`fill.ts`
Branch-Deckung 93,8 % → 95,1 %, weil zwei tote Zweige verschwunden sind). Der neue
Differenz-Property-Test lief 8× mit frischen fast-check-Seeds stabil.

Ein E2E-Lauf zeigte einmalig `controls.spec.ts › a thumb on a screen half steers in
Lenken L/R` rot; isoliert und im nächsten Vollauf 13/13 grün. Der Test fährt Touch-Input
gegen Frame-Timing und berührt keinen Fill — das ist die Flake-Klasse, für die
`playwright.config.ts` in CI genau **einen** Retry vorsieht. Nicht wegretried, sondern
nachgefahren und hier notiert.
