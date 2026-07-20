# 17 — Netcode-Latenz: Sichtverzug von ~0,29 s auf ≤ 0,15 s reduzieren

**What to build:** Der gemessene Ende-zu-Ende-Sichtverzug (Aktion eines Spielers → sichtbar auf fremdem Schirm; identisch zum Einzelsicht-Versatz der Sonde) liegt bei **~0,29 s (p50, Produktion)** — für ein Reaktionsspiel zu viel (User-Anforderung). Ziel: **≤ 0,15 s p50** auf der deployten Version, gemessen mit `tests/soak/offset-probe.mjs`, ohne die Glätte-Garantien zu verlieren (Soak `tests/soak/soak.mjs` bleibt PASS: 0 Resets, 0 Frozen-Frames, Tempi gedeckelt).

**Blocked by:** 03 (erledigt). Unabhängig von 04 startbar; Ergebnisse fließen in 05/07 (Rewind rechnet mit exakt diesem Verzug).

**Status:** ready-for-agent

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

- [ ] `offset-probe` Produktion p50 ≤ 0,15 s (≤ 1,35 WU je Sicht), dokumentiert im Ticket.
- [ ] Soak lokal + Produktion PASS (0 Resets, 0 Frozen, Tempi gedeckelt); Smoothness-E2E grün.
- [ ] Szenario-Test: kurzer Tap bleibt exakt (kein Input verloren) trotz Puffer 0.
- [ ] CONTEXT.md: Ack-Semantik + Tick-Mapping nachziehen.

_Referenz: Ticket 03 Kommentare (Latenz-Budget-Messungen, Soak-FAIL-Beleg für Puffer 1); ADR-0001 (Budget), ADR-0003 (Netcode)._
