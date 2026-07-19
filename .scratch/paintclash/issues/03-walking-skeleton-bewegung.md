# 03 — Ein Spieler bewegt sich end-to-end (Walking Skeleton)

**What to build:** Der erste vollständige vertikale Durchstich. Man öffnet den Browser, gibt einen Namen ein, joint die öffentliche Arena und steuert einen **Kopf** per Tastatur durch die quadratische 200×200-**Arena**; am Rand gleitet der Kopf an der **sanften Barriere** entlang (kein Rand-Tod); man startet auf einem 6×6-**Startblock**. Die Bewegung ist server-autoritativ — der Client sendet **nur Steuer-Intent**, der Server re-derived die Position bei festem Tempo und geklemmter Drehrate — fühlt sich dank Prediction/Reconciliation/Interpolation aber flüssig an. Kein Trail, kein Fill: nur die komplette Pipeline steht.

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] `shared`: eingefrorenes `BALANCE` (arena/movement/spawn-Startwerte) + Tickrate **20 Hz** als einzige Quelle der Wahrheit (§10.6), von `sim-core`/`server`/`client` identisch gelesen.
- [ ] `sim-core`: reine `schritt(zustand, inputs, dt)` mit **festem dt**, ohne echte Uhr, mit **eingespeistem gesätem RNG**; kontinuierliche Bewegung (Tempo 9 WU/s, Drehrate 320°/s), sanfte Barriere, Spawn mit Startblock + Mindestabstand 25 WU.
- [ ] `protocol`: Binär-Nachrichten join / **Steuer-Intent** (mit Input-Sequenznummer) / Snapshot; Input-Batching-fähig (Free-Budget, WS 20:1).
- [ ] `server`: Arena-DO mit 20-Hz-Tick fährt `sim-core` autoritativ; WS-Annahme; **Intent-only-Validierung** an der Protokollgrenze (Opcode/Länge/Wertebereich verwerfen; Intent an Socket-`playerId` gebunden — §8.2); minimaler **Router-Worker** liefert den Client aus und leitet WS ans eine öffentliche Arena-DO.
- [ ] `client`: Tastatur-Steuerung (A/D bzw. Pfeile); Prediction (fährt `sim-core` lokal); Reconciliation (weiches Nachziehen); Interpolation der Gegner; three.js-Szene (Arena-Boden, perspektivischer Tilt); Render-Interpolation zwischen Ticks ist Pflicht.
- [ ] `sim-client`: erstes **headless**-Werkzeug, spricht das echte Binär-Protokoll.
- [ ] Tests: **Replay-Determinismus** (gleiche Inputs+Seed → bit-identischer Zustands-Hash nach N Ticks), **Protocol-Round-trip + Golden-Bytes**, **Szenario-Test** (Server + Sim-Client bewegt Kopf), eine kuratierte **Playwright-E2E** (echte Tastatur-Eingabe im Browser).
- [ ] CI grün inkl. Coverage-Gates der berührten Pakete (§9.7 DoD).

_Referenz: spec §2.3–2.4, §3, §5, §6, §8.2, §10; ADR-0002/0003/0004._
