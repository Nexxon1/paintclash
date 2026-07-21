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
