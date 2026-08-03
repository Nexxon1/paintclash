# bench/territory-bandwidth — Gebiets-Egress und der Preis der Dezimierung (Bau-Ticket 29)

> **Stand 2026-08-03, erste Messung (4 h Arena-Zeit, 200 WU, 8 Entitäten, Seed `20260730`):**
> Der Egress liegt bei **76,4 KB/s je Client** — **2,5× über** den ~31 KB/s, mit denen
> [Ticket 24](../../.scratch/paintclash/issues/24-raster-gebiet-konzeptwechsel.md) und
> Ticket 29 rechnen. Die Dezimierung für den Versand **trägt**: 2,38× bei genau der
> Toleranz, die `carve.ts` schon ausliefert und „unsichtbar" nennt. Sie ist aber nicht
> gratis — sie **löscht** kleine Gebietsstücke, und das ist eine Entscheidung für den
> Menschen, keine Nebenwirkung. Tabellen und Lesart unten.

Misst die eine Zeile, die der Engine-Tausch aus
[Ticket 23](../../.scratch/paintclash/issues/23-fill-vertexzahl-wachstum.md) nicht angefasst
hat: **jeder Fill schickt das komplette Gebiet eines Spielers an jeden Client**
(`arena.ts`, spec §6.1). [Ticket 29](../../.scratch/paintclash/issues/29-gebiets-deltas-statt-vollbild.md)
verlangt zwei Zahlen, bevor daran gebaut wird — „**Messen, bevor gebaut wird.** Es gibt heute
keinen Bandbreiten-Bench" und „diese Variante [Dezimierung für den Versand] **zuerst
abschätzen**" — und dieser Bench liefert beide in einem Lauf.

```sh
pnpm --filter @paintclash/bench-territory-bandwidth test    # Prämisse + Arithmetik (~1 s)
pnpm --filter @paintclash/bench-territory-bandwidth bench   # Messung: 4 h Arena-Zeit
```

Läuft bewusst **nicht** im Root-Test/Coverage-Gate (spec §9.3). Seed gepinnt (`20260730`).

## Was gemessen wird — und was nicht

Gefahren werden die **echten** Teile: `sim-core`s `step` und die **echten** `BotPilot`s über
dieselbe Intent-Naht wie `ArenaCore` (ADR-0005), und für die Bytes der **echte**
`encodeTerritory`. Nachgebaut ist nur die Auswahl der Frames — dieselbe Reihenfolge wie
`ArenaCore.tick`: ein `sync` je Toten, Spawn und Steal-Opfer (dedupliziert), danach ein
`fill` je Loop-Schluss.

Weg ist allein der **Transport**. Das ist Absicht: die Frage ist, wie viele Bytes die Arena
pro Sekunde an jeden Socket übergibt, und daran ändert ein WebSocket nichts.

**Die eine Grösse, die nicht gemessen sondern angenommen ist: die Client-Zahl.**
Gebiets-Frames gehen an _jede_ verbundene Session, eine Bot-Arena hat aber keine Sockets.
Darum gilt:

- **je Client** = was _eine_ Session empfängt. Diese Zahl hängt an der Zahl der **malenden
  Entitäten** (hier 8), nicht an der Zahl der Zuschauer.
- **je Arena** = diese Zahl × Zahl der **menschlichen** Sockets. Im Produktions-Default
  (1 Mensch + 7 Bots) sind Arena-Total und Client-Zahl deshalb **dasselbe**; Ticket 24s
  „245 KB/s je Arena" ist der Fall _acht Menschen_, und die Populationsgrenze liegt bei 16
  (Ticket 16).

## Warum vier Stunden

Dieselbe Lehre wie bei [`../fill-budget`](../fill-budget/): die Vertex-Zahl ist ein
**Sägezahn** mit einer Periode von Dutzenden Minuten — Gebiete wachsen, jemand stirbt, sein
Land fällt auf einen 6×6-Block zurück. Der Egress ist eine Funktion derselben Kurve und erbt
die Regel: **ein Halbfenster muss mehrere Sägezahn-Perioden breit sein**, sonst misst es die
Phase, in der es gelandet ist, und nennt sie einen Trend. 1 800 s Einschwingzeit,
danach 2 × 6 300 s.

Der Lauf sichert **keine Byte-Grenze** zu — nur seine eigenen Prämissen (Plateau erreicht,
Bots haben gemalt, die Dezimierung dezimiert überhaupt). Ticket 29 ist `needs-triage`, seine
Akzeptanz ist „messen und abschätzen, dann entscheiden"; es gibt kein abgenommenes Budget zu
halten, und ein Bench, der an einem menschlich zu entscheidenden Fund scheitert, ist ein
dauerhaft roter Bench.

## Die Toleranzen, an dem gemessen wird, was man sieht

Ein Trail ist **1 WU** breit (`BALANCE.trail.widthWU`), ein Gitterquadrat **10 WU**. Danach
lesen sich die Toleranzen so:

| Toleranz | in Sichtbarem                                                                        |
| -------- | ------------------------------------------------------------------------------------ |
| 0,05 WU  | 5 % der Trailbreite — Ticket 23s Grenze für **sim-ehrliche** Geometrie (dort: 1,11×) |
| 0,10 WU  | 10 % — was `carve.ts` für Voll-Recarves schon ausliefert und dort „unsichtbar" nennt |
| 0,25 WU  | ¼ Trailbreite                                                                        |
| 0,50 WU  | ½ Trailbreite                                                                        |
| 1,00 WU  | eine ganze Trailbreite, 1/10 Gitterquadrat                                           |

Gemessen wird je Toleranz nicht nur die Ersparnis, sondern auch, was sie kostet — und zwar
in **zwei getrennten Grössen**, weil die Dezimierung zwei verschiedene Dinge tut:

- **Umriss-Wanderung** (Stücke, die sie _behält_): die grösste Distanz eines Original-Vertex
  zur Grenze **desselben, vereinfachten Stücks**, in WU. Das ist die Frage „sieht ein Spieler
  es?". O(V²) je Stück und deshalb **gestichprobt** (einmal je Arena-Minute); die Tabelle
  nennt die Stichprobenzahl.
- **gelöschte Stücke** (Stücke, die sie _verliert_): Anzahl, plus Dicke und Fläche des
  schlimmsten. Ein Stück, dessen Aussenring unter ein Dreieck fällt, ist kein Polygon mehr
  und wird nicht verschickt.

**Diese Trennung ist keine Ordnungsliebe, sie war ein Messfehler.** In der ersten Fassung
wurde beides in einer Zahl gemessen — jeder Original-Vertex gegen alles, was übrig blieb —
und eine gesättigte Arena meldete daraufhin **18,5 WU „Umriss-Wanderung" bei 0,05 WU
Toleranz**, also fast zwei Gitterquadrate für eine Toleranz von einem Zwanzigstel
Trailbreite. Die Zahl war nie ein Umriss: sie war die Distanz von einem weit entfernten
gelöschten Splitter zum nächsten echten Land. Getrennt gemessen trifft die
Umriss-Wanderung **exakt** die Toleranz, wie RDP es zusichert.

Ausdrücklich **nicht** `distanceToTerritory` aus `sim-core`: das meldet 0 für alles im
Inneren und würde damit eine abgeschnittene Ecke — genau das Artefakt der Dezimierung — als
perfekte Übereinstimmung verbuchen.

### Warum die Dezimierung hier anders zu beurteilen ist als in Ticket 23

Ticket 23 hat Toleranz-Simplifikation an der **Sim**-Geometrie gemessen und verworfen. Zwei
seiner drei Gegenargumente greifen für den **Versand** nicht:

- **Fläche = Score** (spec §10.5): gilt für die Sim-Wahrheit. Der Score wird serverseitig aus
  ihr gerechnet; eine gröber _gezeichnete_ Grenze verschiebt keinen Punkt.
- **Paarweise Disjunktheit** (spec §9.2): eine Invariante der Sim. Auf dem Versandweg wäre
  eine Überlappung ein _Bild_, kein Rechenfehler.

Was bleibt und in dieser Tabelle nicht steht, weil dieser Bench es nicht misst: RDP kann
einen Ring bei grober Toleranz **selbst schneiden**, und die Vereinfachung schiebt Grenzen
auch nach **aussen**, sodass zwei Nachbar-Plateaus sichtbar überlappen können. Beides ist
Aufgabe eines Bau-Tickets, nicht dieser Schätzung — hier steht nur, ob sich der Bau lohnt.

## Messung 2026-08-03: der Vorher-Wert

`pnpm --filter @paintclash/bench-territory-bandwidth bench`, 8,5 min Wanduhr für 4 h Arena.

|                                    | Ticket 24 / 29 nahmen an | **gemessen**             |
| ---------------------------------- | ------------------------ | ------------------------ |
| Gebiets-Frames/s je Client         | 4,85 (nur Fills)         | **8,14**                 |
| **mittlerer** Frame                | ~6,3 KB                  | **9,4 KB**               |
| Egress je Client                   | 31 KB/s                  | **76,4 KB/s**            |
| je Client und Stunde               | ~110 MB                  | **~268 MB**              |
| grösster **einzelner** Frame       | —                        | **27,6 KB**              |
| _hypothetisch_, 8 Menschen-Sockets | 245 KB/s                 | **611 KB/s** (2,10 GB/h) |

Die letzte Zeile ist die Lesart aus Ticket 24 und **nicht** der Produktions-Default: dort
sitzt 1 Mensch neben 7 Bots, und Bots halten keinen Socket — Arena-Total = Client-Wert.

Über den Lauf (Ganzlauf-Zählungen, anders als die Raten oben, die den Nachlauf ab 1 800 s
mitteln): 83 543 Fill-Frames, 33 059 Sync-Frames, 117 Tode. Als Ganzlauf-Raten sind das
5,80 + 2,30 = 8,10 Frames/s, gegen 8,14 im gemessenen Fenster. Plateau-Prüfung
(2 × 6 300 s nach 1 800 s): 81,1 → 71,6 KB/s, **−11,7 %** — innerhalb der 15-%-Schranke,
also ein Plateau, aber am unteren Rand; `fill-budget` liest über dasselbe Fenster −3,2 % auf
der Vertex-Zahl.

**Warum die alte Zahl zu klein war.** Die 2,5× zerlegen sich sauber in zwei Faktoren, die
sich multiplizieren:

1. **Die Frame-Rate war 1,68× höher als gerechnet** (4,85 → 8,14/s), weil die Sync-Frames
   ganz fehlten. `arena.ts` schickt ein Gebiet nicht nur beim Fill, sondern auch bei jedem
   Tod, Spawn und **Steal** — und Steals dominieren: von 33 059 Sync-Frames gehen nur 125 auf
   Spawns und Tode (8 + 117), die übrigen ~32 900 auf Gebietsdiebstahl (2,3/s). **28 % aller
   Gebiets-Frames** hat die alte Rechnung nicht gesehen.
2. **Der mittlere Frame war 1,49× grösser als gerechnet** (6,3 → 9,4 KB). Ticket 24 bepreiste
   ein Gebiet mit ~809 Vertices; im Dauerzustand ist der Mittelwert grösser, und die Spitze
   erreicht 27,6 KB (≈ 3 500 Vertices). Für den Mittelwert zählt der Mittelwert — die
   Spitzen-Zahl steht hier als Streuungsmass, nicht als Begründung.

1,68 × 1,49 = **2,50×**, und 31 KB/s × 2,50 = 77,5 KB/s gegen 76,4 gemessen (der Rest ist
Rundung in den Eingangswerten von Ticket 24). Die Bandbreiten-Zeile ist damit **dringender**
als aufgeschrieben, nicht weniger dringend.

## Messung 2026-08-03: was die Dezimierung bringt und kostet

Was sie **spart**, und wie weit sie einen Umriss verschiebt, den sie behält:

| Toleranz | Bytes/s/Client | Ersparnis | Flächenfehler (schlimmst./mittel) | Umriss-Wanderung |
| -------- | -------------- | --------- | --------------------------------- | ---------------- |
| 0,05 WU  | 57,6 KB        | 1,33×     | 0,16 % / 0,02 %                   | 0,0500 WU        |
| 0,10 WU  | **32,1 KB**    | **2,38×** | 1,01 % / 0,16 %                   | 0,1000 WU        |
| 0,25 WU  | 19,4 KB        | 3,94×     | 2,67 % / 0,43 %                   | 0,2500 WU        |
| 0,50 WU  | 12,4 KB        | 6,17×     | 7,01 % / 0,68 %                   | 0,5000 WU        |
| 1,00 WU  | 7,5 KB         | 10,22×    | 13,23 % / 1,18 %                  | 0,9999 WU        |

Die Umriss-Wanderung trifft **exakt** die Toleranz — das ist die RDP-Zusicherung, und dass
sie über 2 233 gestichprobte Stücke hält, ist die beste Bestätigung, dass hier das Richtige
gemessen wird.

### Gegen Ticket 23 gelesen — die richtige Spalte ist „zweiseitig"

`simplifyRing` baut auf `simplifyPolyline`, also gewöhnliches, **zweiseitiges** RDP. Zu
vergleichen ist deshalb Ticket 23s zweiseitige Spalte, nicht die disjunkt-sichere
Nur-nach-innen-Spalte:

| Toleranz | T23 nur nach innen | T23 zweiseitig (Vertices) | hier (Bytes) |
| -------- | ------------------ | ------------------------- | ------------ |
| 0,05 WU  | 1,11×              | 1,23×                     | **1,33×**    |
| 0,10 WU  | 1,52×              | 2,95×                     | **2,38×**    |
| 0,25 WU  | 2,03×              | 6,90×                     | **3,94×**    |
| 0,50 WU  | 3,35×              | 20,5×                     | **6,17×**    |

Ab 0,10 WU liegt dieser Bench also **unter** Ticket 23, und zunehmend. Das ist kein
Widerspruch, sondern zwei verschiedene Grössen: T23 zählt **Vertices**, hier stehen **Bytes**,
und der Frame-Überhang schrumpft nicht mit — 5 Byte Kopf plus 1 Byte je Stück plus 2 Byte je
Ring bleiben stehen, während die Vertices verschwinden, sodass das Byte-Verhältnis dem
Vertex-Verhältnis notwendig nachläuft. Dazu mass T23 **einen** Schnappschuss mit 4 285
Vertices, dieser Bench 4 h Frames jeder Grösse, kleine Nach-Tod-Gebiete eingeschlossen, die
kaum etwas zu geben haben.

Was sie **löscht** — und hier liegt der Haken:

| Toleranz | Löschungen | je Frame | keine Nadeln | schlimmstes: Dicke / Fläche |
| -------- | ---------- | -------- | ------------ | --------------------------- |
| 0,05 WU  | 6 444      | 0,055    | 6 444        | 4,42e-2 WU / 2,96e-2 WU²    |
| 0,10 WU  | 22 291     | 0,191    | 22 291       | 8,50e-2 WU / 2,00e-1 WU²    |
| 0,25 WU  | 59 466     | 0,510    | 59 466       | 2,13e-1 WU / 1,29e+0 WU²    |
| 0,50 WU  | 106 073    | 0,910    | 106 073      | 4,82e-1 WU / 3,16e+0 WU²    |
| 1,00 WU  | 164 697    | 1,412    | 164 697      | 1,06e+0 WU / 1,16e+1 WU²    |

**Zwei Warnungen zum Lesen dieser Tabelle, beide wichtiger als ihre Zahlen.**

„Löschungen" zählt **Frame×Stück-Ereignisse, keine unterscheidbaren Stücke.** Gezählt wird je
verschicktem Frame, und ein Splitter, der hundert Frames lang im Gebiet eines Spielers liegt,
zählt hundertmal. Gespeicherte Stücke tragen über Frames hinweg keine Identität, dieser Bench
kann sie also nicht unterscheiden und tut auch nicht so. Die belastbare Grösse ist die Spalte
**je Frame**: bei 0,10 WU geht ungefähr jeder fünfte Frame mit etwas Fehlendem raus.

Die Spalte **„keine Nadeln" ist ein Wächter, kein Fund** — und dass sie gesättigt ist, war
vorher klar, nicht gemessen. `sim-core`s `isLandRing` (`fill.ts`) speichert keinen Ring unter
`MIN_LAND_THICKNESS_WU` = 1e-4, und Ticket 31 schloss mit „davon Nadeln: **0**". Ein
gespeichertes Stück ist damit **per Konstruktion** echte Geometrie, und die Dezimierung kann
keine Nadeln löschen, weil keine mehr da sind. Wert hat die Spalte an dem Tag, an dem sie
**abweicht**: dann ist Ticket 31s Invariante oben gebrochen.

Was zu wissen bleibt, ist also nicht „war es ein Artefakt?" (nein, nie), sondern „sieht man
es?" — und das beantwortet die Grösse:

- bei **0,05 WU** ist das schlimmste gelöschte Stück 0,044 WU dick — 4 % einer Trailbreite,
  in jeder realistischen Kameraeinstellung ein Sub-Pixel;
- bei **1,00 WU** ist es 1,06 WU dick und 11,6 WU² gross — breiter als ein Trail und über
  ein Zehntel Gitterquadrat. Das sieht man.

## Lesart: lohnt sich der Bau?

**Ja, und `0,10 WU` ist der Kandidat** — dieselbe Toleranz, die `carve.ts` für Voll-Recarves
schon ausliefert: **2,38×** (76,4 → 32,1 KB/s, ~268 → ~113 MB/h je Client) für 0,16 %
mittleren Flächenfehler und 0,1 WU Umriss-Wanderung.

Drei Dinge, die diese Schätzung ausdrücklich **nicht** zusagt:

1. **Die Client-CPU-Hälfte des Tickets wird nur halb geheilt.** Die Frame-**Rate** bleibt
   8,14/s — jeder Frame ersetzt weiter ein ganzes Gebiet, also tesseliert der Client weiter
   ~8× je Sekunde ein Plateau neu und rechnet den Carve nach. Billiger wird jeder einzelne
   Rebuild (weniger Vertices, und der Carve-Clipper war laut Ticket 25 die Freeze-Quelle),
   die Häufigkeit nicht. **Nur Deltas senken die Rate.**
2. **Gelöschte Splitter sind eine Divergenz, keine Rundung.** Bei 0,10 WU geht etwa jeder
   **fünfte** Frame mit einem fehlenden Stück raus (0,191 Löschungen je Frame), während der
   Server es weiter besitzt und für den Score zählt (spec §10.5). Das schlimmste ist 0,085 WU
   dick, also Sub-Pixel — aber es ist derselbe Fehler-Typ, den Ticket 29 den Deltas vorhält
   („Divergenz zwischen Server- und Client-Polygon wäre ein neuer Fehlerfall"), nur kleiner
   und ohne Reconciliation-Bedarf. **Wie viele _unterscheidbare_ Stücke das sind, sagt diese
   Messung nicht** (s. Warnung oben) — wer das wissen muss, braucht Stück-Identität über
   Frames hinweg, die es heute nicht gibt.
3. **Zwei Risiken sind ungemessen** (s. o.): Selbstschnitt bei grober Toleranz und der
   Aussen-Schub, der Nachbar-Plateaus sichtbar überlappen lassen kann.
4. **Kein „nachher" für den eigentlichen Vorschlag des Tickets.** Gemessen ist der
   Vorher-Wert und die _Alternative_. Was **Deltas** sparen würden, steht hier nicht: der
   Kandidat dafür ist `gainedRegion`, das laut Ticket 29 „in `fill.ts` bereits vorliegt" —
   es ist dort aber lokal und nicht Teil von `TickEvents`, also nicht ohne Eingriff in die
   Sim messbar. Das wäre der erste Schritt eines Bau-Tickets, nicht dieser Schätzung.
