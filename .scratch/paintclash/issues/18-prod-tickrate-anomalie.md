# 18 — Prod-Tickrate-Anomalie: Isolate-Uhr läuft ~10 % neben der Realzeit

**What to build:** Entscheiden (und ggf. umsetzen), wie mit der real ~22,2 Hz statt 20 Hz tickenden Produktions-Arena umgegangen wird. Der Netcode ist seit Ticket 17 **immun** (Client-Sim-Kadenz-Servo folgt der beobachteten Rate), aber das **Spieltempo** liegt auf Prod real ~11 % über Spec: 9,99 statt 9 WU/s Kopftempo, entsprechend schnellere Drehraten — alle Balance-Werte (Ticket 11) sind faktisch skaliert.

**Befund (2026-07-21, Ticket 17):** Die DO-eigene Uhr ist in sich konsistent (Ticker misst exakt 50,00 ms/Tick via `Date.now()`), real vergehen aber nur ~45 ms/Tick (`tests/soak/tickrate-probe.mjs`: 21,79–22,20 Hz über 15-s-Fenster; lokal exakt 20,00). Re-Anchor-Extra-Ticks ausgeschlossen (`anchors=0` im Tail-Log). Von innen nicht detektierbar — jede `Date.now()`-basierte Pacing-„Korrektur" wäre wirkungslos (Warnkommentar in `arena-do.ts startTicker`).

**Blocked by:** — (unabhängig; Netcode-seitig durch Ticket 17 entschärft)

**Status:** ready-for-human

## Optionen

1. **Akzeptieren + dokumentieren** (Kandidat für die Grundversion): Tempo gilt für alle Spieler einer Arena gleich; Fairness unberührt. Kosten: Balance-Werte bedeuten auf Prod ~11 % mehr als spec'd; lokale Tests laufen langsamer als Prod sich anfühlt.
2. **Extern kalibrieren:** Clients messen die reale Rate ohnehin (Sim-Kadenz-Servo). Ein Kalibrier-Endpunkt/Startup-Messfenster könnte `dtSec` des Sim-Steps um den gemessenen Faktor skalieren, sodass WU/s real stimmen. Kosten: `dt` ≠ `TICK_DT_SEC` bricht die Replay-Determinismus-Annahme (fixes dt, ADR-0003) — nur als konstanter, pro Arena eingefrorener Faktor denkbar.
3. **Cloudflare-Verhalten klären:** Reproduzierbarkeit über Colos/Zeit beobachten (`tickrate-probe` regelmäßig laufen lassen); ggf. Community/Support. Die 45-ms-Realperiode roch nach Timer-Koaleszenz/Quantisierung im Isolate.

## Akzeptanz

- [ ] Entscheidung dokumentiert (ADR oder Ticket-Kommentar) inkl. Messreihe über ≥ 3 Tage/Colos.
- [ ] Falls Option 2: Replay-Determinismus-Auswirkung geklärt und getestet.

_Referenz: Ticket 17 Session-Logs 2026-07-20/21 (Messungen, Tail-Beweis); `tests/soak/tickrate-probe.mjs`; ADR-0003._

## Comments

### 2026-08-01 (Ticket 16) — erster Eintrag der geforderten Messreihe: die Anomalie trat nicht auf

Zwei 5-Minuten-Läufe gegen `paintclash.secure-data.workers.dev` (Commit `8a6642e`,
[`bench/prod-arena`](../../../bench/prod-arena/)), gemessen als **gelieferte Snapshot-Ticks
gegen die Wanduhr** — dieselbe Grösse wie `tickrate-probe.mjs`, nur über 300 s statt 15 s:

| Last | gelieferte Ticks / 300 s | Rate |
| --- | --- | --- |
| 8 Entities (1 Mensch + 7 Bots), 4 979 Vertices | 6 031 | **20,09 Hz** |
| 16 Entities (Populationsgrenze), 4 570 Vertices | 6 027 | **20,10 Hz** |

Also **nominelles Tempo**, nicht die 21,79–22,20 Hz vom 2026-07-21. Das Symptom dieses
Tickets — Balance-Werte faktisch ~11 % skaliert — war an diesem Tag nicht vorhanden.

Zwei Punkte, damit das nicht überinterpretiert wird:

1. **Tick-Arbeit kann die Differenz nicht erklären.** Ein überlaufender Tick verschiebt den
   nächsten (der Ticker verschläft die volle Restzeit auf einer eingefrorenen Uhr), 22,2 Hz
   liesse sich also grundsätzlich durch ~4,7 ms mittlere Tick-Kosten auf 20,1 Hz drücken.
   Dagegen spricht die Messung selbst: die Rate ist über den ganzen Lastbereich **flach**
   (19,84–19,87 Hz je Fenster, während die Vertices von 179 auf 4 570 stiegen, Fill-Rate bis
   4,5/s). Ein lastabhängiger Anteil dieser Grösse wäre sichtbar. Der Rest-Versatz gehört
   dem Timer: ~0,5 % an diesem Tag, nicht 11 %.
2. **Ein Tag, ein Colo, ein Client-Standort.** Genau deshalb verlangt die Akzeptanz hier
   eine Reihe über ≥ 3 Tage/Colos. Dies ist Eintrag 1.

Konsequenz für die Optionen: falls sich das bestätigt, ist die Anomalie **transient** und
Option 1 („akzeptieren + dokumentieren") wird noch billiger — es gäbe dann nichts zu
kalibrieren, sondern nur etwas zu beobachten. Ein wiederholbares Messwerkzeug liegt jetzt
vor; `pnpm --filter @paintclash/bench-prod-arena bench` gegen Produktion reicht für den
nächsten Eintrag.

### 2026-08-02 (Ticket 23) — Eintrag 2 der Messreihe, und er kippt Eintrag 1: die Anomalie ist bestätigt

Gemessen gegen `paintclash.secure-data.workers.dev` nach dem Deploy des Engine-Tauschs:

| Lauf                                            | Dauer | gelieferte Ticks | Rate         |
| ----------------------------------------------- | ----- | ---------------- | ------------ |
| 16 Clients (Populationsgrenze), `bench/prod-arena` | 300 s | 6 538            | **21,79 Hz** |
| 1 Client + Bots (Produktions-Default), Sonde     | 300 s | 6 553            | **21,85 Hz** |
| 1 Client + Bots, Kontrolllauf                    | 120 s | 2 624            | **21,87 Hz** |

Damit liegt die Rate **genau im Band der Erstmessung vom 2026-07-21 (21,79–22,20 Hz)**. Die
Anomalie ist **nicht transient**. Und sie ist nicht Tick-Arbeit: über den 16er-Lauf blieben
die 30-s-Fenster bei 21,28–22,08 Hz, während die Vertices von 167 auf 4 600 stiegen —
flach über den ganzen Lastbereich, wie schon 2026-08-01 argumentiert. Der Server liess
dabei **keinen einzigen Snapshot aus**: über 6 552 Lücken stieg die Tick-Nummer immer um
genau 1.

**Eintrag 1 war ein Instrumentenfehler, kein Datenpunkt.** Der Kommentar vom 2026-08-01
meldete 20,09/20,10 Hz und schloss daraus „das Symptom war an diesem Tag nicht vorhanden".
Beide Läufe kamen aus `bench/prod-arena`, und der stempelte seine Tick-Marken mit
**`Date.now()`**. Unter WSL2 wird diese Uhr in Sprüngen nachgezogen; im selben Prozess
gemessen erfand sie **~3-s-Aussetzer alle ~35 s** und meldete eine 120-s-Spanne als 132 s,
während ein 50-ms-Heartbeat auf `performance.now()` gleichzeitig p99 54 ms und **null**
Aussetzer las. Ein um ~8 % zu grosser Nenner macht aus 21,9 Hz gemeldete 20,1 Hz — die
Differenz ist vollständig erklärt.

`tests/soak/tickrate-probe.mjs`, die Sonde der Erstmessung, rechnete von Anfang an mit
`performance.now()`. **Die beiden Instrumente widersprachen sich, weil eines kaputt war,
und das kaputte war das jüngere.** `probe.ts` ist seit Ticket 23 monoton
(`TickMark.atMonoMs`); der Nachtrag in
[`docs/benchmarks/do-cpu-benchmark.md`](../../../docs/benchmarks/do-cpu-benchmark.md)
korrigiert die Ticket-16-Tabelle.

**Was das für die Optionen heisst.** Option 1 („akzeptieren + dokumentieren") wird dadurch
nicht teurer, aber die Begründung ändert sich: nicht „war ohnehin nur ein Ausrutscher",
sondern „gilt dauerhaft, betrifft alle in einer Arena gleich, und wir schreiben das
Spieltempo entsprechend auf". Konkret unaufgeschrieben und ab jetzt zu wissen:

- Das Kopftempo liegt real bei ~9,8 statt 9 WU/s, alle Balance-Werte aus Ticket 11 sind
  auf Produktion um ~9 % skaliert.
- **Ein Tick hat real ~45,8 ms statt 50 ms Zeit.** Das Tick-Budget ist ~8 % enger als
  überall angeschrieben — bei den Fill-Kosten nach Ticket 23 (lokal p99 12,5 ms) folgenlos,
  aber es gehört in jede künftige Budget-Rechnung.

Die Akzeptanz verlangt „≥ 3 Tage/Colos". Dies ist Eintrag 2, gemessen an **einem** Tag aus
**einem** Colo — die Reihe ist noch nicht voll. Was sie jetzt schon leistet: die Frage ist
nicht mehr „tritt es auf?", sondern nur noch „wie konstant ist der Faktor?".
