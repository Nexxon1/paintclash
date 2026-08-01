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
