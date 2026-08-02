# bench/fill-budget — Fill-Kosten unter Last (Bau-Tickets 22, 23, 28)

Misst, was ein 20-Hz-Tick kostet, während acht Bots die Karte über Minuten voll malen.
Fährt den **echten** `sim-core`-`step` und die **echten** `BotPilot`s über dieselbe
Intent-Naht wie `ArenaCore` (ADR-0005) — nur der Transport fehlt. Anders als
[`../do-cpu`](../do-cpu/) braucht das kein Durable Object: gemessen wird die Arithmetik
des Fills, nicht die Overheads der DO-Laufzeit.

```sh
pnpm --filter @paintclash/bench-fill-budget test          # Smoke + Arithmetik (~1 s)
pnpm --filter @paintclash/bench-fill-budget bench         # Akzeptanz: 2 × 5 min Arena-Zeit (~20 s)
pnpm --filter @paintclash/bench-fill-budget bench:steady  # Dauerzustand: 2 × 30 min Arena-Zeit (~5,5 min)
```

Läuft bewusst **nicht** im Root-Test/Coverage-Gate (spec §9.3): ein `bench`-Lauf simuliert
zehn Minuten Arena-Zeit, ein `bench:steady`-Lauf eine Stunde. Seed gepinnt (`20260730`) —
zwei Läufe fliegen denselben Pfad, nur die Stoppuhr unterscheidet sich.

## Zwei Messungen, zwei Fragen

|             | `bench` (Tickets 22, 28)                    | `bench:steady` (Ticket 23)          |
| ----------- | ------------------------------------------- | ----------------------------------- |
| Arena-Zeit  | 2 × 5 min                                   | 2 × 30 min                          |
| Frage       | malt die Arena dieselbe Geometrie?          | was kostet der Dauerzustand?        |
| Zusicherung | **Vertex-Zahl ±5 %**, Schlüsse + Tode exakt | **keine** — nur die eigene Prämisse |

`bench` ist der Regressions-Halt. Er sichert seit **Ticket 28** die **Vertex-Zahl** zu und
nicht mehr die Stoppuhr — nicht als Lockerung, sondern weil die Stoppuhr an dieser Stelle
zwei Dinge nicht leisten kann:

1. **Bei 200 WU ist die Arena wirklich über Budget**, und war es schon, bevor dieser Halt
   es merkte. `bench:steady` mass dort **1 860** Überläufe über 30 min; die „0 Ticks über
   Budget", die Ticket 22 aufschrieb, hielten nur, weil dieser Lauf bei t = 300 s endet und
   der erste Überlauf bei t = 355 s lag — 55 Sekunden nach dem Ende der Messung. Als die
   Tickets 19 und 26 den Bruch auf t ≈ 172 s vorzogen, wurde der Halt rot: nicht an einem
   neuen Fehler, sondern an einem bekannten, der ins Fenster wanderte. Die Budget-Frage bei
   200 WU gehört **Ticket 23** und wird hier nicht noch einmal gestellt.
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
pendelt sich erst nach ~7 min ein, die Tick-Kosten mit ihr. Wer auf fünf Minuten urteilt,
urteilt auf das Einschwingen — dafür ist `bench:steady` da.

`bench:steady` misst deshalb den **Dauerzustand** und behauptet dort bewusst _nicht_, dass
das Budget hält (es hält nicht, s. u.; Ticket 23 verlangt „die Messung plus Entscheidung",
nicht „Budget gehalten" — eine Zusicherung daraus zu machen hiesse, einen menschlich
begateten Fund in einen dauerhaft roten Bench zu verwandeln). Zugesichert wird die
**Prämisse**: dass der Lauf das Plateau überhaupt erreicht hat. `saturationOf` vergleicht
dafür die beiden Hälften des Laufs nach 450 s Einschwingen; driftet die Vertex-Zahl
zwischen ihnen, benennt der Fehlschlag sich selbst — eine Basislinie aus dem Einschwingen
würde den Dauerzustand untertreiben. Die Rechnung ist eine reine Funktion mit eigenen
Unit-Tests in `smoke.test.ts`, damit ein Fehler im Fenster-Split in Millisekunden sichtbar
wird statt am Ende eines 36 000-Tick-Laufs. Dasselbe gilt für die Schranke von `bench`:
`driftFrom` ist eine reine Funktion mit eigenen Unit-Tests daneben.

### Die Basislinie neu aufnehmen

Die aufgezeichneten Zahlen stehen in `budget.test.ts` (`ARENAS`). Sie zu ändern ist eine
**bewusste** Handlung mit Begründung im Commit: eine andere Zahl heisst, dass die Arena
eine andere Form malt — genau der Moment, in dem sich jemand ansehen sollte, was das
kostet. Ticket 23 wird sie rotieren (andere Boolean-Engine ⇒ andere Vertex-Koordinaten);
das ist erwartet und gehört mit Vorher/Nachher-Zahlen in dessen Answer.

## Stand auf `main` (2026-08-02, nach Ticket 28)

Die aufgezeichnete Basislinie, gegen die `bench` prüft — alles über dem Strich ist
deterministisch und über Läufe **bit-identisch**, alles darunter streut:

| 5 min · 8 Bots         | 200 WU              | 50 WU        |
| ---------------------- | ------------------- | ------------ |
| **Peak-Vertices**      | **7 408**           | **1 750**    |
| **Loop-Schlüsse**      | **1 368**           | **2 527**    |
| **Tode**               | **1**               | **79**       |
| davon leer ausgegangen | 35                  | —            |
| bemalt bei t = 300 s   | 37,7 % der Karte    | —            |
| — — —                  |                     |              |
| mean                   | 3,59–3,85 ms        | 1,58–1,62 ms |
| p95                    | 24,8–26,3 ms        | 7,8–7,9 ms   |
| max                    | 94,9–116,3 ms       | 27,7–49,5 ms |
| Ticks über 50 ms       | 52–62, ab t ≈ 172 s | 0            |

**Fett** = vom Bench zugesichert. Die Spannen darunter sind **drei** Läufe (200 WU) bzw.
**vier** (50 WU) **derselben Geometrie**: sie messen die Streuung der Stoppuhr, nicht die
des Spiels. Genau deshalb hängt der Halt an den fetten Zeilen.

Die beiden nicht zugesicherten Zeilen darüber („leer ausgegangen", „bemalt") stammen aus
**Wegwerf-Instrumentierung** von Ticket 28, nicht aus `bench`: `ArenaRun` führt beides
nicht. „Leer ausgegangen" wurde über die Referenz-Identität von `p.territory` gezählt (ein
verfallener Fang lässt sie stehen), „bemalt" per Shoelace über alle Gebiete. Sie stehen
hier, weil sie die Bisektion erklären — wer sie nachrechnen will, baut sie neu.

**Bei 200 WU ist die Arena über Budget.** Das wird hier nicht versteckt und nicht
zugesichert — es ist der Fund, den [Ticket 23](../../.scratch/paintclash/issues/23-fill-vertexzahl-wachstum.md)
besitzt und der dort menschlich begatet ist. Die 50-WU-Arena hält ihn mit Luft (p95 7,9 ms
von 50) und zeigt den todgetriebenen Sägezahn, der das Wachstum deckelt.

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

## Stand nach Ticket 23 — der Dauerzustand (2026-08-02)

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

**Bekannte Kosmetik:** ein 200-WU-`bench:steady`-Lauf blockiert den Event-Loop ~280 s am
Stück, woraufhin Vitest `Timeout calling "onTaskUpdate"` als „unhandled error" meldet. Das
ist der Reporter-RPC, nicht die Messung.

## Zwei Artefakte, nur eines liegt hier

Dieser Bench ist die **dauerhafte** Hälfte (Regression halten). Die
**Diagnose**-Instrumentierung, die zu den Zahlen oben führte — Phasen-Stoppuhren und
Op-Zähler mitten in `sim-core` — war Wegwerf-Code unter einem einheitlichen Präfix
(`[DEBUG-…]`) und ist restlos entfernt; wer sie braucht, baut sie neu. Die Methode steht
in Ticket 22, die Kurve ist mit gepinntem Seed reproduzierbar.
