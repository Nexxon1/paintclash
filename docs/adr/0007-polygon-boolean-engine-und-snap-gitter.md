# ADR-0007 — Polygon-Boolean-Engine & Snap-Gitter für den Fill

Status: Angenommen (2026-07-21)
Kontext-Tickets: [Bau-Ticket 04 — Trail + Loop-Schluss → Fill](../../.scratch/paintclash/issues/04-trail-loop-fill.md); Spec §2.2, §6.1, §9.2; ADR-0002/0003 (Determinismus-Disziplin des `sim-core`)

## Kontext

Der Fill ist **polygonbasiert** (Spec §2.2, kein Zell-Flood-Fill). Loop-Schluss heißt: Vereinigung von Gebiet und Loop-Polygon, Löcher füllen, fremdes Gebiet ausstanzen — robuste boolesche Polygon-Operationen im deterministischen `sim-core`. Selbstgebaute Clipping-Algorithmen sind ein bekanntes Robustheits-Grab (Shared Edges, Berührpunkte, kollineare Ketten sind hier der *Normalfall*: die Sehne des Loops liegt im eigenen Gebiet, Ausstanzungen erzeugen gemeinsame Kanten).

## Entscheidung

- **Engine: `polyclip-ts`** (Martinez-Sweep mit exakten Prädikaten; MIT; pure JS → deterministisch im Sinne von ADR-0003, keine Uhr/kein Zufall). Nur der `sim-core` ruft sie; **Fill bleibt strikt server-only** (§6.1) — Clients erhalten Ergebnisse über `territory`-Nachrichten.
- **Snap-Gitter:** alle Clipper-Ein- und -Ausgaben werden auf ein **1e-7-WU-Gitter** gerastet (`snapWU`). Beinahe-Koinzidenzen kollabieren zu exakten (die die Engine robust behandelt); Subnormale Doubles — ein im Spike **verifizierter** Korruptions-Trigger (`difference` lieferte ein „Loch" außerhalb seines Außenrings) — können nicht mehr auftreten. 200 WU × 1e7 < 2^53 → gitter-exakt in Doubles.
- **Fehler-Semantik: Verwirkung statt Absturz.** Wirft die Engine (bekannter Modus: massive Selbstüberlappung des Loop-Rings, roh reproduziert im Spike), verfällt der Fang deterministisch (`closeLoop → null`, Trail endet trotzdem). Zusätzlich vetot ein Topologie-Wächter (`validPolyTopology`) korrupte Ausgaben. Nach Ticket 05 sterben Selbstschneider ohnehin vor dem Loop-Schluss.
- **Gebiets-Repräsentation: Multipolygon mit Löchern** (`Territory = Poly[]`, `Poly = [Außenring, …Löcher]`, Even-Odd). Löcher sind Spielinhalt: wer einen fremden Block umschließt, erhält einen **Annulus** (fremdes Gebiet wird in der Grundversion nicht gestohlen — Ticket 06).

## Konsequenzen

- Spike-belegt (2026-07-21): Shared Edges, Sehnen-Überlappung, Bowties, Duplikate/Kollineare, 500 Zufallsringe, 5000-Punkte-Union (76 ms) — alles robust; Fills sind seltene Ereignisse, Performance unkritisch.
- Gitter-Rundung bewegt Grenzen um ≤ 5e-8 WU — visuell und spielerisch bedeutungslos, aber sie hält alle Folge-Operationen auf dem Gitter (Gebiete sind frühere Clipper-Ausgaben).
- Verwaiste Löcher (Besitzer weg) bleiben neutral, bis irgendein späterer Fill desselben Spielers sie konsolidiert — bewusst schlicht; Ticket 06 (Stehlen) präzisiert die Semantik.
- Wire-Deckel: Polygon-/Ring-Zahlen als u8, Punkte je Ring als u16 (`protocol`); organisch praktisch unerreichbar, Encoder wirft laut bei Überschreitung.

## Nachtrag (2026-07-31, Ticket 25) — das Gitter gilt für **jeden** Clipper, nicht nur den der Sim

Diese ADR entschied für den `sim-core`. Der Client fährt seit Ticket 06 eine **zweite**
Boolean-Engine für den Trail-Carve (`polygon-clipping`, float statt arbitrary precision,
~10× schneller — Kosmetik braucht keine exakten Prädikate) — und die lief **ohne Gitter**.
Das war der Fehler: Fast-Koinzidenzen liessen ihren Sweep **0,7–2,6 s** mahlen und danach
werfen, an Geometrie von drei Vertices. Seit Ticket 25 rastert auch der Client, auf ein
eigenes **Carve-Gitter** von **1e-4 WU** (`CARVE_LATTICE_INV_WU`).

Zwei Präzisierungen, die aus dieser Messung folgen:

- **Die Gitterweite ist kein universeller Wert.** Von allen probierten Weiten war für
  `polygon-clipping` ausgerechnet **1e-7 die langsamste** (ein Fall 11 ms statt 1 ms);
  1e-4 war am schnellsten. Wer eine Engine tauscht (offen in Ticket 23), misst die Weite
  neu, statt die 1e-7 von hier zu übernehmen.
- **„Ein- *und* Ausgaben" gilt weiterhin für die Sim, im Client nur für Eingaben.**
  `fill.ts` rastert seine Ausgabe zurück, weil sie **gespeichert** wird und jede
  Folgeoperation darauf aufbaut. Der Carve speichert nichts Autoritatives; sein Ergebnis
  betritt den Clipper nur über `snappedDifference` wieder, und das rastert es dort. Der
  Effekt ist derselbe, die Stelle eine andere.

## Nachtrag (2026-08-01, Ticket 26) — was der Sweep nicht sehen kann, muss ihm gegeben werden

Diese ADR stellt die Robustheit des Fills auf exakte Prädikate plus Gitter. Beides
beantwortet die Frage „liegt dieser Punkt links oder rechts" — keines beantwortet „ist
dieser Ring überhaupt ein Gebiet". Ticket 26 fand die Lücke, die daraus folgt: eine
**schnurgerade** Überfahrt faltet `appendTrailPoint` auf zwei Punkte (bewusst, damit gerade
Fahrten O(1) Vertices kosten), und ein Zwei-Punkt-Ring hat Fläche 0. Der Sweep verarbeitet
ihn tadellos — er trägt nur nichts bei: keine Vereinigung, kein Loch, kein Fang. Die
Mechanik versagte damit genau bei dem Manöver, das man geradeaus fährt (über eine kleine
Lücke im eigenen Rand).

Die Konsequenz für diese Entscheidung: **entartete Eingaben sind kein Robustheitsproblem,
sondern ein Repräsentationsproblem, und sie werden vor dem Clipper gelöst.** `closeLoop`
legt dem Loop bei Fläche unter `DEBRIS_AREA_WU2` ein **Dichtband** von 1e-6 WU Halbbreite
bei (`polylineBand`) — 10× die Gitterweite, damit das Snapping es nicht flachdrückt, und
selbst über 200 WU Trail nur 1/40 der minimalen Fill-Fläche, damit es nie selbst zum Fang
führt. Der Ring bleibt daneben stehen: „Fläche 0" heisst nicht „deckt nichts" (ein sich
überkreuzender Trail hebt sich vorzeichenmässig auf, und der Sweep löst ihn korrekt zu
seinem echten Land auf) — das Band **addiert**, es ersetzt nicht.

Der Golden-Replay-Hash bleibt dabei unverändert, und zwar nachgewiesen statt zufällig: sein
einziger Fill hat 13 Trail-Punkte und einen Ring von 13,5 WU² — kein Band wird dort gebaut.

Ein Preis wird dabei bewusst bezahlt, in derselben Währung wie das Gitter selbst: das Band
liegt im Loop, wird also mit-vereinigt und mit-ausgestanzt. Ein entarteter Fang nimmt
deshalb zusätzlich zur Tasche einen ≤ 2e-6 WU breiten Streifen entlang des Trails —
Land, das §2.2 nicht „eingeschlossen" nennt, im Extremfall (200 WU Trail) 4e-4 WU². Das ist
drei Grössenordnungen unter dem Sliver-Boden und dieselbe Art von Handel wie die ≤ 5e-8 WU,
um die das Gitter jede Grenze verschiebt; die Disjunktheit bleibt gewahrt, weil Gewinner und
Verlierer denselben Streifen aus derselben Geometrie sehen.
