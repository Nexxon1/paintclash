# ADR-0004 — Arena-, Prozess- & Persistenzmodell

Status: Angenommen (2026-07-19)
Kontext-Tickets: [02 Spielregeln](../../.scratch/draw-race/issues/02-spielregeln-im-detail.md), [08 Architektur](../../.scratch/draw-race/issues/08-architektur-erweiterbarkeit.md), [13 Billing-Sicherheit](../../.scratch/draw-race/issues/13-free-tier-billing-sicherheit.md)

## Kontext

Jede Arena braucht ein konsistentes „Gehirn", das ihren Zustand hält und die Tick-Schleife dreht. Persistenz ist auf Free nur als **SQLite-backed DO** verfügbar, mit knappem Schreib-Budget (100k Row-Writes/Tag).

## Entscheidung

**Prozessmodell:**
- **1 Durable Object = 1 Arena.**
- **Öffentliche Arena:** *ein* always-on DO mit fester Adresse (Phase 1: genau eine — passt aufs Free-Budget).
- **Private Räume:** *ein* DO pro **Raum-Code** (`idFromName(code)`); entsteht beim Erstellen/Beitreten, **hibernieren bei Leere/Lobby**, Aufräumen per Timeout. Host konfiguriert Grösse/Bots/Limit (Ticket 02).
- **Router-Worker davor:** zustandslos, liefert den statischen Client aus und leitet WS-Verbindungen an das richtige Arena-DO (öffentlich → feste Adresse, privat → Code). Naht für den späteren Matchmaker (ADR-0001-Skalierung / Ticket 08 Frage 8).

**Persistenz:**
- **Live-Spielzustand (Positionen/Trails/Gebiet): flüchtig im Speicher, nicht persistiert.** Neustart = Arena-Reset, Spieler spawnen frisch (akzeptiert; persistenter Live-Zustand = „persistenter Canvas" = out of scope).
- **SQLite (im DO):** nur die **Raum-Registry** privater Räume (Code → Konfig), selten geschrieben.
- **Persönliche Rekorde: lokal im Browser (localStorage)**, kein Server-Speicher (bis Accounts, ADR-0006).
- **Leaderboard:** live aus dem Speicher berechnet (nur %).
- **Nickname-Blockliste:** statische, mit dem Server ausgelieferte Daten.

## Konsequenzen

- „Ein paar private Räume" sind gratis machbar, weil leere/Lobby-Räume hibernieren; nur ticken, wenn ein Spiel mit Spielern läuft.
- Winzige SQLite-Schreiblast → passt bequem ins Free-Budget.
- Bei Dauer-Volllast privater Räume greift der harte Tages-Stopp (keine Rechnung) → Signal für bewusstes Paid-Upgrade.
