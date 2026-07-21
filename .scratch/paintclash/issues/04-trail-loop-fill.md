# 04 — Trail + Loop-Schluss → Fill (eigenes Gebiet wächst)

**What to build:** Der Kern-Loop des Genres. Fährt man aus dem eigenen **Gebiet** heraus, zieht der Kopf einen **Trail** (außerhalb = kein Safespace); kehrt man mit dem Trail ins eigene Gebiet zurück (**Loop schließen**), wird die vom Loop eingeschlossene Fläche **polygonbasiert gefärbt** und dem eigenen Gebiet zugeschlagen — das Gebiet wächst sichtbar. Im eigenen Gebiet gibt es keinen Trail. Noch ohne Tod und ohne fremdes Gebiet: nur der eigene Färbe-Loop.

**Blocked by:** 03.

**Status:** resolved (2026-07-21)

- [x] `sim-core`: Trail-Tracking ab Verlassen des Gebiets; Loop-Schluss-Erkennung; **polygonbasierter** Fill der eingeschlossenen Fläche (nicht der zellbasierte Flood-Fill aus splix); Flächenberechnung; minimale Fill-Fläche **1 WU²** (nur numerische Splitter verwerfen).
- [x] Fill ist **strikt server-only** — nie client-behauptbar (§6.1).
- [x] `protocol`: Trail-Delta + Gebiets-/Fill-Delta-Nachrichten (kleine Rechtecke/Polygone, Area-of-Interest-tauglich).
- [x] `client`: Trail als durchgezogene, glatte **2D-Linie** auf Bodenhöhe; Gebiet als flaches, zusammenhängendes Plateau mit leichter Kante; Fill-Animation (Höhen-/Farbwelle).
- [x] Property-Tests (§9.2): Flächenanteile aller Spieler + neutral = 100 % (nie negativ / > Karte); Fill erzeugt nie Loch/Überlappung; geschlossener Loop vergrößert eigenes Gebiet ≥ eingeschlossene Fläche.
- [x] Szenario-Test: Sim-Client fährt einen Loop → Gebiet wächst um die erwartete Fläche.
- [x] CI grün inkl. Coverage (§9.7) — alle Gates lokal grün (typecheck, lint, format, 220+ Unit/Property, 7 Szenario, 4 E2E, Coverage-Böden, Build); CI-Lauf folgt mit dem Push.

_Referenz: spec §2.1–2.2, §4.1–4.2, §6.3, §9.2. Architektur: **ADR-0007** (polyclip-ts, Snap-Gitter, Verwirkung, Multipolygon-Gebiet); Vokabular: CONTEXT.md (Gebiets-Nachricht, Trail-Sync, Snap-Gitter)._

## Comments

**2026-07-21 — resolved.** Kern-Loop steht end-to-end: Sim (Trail → Loop → polygonbasierter Fill) → Protokoll v2 → Arena-DO-Broadcast → Browser-Rendering (Plateau + Bodentrail + Fill-Pop). Entscheidungen & bewusste Abweichungen:

- **Engine statt Eigenbau:** boolesche Polygon-Ops über `polyclip-ts` auf einem 1e-7-WU-**Snap-Gitter**; Engine-Fehler ⇒ deterministische **Verwirkung** des Fangs statt Tick-Absturz (ADR-0007, Spike-belegt inkl. eines echten Korruptions-Triggers durch subnormale Doubles — vom Gitter eliminiert).
- **Gebiet = Multipolygon mit Löchern.** Wer einen fremden Block umschließt, bekommt den **Annulus** — fremdes Gebiet bleibt unangetastet (Stehlen = Ticket 06), eingeschlossene Köpfe überleben per Konstruktion. Neu-Spawns werden aus fremdem Land ausgestanzt → Gebiete sind **paarweise disjunkt**, die 100-%-Invariante gilt exakt und ist property-getestet (Summe + neutral, Monotonie, paarweise Schnittfläche ≈ 0, Solo-Fills lochfrei; Rechteck-Loops gegen **analytisch** berechnete Soll-Fläche).
- **„Trail-Delta" konkretisiert als Null-Overhead-Ableitung:** Snapshots tragen nur Posen; Clients leiten Trails aus den Posen ab (identische Regel wie die Sim), voller **Trail-Sync** nur an Spät-Joiner, **Gebiets-Nachricht** ersetzt pro Spieler das ganze Polygon bei Spawn/Fill. Das ist die AoI-Naht; echte Teil-Deltas lohnen erst mit AoI.
- **Splitter-Loops** (< 1 WU²): Loop schließt, Trail endet, Gebiets-Nachricht räumt den Trail client-seitig — aber **keine** Wachstums-Animation (Client animiert nur bei realem Flächenzuwachs).
- **Fill-Animation** = Höhen-Pop + Farbglühen des ganzen Plateaus (ease-out-back). Eine räumlich laufende Welle über die *neu* gewonnene Fläche bräuchte das Zugewinn-Polygon am Client — Politur, sinnvoll zusammen mit dem Überfärben-Visual aus Ticket 06.
- **Bekannte 04→05-Lücke (bewusst):** ohne Tod (Ticket 05) kann ein Trail unbegrenzt wachsen (Sim-seitig unbeschnitten; Wire-Sync deckelt bei 65 535 Punkten, ~55 min Dauerkurven). Selbstschneider löst Ticket 05; Ressourcen-Deckel ist Ticket 15.
- **Verwaiste Löcher** (Besitzer disconnected) bleiben neutral, bis ein späterer eigener Fill sie konsolidiert — Semantik wird mit Ticket 06 geschärft.
- Golden-Replay-Hash **absichtlich regeneriert** (Trail/Gebiet sind jetzt Zustand + Hash); das Fixture-Skript enthält seither ein garantiertes Fill-Manöver und der Replay-Test erzwingt `fills ≥ 1`.

**2026-07-21 — zwei User-Befunde am laufenden Build, beide bestätigt und behoben:**

- **„Trail nicht sichtbar":** bestätigt per Screenshot — die Ribbon-Dreiecke waren mit Normale **nach unten** gewickelt und wurden von oben backface-gecullt (nur verdrehte Segmente blitzten auf). Fix: Winding korrigiert (+y) **plus** `DoubleSide` (kollineare Kehrtwenden verdrehen das Band lokal). Visuell verifiziert: Trail als durchgezogenes Band, Loop-Schluss verschmilzt sichtbar zum Plateau (36 → 64,8 WU² im Test-Lauf).
- **„Sehr kleine Lücken werden nicht gefüllt":** bestätigt per Sim-Probe — ein bewusster flacher Kantenloop (0,3 × 2 WU ≈ 0,6 WU²) fiel unter die 1-WU²-Schwelle und verfiel. Das widerspricht der Spec-*Intention* („nur numerische Splitter verwerfen; **jeder bewusste Loop färbt**"): die 1-WU²-Annahme gilt nur für freistehende Loops (Wenderadius 1,6 ⇒ ≥ ~8 WU²), nicht für Kantenschmiegen. **`minFillAreaWU2` von 1 auf 0,01 nachjustiert** (Balance-Startwert, laut Spec ausdrücklich gegen den spielbaren Build zu tunen); Regressionstest für den 0,6-WU²-Fall ergänzt. Golden-Hash unverändert (der Fixture-Fill lag weit über der Schwelle).

**2026-07-21 — Zwei-Spieler-Sichtprüfung + drei weitere User-Befunde, alle behoben (Screenshots im Session-Scratchpad):**

- **Exit-Gap** („Trail connected nicht immer mit der Startarea"): der eigene visuelle Trail begann erst mit der ersten *Außen*-Pose (bis zu 0,45 WU jenseits der Kante). Fix: wie in Sim und Gegner-Ableitung wird ein frischer Trail mit der **letzten Innen-Pose gesät** — das Band taucht jetzt unter dem Plateau auf, kein Spalt.
- **„Trail laggy/stottrig, nicht so smooth wie die Spielfigur":** der eigene Trail sammelte **Tick-Posen (20 Hz)**, der Kopf rendert aber pro Frame; der Brückenpunkt lag zudem *zwischen* den letzten zwei Tick-Posen → das Band faltete sich an der Spitze jeden Tick kurz zurück. Design geändert: eigener Trail = **gerenderte Frame-Posen** (kollinear-kompaktiert) — per Konstruktion exakt so glatt wie die Figur. Zusätzlich **Mindest-Vorschub 0,1 WU** pro Trail-Punkt (eigen + Gegner): Reconciliation-Wackler (v. a. an Wänden) ätzten sonst einen sichtbaren Sägezahn ins Band (im Zwei-Spieler-Lauf reproduziert).
- **Farbkollision:** Spieler-ID 1 bekam per Golden-Ratio-Hue fast exakt das reservierte Eigen-Blau — im Gegner-Blick ununterscheidbar. Kollidierende Hues werden jetzt am Eigen-Blau vorbeigeschoben (ID 1 → Violett); zusätzlich minimale Höhenstaffelung der Bänder gegen Z-Fighting bei Kreuzungen.
- Zwei-Browser-Lauf verifiziert: beide sehen einander mit korrekt gefärbten Plateaus, lückenlos verbundenen, glatten Trails; Kreuzungen artefaktfrei.
