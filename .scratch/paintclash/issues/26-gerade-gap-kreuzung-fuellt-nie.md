# 26 — Eine schnurgerade Kreuzung füllt nie: kollineare Trails haben 2 Punkte

**Beobachtung (User-Playtest 2026-08-01):** „Wenn ich nur über kleine Gaps fahre, um ein
Gebiet zu schliessen, funktioniert es oft nicht. Wird nichts ausgefüllt."

**Blocked by:** — (unabhängig)

**Status:** resolved (2026-08-01)

## Befund: zwei Regeln greifen unglücklich ineinander

`appendTrailPoint` (`sim-core/geometry.ts`) faltet **vorwärts-kollineare** Bewegung in ein
Segment zusammen — bewusst so, damit gerade Fahrten O(1) Punkte kosten statt einen Vertex
je Tick. `closeLoop` (`sim-core/fill.ts:88`) verwirft aber jeden Trail mit weniger als drei
Punkten:

```ts
if (trail.length < 3) return null;
```

Fährt man **geradeaus** über eine Lücke, ist der komplette Trail kollinear und kollabiert
auf **zwei** Punkte (Startpose innen + verschmolzene Spitze). Damit greift die Schranke und
der Fang wird verworfen — nicht wegen der Fläche, sondern wegen der Punktzahl.

Und über ein kleines Gap fährt man geradeaus. Jedes kleine Lenken erzeugt einen dritten
Punkt und alles funktioniert — daher „oft nicht" statt „nie".

## Reproduktion (gemessen, `sim-core`, rein deterministisch)

Dieselbe Kerbe (12×6-Block mit 4 breiter, 3 tiefer Einbuchtung), einmal gerade gequert,
einmal mit 0,05 WU Versatz:

| Kreuzung | Trail nach `appendTrailPoint` | `closeLoop` |
| --- | --- | --- |
| schnurgerade | `[[97.9,103],[102.4,103]]` — **2 Punkte** | **`null`** |
| 0,05 WU gekurvt | 3 Punkte | **12,10 WU²** gefüllt |

Ebenso auf zwei getrennten Stücken (6×6-Blöcke, 2 WU Lücke): die gerade Überfahrt liefert
`[[99.8,100],[102.5,100]]` und damit `null`.

## Warum die Schranke da steht — und was stattdessen gelten müsste

Die `< 3` ist ein Schutz vor entarteten Ringen: aus zwei Punkten lässt sich kein Polygon
bauen, `union(territory, loop)` bekäme eine Fläche von exakt 0 und die Loch-Füllung fände
nichts. Der Fehler ist nicht die Schranke, sondern dass die **Kompaktierung dem Ring seine
Stützpunkte wegnimmt**: geometrisch ist die gerade Überfahrt eine völlig normale Schleife,
die zusammen mit der Gebietsgrenze eine echte Fläche einschliesst.

Zu prüfen (Reihenfolge = Aufwand):

- [x] **Die Trail-Enden von der Kollinear-Faltung ausnehmen.** Der jüngste Punkt darf
      verschmelzen, solange er nicht der letzte vor dem Loop-Schluss ist. Billigste
      Variante, aber sie verschiebt nur, wo das Problem auftritt (zwei Punkte bleiben zwei
      Punkte, wenn die Fahrt exakt gerade war). — **verworfen**, s. Answer: der eigene
      Vorbehalt trifft zu, und zwar grundsätzlich.
- [x] **Beim Schliessen den Ring aus dem Trail *plus* dem Wiedereintrittspunkt bauen** —
      also nicht die gespeicherten Punkte als Ring nehmen, sondern die Sehne bewusst
      schliessen. Klärt zugleich, ob `< 3` danach überhaupt noch nötig ist. —
      **hinfällig**: der Wiedereintrittspunkt *ist* schon im Trail (`trackTrail` hängt ihn
      an, bevor es schliesst), und die Sehne ist implizit. Es fehlt kein Punkt.
- [x] **Fläche statt Punktzahl entscheiden lassen.** `minFillAreaWU2` = 0,01 WU² ist bereits
      der Sliver-Boden; eine echte Null-Fläche fällt ohnehin durch. Dann kann `< 3` auf
      `< 2` sinken. — **umgesetzt**, aber allein reicht es nicht (s. Answer).

## Akzeptanz

- [x] Eine schnurgerade Überfahrt über eine Lücke/Kerbe füllt dieselbe Fläche wie die um
      0,05 WU gekurvte (Test mit beiden Varianten, gegen den alten Code rot verifiziert).
- [x] Property-Tests §9.2 bleiben grün (Summe + neutral = 100 %, Disjunktheit, kein Loch).
- [x] Golden-Replay-Hash **rotiert bewusst** (Fill-Semantik ändert sich) und wird in der
      Answer benannt. — er rotiert **nicht**, und das ist nachgewiesen statt zufällig
      (s. Answer).
- [x] Szenario-Abdeckung: eine Lücke über den echten Draht schliessen (DoD 5 — es ist
      Kern-Mechanik).

_Referenz: spec §2.2 (Fill), §10.4 (`minFillAreaWU2`); `appendTrailPoint` stammt aus
Ticket 04, die `< 3`-Schranke aus derselben Runde. Aufgedeckt beim Playtest zu Ticket 20._

## Answer

Der Befund des Tickets stimmt, seine Diagnose ist eine Stufe zu früh stehengeblieben — und
alle drei vorgeschlagenen Varianten hätten den Fehler **nicht behoben**.

**Warum die Punktzahl nicht das Problem ist.** Die `< 3`-Schranke fällt, das war richtig
(jetzt `< 2`, „ist überhaupt eine Strecke da"). Aber sie war nur der Türsteher. Selbst mit
drei, zehn oder hundert Punkten ist ein **kollinearer Ring flächenlos**, und ein flächenloses
Polygon trägt zu `union(Gebiet, Loop)` nichts bei: es entsteht kein Loch, die Loch-Füllung
findet nichts, die Flächen-Prüfung am Ende verwirft. Der Clipper ist dabei völlig in Ordnung
— exakte Prädikate beantworten „links oder rechts", nicht „ist dieser Ring ein Gebiet".
Gemessen: ein Zwei-Punkt-Ring **und** ein exakt kollinearer Drei-Punkt-Ring gehen beide
fehlerfrei durch `union` und liefern beide das Gebiet unverändert zurück. Vorschlag 1 des
Tickets nennt diesen Vorbehalt selbst („zwei Punkte bleiben zwei Punkte") — er gilt
grundsätzlich, nicht nur für den Randfall. Vorschlag 2 ist hinfällig: der Wiedereintritts-
punkt steckt längst im Trail (`trackTrail` hängt ihn an, *dann* schliesst es), die Sehne ist
implizit. Es fehlt kein Stützpunkt — es fehlt eine **Dicke**.

**Die Lösung: ein Dichtband.** `loopPolygons` (neu, `fill.ts`) gibt dem Loop, wenn sein Ring
unter `DEBRIS_AREA_WU2` (1e-9 WU²) liegt, ein hauchdünnes Band entlang des Trails bei —
ein Rechteck je Segment, `polylineBand` in `geometry.ts`, Halbbreite `SEAL_HALF_WIDTH_WU`
= **1e-6 WU**. Zwei Zahlen begründen die Grössenordnung:

- **10× über dem Snap-Gitter** (1e-7, ADR-0007), damit das Raster das Band nicht flachdrückt.
  Die Halbbreite muss über √2 Gitterzellen liegen, dann ist die grössere Normalen-Komponente
  garantiert ≥ 1 Zelle — bei 1e-6 ist das 7× Reserve, per Property-Test über alle Richtungen
  und Längen von 0,01–200 WU festgehalten.
- **1/40 der minimalen Fill-Fläche**, selbst über die ganze Karte: ein Band ist höchstens
  `2 × 1e-6 × Traillänge`, also 4e-4 WU² bei 200 WU Trail gegen `minFillAreaWU2` = 0,01. Das
  Band kann einen Fang deshalb **nie auslösen**, nur sichtbar machen. Es ist ausdrücklich
  nicht die gerenderte Trail-Breite (1 WU) — die zu vereinigen wäre eine Balance-Änderung,
  ein halber WU Rand entlang *jedem* Fill.

**Was das Band mit-erobert, ausdrücklich benannt.** Es liegt im Loop, wird also mit-vereinigt
und mit-ausgestanzt: ein entarteter Fill nimmt zusätzlich zum Pocket einen ≤ 2e-6 WU breiten
Streifen entlang des Trails — Land, das §2.2 nicht „eingeschlossen" nennt, und im
Extremfall (200 WU Trail) 4e-4 WU². Das ist derselbe Handel wie beim Snap-Gitter selbst
(ADR-0007: Grenzen wandern um ≤ 5e-8 WU) und liegt drei Grössenordnungen unter dem
Sliver-Boden; die Disjunktheit bleibt gewahrt, weil der Streifen bei allen Beteiligten
konsistent aus derselben Geometrie stammt.

**Der Ring bleibt daneben stehen, statt ersetzt zu werden.** „Vorzeichenfläche 0" heisst
nicht „deckt nichts": ein Trail, der sich selbst kreuzt, hebt sich vorzeichenmässig auf und
deckt trotzdem echtes Land, das der Sweep korrekt auflöst (der Spiral-Fall in `fill.test.ts`
fängt genau das). Ein Ersetzen könnte also stillschweigend einen Fang verkleinern; ein
Beilegen kann nur addieren. Der entartete Ring kostet nichts — der Clipper löst ihn zur
leeren Menge auf, für Zwei-Punkt und Kollinear-Drei-Punkt verifiziert.

**Was jetzt gilt (gemessen, `sim-core`, deterministisch).** 12×6-Block mit 4 breiter, 4
tiefer Kerbe, Überfahrt auf halber Kerbenhöhe:

| Kreuzung        | Trail    | vorher     | jetzt                       |
| --------------- | -------- | ---------- | --------------------------- |
| schnurgerade    | 2 Punkte | **`null`** | **4,000004 WU²** (die Tasche) |
| 0,05 WU gekurvt | 3 Punkte | 4,12 WU²   | 4,12 WU² (unverändert)      |

Die Tasche ist die untere Hälfte der Kerbe, 4 × 1 WU = **4,0 WU²** exakt; die 4e-6 darüber
ist das Band selbst. Die Differenz von **0,1200 WU²** ist die **Linse der Kurve** — das Land,
um das sie sich gebogen hat. Mehr kann eine gerade Fahrt gar nicht einschliessen, und weniger
auch nicht: beide Varianten färben dieselbe Tasche (`pointInTerritory` mitten in der Kerbe),
und die offene Hälfte der Kerbe bleibt bei beiden offen.

**Was das Band im gespeicherten Gebiet hinterlässt** (relevant für Ticket 23, dem die
Vertexzahl der Kostentreiber ist): in der Kerbe oben **nichts** — 8 Vertices vorher, 8
nachher, während die gekurvte Variante 9 speichert. Sichtbar ist es nur daran, dass die
Kerbenwände auf `y = 3.000001` stehen statt auf 3: die Bandkanten sind hier mit der Wand
kollinear und verschmelzen. Im allgemeinen Fall kostet ein Band höchstens vier Vertices je
Trail-Segment, und ein schnurgerader Trail hat genau eines — also nie mehr als eine Handvoll,
gegen die Dutzende, die ein gewöhnlicher Trail einbringt.

**Die andere Hälfte des Playtest-Berichts hat eine andere Antwort.** Zwei *getrennte* eigene
Stücke mit einer Lücke dazwischen sind keine Kerbe: eine Überfahrt schliesst dort nichts ab,
die Lücke bleibt an beiden Flanken offen, es gibt keine Tasche. Das Band bleibt mit ~4e-6 WU²
weit unter dem Boden, und der Fang verfällt — **richtig so**, eine Naht darf kein Land
erfinden. Als Test festgehalten (`a straight crossing between two own pieces encloses nothing`),
damit es niemand später als Bug „repariert". Das Ticket hatte diesen Fall mit der Kerbe in
einen Topf geworfen; er ist der Gegenbeweis, nicht dasselbe Symptom.

**Ein Rest bleibt dort allerdings stehen, und zwar auf der anderen Seite.** Gemessen an
denselben zwei Blöcken: gerade → `null`, mit 0,05 WU Bauch → **0,0623 WU²**. Das ist keine
Tasche, sondern die **Linse der Kurve selbst** — Fläche, um die der Kopf real herumgefahren
ist, und nach §2.2 („die komplette eingeschlossene Fläche") zu Recht sein Land. Trotzdem
bleibt hier ein Rest der Asymmetrie, die dieses Ticket beseitigen wollte: wer wackelt,
bekommt einen Splitter; wer gerade fährt, nichts. Beides ist regelkonform, und *keins* von
beidem ist, was der Spieler wollte — die Frage ist damit nicht mehr die Naht, sondern ob
`minFillAreaWU2` = 0,01 WU² für eine reine Kurven-Linse zu tief liegt. Das ist eine
Balance-Frage (Ticket 04/§10.4), keine Geometrie-Frage, und steht deshalb als Kommentar
unten statt als Änderung hier.

**Golden-Replay-Hash: rotiert NICHT** — entgegen der Akzeptanz-Erwartung, und nachgewiesen
statt zufällig. Der Replay wurde instrumentiert: er enthält **genau einen** Fill, mit **13**
Trail-Punkten und einem Ring von **13,5 WU²** — dort wird kein Band gebaut, also kann sich
nichts ändern. Für nicht-entartete Loops ist die Änderung bit-neutral (der Ring wird
gebaut wie vorher, nur der Pfad dahin heisst jetzt `loopPolygons`). Das ist das bessere
Ergebnis als eine Rotation: die Fill-Semantik ändert sich **nur** dort, wo sie vorher
gar keine war.

**Rot verifiziert, nicht nur grün** — und zwar drei der vier neuen Tests, nicht vier.
Gegen die alte Semantik gefahren (`< 3` + kein Band) fallen: die beiden Kerben-Tests in
`fill.test.ts`, der Tick-Test in `step.test.ts` und der Szenario-Test. Der vierte
(`a straight crossing between two own pieces encloses nothing`) besteht auch auf dem alten
Code — dort allerdings **vakuum**, weil sein Zwei-Punkt-Trail genau in die Schranke läuft,
die entfernt wird. Er ist eine **Fixierung**, kein Regressionstest: er hält fest, dass die
neue Naht diesen Fall *weiterhin* nicht füllt. Der `step`-Test ist der eigentliche Regressionswächter: er fährt
die zwei Regeln, die sich gegenseitig aufhoben, durch den **echten Tick-Pfad** — Kopf mit
`turn = 0` über die Kerbe, 12 Ticks, Trail faltet auf zwei Punkte, Fill kommt.

**DoD 5 (Kern-Mechanik ⇒ Szenario-Abdeckung):** neu `tests/scenario/fill.test.ts` — eine
Lücke über den echten Draht schliessen, mit einem Lauf, der **nie lenkt**. Das liess sich
nicht skripten, also ist es eine Rückkopplungs-Maschine, und jeder ihrer drei Teile hat einen
**gemessenen** Fehlversuch als Begründung (alle im Datei-Kommentar benannt):

1. **Die Lücke wird gebaut, nicht erhofft.** Ein einzelner Fill kann keine Konkavität
   erzeugen — jeder Fang wird loch-gefüllt, das konvexiert. Also fliegt der Kopf **zwei
   Lappen** 60° auseinander (Manöver aus `steal.test.ts`); der Keil dazwischen, am Scheitel
   vom Startblock geschlossen, ist die Lücke. Zuerst probiert: die *zufälligen* Reflex-Ecken
   **eines** Out-and-back — über 5 Seeds × 4 Runden gegen `sim-core` gefegt liefern sie
   Lücken von 1,6–4,4 WU mit zu dünnen Landstücken zum Starten, bei einem Seed nach vier
   Runden gar nichts.
2. **Der Rand wird vom Draht zurückgelesen, nie angenommen.** `findCrossings` durchsucht das
   Polygon, das der Server tatsächlich geschickt hat, und nimmt nur Kreuzungen, die auch um
   0,6 WU seitlich versetzt noch kreuzen (ein Pilot kommt schief an). Kandidaten werden
   **gerankt statt reduziert**: die Suche ist deterministisch, eine nicht fliegbare Kreuzung
   würde sonst ewig wieder gewählt.
3. **Ausgelöst wird per Vorhersage, nicht per Ziel-Toleranz.** Jeden Tick fragt der Pilot
   „wenn ich *jetzt* aufhöre zu lenken — kreuzt die Linie, auf der ich dann liege, eine
   Lücke?", und projiziert seine Pose dafür durch `advancePlayer`s eigene Regel, für **beide**
   Ticks, auf die der Intent fallen kann. Auf „nah genug gezielt" zu warten funktioniert in
   keiner Richtung: Bang-Bang hält ein Heading nur auf einen Tick Drehung genau (16° — aus
   14 WU sind das 4 WU Fehlschlag), und auf einen Tick zu warten, der *schon* ungelenkt ist,
   kam nie (gemessen: 224 Ticks auf eigenem Land, kein einziger davon leer).

Der Test beweist nicht „ein Fill passierte", sondern **welche Ringform** ihn erzeugt hat: er
zählt pro Tick die Ticks ausserhalb des eigenen Landes und die Ticks mit angewandtem
`turn = 0` und prüft am Fill-Tick, dass der Server über den **ganzen** Ausflug plus den
Schluss-Tick nie gedreht hat. Konstanter Turn ⇒ konstantes Heading ⇒ identische
Bewegungssegmente ⇒ `appendTrailPoint` hat gefaltet. Das ist genau der Ring dieses Tickets.

Das schönste Stück Beweis liefert dabei der Rot-Lauf: **derselbe** Flug (Tick 583, Freigabe
auf eine 2,8-WU-Lücke, 9,8 WU Anlauf) färbt mit dem Fix **0,32 WU²** und ohne ihn **0,00** —
gleiche Choreografie, gleicher Tick, gleiche Lücke, nur die Naht fehlt.

**Stabilität** (README Regel 4, kein Retry): fünf Läufe hintereinander grün — 37 / 33 / 37 s
vor dem Review-Nachzug, 37 / 33 s danach. Die Wanduhr-Decke steht bei 150 s (wie die Raids in
`steal.test.ts`) und ist damit grösser als die Tick-Budgets, die sie einschliesst: ein
vollständiger Umplanungs-Zyklus wäre ~45 s Sim-Zeit, ein 60-s-Deckel hätte den ersten schon
gerissen und den Test rot gemacht statt langsam.

**Gates:** typecheck · lint (0 errors; 3 vorbestehende Warnungen aus generierten
Coverage-Reports) · format · **712** Unit-Tests · Coverage `sim-core` 100 % Statements /
96,8 % Branch (Boden 95) · Szenario **46 + 2** (11 Dateien, 224 s — die neue Datei trägt 37 s
bei, keine andere Choreografie nimmt Schaden) · Playwright **21** — alle grün.

**Review-Nachzug (beide Achsen).** Die Spec-Achse fand zwei Ungenauigkeiten *in dieser
Answer*, beide korrigiert: „alle vier Tests rot verifiziert" war zu breit (es sind drei, s. o.),
und der Streifen, den das Band mit-erobert, war unbenannt (jetzt oben und in ADR-0007). Die
Standards-Achse fand einen echten Fehler im Szenario-Test: der 60-s-Deckel war ein
Debugging-Wert, den ich nicht zurückgestellt hatte — er verstiess gegen README Regel 3 und ist
jetzt 150 s. Dazu Namen geschärft (`rank` statt `attempt` für den Rang-Index, `guaranteed` für
das Minimum beider Vorhersagen, `Tally.outsideTicks`/`unsteeredTicks` statt Adjektive für
Tick-Zähler) und der ADR-Nachtrag chronologisch hinter den von Ticket 25 gestellt.

**Nicht angefasst:** `spec.md` (gelockt). Das Dichtband ist kein Balance-Parameter, sondern
eine numerische Naht; es steht in `CONTEXT.md` (Begriff **Dichtband**) und als Nachtrag in
**ADR-0007**, dessen Entscheidung es präzisiert: entartete Eingaben sind kein
Robustheits-, sondern ein Repräsentationsproblem, und sie werden **vor** dem Clipper gelöst.

## Comments

**Aufgefallen beim Code-Review dieses Tickets (2026-08-01) — eigenes Ticket wert, keine
Nacharbeit hier.** Zwei getrennte eigene Stücke mit 2 WU Lücke: die gerade Überfahrt füllt
richtigerweise nichts (nichts eingeschlossen), die um 0,05 WU gekurvte füllt **0,0623 WU²** —
ihre eigene Linse. Regelkonform (§2.2), aber es ist der letzte Rest der Asymmetrie „ein
Fünftel Kopfbreite Lenken entscheidet": man bekommt einen Splitter fürs Wackeln. Die Frage
ist nicht die Naht, sondern der Sliver-Boden: `minFillAreaWU2` = 0,01 WU² wurde in Ticket 04
so tarariert, dass „jeder bewusste Loop färbt" — eine reine Kurven-Linse von 0,06 WU² ist
aber kein bewusster Loop, sondern Lenk-Rauschen. Zu klären wäre, ob der Boden für Loops
**ohne eingeschlossene Tasche** höher liegen müsste. Bewusst nicht in diesem Ticket
mitgenommen: es wäre eine Balance-Änderung mit Playtest-Bedarf, und dieses Ticket ist eine
Geometrie-Korrektur.
