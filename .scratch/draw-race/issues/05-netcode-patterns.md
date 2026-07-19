# 05 — Netcode-Patterns für Echtzeit-Trail-Spiele

Type: research
Status: resolved
Blocked by: —

## Question

Welche Netcode-Architektur passt für unser Spiel — autoritativer Server in TypeScript, Browser-Client, ~10–100 Spieler pro Arena — und zwar **jeweils** für die Grid- und die Continuous-Bewegungsvariante (Ticket 01 ist noch offen; beide Varianten abdecken, Aufwandsunterschied explizit machen)?

Zu beantworten (Primärquellen: Gabriel Gambettas Client-Server-Artikelserie, Gaffer on Games, Colyseus-/Nakama-Docs, splix-Protokoll-Doku, ggf. GDC-Talks):

- **Grundmuster:** Autoritativer Server + Client-Prediction + Server-Reconciliation + Entity-Interpolation — wie sieht das konkret für ein Trail-/Territory-Spiel aus (im Unterschied zu Shootern)?
- **Tick-Rate & Simulation:** Sinnvolle Server-Tick-Rate, fixe Zeitschritte, deterministische geteilte Sim (gleicher TS-Code auf Client und Server) — was ist Standard, wo lauern Floating-Point-/Determinismus-Fallen?
- **Transport:** WebSocket (Standard) vs. WebTransport/WebRTC-DataChannel — was ist 2026 im Browser praxistauglich, was bringt es bei unserer Spielgrösse wirklich?
- **Wire-Format:** Binär (eigenes Format, Flatbuffers, CBOR, msgpack) vs. JSON; Delta-Updates + Area-of-Interest (Karten-Chunks wie bei splix) — Empfehlung für unsere Kartengrösse.
- **Bibliothek vs. selbst bauen:** Colyseus (Raum-Modell, State-Sync) vs. rohes ws + eigene Sim — Trade-offs bzgl. sauberer Architektur, Testbarkeit, Lock-in, Hosting-Kompatibilität (Wechselwirkung mit Ticket 03 benennen).
- **Latenz-Toleranz:** Was ist für dieses Genre akzeptabel (EU-Server, Mobilfunk-Clients), welche Kaschier-Techniken (Input-Delay vs. Prediction) passen zu Grid vs. Continuous?

Entscheidungs-Ausgang: Findings-Dokument mit Empfehlung pro Bewegungsvariante; fliesst in Ticket 08 (Architektur) ein.

## Answer

Beide Varianten: autoritativer Server, 20 Hz fixer Tick, WebSocket + Binärformat (WebTransport erst seit Safari 26.4 Baseline, auf Gratis-Hostern ohne UDP kaum nutzbar — Transport-Schicht abstrahieren), Fill strikt server-only, Sim als headless testbares TS-Paket vom Transport getrennt.
**Grid:** kein klassisches Prediction/Rollback nötig — Dead Reckoning + „turn at cell (x,y)"-Inputs mit serverseitigem Undo-Fenster, exakt das Modell des offiziellen splix-Servers (MIT, 1:1-Referenz); Integer-Sim trivial deterministisch; leichte Präferenz Eigenbau auf `ws`.
**Continuous:** zusätzlich echte Client-Prediction + Reconciliation (Gambetta II), Snapshot-Interpolation für Remote-Spieler, Float-Geometrie mit Positions-Historie/Rewind für Kill-Fairness, Determinismus-Disziplin (`Math.*` implementation-dependent); leichte Präferenz Colyseus (MIT, Schema-Delta-Sync).
**Aufwand: Continuous-Netcode ≈ 2–3× Grid**, ohne offene Referenzimplementierung. Latenz-Toleranz des Genres hoch (splix akzeptiert bis ~500 ms); Bandbreite bei 10–100 Spielern kein Kriterium.
Details: [../research/netcode.md](../research/netcode.md)
