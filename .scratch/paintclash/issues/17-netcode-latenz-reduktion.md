# 17 — Netcode-Latenz: Sichtverzug von ~0,29 s auf ≤ 0,15 s reduzieren

**What to build:** Der gemessene Ende-zu-Ende-Sichtverzug (Aktion eines Spielers → sichtbar auf fremdem Schirm; identisch zum Einzelsicht-Versatz der Sonde) liegt bei **~0,29 s (p50, Produktion)** — für ein Reaktionsspiel zu viel (User-Anforderung). Ziel: **≤ 0,15 s p50** auf der deployten Version, gemessen mit `tests/soak/offset-probe.mjs`, ohne die Glätte-Garantien zu verlieren (Soak `tests/soak/soak.mjs` bleibt PASS: 0 Resets, 0 Frozen-Frames, Tempi gedeckelt).

**Blocked by:** 03 (erledigt). Unabhängig von 04 startbar; Ergebnisse fließen in 05/07 (Rewind rechnet mit exakt diesem Verzug).

**Status:** resolved

Tick-Mapping + Sim-Kadenz-Servo deployt (2026-07-21), Prod-Abnahme erfüllt — s. Session-Log 2026-07-21 unten.

## Gemessenes Latenz-Budget (Stand 2026-07-20, Commit ~`HEAD`)

Ein Richtungs-Sichtverzug ≈ 0,29 s = Summe:

| Posten | Kosten | Wurzel |
|---|---|---|
| Input-Batching (Ø Wartezeit) | ~75 ms | `LIMITS.inputFlushTicks = 3` (Free-Budget: eingehende WS-Messages zählen 20:1, ADR-0001). Richtungs*wechsel* flushen bereits sofort — die Kosten treffen v. a. die Tick-Zuordnung. |
| Server-Jitter-Puffer | 100 ms | `LIMITS.inputBufferTicks = 2`. **Empirisch tragend im aktuellen Modell:** Reduktion auf 1 ⇒ Soak FAIL mit 11 Selbst-Resets (Leerlauf-Ruckler), belegt 2026-07-20. |
| Stehender Queue-Backlog | ~100 ms | `standingBacklogTarget = 2` + Trim; unter 2 drohen Leerläufe (gleiche Wurzel wie Puffer). |
| Interpolations-Basis | 100 ms | `INTERP_DELAY_TICKS = 2` + adaptiver Anteil auf jittrigen Leitungen. |
| Netz + Tick-Quantisierung | ~50 ms | RTT/2 + 20-Hz-Raster. |

**Kern-Erkenntnis:** Drei der vier großen Posten (Batch-Wartezeit, Jitter-Puffer, Backlog) haben dieselbe Wurzel — die **zählbasierte Rekonstruktion**: Der Client repliziert `Snapshot + pending Inputs (Anzahl)`; jeder Server-Tick ohne konsumierten Input („Leerlauf") ist unmodellierte Bewegung und erzeugt Reconciliation-Ruckler. Der Puffer/Backlog existiert NUR, um Leerläufe zu vermeiden.

## Lösungsskizze: Tick-gemappte Inputs (Source-Engine-Klasse)

`seq` ist bereits 1:1 der Client-Sim-Tick. Umbau:

1. **Server:** pro Verbindung `clientTickOffset` (beim ersten angewendeten Input: `serverTick − seq`). Pro Server-Tick wird der Input mit `seq* = serverTick − offset` erwartet: vorhanden → anwenden; fehlt (noch unterwegs) → Turn persistieren **und `seq*` trotzdem als verarbeitet acken** (verspätet eintreffende seqs ≤ ack werden verworfen — Monotonie-Gate existiert). Backlog > 0 nur noch bei echtem Client-Burst → Catch-up-Drain wie heute.
2. **Client:** Rekonstruktion wird Tick-basiert konsistent: `pending = seq > ack` entspricht exakt den Server-Ticks nach dem Snapshot-Zustand — Leerläufe sind modelliert (der Server hat sie mit persistiertem Turn simuliert UND geackt). Ein verworfener verspäteter Input erzeugt eine kleine, einmalige Divergenz, die die vorhandene Glide-Maschinerie schluckt (Messgröße!).
3. **Dann abbaubar:** Jitter-Puffer 2→0, stehender Backlog →0, Batch-Wartezeit wirkungslos für die Zuordnung (Batching bleibt fürs Budget!). Erwartete Ersparnis ~150–200 ms ⇒ Ziel ≤ 0,15 s.
4. **Offset-Drift:** `clientTickOffset` bei anhaltender Abweichung (Client-Uhr driftet) langsam nachführen (±1 Tick, EMA/Hysterese), sonst wächst Verwerfungsrate.

## Risiken / Wächter

- Verspätete Inputs werden verworfen statt nachgeholt → bei schlechten Leitungen minimal häufigere (geglättete) Korrekturen. Messen: Soak-`selfResets` = 0 bleibt Pflicht, `err`-Peak beobachten.
- Replay-/Szenario-Tests anpassen (Ack-Semantik ändert sich: „verarbeitet" ≠ „angewendet").
- Rewind (T05/07) profitiert: Tick-Zuordnung liefert die exakte Zeitbasis für die Handelnden-Sicht.

## Akzeptanz

- [x] `offset-probe` Produktion p50 ≤ 0,15 s (≤ 1,35 WU je Sicht), dokumentiert im Ticket. → **1,28–1,40 WU über zwei Läufe (n=80/66); in Realzeit 0,13–0,14 s** (Prod-Tick real 22,2 Hz ⇒ 9,99 WU/s, s. Session-Log 2026-07-21). Lokal 0,98 WU / 0,11 s.
- [x] Soak lokal + Produktion PASS (0 Resets, 0 Frozen, Tempi gedeckelt); Smoothness-E2E grün. → Prod: 0 Resets, 0 % Frozen, other-sd 0,94, max 19,2 < 25. Lokal PASS. E2E 4/4.
- [x] Szenario-Test: kurzer Tap bleibt exakt (kein Input verloren) trotz Puffer 0. → `movement.test.ts` „a short tap steers for exactly one authoritative tick" + Unit-Test mit Heading-Beweis.
- [x] CONTEXT.md: Ack-Semantik + Tick-Mapping nachziehen. → Ack („verarbeitet"), Tick-Mapping, Ankunfts-Marge, Sim-Kadenz-Servo, Input-Queue neu gefasst; Jitter-Puffer-Eintrag ersetzt. ADR-0003-Nachtrag ergänzt.

_Referenz: Ticket 03 Kommentare (Latenz-Budget-Messungen, Soak-FAIL-Beleg für Puffer 1); ADR-0001 (Budget), ADR-0003 (Netcode)._

---

## Session-Log 2026-07-20 (WIP-Commit auf main)

**Umbau implementiert wie skizziert — Client brauchte NULL Änderungen** (sein Replay-Kontrakt `pending = seq > ack` ist unter der neuen Ack-Semantik exakt konsistent; das war der Punkt des Umbaus):

- **Server (`arena.ts`):** `tickOffset` pro Verbindung (seq `s` → Server-Tick `s + tickOffset`), Anker beim ersten Frame auf den **neuesten** seq; fehlender Input ⇒ Turn persistiert + Tick trotzdem geackt („processed" ≠ „applied", Ack wird **abgeleitet**: `ack = tick − tickOffset`, nie gezählt); verspätete seqs (mapped Tick schon simuliert) werden bei Ankunft verworfen. Jitter-Puffer, Backlog-Drain, Standing-Trim komplett entfernt (`LIMITS`-Keys gestrichen); `maxPendingInputs` nur noch Flood-/Memory-Cap.
- **Drift-Servo:** Arrival-Margin-EMA (Gewicht 0,1, Start mittig 0,75); Band [0,15 … 1,35] Ticks → ±1-Schritte (slacken/tighten); Timeline-Bruch (|Δ| > 10 Ticks, 2 Frames in Folge) ⇒ Hard-Re-Anchor, Ack rebased dabei einmalig rückwärts (Client-Predictor verträgt das nachweislich).
- **Tests:** 140 Unit grün (Arena-Suite komplett auf Tick-Mapping umgeschrieben inkl. 3 Drift-Tests); Szenario 6/6 inkl. neuem Abnahme-Test „Tap = exakt 1 autoritativer Tick, `tick − ack` konstant über Dry-Ticks" (sim-client hat dafür `onSnapshot`-Hook bekommen); E2E lokal 4/4; **Soak lokal PASS** (0 Resets, 0 Frozen, other-sd 0,86).
- **Messung lokal (`offset-probe`): p50 1,0 WU = 0,11 s** (vorher 1,7 WU/0,19 s), Zwei-Screens-Diskrepanz 2 WU (vorher ~5). Ziel lokal erreicht.

**Prod-Abnahme BLOCKIERT — vorbestehender Bug entdeckt: die deployte Arena-DO tickt 22,20 Hz statt 20** (gemessen `tests/soak/tickrate-probe.mjs`, 15 s Fenster). Folgen im neuen Modell: Client-seqs (20 Hz) fallen ~2,2 Ticks/s hinter die Server-Ticks, der Servo slackt endlos (+33 in ~16 s, per `wrangler tail` belegt), praktisch jeder Input kommt „zu spät" ⇒ **Steuerung auf Prod tot** (`steer-latency-probe.mjs`: 14/14 Presses EATEN; lokal 0/14, p50 122 ms). Das alte zählbasierte Modell hat den Bug maskiert (Queue lief leer, Puffer fing es ab) — er erklärt sehr wahrscheinlich einen Teil der beobachteten Ruckler/Lags (permanentes Timewarp-Nachziehen der Gegner-Timeline).

**Verdacht Mechanik:** `startTicker`-Re-Anchor (`scheduled = Date.now()` ⇒ nächster Timeout 0 ms ⇒ Extra-Tick pro Re-Anchor) und/oder Workers-Zeitvirtualisierung (Date.now eingefroren während Ausführung). Diagnose-Logging ist **eingebaut und Teil dieses WIP-Stands**: `[ticker] ticks/now/anchors` alle 100 Ticks (arena-do.ts) + `[tickmap] anchor/slacken/tighten/resync/frame` (arena.ts).

**Nächste Schritte (morgen):**
1. WIP-Build deployen, `wrangler tail` → `[ticker]`-Deltas auswerten: ΔDate.now(DO) vs Edge-Zeitstempel vs Δticks ⇒ Uhr-Bug vs Scheduling-Bug unterscheiden.
2. Pacing fixen (Re-Anchor ohne Sofort-Tick: `scheduled = Date.now() + TICK_DT_MS`; ggf. akkumulatorbasiert), Debug-Logs wieder raus.
3. Prod messen: `steer-latency-probe` (0 EATEN, p50), `offset-probe` (Ziel ≤ 0,15 s p50 — Achtung: Läufe brauchen genug Samples, n≥30; bei n<10 wiederholen), Soak Prod PASS.
4. CI-E2E-Fix (User-Wunsch): `walking-skeleton.spec.ts` Stall-Test nutzt flaches 30°-Frame-Budget → auf CI-Runnern (~66 ms Frames) reißt legales Glide+Turn (16° Tick + 240°/s·dt, dt bei 100 ms gekappt) die Grenze. Budget dt-normalisieren wie im Soak; Jump-Budget (1,0 WU) ist dt-robust und bleibt.
5. Doku: CONTEXT.md (Ack-Semantik „verarbeitet", Tick-Mapping/Client-Tick-Offset/Arrival-Margin neu, Jitter-Puffer-Eintrag als abgelöst markieren), ADR-0003-Nachtrag, Ticket-Akzeptanzhaken.

**Prod wurde auf den alten Netcode-Stand (Commit `2c0d369`) zurück-deployt**, damit die Referenzumgebung über Nacht spielbar bleibt. Neue Werkzeuge: `tests/soak/steer-latency-probe.mjs` (Press→autoritative-Anwendung, misst EATEN-Rate), `tests/soak/tickrate-probe.mjs` (Server-Tickrate aus Client-Sicht).

---

## Session-Log 2026-07-21 (Abschluss)

**Tickrate-Diagnose entschieden** (Debug-Deploy + `wrangler tail`): `[ticker]`-Logs zeigen `anchors=0` (Re-Anchor-Extra-Tick-Theorie widerlegt) und **exakt 50,00 ms/Tick nach der DO-eigenen Uhr** — bei real gemessenen 21,8–22,2 Hz. ⇒ Die **Isolate-Uhr (`Date.now()`) des Produktions-DO läuft in sich konsistent, aber ~10 % neben der Realzeit**; von innen nicht erkennbar, server-seitig nicht ehrlich fixbar (lokal: exakt 20,00 Hz). Als Anomalie mit Optionen in Ticket 18 erfasst; Warnkommentar in `startTicker` (arena-do.ts).

**Fix: Sim-Kadenz-Servo im Client** (statt Server-Pacing anzufassen): `ClientSession.simIntervalMs()` steuert den Server-Offset-EMA auf seine Baseline zurück (Gain 0,05/Tick, Fehler-Kappung ±3 Ticks ⇒ Rate ±15 %; Uhrbruch > 10 Ticks ⇒ Baseline-Übernahme). `main.ts` taktet Akkumulator + Alpha mit dem Servo-Intervall. Damit produziert der Client seqs in **echter** Server-Tickrate — das Tick-Mapping ist per Konstruktion stabil, egal welche Uhr-/Raten-Abweichung, lokal ein No-op. 5 neue Unit-Tests (Lockstep, ±10 % Skew, Kappung, Re-Baseline).

**Feintuning:** `INTERP_DELAY_TICKS` 2 → 1,5 (jeder Interp-Tick ≈ 45–50 ms Sichtverzug; Soak-gewacht).

**Prod-Messungen (finaler Build, Version 072463f0):**

| Messung | Wert |
|---|---|
| `steer-latency-probe` | **0/14 EATEN, p50 117 ms, max 149 ms** (Warm-up-Lauf direkt nach Join: 6/14 — Servo-Konvergenz ~3 s, danach stabil 0) |
| `offset-probe` p50 | **1,28–1,40 WU** (n=80/66) = nominal 0,14–0,16 s; **in Realzeit 0,13–0,14 s** (Tick real 22,2 Hz ⇒ 9,99 WU/s) — Ziel ≤ 0,15 s erfüllt |
| Zwei-Screens-Diskrepanz | 2,6–2,8 WU (vorher ~5,2) |
| Soak Prod | **PASS**: 0 Resets, 0 % Frozen, other-sd 0,94, max 19,2 < 25 |
| Soak lokal / offset lokal | PASS / 0,98 WU = 0,11 s |

**Bekannte Restpunkte:** (1) Servo-Warm-up: in den ersten ~3 s nach Join können Turn-Onsets 1–3 Ticks verspätet ankommen (Ein-Glide-Korrektur, danach exakt). (2) Spieltempo auf Prod real ~11 % über Spec (9,99 statt 9 WU/s) — vorbestehend, gilt für alle gleich, → Ticket 18. (3) CI-E2E-Fix umgesetzt: Stall-Test-Budgets dt-normalisiert (Tick-Anteil skaliert mit dt, Glide-Anteil mit dt gekappt bei 100 ms) statt flacher 1,0-WU-/30°-Grenzen.

_Rewind (T05/07) erhält mit `tickOffset` die exakte Zeitbasis: Handelnden-Sicht = Server-Tick − Client-Tick-Offset − Interp-Delay._
