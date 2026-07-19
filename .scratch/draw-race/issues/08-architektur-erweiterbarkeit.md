# 08 — Architektur & Erweiterbarkeit

Type: grilling
Status: resolved
Blocked by: 02, 03, 04, 05

## Question

Wie schneiden wir das System, damit es sauber testbar bleibt und die Ausbaustufen (Items/Upgrades, Spielmodi, Skins/Monetarisierung, persistenter Canvas) andocken können, ohne die Grundversion zu verkomplizieren?

Zu entscheiden (via /grilling + /domain-modeling; Ergebnisse als ADRs unter `docs/adr/` und Glossar in `CONTEXT.md`):

- **Modulschnitt:** Paketstruktur (Monorepo?) mit engine-unabhängigem, deterministischem Sim-Core (geteilt Client/Server), Server-Schale (Räume, Verbindungen, Ticks), Client-Schale (Rendering, Input, Prediction), Protokoll-Paket.
- **Runtime & Prozessmodell:** Konkrete Runtime (Node/Deno/Bun/Workers — folgt aus Ticket 03), eine Arena pro Prozess/Objekt? Wie entstehen private Räume (Ticket 02) technisch?
- **Zustand & Persistenz:** Was überlebt einen Server-Neustart (Arena-Zustand? Raum-Codes? Rekorde?), wo liegt es?
- **Skalierungspfad:** Wie kämen später mehrere Arenen/Regionen dazu, ohne Umbau (nur Pfad dokumentieren, nicht bauen)?
- **Erweiterungspunkte:** Wo genau docken Items/Upgrades (Entity-/Effekt-System?), Spielmodi (Regel-Strategie?), Skins (Kosmetik getrennt von Sim), Accounts (Spieler-ID-Platzhalter) und der persistente Canvas an? Je ein Absatz „so würde es andocken" reicht.
- **Bot-Architektur:** Bots als Fake-Clients gegen die Server-API vs. serverinterne Entities — was hält die Sim sauber?

Input: Regelwerk (02), Hosting-Empfehlung (03), splix-Erkenntnisse (04), Netcode-Empfehlung (05).

Entscheidungs-Ausgang: ADRs + Architektur-Kapitel der Spec.

## Comments

**2026-07-18, aus Ticket 01 (Bewegungsmodell = Kontinuierlich):** Die Bewegung ist kontinuierlich (freie Winkel). Damit ist der in Ticket 05 beschriebene teurere Netcode-Pfad aktiv, und dieses Ticket muss ihn konkret auflösen:

- **Netcode:** echte Client-Prediction + Server-Reconciliation + Entity-Interpolation + Input-Rewind — keine offene Referenzimplementierung, also Eigenbau. Aufwand laut Ticket 05 ≈ 2–3× Grid.
- **Hosting-Konflikt (mit Ticket 03):** die in 05 leicht bevorzugte Bibliothek Colyseus läuft nicht auf Cloudflare Workers/Durable Objects. Zu entscheiden: Netcode selbst auf Workers/DO bauen **oder** Hosting neu bewerten (Fallback Oracle-Always-Free-VM aus Ticket 03).
- **Fill:** polygonbasierte Flächeneroberung (Paper.io-Stil), nicht der zellbasierte Uint8-Flood-Fill aus splix (Ticket 04); splix bleibt Referenz nur für Server-Autorität, 20-Hz-Tick und Binärprotokoll.
- **Sim-Core:** deterministischer, headless testbarer TS-Kern mit Float-Positionen/Winkeln + Polygon-Fill — Floating-Point-Determinismus zwischen Client und Server beachten (Fixed-Point/Integer-Erwägung).

## Answer

Vollständig durchgegrillt (HITL, 2026-07-19). Ergebnisse als 6 ADRs unter [docs/adr/](../../../docs/adr/) und Glossar-Erweiterung in [CONTEXT.md](../../../CONTEXT.md). Kern:

- **Runtime/Hosting (ADR-0001):** bei Cloudflare Workers + Durable Objects bleiben, Netcode selbst bauen, Transport-Abstraktion hält die Wahl reversibel. Bestätigt durch Ticket 13 (gratis + abbuchungssicher auf Free ohne Karte; DO-CPU pro Arena ist das Risiko → Benchmark Ticket 14).
- **Modulschnitt (ADR-0002):** Monorepo, Pakete `sim-core` / `protocol` / `shared` / `server` / `client`; `sim-core` rein & deterministisch.
- **Netcode & Determinismus (ADR-0003):** autoritativer Server + Prediction/Reconciliation/Interpolation; Float + interner Determinismus, kein Festkomma-Lockstep; 20-Hz-Tick (einstellbar); Server-Rewind für Kill-Fairness; WebSocket + Binärprotokoll + Input-Batching.
- **Arena/Prozess/Persistenz (ADR-0004):** 1 DO = 1 Arena, Router-Worker davor, private Räume = DO pro Code + Hibernation; Live-Zustand flüchtig (Neustart = Reset), SQLite nur für Raum-Registry, Rekorde lokal.
- **Bots (ADR-0005):** server-interne Entities über geteilte Eingabe-Schnittstelle, begrenzte Sicht.
- **Erweiterbarkeit (ADR-0006):** Effekt-Feld / Regel-Strategie / `appearance` / `playerId`-Indirektion / DO-Snapshot-Naht — 1–4 als geplante Evolution, 5 (persistenter Canvas) spekulativ.

**Neue Tickets:** 14 (DO-CPU-Benchmark, blockiert durch Spec 10 → erster Implementierungs-Spike) und 15 (Abuse-/Cheat-Schutz, graduiert aus dem Nebel). **Ticket 09** (Teststrategie) ist damit entblockt.
