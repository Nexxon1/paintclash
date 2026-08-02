# 31 — Je länger die Runde läuft, desto mehr Artefakte liegen auf der Karte

**Beobachtung (User-Playtest 2026-08-02):** „Je länger das Spiel geht desto mehr komische
Artefakte sieht man auf der Map. Sieht aus wie kleine Quadrate auf der Map die aber nicht
zum Gebiet von irgendjemand gehören sondern einfach random artefakte sind."

Zwei Screenshots, zwei Erscheinungsformen desselben Dings:

- **`202249`** — dünne, freistehende Striche in Spielerfarbe, verstreut über grauen
  Untergrund, teils 2–3 Rasterquadrate lang.
- **`201920`** — feine diagonale Kratzer **innerhalb** der geschlossenen Fläche des grünen
  Spielers (vom User rot eingekreist), leicht abweichend schattiert.

**Blocked by:** — (unabhängig)

**Status:** resolved (2026-08-02)

## Befund: es sind Nadeln, und sie stehen in der Server-Wahrheit

Reproduziert im Bot-Arena-Harness (`bench/fill-budget`, Seed 20260730, 200 WU, 8 Bots) —
also **nicht** erst im Renderer. Gemessen wurde pro gespeichertem Stück die *Dicke*
`2·|Fläche| / Umfang`, was bei einem langen dünnen Streifen genau seine Breite ist:

| t | gespeicherte Stücke | davon dünner als 0,05 WU |
| --- | --- | --- |
| 30 s | 8 | 0 |
| 60 s | 9 | 1 |
| 120 s | 16 | 8 |
| 180 s | 34 | 18 |
| 240 s | 76 | 48 |
| 270 s | 115 | 82 |
| 300 s | **152** | **105** |

Sie verschwinden nie und sie häufen sich monoton an — exakt das „je länger, desto mehr"
der Meldung. Bei t = 300 s sind **69 % aller gespeicherten Gebietsstücke** keine Gebiete.

Es sind fast durchweg **Dreiecke aus drei Gitterpunkten**, die beinahe auf einer Geraden
liegen: bis zu 27 WU lang, 1e-8 WU breit. Was ein Martinez-Sweep dort hinterlässt, wo sich
zwei Ränder beinahe decken.

## Warum der vorhandene Debris-Filter sie durchlässt

`compactPoly` (`sim-core/fill.ts`) hat genau eine Frage gestellt — **die falsche**:

```ts
Math.abs(ringArea(outer)) < DEBRIS_AREA_WU2   // 1e-9 WU²
```

Eine Nadel ist beliebig **lang**, trägt also beliebig viel Fläche, während sie nichts ist.
Die längste gemessene: 27 WU lang, **4,2e-7 WU²** — das **Vierhundertfache** des
Debris-Bodens. Über eine Fläche ist sie nicht zu fassen; über ihre **Breite** sofort. Und
die ist nach oben durch das Gitter beschränkt, auf das sie gesnappt wurde.

Die Verteilung über 300 s, dekadenweise, zeigt eine **fünf Dekaden breite leere Lücke**:

| Dicke | Stücke |
| --- | --- |
| 1e-10 … 1e-7 | 104 |
| 1e-7 … 1e-6 | 1 |
| *1e-6 … 1e-3* | *0* |
| 1e-3 … 1e-2 | 3 |
| 1e-2 … 1e0 | 14 |
| 1e0 … 1e2 | 30 |

Die dickste Nadel misst **1,00e-7 WU** = genau eine Gitterzelle; das dünnste echte Stück
**6,9e-3 WU**. Es gibt nichts dazwischen, über das man streiten müsste.

Alle 105 Nadeln zusammen halten **5,3e-6 WU²** von 15 308 WU² bemalter Karte — ein halbes
Tausendstel *einer* Mindest-Einnahme (`minFillAreaWU2` = 0,01). Deshalb hat sie nie etwas
gemerkt: keine Flächenrechnung, kein Leaderboard, kein Vertex-Budget.

## Warum man sie trotzdem sieht — beide Screenshots erklärt

Der Renderer extrudiert **jedes** gespeicherte Polygon zu einem 0,35 WU hohen Plateau
(`client/render/scene.ts`, `THREE.ExtrudeGeometry`). Bei einer Nadel ist die Deckfläche
sub-pixelig — aber ihre beiden **Seitenwände** sind volle Plateauhöhe und bis zu 27 WU
lang und fallen aufeinander. Aus der gekippten Kamera ist das ein Haarstrich-Band.

Wo eine Nadel liegt, entscheidet über die Erscheinungsform, und die Messung ist
eindeutig: **alle 105 lagen innerhalb einer fremden Fläche**, keine einzige auf freiem
Grund. Das ist auch zu erwarten, denn sie entstehen dort, wo Land den Besitzer wechselt:

| Nadel entsteht bei | Anzahl über 300 s |
| --- | --- |
| dem **Bestohlenen** (`difference(other, gained)`) | 115 |
| dem **Fänger** (`union(territory, loop)`) | 50 |

- **Screenshot `201920`** ist der Normalfall: die Nadeln des Vorbesitzers stecken in der
  Fläche, die ihm abgenommen wurde. Ihre Wand-Oberkante liegt auf derselben Höhe wie das
  Plateau ringsum → Z-Fighting → der feine Kratzer im grünen Gebiet.
- **Screenshot `202249`** ist derselbe Rest, nachdem das Plateau um ihn herum
  verschwunden ist (Tod, Übermalung) — die Nadel überlebt die Fläche, in der sie steckte,
  und steht dann frei auf grauem Grund.

Der Client-Carve (`PlateauCarver`) ist **nicht** mitschuldig: über denselben Lauf gemessen
kamen aus ihm 99 dünne Stücke gegen 105 aus dem Server — er erzeugt keine eigenen.

## Nebenbefund: die Nadeln haben auch die Bots gesteuert

Nicht nur Kosmetik. `closestOnTerritory` (`server/bot.ts`) läuft über **jeden** Ring, und
`territoryCenter` mittelt **ungewichtet** über Aussenring-Vertices. Bei 105
Dreiecks-Nadeln unter 152 Stücken kamen also ~315 Härchen-Vertices in die Antwort auf „wo
ist mein Land" und „wo ist mein nächster Rand". Ein Bot konnte ein 13 WU langes Haar im
Nichts für seine nächste Grenze halten.

## Fix: nach der Dicke fragen, nicht nur nach der Fläche

`ringThickness` in `geometry.ts` (`2·|A| / Umfang`), und in `fill.ts` ein Prädikat
`isLandRing`, das **beide** Böden verlangt:

```ts
Math.abs(ringArea(ring)) >= DEBRIS_AREA_WU2 && ringThickness(ring) >= MIN_LAND_THICKNESS_WU
```

`MIN_LAND_THICKNESS_WU = 1e-4` liegt mitten in der leeren Lücke — 1000× über der dicksten
gemessenen Nadel, 69× unter dem dünnsten echten Stück. Dieselben drei Gründe wie bei
`SEALED_NECK_WU`: drei Grössenordnungen über dem Snap-Gitter (1e-7); genau dort, wo der
Client aufhört, Geometrie aufzulösen (Carve-Gitter 1e-4); und vier Grössenordnungen unter
allem Spielbaren — ein Kopf ist 1 WU breit, und weil eine Einnahme `minFillAreaWU2` =
0,01 WU² erreichen muss, müsste ein so dünner Streifen **100 WU** lang sein, halbe Arena,
um überhaupt eine legale Einnahme zu sein.

Angewandt an den zwei Stellen, an denen ein Ring gespeichert wird: `compactPoly` (Union-,
Carve- und Spawn-Ausgabe) und `sealCapture` (der einzige Ring, der an `compactPoly`
vorbeikommt, plus seine Buchten).

**Mitgenommen:** `compactPoly` beurteilte den Aussenring **roh** und speicherte ihn
**kompaktiert**. Wo die beiden auseinanderliegen, fällt der Aussenring weg und ein
überlebendes Loch rückt auf Index 0 — und jeder Leser hält Index 0 für die Aussengrenze.
Jetzt wird der kompaktierte Ring beurteilt, also genau die Geometrie, die gespeichert wird.

## Wirkung und Preis (gemessen)

| 200 WU · 8 Bots · 5 min | vorher | nachher |
| --- | --- | --- |
| gespeicherte Stücke | 152 | **47** |
| davon Nadeln | 105 | **0** |
| Peak-Vertices | 7 369 | **7 044** (−4,4 %) |
| Loop-Schlüsse / Tode | 1 323 / 1 | **1 323 / 1** (bit-identisch) |
| mean / p95 / p99 | 0,58 / 3,31 / 6,78 ms | **0,54 / 3,10 / 6,53 ms** |

Die 47 echten Stücke sind **dieselben 47** wie vorher — es fiel nur totes Gewicht weg.
Weil der Pfad bei 200 WU bit-identisch bleibt, ist diese Spalte ein sauberes A/B (eine
Maschine, derselbe Seed, direkt vorher/nachher).

Der **50-WU-Lauf fliegt danach anders** (1 750 → 1 562 Vertices, 2 527 → 2 575 Schlüsse,
79 → 90 Tode), und das ist der Nebenbefund oben: bei sechzehnfacher Dichte reicht die
Verzerrung der Bot-Wahrnehmung zum Steuern. Die Mehrtode sind `headOn` (33 → 46), **nicht**
`totalLoss` — es wird durch die Änderung niemand enteignet. Beide Basislinien in
`bench/fill-budget` sind mit dieser Begründung neu aufgezeichnet.

Kosten für den Spieler: die 5,3e-6 WU², die er nominell hielt. Räumt eine Runde bereits
vorhandene Nadeln weg, wird das als (mikroskopischer) Abzug an der nächsten Einnahme
verbucht — im Unit-Test auf 22 − 1e-6 WU² festgenagelt.

## Watch-Items

- **Bestehende Arenen heilen von selbst.** Ein Fill schreibt das ganze Territorium neu,
  also fällt die Nadel beim nächsten Loop-Schluss des Besitzers. Kein Migrationsschritt.
- **Die Carve-Seite hat keinen Unit-Test.** Nadeln beim Bestohlenen brauchen die über
  Minuten akkumulierten Ränder einer echten Arena; 4 000 randomisierte Gegner mit
  diagonalen Rändern erzeugten keine. Abgedeckt ist sie *baulich* (dieselbe `compactPoly`)
  und durch den neuen Halt in `bench/fill-budget`, der die Nadeln am Ende eines
  5-Minuten-Laufs zählt und auf 0 prüft — mit eigener Schwelle, damit er nicht
  mitwandert, wenn jemand `MIN_LAND_THICKNESS_WU` senkt.
- **`loopPolygons` wurde bewusst nicht angefasst.** Dort entscheidet dieselbe
  Flächenschwelle, ob ein *Loop-Ring* ein Dichtband braucht (Ticket 26). Ein
  nadelförmiger Loop-Ring bekommt heute keines, obwohl er nichts umschliesst — das ist
  eine Spielregel-Frage, kein Artefakt, und gehört in ein eigenes Ticket.
- **`bench/carve-budget` ist rot**, und war es schon vor dieser Änderung (max 19,16 ms
  gegen 16,67 ms Frame-Budget, ohne den Fix gemessen). Eine `max`-Stoppuhr, also genau die
  Grösse, die dieses Repo für nicht zweimal messbar hält (Ticket 28). Eigenes Thema.
