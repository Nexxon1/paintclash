# bench/fill-budget — Fill-Kosten unter Last (Bau-Tickets 22, 23, 28)

> **Stand 2026-08-02, nach dem Engine-Tausch aus [Ticket 23](../../.scratch/paintclash/issues/23-fill-vertexzahl-wachstum.md):**
> Die 200-WU-Arena hält das Tick-Budget über **vier Stunden** Arena-Zeit
> (0–2 von 288 000 Ticks über 50 ms) und ihre Vertex-Zahl **plateaut**. Beide
> Aussagen widersprechen dem, was weiter unten unter „Stand **vor** dem
> Engine-Tausch" steht — das ist der Vorher-Stand und bleibt als Vergleich stehen.

Misst, was ein 20-Hz-Tick kostet, während acht Bots die Karte über Minuten voll malen.
Fährt den **echten** `sim-core`-`step` und die **echten** `BotPilot`s über dieselbe
Intent-Naht wie `ArenaCore` (ADR-0005) — nur der Transport fehlt. Anders als
[`../do-cpu`](../do-cpu/) braucht das kein Durable Object: gemessen wird die Arithmetik
des Fills, nicht die Overheads der DO-Laufzeit.

```sh
pnpm --filter @paintclash/bench-fill-budget test          # Smoke + Arithmetik (~1 s)
pnpm --filter @paintclash/bench-fill-budget bench         # Akzeptanz: 2 × 5 min Arena-Zeit (~5 s)
pnpm --filter @paintclash/bench-fill-budget bench:steady  # Dauerzustand: 2 × 4 h Arena-Zeit (~8 min)
```

Läuft bewusst **nicht** im Root-Test/Coverage-Gate (spec §9.3): ein `bench`-Lauf simuliert
zehn Minuten Arena-Zeit, ein `bench:steady`-Lauf acht Stunden. Seed gepinnt (`20260730`) —
zwei Läufe fliegen denselben Pfad, nur die Stoppuhr unterscheidet sich.

## Zwei Messungen, zwei Fragen

|             | `bench` (Tickets 22, 28)                    | `bench:steady` (Ticket 23)          |
| ----------- | ------------------------------------------- | ----------------------------------- |
| Arena-Zeit  | 2 × 5 min                                   | 2 × 4 h                             |
| Frage       | malt die Arena dieselbe Geometrie?          | was kostet der Dauerzustand?        |
| Zusicherung | **Vertex-Zahl ±5 %**, Schlüsse + Tode exakt | **keine** — nur die eigene Prämisse |

`bench` ist der Regressions-Halt. Er sichert seit **Ticket 28** die **Vertex-Zahl** zu und
nicht mehr die Stoppuhr — nicht als Lockerung, sondern weil die Stoppuhr an dieser Stelle
zwei Dinge nicht leisten kann:

1. **Bei 200 WU war die Arena wirklich über Budget**, und war es schon, bevor dieser Halt
   es merkte. `bench:steady` mass dort **1 860** Überläufe über 30 min; die „0 Ticks über
   Budget", die Ticket 22 aufschrieb, hielten nur, weil dieser Lauf bei t = 300 s endet und
   der erste Überlauf bei t = 355 s lag — 55 Sekunden nach dem Ende der Messung. Als die
   Tickets 19 und 26 den Bruch auf t ≈ 172 s vorzogen, wurde der Halt rot: nicht an einem
   neuen Fehler, sondern an einem bekannten, der ins Fenster wanderte. Seit dem
   Engine-Tausch (Ticket 23) sind es 0 Überläufe — aber die Zusicherung bleibt trotzdem auf
   der Vertex-Zahl, aus Grund 2.
2. **Millisekunden sind das Einzige, was dieser Bench nicht zweimal messen kann.** Seed
   gepinnt, Bots reine Funktionen des Zustands: zwei Läufe fliegen denselben Pfad, und
   Vertices, Loop-Schlüsse und Tode kommen **auf die Einheit** identisch heraus. Die
   Stoppuhr nicht — und `max` am wenigsten. Bei 50 WU landete er in vier Läufen auf vier
   verschiedenen Ticks (t = 60,2 / 30,0 / 141,3 / 126,8 s) und streute 27,7–49,5 ms gegen
   die 50-ms-Grenze. Ein Ausreisser, der wandert, während die Arbeit feststeht, ist die
   Laufzeit, nicht der Fill.

Der Halt ist damit **schärfer** geworden, nicht weicher: die Schranke ist 5 %, und die
beiden Änderungen, die Ticket 28 bisectiert hat, bewegten die Vertex-Zahl um **+26,5 %**
und **+11,7 %**. Jede von beiden hätte ihn am Tag ihres Landens gerissen — in 20 Sekunden,
mit der Zahl, die erklärt, warum. Zeiten werden weiter bei jedem Lauf **gedruckt**, nur
nicht mehr beurteilt.

Was auch der geschärfte Halt nicht kann: über den Dauerzustand urteilen. Die Vertex-Zahl
pendelt sich erst nach Minuten ein, die Tick-Kosten mit ihr. Wer auf fünf Minuten urteilt,
urteilt auf das Einschwingen — dafür ist `bench:steady` da.

`bench:steady` misst deshalb den **Dauerzustand** und behauptet dort bewusst _nicht_, dass
das Budget hält. Es hält inzwischen (s. o.), aber die Zusicherung wäre trotzdem falsch
platziert: Ticket 23 verlangt „die Messung plus Entscheidung", nicht „Budget gehalten", und
ein Bench, der auf einer menschlich begateten Frage rot wird, ist ein dauerhaft roter
Bench. Zugesichert wird stattdessen die **Prämisse**: dass der Lauf das Plateau überhaupt
erreicht hat. `saturationOf` vergleicht dafür die beiden Hälften des Laufs nach 1 800 s
Einschwingen; driftet die Vertex-Zahl zwischen ihnen, benennt der Fehlschlag sich selbst —
eine Basislinie aus dem Einschwingen würde den Dauerzustand untertreiben. Die Rechnung ist
eine reine Funktion mit eigenen Unit-Tests in `smoke.test.ts`, damit ein Fehler im
Fenster-Split in Millisekunden sichtbar wird statt am Ende eines 288 000-Tick-Laufs.
Dasselbe gilt für die Schranke von `bench`: `driftFrom` ist eine reine Funktion mit eigenen
Unit-Tests daneben.

### Warum `bench:steady` vier Stunden misst und nicht dreissig Minuten

Weil dreissig Minuten die falsche Antwort gaben, und zwar überzeugend. Der Lauf meldete
zweimal „kein Plateau erreicht" (+33,3 %, nach dem Engine-Tausch +19,1 %) für eine Arena,
die zu dem Zeitpunkt längst im Gleichgewicht war.

Der Grund ist die Form der Kurve: die Vertex-Zahl ist ein **Sägezahn** — Gebiete wachsen,
jemand stirbt, sein Land fällt auf einen 6×6-Block zurück — mit einer Periode von
**Dutzenden von Minuten**. `saturationOf` vergleicht zwei Hälften des Laufs; bei 30 Minuten
sind das zwei 11-Minuten-Fenster, also **weniger als eine Periode**. Verglichen wurde damit
ein Tal gegen einen Berg, und die Differenz las sich als Wachstum. Über vier Stunden liest
dieselbe Rechnung **−3,2 %**, und die Kurve pendelt trendfrei zwischen ~5 000 und ~10 500
Vertices.

Daraus die Regel, an der die beiden Konstanten in `steady.test.ts` hängen: **eine
Vergleichshälfte muss mehrere Sägezahn-Perioden breit sein**, sonst misst sie die Phase, in
der sie zufällig liegt. 6 300 s je Hälfte fassen drei bis fünf Zyklen.

Der Fehlschluss lag nicht in der Schranke, sondern im Fenster — eine engere Schranke hätte
ihn nicht gefunden, ein breiteres Fenster hat es.

### Die Basislinie neu aufnehmen

Die aufgezeichneten Zahlen stehen in `budget.test.ts` (`ARENAS`). Sie zu ändern ist eine
**bewusste** Handlung mit Begründung im Commit: eine andere Zahl heisst, dass die Arena
eine andere Form malt — genau der Moment, in dem sich jemand ansehen sollte, was das
kostet.

Ticket 23 hatte angekündigt, sie zu rotieren (andere Boolean-Engine ⇒ andere
Vertex-Koordinaten). **Sie sind nicht rotiert:** 7 408 / 1 368 / 1 und 1 750 / 2 527 / 79
kommen nach dem Tausch auf die Einheit gleich heraus. Das Snap-Gitter rastet die Ausgaben
beider Engines auf dieselben Punkte, und über fünf Minuten reicht das für einen
bit-identischen Pfad. Erst im Vier-Stunden-Lauf laufen die Pfade auseinander.

## Stand auf `main` (2026-08-02, nach Ticket 23)

Die aufgezeichnete Basislinie, gegen die `bench` prüft — alles über dem Strich ist
deterministisch und über Läufe **bit-identisch**, alles darunter streut. Die
Geometrie-Zeilen sind seit Ticket 28 unverändert; **der Engine-Tausch hat sie nicht
angefasst**, nur was sie kostet:

| 5 min · 8 Bots         | 200 WU vor T23      | **200 WU nach T23** | 50 WU vor T23 | **50 WU nach T23** |
| ---------------------- | ------------------- | ------------------- | ------------- | ------------------ |
| **Peak-Vertices**      | **7 408**           | **7 408**           | **1 750**     | **1 750**          |
| **Loop-Schlüsse**      | **1 368**           | **1 368**           | **2 527**     | **2 527**          |
| **Tode**               | **1**               | **1**               | **79**        | **79**             |
| davon leer ausgegangen | 35                  | —                   | —             | —                  |
| bemalt bei t = 300 s   | 37,7 % der Karte    | —                   | —             | —                  |
| — — —                  |                     |                     |               |                    |
| mean                   | 3,59–3,85 ms        | **0,54–0,57 ms**    | 1,58–1,62 ms  | **0,24–0,25 ms**   |
| p95                    | 24,8–26,3 ms        | **3,04–3,20 ms**    | 7,8–7,9 ms    | **1,04–1,05 ms**   |
| max                    | 94,9–116,3 ms       | **19,8–23,7 ms**    | 27,7–49,5 ms  | **9,9–11,0 ms**    |
| Ticks über 50 ms       | 52–62, ab t ≈ 172 s | **0**               | 0             | **0**              |

**Fett** = vom Bench zugesichert bzw. der aktuelle Stand. Die Spannen sind Läufe
**derselben Geometrie**: sie messen die Streuung der Stoppuhr, nicht die des Spiels. Genau
deshalb hängt der Halt an den fetten Geometrie-Zeilen.

Die beiden nicht zugesicherten Zeilen oben („leer ausgegangen", „bemalt") stammen aus
**Wegwerf-Instrumentierung** von Ticket 28, nicht aus `bench`: `ArenaRun` führt beides
nicht. „Leer ausgegangen" wurde über die Referenz-Identität von `p.territory` gezählt (ein
verfallener Fang lässt sie stehen), „bemalt" per Shoelace über alle Gebiete. Sie stehen
hier, weil sie die Bisektion erklären — wer sie nachrechnen will, baut sie neu.

**Bei 200 WU war die Arena über Budget.** Sie ist es seit dem Engine-Tausch nicht mehr —
weder hier noch im Dauerzustand (nächster Abschnitt). Die 50-WU-Arena hielt das Budget
schon vorher und zeigt den todgetriebenen Sägezahn, der das Wachstum deckelt.

## Der Dauerzustand nach Ticket 23 (2026-08-02) — vier Stunden, Vorher/Nachher

Beides auf derselben Maschine gemessen, Seed 20260730. Die Vorher-Spalte ist ein
**30-Minuten**-Lauf, weil ein Vier-Stunden-Lauf mit der alten Engine ~53 Minuten Wanduhr
gekostet hätte; sie ist damit die _günstigere_ Hälfte des Vergleichs, nicht die härtere.

| 200 WU · 8 Bots  | `polyclip-ts`, 30 min | `polygon-clipping`, 30 min | `polygon-clipping`, **4 h** |
| ---------------- | --------------------- | -------------------------- | --------------------------- |
| mean             | 9,00 ms               | 1,13 ms                    | **1,37–1,43 ms**            |
| p95              | 59,36 ms              | 6,52 ms                    | **7,32–7,74 ms**            |
| p99              | 98,98 ms              | 11,45 ms                   | **12,52–13,39 ms**          |
| max              | 569,72 ms             | 33,36 ms                   | **46,19–61,64 ms**          |
| Ticks über 50 ms | 2 389 (6,64 %)        | 0                          | **0–2 von 288 000**         |
| Peak-Vertices    | 10 502                | 10 499                     | 11 105                      |
| Tode             | 25                    | 26                         | 124                         |
| Plateau?         | nein (+33,3 %)¹       | nein (+19,1 %)¹            | **ja (−3,2 %)**             |

¹ Beide „nein" sind Messartefakte des 11-Minuten-Fensters, nicht Befunde — s.
„Warum `bench:steady` vier Stunden misst".

Die `polyclip-ts`-Spalte ist am Tag des Tauschs **neu gemessen** worden, damit Vorher und
Nachher aus derselben Sitzung stammen. Sie liest schlechter als die historische Tabelle
weiter unten (7,84 / 50,80 / 90,57 / 230,14 ms, 1 860 Überläufe): **identische Geometrie**
— 10 502 Peak-Vertices und 25 Tode auf die Einheit, der Lauf ist deterministisch —, aber
eine andere Stoppuhr. Das ist dieselbe Streuung, die dieser Bench seit Ticket 28
dokumentiert, hier bei Ticks von ~9 ms besonders sichtbar. Für den Faktor spielt es keine
Rolle: 8,0× gegen die neue Zeile, 6,9× gegen die alte.

| 50 WU · 8 Bots   | `polyclip-ts`, 30 min | `polygon-clipping`, **4 h** |
| ---------------- | --------------------- | --------------------------- |
| mean             | 1,56 ms               | **0,25–0,27 ms**            |
| p95              | 7,79 ms               | **1,04–1,11 ms**            |
| p99              | 13,21 ms              | **1,88–2,18 ms**            |
| max              | 38,48 ms              | **19,39–33,75 ms**          |
| Ticks über 50 ms | 0                     | **0 von 288 000**           |
| Plateau?         | ja (+6,2 %)           | **ja (0,0 %)**              |

**Die Kurve wird über Stunden nicht schlechter.** Die letzte der vier Stunden liest bei
200 WU p95 6,78 ms / p99 11,39 ms / 0 Überläufe — also eher besser als der Gesamtlauf. Die
Vertex-Zahl pendelt trendfrei zwischen ~5 000 und ~10 500.

**Was das mit dem 4×-Hardware-Faktor bedeutet** (Konvention aus Ticket 02, hier
informativ): abgeleitet liegt p95 bei ~31 ms von 50 — passt; p99 bei ~53 ms — auf der
Linie; der einzelne `max` darüber. Vorher waren dieselben Zahlen 237 ms und 396 ms. Ob der
Faktor für diese Last stimmt, sagt nur eine Messung gegen Produktion
([`../prod-arena`](../prod-arena/)).

### Wie es hierher kam (Ticket 28)

Der Halt fiel am 2026-08-02 auf `main`. Bisectiert über volle Worktrees, drei Läufe je
Commit — **zwei** Änderungen, beide erwünscht, keine davon zurückgebaut:

| Commit                            | Peak-Vertices   | mean    | Tode  | leer ausgegangen |
| --------------------------------- | --------------- | ------- | ----- | ---------------- |
| `b786fb6` (Ticket 22)             | 5 244           | 1,90 ms | 6     | 62               |
| `3e2682b` (Ticket 19)             | 6 635 (+26,5 %) | 3,12 ms | **1** | 66               |
| `b167439` (Ticket 26)             | 7 408 (+11,7 %) | 3,68 ms | 1     | **35**           |
| `c43ea08` (HEAD, inkl. `e11ab96`) | 7 408           | 3,72 ms | 1     | 35               |

- **Ticket 19** liess Bots aufhören, am eigenen Trail zu sterben (6 → 1 Tode in 5 min) —
  genau der Preis, den CONTEXT.md dort notiert („0,2 WU neben der eigenen Linie
  herzufahren überlebt"). Sie überleben, malen weiter (29,5 % → 39,4 % der Karte), und
  Tode sind laut Ticket 23 der einzige Mechanismus, der die Vertex-Zahl deckelt.
- **Ticket 26** liess von 1 368 Loop-Schlüssen **31 weitere** wirklich Land holen (leer
  ausgegangen: 66 → 35). Das ist das Dichtband, das tut, wofür es gebaut wurde.
  Dass die **bemalte Fläche** dabei von 39,4 % auf 37,7 % _sinkt_, ist kein Widerspruch:
  ab dem ersten geretteten Fang fliegen die Bots einen anderen Pfad, und danach sind die
  beiden Läufe nicht mehr Punkt für Punkt vergleichbar. Vergleichbar bleibt der
  Mechanismus — gleiche Schluss-Zahl, 31 Schlüsse weniger leer.
- Die letzte Zeile deckt **zwei** Commits ab: `e11ab96` (Ticket 20) fasste `geometry.ts`
  mit vier Zeilen an, `c43ea08` nur Tests. Beide sind hier **gemessen** folgenlos, nicht
  bloss als harmlos eingeschätzt: die Geometrie ist gegen `b167439` bit-identisch.
- Eine ehrliche Einschränkung: die Ticket-22-Zahlen reproduzieren auf dieser Maschine
  **auch bei `b786fb6` nicht** (max 47–56 ms statt 36–43, 0–2 Überläufe statt 0). Ein Teil
  des Abstands ist Umgebung, nicht Code — und ein weiterer Grund, `max` nicht zu glauben.

## Stand nach Ticket 22 (historisch)

Ticket 22 fand den Fill als **~99 %** der Tick-Zeit und einzelne Ticks bei **114 ms**.
Zwei Änderungen in `sim-core/fill.ts` — Bounding-Box-Vorfilter (`skipsCarve`) und Carve
gegen die **neu gewonnene** Region statt gegen das ganze Gebiet — über 5 min gemessen:

| Arena  | max/Tick vorher | max/Tick nachher | Ticks über Budget |
| ------ | --------------- | ---------------- | ----------------- |
| 200 WU | 189 ms          | **36–43 ms**     | 0 (vorher 269)    |
| 50 WU  | 106 ms          | **23–25 ms**     | 0 (vorher 9)      |

**Die Kurve ist abgeflacht, nicht flach.** Bei 200 WU steigt sie im letzten
30-s-Fenster noch — und zwar mit der Vertex-Zahl der Gebiete, die in einer **reinen
Bot-Arena** monoton wächst, weil Bots einander kaum töten (6 Tode in 5 min). Die 50-WU-
Arena zeigt dagegen den erwarteten Sägezahn (96 Tode) und pendelt stabil. Wird dieser
Bench bei 200 WU rot, ist das darum **kein Flake**, sondern genau dieses Restwachstum:
die Zahlen und die verworfenen Auswege stehen in Ticket 23.

Der `max` eines Laufs streut über Läufe um ±10 % (eine Major-GC, die auf einen Fill-Tick
fällt, ist eine echte Tick-Kosten — deshalb wird sie nicht herausgemittelt). Für die
Beurteilung eines Laufs zählt neben `max` die Spalte `p95`: das ist die Grösse, in der
das Kriterium von Ticket 02 formuliert ist (p95 ≤ 25 ms inkl. 4×-Hardware-Faktor).

> **⚠ Diese Tabelle ist historisch.** Sie beschreibt `main` seit dem 2026-08-02 nicht mehr,
> und ihre Zusicherung „0 Ticks über Budget" beschrieb bei 200 WU auch damals nur die
> ersten fünf Minuten. Aktuelle Zahlen und die Bisektion: **Stand auf `main`** oben,
> [Ticket 28](../../.scratch/paintclash/issues/28-fill-kosten-regression-seit-t22.md).
> Die ±10 %-Streuung des `max` ist ebenfalls zu optimistisch gemessen: über vier Läufe bei
> 50 WU sind es 27,7–49,5 ms, also fast ein Faktor 2 auf identischer Geometrie.

## Stand vor dem Engine-Tausch — der Dauerzustand über 30 min (historisch)

> **⚠ Überholt.** Dies war die erste `bench:steady`-Messung, mit `polyclip-ts` und einem
> 30-Minuten-Fenster. Beide Aussagen darin sind inzwischen widerlegt: die Kosten (durch den
> Engine-Tausch) und die Diagnose „kein Plateau" (durch das zu schmale Fenster). Aktuell:
> **Der Dauerzustand nach Ticket 23** oben. Die Tabelle bleibt als Vorher-Stand stehen.

Erste Messung mit `bench:steady`, Seed 20260730:

| 30 min · 8 Bots   | 200 WU                            | 50 WU                      |
| ----------------- | --------------------------------- | -------------------------- |
| mean              | 7,84 ms                           | 1,51–1,66 ms               |
| p95               | 50,80 ms                          | 7,51–8,23 ms               |
| p99               | 90,57 ms                          | 12,19–14,03 ms             |
| max               | 230,14 ms                         | 28,93–64,55 ms             |
| Ticks über 50 ms  | **1 860 (5,17 %)**, ab t = 221 s  | 0–3                        |
| Peak-Vertices     | 10 502                            | 2 081                      |
| Tode              | 25                                | 540                        |
| Plateau erreicht? | **nein** (6 375 → 8 501, +33,3 %) | ja (1 094 → 1 162, +6,2 %) |

Die 50-WU-Spalte nennt Spannen über zwei Läufe, und zwar aus einem Grund, der die Zahlen
lesbar macht: die **Geometrie** ist zwischen beiden Läufen identisch (2 081 Peak-Vertices,
14 704 Fills, 540 Tode, Plateau 1 094 → 1 162 auf die Einheit), nur die **Stoppuhr** streut.
Bei Ticks dieser Grösse ist der `max` reines GC-Rauschen — deshalb ist dort die Verteilung
(p95/p99) die aussagekräftige Zahl und nicht der Ausreisser. Beim 200-WU-Lauf trägt der
Ausreisser dagegen echte Fill-Arbeit: 1 860 Ticks über Budget sind kein Rauschen.

Der 200-WU-Lauf **fällt** darum — nicht am Budget (das prüft dieser Bench bewusst nicht),
sondern an seiner Prämisse: er hat kein Plateau erreicht, seine Tick-Kosten sind also keine
Dauerzustands-Basislinie. Das ist der beabsichtigte Ausgang, nicht ein zu lockernder
Schwellwert — Ticket 23 hatte am 31.07. noch **−1,8 %** Drift gemessen, heute sind es
+33,3 %. Der todgetriebene Sägezahn bei 50 WU funktioniert dagegen unverändert; es ist der
todarme Fall, der wandert.

**Behoben, war „bekannte Kosmetik":** ein langer `bench:steady`-Lauf blockierte den
Event-Loop am Stück, woraufhin Vitest `Timeout calling "onTaskUpdate"` als „unhandled
error" meldete — und der Lauf mit Exit-Code 1 endete, obwohl beide Tests grün waren. Bei
30 Minuten war das ein Schönheitsfehler, bei vier Stunden wäre es ein Bench, dessen
Exit-Code nichts mehr bedeutet. `runArena` gibt den Event-Loop seit Ticket 23 einmal je
simulierter Sekunde zurück (ausserhalb der Tick-Stoppuhr, ~1,5 s auf sieben Minuten).

## Zwei Artefakte, nur eines liegt hier

Dieser Bench ist die **dauerhafte** Hälfte (Regression halten). Die
**Diagnose**-Instrumentierung, die zu den Zahlen oben führte — Phasen-Stoppuhren und
Op-Zähler mitten in `sim-core` — war Wegwerf-Code unter einem einheitlichen Präfix
(`[DEBUG-…]`) und ist restlos entfernt; wer sie braucht, baut sie neu. Die Methode steht
in Ticket 22, die Kurve ist mit gepinntem Seed reproduzierbar.
