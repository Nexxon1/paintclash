# bench/fill-budget — Tick-Budget unter Fill-Last (Bau-Ticket 22)

Misst, ob ein 20-Hz-Tick unter seinen **50 ms** bleibt, während acht Bots die Karte
über Minuten voll malen. Fährt den **echten** `sim-core`-`step` und die **echten**
`BotPilot`s über dieselbe Intent-Naht wie `ArenaCore` (ADR-0005) — nur der Transport
fehlt. Anders als [`../do-cpu`](../do-cpu/) braucht das kein Durable Object: gemessen
wird die Arithmetik des Fills, nicht die Overheads der DO-Laufzeit.

```sh
pnpm --filter @paintclash/bench-fill-budget test          # Smoke + Arithmetik (~1 s)
pnpm --filter @paintclash/bench-fill-budget bench         # Akzeptanz: 2 × 5 min Arena-Zeit (~20 s)
pnpm --filter @paintclash/bench-fill-budget bench:steady  # Dauerzustand: 2 × 30 min Arena-Zeit (~5,5 min)
```

Läuft bewusst **nicht** im Root-Test/Coverage-Gate (spec §9.3): ein `bench`-Lauf simuliert
zehn Minuten Arena-Zeit, ein `bench:steady`-Lauf eine Stunde. Seed gepinnt (`20260730`) —
zwei Läufe fliegen denselben Pfad, nur die Stoppuhr unterscheidet sich.

## Zwei Messungen, zwei Fragen

|             | `bench` (Ticket 22)  | `bench:steady` (Ticket 23)          |
| ----------- | -------------------- | ----------------------------------- |
| Arena-Zeit  | 2 × 5 min            | 2 × 30 min                          |
| Frage       | hält die Regression? | was kostet der Dauerzustand?        |
| Zusicherung | `max < 50 ms`        | **keine** — nur die eigene Prämisse |

`bench` ist der Regressions-Halt aus Ticket 22 (Stand 2026-08-02: **rot**, s. u.). Er endet
bei t = 300 s — und selbst wenn er grün ist, sagt das nichts über den Dauerzustand: die
Vertex-Zahl pendelt sich erst nach ~7 min ein, die Tick-Kosten mit ihr. Wer auf fünf
Minuten urteilt, urteilt auf das Einschwingen. Am 31.07. war das direkt zu sehen — 0 Ticks
über Budget bis t = 300 s, die ersten Überläufe dann bei t = 355 s, also 55 Sekunden nach
dem Ende der Messung.

`bench:steady` misst deshalb den **Dauerzustand** und behauptet dort bewusst _nicht_, dass
das Budget hält (es hält nicht, s. u.; Ticket 23 verlangt „die Messung plus Entscheidung",
nicht „Budget gehalten" — eine Zusicherung daraus zu machen hiesse, einen menschlich
begateten Fund in einen dauerhaft roten Bench zu verwandeln). Zugesichert wird die
**Prämisse**: dass der Lauf das Plateau überhaupt erreicht hat. `saturationOf` vergleicht
dafür die beiden Hälften des Laufs nach 450 s Einschwingen; driftet die Vertex-Zahl
zwischen ihnen, benennt der Fehlschlag sich selbst — eine Basislinie aus dem Einschwingen
würde den Dauerzustand untertreiben. Die Rechnung ist eine reine Funktion mit eigenen
Unit-Tests in `smoke.test.ts`, damit ein Fehler im Fenster-Split in Millisekunden sichtbar
wird statt am Ende eines 36 000-Tick-Laufs.

## Stand nach Ticket 22

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

> **⚠ Diese Tabelle beschreibt `main` nicht mehr.** Seit dem 2026-08-02 fällt `bench` bei
> 200 WU: **max 103,20 ms, 57 Ticks über Budget** (ab t = 192,2 s) statt 36–43 ms und 0.
> Gleicher Seed, gleicher geflogener Pfad — es ist eine Regression, kein Flake, und sie
> liegt in einem der drei `sim-core`-Commits seit dem 31.07. Diagnose und Auftrag stehen in
> [Ticket 28](../../.scratch/paintclash/issues/28-fill-kosten-regression-seit-t22.md); die
> Zahlen oben bleiben stehen, bis dort entschieden ist, ob sie zurückerobert oder ersetzt
> werden. 50 WU ist unverändert grün.

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
