# bench/fill-budget — Tick-Budget unter Fill-Last (Bau-Ticket 22)

Misst, ob ein 20-Hz-Tick unter seinen **50 ms** bleibt, während acht Bots die Karte
über Minuten voll malen. Fährt den **echten** `sim-core`-`step` und die **echten**
`BotPilot`s über dieselbe Intent-Naht wie `ArenaCore` (ADR-0005) — nur der Transport
fehlt. Anders als [`../do-cpu`](../do-cpu/) braucht das kein Durable Object: gemessen
wird die Arithmetik des Fills, nicht die Overheads der DO-Laufzeit.

```sh
pnpm --filter @paintclash/bench-fill-budget test    # Smoke: malen die Bots überhaupt? (~1 s)
pnpm --filter @paintclash/bench-fill-budget bench   # Akzeptanz: 2 × 5 min Arena-Zeit (~20 s)
```

Läuft bewusst **nicht** im Root-Test/Coverage-Gate (spec §9.3): ein Lauf simuliert zehn
Minuten Arena-Zeit. Seed gepinnt (`20260730`) — zwei Läufe fliegen denselben Pfad, nur
die Stoppuhr unterscheidet sich.

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

## Zwei Artefakte, nur eines liegt hier

Dieser Bench ist die **dauerhafte** Hälfte (Regression halten). Die
**Diagnose**-Instrumentierung, die zu den Zahlen oben führte — Phasen-Stoppuhren und
Op-Zähler mitten in `sim-core` — war Wegwerf-Code unter einem einheitlichen Präfix
(`[DEBUG-…]`) und ist restlos entfernt; wer sie braucht, baut sie neu. Die Methode steht
in Ticket 22, die Kurve ist mit gepinntem Seed reproduzierbar.
