# 15 — Abuse- & Cheat-Schutz der öffentlichen Arena

Type: grilling
Status: open
Blocked by: 08

## Question

Welche Abuse-/Cheat-Schutzmassnahmen bekommt die Grundversion, und welche bleiben Ausbaustufe? Jetzt ticketreif, da die Architektur (Ticket 08) steht: der autoritative Server (Fill/Kills server-only) macht klassisches Cheating schwer, aber offene Flanken bleiben.

Graduiert aus dem Map-Nebel „Abuse-/Cheat-Schutz". Zu klären (via /grilling):

- **Rate-Limiting / Flood-Schutz:** pro Verbindung, verzahnt mit Input-Batching und dem Free-Request-Budget (ADR-0001) — DoS-/Spam-Schutz.
- **Dritt-Clients / Headless-Bots:** jemand baut einen eigenen Client, der sich verbindet. Verbindungslimits pro IP, ggf. Turnstile/Proof-of-Work vor dem Join? Was ist Phase-1-verhältnismässig?
- **Nickname-Moderation:** Blockliste client+server steht (Ticket 02) — reicht das, oder mehr (Meldefunktion später)?
- **Server-Autoritäts-Grenzen:** was kann ein manipuliertes Client-Paket *maximal* erreichen, und deckelt der Server das (Input-Validierung, plausible Bewegungsdeltas)?

Rahmen (entschieden): autoritativer Server + Rewind (ADR-0003), Input-Batching Pflicht (ADR-0001), 1 DO = 1 Arena (ADR-0004).

Entscheidungs-Ausgang: Sicherheits-/Betriebs-Abschnitt der Spec (Ticket 10) — Massnahmen der Grundversion + bewusst verschobene.
