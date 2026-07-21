# ADR-0003 — Netcode-Modell & Determinismus

Status: Angenommen (2026-07-19)
Kontext-Tickets: [01 Bewegungsmodell](../../.scratch/draw-race/issues/01-bewegungsmodell-prototyp.md), [05 Netcode](../../.scratch/draw-race/issues/05-netcode-patterns.md), [08 Architektur](../../.scratch/draw-race/issues/08-architektur-erweiterbarkeit.md)

## Kontext

Kontinuierliche Bewegung (freie Winkel, ADR/Ticket 01) mit Kommazahlen-Geometrie. Frage: wie streng muss der Determinismus sein, und wie bleibt der Tod fair, obwohl der Client Gegner leicht verzögert sieht? Latenz-Toleranz des Genres ist hoch (~500 ms, Ticket 05).

## Entscheidung

- **Autoritativer Server + Client-Prediction + Server-Reconciliation + Interpolation** der Gegner (Gambetta-Modell). Der Server hat immer recht; der Client sagt nur die *eigene* Bewegung voraus und zieht kleine Korrekturen weich glatt.
- **Kommazahlen (Float) mit *internem* Determinismus, KEIN Festkomma-Lockstep:** `sim-core` ist eine reine Funktion `schritt(zustand, inputs, dt)` mit festem `dt`, ohne Zugriff auf echte Uhr, mit **eingespeistem, gesätem Zufallsgenerator**. Bit-genaue Cross-Machine-Gleichheit ist **nicht** nötig, weil der Server reconciled.
- **Tickrate 20 Hz**, als einstellbarer Wert in `shared` (Ticket 11).
- **Kill-Fairness = server-autoritativ mit Rewind:** der Server hält eine Positions-Historie und beurteilt Tode/Schnitte aus der Sicht des *handelnden* Spielers.
- **Transport:** WebSocket + eigenes **Binärprotokoll**, Transport-Schicht abstrahiert; **Input-Batching** (Free-Budget, ADR-0001). **Fill strikt server-only** (Ticket 05).

## Konsequenzen

- Kein Festkomma-Aufwand; **Notausgang:** einzelne heikle Stellen können punktuell auf Festkomma gehoben werden, falls konkrete Divergenz auftritt.
- Höhere Tickrate = flüssiger, aber **mehr DO-CPU** (Trade-off mit dem Free-Budget, ADR-0001) → 20 Hz ist der Sweet Spot (splix-erprobt).
- Der seltene „ich schwöre, ich bin ausgewichen"-Fall lässt sich minimieren (EU-Server, kleiner Interpolationspuffer, Rewind), nicht eliminieren — genretypisch akzeptabel.

## Nachtrag 2026-07-21 — Tick-gemappte Inputs & Sim-Kadenz-Servo (Ticket 17)

Die ursprünglich zählbasierte Input-Rekonstruktion (Queue, ein Intent pro Tick, Jitter-Puffer, Backlog-Drain) ist durch **tick-gemappte Inputs** ersetzt: `seq` ≡ Client-Sim-Tick; der Server hält pro Verbindung einen `tickOffset` (seq `s` → Server-Tick `s + tickOffset`), ackt Ticks als **verarbeitet** (auch ohne eingetroffenen Input — der Turn persistiert) und verwirft verspätete Inputs statt sie nachzuholen. Ein Ankunfts-Margen-Servo (EMA, ±1-Tick-Schritte, Hard-Resync bei Timeline-Bruch) hält die Zuordnung; Begriffe in CONTEXT.md (Tick-Mapping, Ankunfts-Marge, Ack).

Konsequenz für die Uhrenfrage: Die Zuordnung setzt gleiche **reale** Tickraten voraus. Gemessen läuft die Isolate-Uhr des Produktions-DO ~10 % neben der Realzeit (22,2 Hz real bei intern konsistenten 50 ms; Ticket 17/18). Deshalb taktet der Client seine Sim **auf die beobachtete Server-Rate** (Sim-Kadenz-Servo in `ClientSession`, Kappung ±15 %) statt auf 20 Hz Wanduhr. Das fixe `dt = 0,05 s` der Simulation bleibt unangetastet — Replay-Determinismus unverändert; nur die *reale* Abspielrate folgt dem Server.

Gestrichen: `LIMITS.inputBufferTicks`, `inputBacklogTarget`, `standingBacklogTarget`, `backlogTrimAfterTicks`. Messergebnis: Einzelsicht-Versatz Produktion p50 von ~0,29 s auf ~0,14 s real (Belege im Ticket 17).
