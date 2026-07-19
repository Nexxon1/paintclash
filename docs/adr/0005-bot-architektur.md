# ADR-0005 — Bot-Architektur

Status: Angenommen (2026-07-19)
Kontext-Tickets: [04 splix-Analyse](../../.scratch/draw-race/issues/04-splix-codebasis-analyse.md), [08 Architektur](../../.scratch/draw-race/issues/08-architektur-erweiterbarkeit.md), [11 Balance](../../.scratch/draw-race/issues/11-balance-parameter.md)

## Kontext

splix hat keine Bots im Server. Wir brauchen sie, um die öffentliche Arena zu beleben. Zwei Bauweisen: server-interne Entities vs. externe Fake-Clients.

## Entscheidung

**Server-interne Wesen**, die ihre Steuerbefehle über **dieselbe Eingabe-Schnittstelle** wie Netz-Spieler einspeisen (Quelle = lokale KI-Heuristik statt WebSocket). Die Bot-KI erhält bewusst nur eine **begrenzte Wahrnehmungs-Sicht** (was ein Mensch sehen könnte), damit Bots schlagbar/fair bleiben.

## Konsequenzen

- **Kein Netz-/Verbindungs-/Budget-Overhead** — Fake-Clients würden das Free-Budget sprengen (WS 20:1) und einen externen Dauerprozess brauchen, den es auf Workers/DO nicht gibt.
- **Kein Sonder-Pfad** für Bots → die Sim bleibt ehrlich, Bots können per Konstruktion nicht schummeln.
- Bot-Code lebt gekapselt im `server`-Paket.
- **Verhalten/Dichte/Anzahl = Balance** (Ticket 11); bei Bedarf graduiert daraus ein eigenes Bot-Verhalten-Ticket.
