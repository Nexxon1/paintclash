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
