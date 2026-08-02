# 30 — Eine Gebietseinnahme füllt die eingeschlossene Fläche nicht ganz

**Beobachtung (User-Playtest 2026-08-02):** „Es gibt teilweise die komische Situation, dass
eine Gebietseinnahme (Verbindung zwischen dem eigenen Territorium) nicht die gesamte Fläche
ausfüllt. Ich weiss nicht genau wann es auftritt, aber habe es schon einige Male bemerkt."

Im Screenshot: ein lilanes Gebiet, in dem eine graue Fläche liegt, die **rundum** von
eigenem Land umschlossen ist — links eine Gebietssäule, rechts ein Block, unten die grosse
Masse, oben ein hauchdünner Streifen frisch gefangenen Lands. Beide Enden des Streifens
hängen sichtbar am Gebiet. Die Tasche wird auch von keinem späteren Fill je nachgeholt.

**Blocked by:** — (unabhängig)

**Status:** resolved (2026-08-02)

## Befund: die Loch-Füllung liest die Union, bevor sie aufs Gitter kommt

`closeLoop` (`sim-core/fill.ts`) erobert Eingeschlossenes in zwei Schritten: `union(Gebiet,
Loop)`, dann **jedes Loch der Union füllen**. Das beantwortet aber die *topologische* Frage
— und die weicht genau einmal von dem ab, was das Auge sieht: wenn die Aussengrenze die
Tasche zwar umrundet, sie aber durch einen **Hals von wenigen Gitterzellen** offen lässt.
Dann ist die Tasche kein Loch, sondern eine **Bucht**; die Loch-Füllung findet nichts, und
der Ring läuft einmal falsch herum um die Tasche und wieder zurück.

Reproduziert in der Bot-Arena (`bench/fill-budget`, Seed 20260730, 200 WU, 8 Bots), Tick
670, Spieler 5 — die rohe Union-Ausgabe, Vertex 54 und 65 desselben Aussenrings:

| | Koordinate |
| --- | --- |
| Vertex 54 | `(49.335698900784706, 96.65983593819055)` |
| Vertex 65 | `(49.335698888718944, 96.65983586350518)` |
| Abstand | **7,57e-8 WU** |
| Fläche der Teilschleife dazwischen | **−1,168 WU²** (negativ = nicht besessen) |

Das negative Vorzeichen ist der ganze Befund: die Grenze umrundet dort 1,17 WU² Land, das
dem Spieler nicht gehört. `territoryArea` (Shoelace) und `pointInTerritory` (Even-Odd)
sind sich darüber **einig** — die Sim ist in sich konsistent, sie hat nur nicht gefüllt.

Der Hals ist 7,6e-8 WU breit: **ein Zehnmillionstel** der Arena, ein Zehnmillionstel einer
Kopfbreite. Kein Spieler kann ihn sehen, treffen oder durchfahren. Für das Auge ist die
Tasche geschlossen — und deshalb ist die Beschwerde berechtigt, obwohl die Geometrie
formal recht hat.

## Warum „exakt gleicher Vertex" als Kriterium nicht reicht

Naheliegend wäre, auf **doppelte Vertices** zu prüfen: das Snap-Gitter (1e-7, ADR-0007)
schnappt zwei Punkte, die näher als eine Zelle liegen, ohnehin auf denselben Gitterpunkt,
und dann steht die Einschnürung exakt im gespeicherten Ring. Genau das passiert oben — der
gespeicherte Ring trägt den Punkt `(49.3356989, 96.6598359)` zweimal.

Gemessen über **10 Minuten** derselben Arena, alle Buchten mit Hals < 1e-3 WU:

| | Beobachtungen (1-Hz-Stichprobe) | grösste Tasche |
| --- | --- | --- |
| Hals **exakt 0** (zugeschnappt) | 6 | 1,17 WU² |
| Hals **> 0** (offen geblieben) | **134** | **3,63 WU²** |

Die offenen Hälse messen 4,00e-7 / 7,07e-7 / 8,06e-7 WU — vier bis acht Gitterzellen, also
benachbarte, aber verschiedene Gitterpunkte. Ein Fix auf Punktgleichheit hätte **6 von 140**
Fällen erwischt und die grösseren allesamt verfehlt.

Das Snappen ist damit auch nicht die Ursache, sondern nur der Würfel darüber, ob eine
Bucht als Einschnürung sichtbar wird oder nicht. Die Ursache ist, dass die Union überhaupt
Hälse dieser Breite produziert — unvermeidlich, sobald ein Trail fast entlang der eigenen
Gebietskante zurückkommt.

## Fix: die Frage nach dem Snappen ein zweites Mal stellen

`sealEnclosedBays` (`sim-core/geometry.ts`) läuft über jeden gitter-gesnappten Aussenring
der Eroberung und schneidet die Teilschleifen heraus, die **gegen** den Ring gewickelt sind
und deren Ein-/Ausstieg näher als `SEALED_NECK_WU` beieinander liegen. Gefragt wird damit
nicht mehr „ist das topologisch ein Loch?", sondern die Frage des Spielers: **ist das Land
eingemauert?** Ein Hals unterhalb der Schwelle ist kein Weg hinaus.

`SEALED_NECK_WU` = **1e-4 WU**, aus drei Richtungen belegt:

- **Drei Grössenordnungen über dem Snap-Gitter** (1e-7) — die gemessenen Hälse liegen bei
  4e-8…8e-7, alle deutlich darunter.
- **Vier Grössenordnungen unter allem Spielbaren.** Ein Kopf ist 1 WU breit und macht
  0,1 WU pro Tick (`MIN_TRAIL_STEP_WU`); die engste Lücke, auf die jemand zielen kann, ist
  tausendfach breiter.
- **Es ist die Auflösung, an der der Client ohnehin aufhört** — das Carve-Gitter ist
  1e-4 WU (Ticket 25). Was der Renderer nicht auseinanderzeichnen kann, ist kein Hals.

Gegen-Wickelung ist die zweite Bedingung und nicht kosmetisch: eine **gleich** gewickelte
Teilschleife ist eine Taille im eigenen Land (zwei Lappen, die sich berühren) — echte
Geometrie, die unangetastet bleibt.

Die herausgeschnittenen Buchten wandern zu den `pockets` und damit in die **gewonnene
Region**, mit der gestohlen wird: die Tasche gehört jetzt dem Färber, also muss fremdes
Land darin ausgeschnitten werden (spec §2.2), sonst gehörte es zweien.

## Wirkung und Preis (gemessen)

- Dieselben 10 Minuten Arena nach dem Fix: **140 → 0** Buchten, keine einzige mehr.
- **Tick-Kosten unverändert.** Der 50-WU-Lauf fliegt vorher/nachher denselben Pfad
  (1 750 Vertices, 2 527 Schlüsse, 79 Tode — bit-identisch), und darauf gemessen:
  mean 0,27 → 0,26 ms, p95 1,09 → 1,07 ms. Die Suche läuft über ein Hash-Gitter statt über
  einen quadratischen Sweep, und die Fläche einer Teilschleife wird erst gemessen, wenn ein
  Paar den Abstandstest bestanden hat — in einem Lauf ohne Buchten also nie.
- **Der 200-WU-Lauf fliegt einen anderen Pfad** (7 408 → 7 369 Vertices, 1 368 → 1 323
  Schlüsse) und die Baseline in `bench/fill-budget/src/budget.test.ts` ist neu aufgezeichnet.
  Das ist der Fix selbst: ab dem ersten gefüllten Kammer-Fall besitzt ein Bot Land, das er
  vorher nicht hatte, und fliegt ab da anders. Dass der 50-WU-Lauf **bit-identisch** bleibt,
  ist der Beleg, dass die neue Regel feuert und nicht die Arithmetik darunter verrutscht ist.
- Der **Golden-Replay-Hash rotiert nicht** — im Skript kommt keine solche Kammer vor.

## Watch-Items

- Erkannt werden **Vertex-Paare**. Ein Hals, dessen engste Stelle zwischen zwei Kanten
  ohne Vertex liegt, fällt durch. In den gemessenen 140 Fällen kam das nicht vor (der
  Martinez-Sweep setzt an solchen Fast-Berührungen Schnittpunkte), aber es ist die Annahme,
  die kippen könnte.
- Die **Carve-Ausgabe** (`others`) wird bewusst *nicht* entbuchtet: dort wäre eine Bucht
  Land, das der Gewinner gerade genommen hat. Sie dem Opfer zurückzugeben würde die
  paarweise Disjunktheit brechen (spec §9.2).
