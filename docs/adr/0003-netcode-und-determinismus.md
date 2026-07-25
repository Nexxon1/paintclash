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

## Nachtrag 2026-07-25 — Rewind konkretisiert (Ticket 07)

Die Entscheidung „Kill-Fairness = server-autoritativ mit Rewind" ist umgesetzt; wie, war offen. Festgelegt:

- **Additiv, nicht ersetzend.** Der zurückgespulte Durchgang läuft *nach* dem Live-Durchgang, in derselben reinen `detectDeaths`; ein Opfer stirbt höchstens einmal (Dedup pro Tick), also kann Rewind Tode nur **hinzufügen**, nie umdeuten. Ein Live-Treffer bleibt ein Live-Treffer.
- **Historie im Sim-Zustand, nicht daneben.** Je Entity ein rollierendes Fenster von `LIMITS.rewindMaxTicks` = 10 Nach-Tick-Posen (500 ms — die Latenz-Toleranz des Genres, §6.3). Sie wird mit-geklont und **mit-gehasht**: der Replay-Determinismus deckt die Rewind-Eingaben mit ab, statt sie in einem Nebenzustand ohne Garantien zu halten. Preis: der Golden-Hash wandert (dokumentiert), und ein Rewind-Bug kann sich nicht hinter dem Replay verstecken.
- **Verzögerung ist client-*gemeldet*, aber doppelt server-geklemmt.** Der Client sendet im Input-Frame (Protokoll v4 → v5) den **Sicht-Tick**, den er gerade rendert; der Server rechnet daraus die Rewind-Tiefe. Reines Timing, kein Spielzustand (spec §6.4) — aber ein tiefer Rewind ist ein *Vorteil* (der Durchgang kann nur Tode hinzufügen), also wäre Untertreiben sonst gratis profitabel. Deshalb bindet die Tiefe nicht nur das harte Fenster (`sv_maxunlag`-Klasse), sondern auch die **gemessene** Zeitachse der Verbindung: `tickOffset` misst die Upstream-Laufzeit (der Margen-Servo parkt ihn knapp darüber), also ist „2 × tickOffset + Interpolations-Zuschlag" so tief, wie diese Verbindung ehrlich sehen könnte. Wer mehr Unlag will, muss seine **eigenen** Inputs echt später eintreffen lassen und zahlt ihn mit derselben Menge Steuer-Verzug — der Exploit trägt seine Kosten selbst. Alternative „Server schätzt die Verzögerung ganz allein" bleibt verworfen: den (adaptiven, Ticket 17) Interpolationspuffer des Clients kennt er nicht — er deckt ihn als Zuschlag ab (`LIMITS.rewindInterpAllowanceTicks`), wer darüber liegt, spult etwas flacher zurück als er rendert.
- **Kein Sicht-Tick ⇒ kein Rewind.** Sicht-Tick 0 („noch nichts gerendert", frisch beigetreten) heisst Tiefe 0 — nie das ganze Fenster, und es lässt sich auch keine einmal erreichte Tiefe damit einfrieren.
- **Trails werden nicht kopiert.** Ein Trail wächst nur an der am Kopf klebenden Spitze, also ist die Vergangenheit *derselben* Trail-Generation eine Teilmenge der lebenden — ein Live-Fehlschlag ist beweisend. Nur ein **Reset** entfernt Geometrie, deshalb wird ausschliesslich beim **Fill** der alte Trail eingefroren aufbewahrt (per Generation an die Historie gebunden, GC beim Herausrollen). Das ist der Fall, für den der Rewind existiert: „ich habe geschnitten, bevor er heimkam".
- **Tod löscht die Rewind-Vergangenheit.** Ein Todes-Reset retiriert *nicht* — sonst könnte der verzögerte Schnitt eines abgeschlossenen Lebens den frischen Respawn ein zweites Mal töten (die „doppelter Tod"-Falle des Rewinds).
- **Schild zum gesehenen Tick.** „Eigenes Gebiet = sicher" wird im zurückgespulten Durchgang aus dem Historien-Eintrag gelesen, nicht aus dem Jetzt. Damit fällt die Ein-Tick-Karenz frisch Beklauter aus Ticket 06 weg: Sicherheit ist jetzt durchgehend „steht wirklich auf eigenem Land", einmal pro Tick entschieden und an Historie *und* Kollision gegeben.
