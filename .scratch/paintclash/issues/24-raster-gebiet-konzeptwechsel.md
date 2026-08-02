# 24 — Konzeptwechsel: Gebiet als Raster statt Polygon

**What to build:** Zur Entscheidung, nicht sofort zum Bau. Das Gebiet (nur das Gebiet —
Kopf, Trail und Kollision bleiben kontinuierlich) würde als **festes Zellgitter** geführt
statt als Multipolygon: `ownerId` je Zelle, Fill = Scanline-Flood-Fill der eingeschlossenen
Region. Das ist, was paper.io/splix tun, und der Grund, warum die stundenlang gleichmässig
laufen: die Kosten hängen an der **bemalten Fläche**, nie an der Historie.

**Blocked by:** ~~23~~ — erledigt am 2026-08-02, s. Kommentar unten. War echt, nicht formal: T23 misst, ob ein blosser Engine-Tausch
reicht. Reicht er, ist dieses Ticket **wontfix**; siehe „Warum das warten muss".

**Status:** **wontfix** (2026-08-02, menschliche Entscheidung) — der Engine-Tausch aus
[Ticket 23](23-fill-vertexzahl-wachstum.md) hat die Lags im laufenden Spiel deutlich
gesenkt, damit wird dieser Konzeptwechsel nicht mehr gebraucht. Das ist der Ausgang, den
die „Empfehlung" unten für genau diesen Fall vorzeichnet. Das Ticket bleibt als
Entscheidungs-Archiv stehen; die eine Zeile, die den Tausch überlebt hat, ist die
**Bandbreite** und die ist jetzt [Ticket 29](29-gebiets-deltas-statt-vollbild.md).

Bedingung für ein Wiederaufmachen (bewusst benannt, damit es nicht aus dem Bauch passiert):
Die CPU-Begründung dieses Tickets kommt nur zurück, wenn `bench:steady` bei 200 WU über
4 h **wieder** ein Plateau verfehlt *oder* Ticks über Budget zeigt — beides misst der Bench
heute und beides steht dort auf 0. Alles andere (Look, Disjunktheit als Struktur,
`pointInTerritory` in O(1)) sind Vorteile, aber keine Not.

## Warum das warten muss (das Argument hat sich umgedreht)

Ticket 22 argumentierte: „konstante Faktoren kaufen Zeit, keine Immunität — die Kurve
steigt weiter". Auf **30 min gemessen stimmt das nicht**: die Vertex-Zahl sättigt nach
~7 min bei ~6 500 und bleibt dort (t=450–870 s: 6 592 → t=900–1770 s: 6 473, **−1,8 %**).
Sie *kann* auch nicht davonlaufen — sie ist `Randlänge / 0,45 WU`, der Abstand ist durch
Tempo × Tickdauer fest und die Randlänge durch die Karte beschränkt.

**Damit kippt die Logik:** gegen ein *beschränktes* Plateau ist ein ausreichend grosser
konstanter Faktor eine **dauerhafte** Lösung, kein Aufschub. Bei 1,2 % Ticks über Budget
(p99 51,9 ms, max 138 ms) genügt ein Faktor 10, um das Plateau mit ~5 ms p99 zu erschlagen
— für immer, weil das Plateau nicht wandert. Ein Konzeptwechsel wäre dann teuer bezahlte
Redundanz.

Und ein Faktor 10 liegt möglicherweise **schon im Repo**: `client/render/carve.ts` hat
exakt dieses Problem bereits gelöst und dokumentiert es —

> „the sim's clipper, polyclip-ts, runs on arbitrary-precision arithmetic — a one-shot band
> difference costs ~1 s at 500 trail points and froze the frame […] this module uses
> `polygon-clipping` (same Martinez sweep, float + robust predicates, **~10× faster**)"

Der Client fährt also seit Ticket 06 produktiv eine 10× schnellere Engine, während der
`sim-core` bei der arbitrary-precision-Variante blieb. Der Grund dafür war **Robustheit**,
nicht Determinismus: float-Martinez ist im Sinne von ADR-0003 (gleiche Eingaben → gleiche
Ausgaben, nicht maschinen-bit-exakt) genauso deterministisch. Das Snap-Gitter existiert
ohnehin genau dafür, float-Robustheit zu tragen. Das ist T23s erster Versuch, und er ist
ein Tag Arbeit, kein Quartal.

## Der eine Vorteil, den ein Engine-Tausch NICHT bringt: Bandbreite

Bisher unbeachtet, weil alle Messungen CPU massen. `encodeTerritory` schickt bei **jedem**
Fill das **komplette** Gebiet eines Spielers an **jeden** Client, 8 Byte je Vertex:

| | Dauerzustand (200 WU, 8 Entities) |
|---|---|
| Vertices je Spieler | ~809 |
| Gebiets-Frame | ~6,3 KB |
| Fills | 4,85/s |
| Egress | 31 KB/s je Client, **245 KB/s** je Arena |
| | **≈ 0,9 GB pro Stunde und Arena** |

Das skaliert mit derselben Vertex-Zahl wie die CPU — ein schnellerer Clipper ändert daran
**nichts**. Ein Raster verschickt stattdessen Zell-Deltas des bemalten Bereichs: ein paar
hundert Byte RLE statt 6,3 KB.

**Wem das weh tut — und wem nicht.** *Nicht* der Cloudflare-Rechnung: die eigene Recherche
zu T13 hält fest, dass Workers/DO **keine Egress-/Bandbreitenkosten** berechnen, und das
Duration-Budget (13 000 GB-s/Tag auf Free) läuft über Wanduhr, nicht über Bytes. Die
frühere Einordnung „Free-Tier-Kostenrisiko" in diesem Ticket war falsch. Es trifft
stattdessen:

- **das Datenvolumen der Spieler** — 31 KB/s sind ~110 MB pro Stunde und Client, für ein
  2D-Browserspiel auf Mobilfunk viel;
- **die Client-CPU** — jeder 6,3-KB-Frame ersetzt ein ganzes Gebiet, also Neu-Tesselierung
  des Plateaus plus Carve-Neuberechnung (`carve.ts` drosselt die schon heute), ~5× pro
  Sekunde.

Damit bleibt es ein eigenständiges Argument, aber ein **Qualitäts-**, kein Sicherheits-
oder Kostenargument.

(Zwischenlösung, falls nur die Bandbreite stört und die CPU nach T23 passt: Gebiets-Deltas
statt Vollbild senden, oder Gebiete für den Versand dezimieren. Beides deutlich kleiner
als ein Konzeptwechsel und sollte vorher geprüft werden.)

## Was der Wechsel gewinnt

- **Kosten historieunabhängig**, dauerhaft und beweisbar, nicht empirisch: Fill kostet
  „bemalte Zellen", nicht „was ich je gemalt habe".
- **Disjunktheit wird strukturell unmöglich zu verletzen** — eine Zelle hat genau einen
  Besitzer. Damit entfällt eine ganze Fehlerklasse, gegen die die Tickets 04/06/22
  gekämpft haben: korrupte Topologie, Verwirkungs-Semantik, `validPolyTopology`,
  Debris-Ringe, Gitter-Splitter (`LATTICE_NOISE_WU2`), die Sliver-Untergrenze.
- **`pointInTerritory` von O(Vertices)-Raycast auf O(1)-Array-Zugriff** — das läuft **pro
  Spieler pro Tick**, ist heute in der Messung unter dem Fill versteckt und wächst mit
  derselben Zahl.
- Fläche fürs Scoring = Integer-Zähler, inkrementell gepflegt; kein `territoryArea` mehr.
- Kein Dritt-Clipper mehr im Determinismus-Pfad.

## Nachteile — ehrlich, das ist die eigentliche Frage

1. **Der Look ist Spielidentität und steht auf dem Spiel.** Spec §4.1/4.2 und
   `client/render/carve.ts`: erhöhte Plateaus mit organischen Rändern, und der Trail fräst
   eine **echte Rinne** durch fremdes Plateau, deren Wände korrekt schattieren. Zellen
   geben Treppenkanten. Abhilfe (Marching Squares + Glättung) heisst: aus dem Raster
   wieder Polygone gewinnen — man zahlt Kontur-Extraktion und holt sich einen Teil des
   Problems zurück. Risiko in einem Satz: es sieht aus wie **splix** (blockig) statt wie
   **paper.io** (rund) — paper.io ist zwar auch gitterbasiert, rendert aber mit hoher
   Zellauflösung und gerundeten Ecken.
2. **Quantisierung trifft auf kontinuierliche Bewegung — und ändert Spielverhalten.**
   Konkret prüfbar: der Test „fills a deliberate shallow edge-hugging loop well under
   1 WU²" schützt einen bewussten Fill von **0,6 WU²**. Bei 0,5-WU-Zellen sind das ~2
   Zellen; eine 0,3 WU tiefe Exkursion malt womöglich **gar nichts** mehr. Das ist keine
   Rundung, das ist eine Regeländerung, und sie betrifft genau die Feinsteuerung, die
   §2.2 („jeder bewusste Loop färbt") zugesichert hat. Zellgrösse ist damit eine
   **Balance-Entscheidung**, keine technische.
3. **Grösster Blast Radius des Projekts.** Berührt spec §2.2 (eine *begründet gelockte*
   Entscheidung: „Polygonbasiert (kontinuierliche Bewegung), nicht der zellbasierte
   Flood-Fill aus splix"), ADR-0007 komplett, das Wire-Format, den Renderer inkl.
   Carve-Effekt, `sim-core/geometry.ts`, Score/Leaderboard-Flächen, den Golden-Replay-Hash.
   Braucht eine eigene ADR, die ADR-0007 ersetzt.
4. **Speicher je Arena** steigt von „so gross wie die Polygone" auf konstant 156 KB
   (400×400 u8, 0,5 WU) bzw. 625 KB (0,25 WU). Gegen 128 MB DO-Limit unkritisch, aber es
   ist Grundlast auch in einer leeren Arena — und ADR-0004 will, dass leere Arenen billig
   hibernieren.

## Empfehlung

**Jetzt nicht bauen.** Reihenfolge:

1. T23 spiked den Engine-Tausch (zuerst `polygon-clipping`, das schon im Repo ist; sonst
   Clipper2-WASM). Misst am 1 800-s-Bench.
2. Hält der Dauerzustand danach das Budget → dieses Ticket auf **wontfix**, aber die
   **Bandbreiten-Zeile bleibt offen** und wird ein eigenes, kleines Ticket (Gebiets-Deltas).
3. Hält er nicht → dieses Ticket wird gebaut, mit ADR und einer Balance-Entscheidung zur
   Zellgrösse, und Punkt 2 der Nachteile wird vorher an einem Prototyp geprüft
   (`/prototype`), nicht im Produktionscode.

_Referenz: spec §2.2, §4.1/4.2, §9.2, §10.5; ADR-0004, ADR-0007. Zahlen aus Ticket 22/23
(`bench/fill-budget`, 30-min-Lauf, Seed 20260730)._

## Comments

### 2026-08-02 (nach [Ticket 23](23-fill-vertexzahl-wachstum.md)) — der Blocker ist weg, und mit ihm das CPU-Argument

Ticket 23 ist **resolved**: der Engine-Tausch ist gebaut und gemessen. Damit greift die
Reihenfolge, die die „Empfehlung" unten vorzeichnet, Punkt 2 — mit einer Präzisierung.

**Was erledigt ist.** Der Dauerzustand hält das Budget: 200 WU, 8 Bots, **vier Stunden**,
**0–2 Ticks über 50 ms von 288 000** (vorher 2 389 über 30 min). Und der Satz weiter oben
in diesem Ticket — „gegen ein *beschränktes* Plateau ist ein ausreichend grosser
konstanter Faktor eine **dauerhafte** Lösung" — steht wieder, weil das Plateau steht: über
4 h driftet die Vertex-Zahl **−3,2 %**. Die zwischenzeitliche Gegenmessung (+33,3 %) war
ein zu schmales Vergleichsfenster gegen einen Sägezahn mit Perioden von Dutzenden Minuten,
kein Wachstum.

**Was nicht erledigt ist.** Die **Bandbreiten-Zeile** — ~31 KB/s je Client, ~0,9 GB pro
Stunde und Arena, weil `encodeTerritory` bei jedem Fill das komplette Gebiet an jeden
Client schickt. Kein Clipper berührt das. Sie ist damit das **einzige** verbliebene
Argument dieses Tickets, und sie hat eine viel billigere Antwort als ein Konzeptwechsel:
**Gebiets-Deltas statt Vollbild**. Dafür gibt es weiterhin kein eigenes Ticket; es wäre
der nächste Schritt, bevor irgendjemand das Raster ernsthaft erwägt.

Die Bandbreiten-Zeile ist inzwischen das eigene Ticket, das die „Empfehlung" unten für
diesen Fall vorsieht: [Ticket 29](29-gebiets-deltas-statt-vollbild.md).

**Der Status blieb zunächst `needs-triage`, obwohl das Gate von Ticket 23 wörtlich
vorschreibt: „Reicht der Faktor: Ticket auflösen und Ticket 24 auf `wontfix`."** Der Faktor
reichte — der Status wurde trotzdem nicht gesetzt, weil der Mensch am selben Tag, beim
Öffnen jenes Gates, Interesse an dem Ansatz geäussert hatte („paper.io sieht auch sehr
smooth aus … dann wäre vielleicht Ticket 24 die nachhaltigste Lösung"). Ein Ticket
zuzuklappen, während danach gefragt wird, ist keine Entscheidung für einen
Implementierungslauf.

**Nachgereicht am selben Tag: der Mensch hat entschieden.** Nach dem Spielen gegen den
getauschten Stand — „Dieser Commit hat die Lags deutlich minimiert" — lautet die Ansage
`won't do`, „weil wir es nicht mehr benötigen". Der Status oben ist entsprechend gesetzt.
Was damit ausdrücklich **nicht** entschieden ist: dass Raster der schlechtere Entwurf wäre.
Er wird nur nicht mehr gebraucht — die Kosten sind kein Argument mehr, die Bandbreite
gehört Ticket 29, und was übrig bliebe, wäre der Look. Würde das jemand später doch
angehen, gehörte als Erstes ein `/prototype` daneben (hohe Zellauflösung, gerundete Ecken,
Trail-Rinne): Nachteil 1 und 2 sind an einem Bild in Minuten zu beurteilen und an diesem
Text gar nicht.
