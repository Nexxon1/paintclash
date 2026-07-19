# 13 — Free-Tier-Konditionen & Billing-Sicherheit (Cloudflare Workers/DO)

Type: research
Status: resolved
Blocked by: —

## Question

Bestätige verbindlich für 2026 die kostenlosen Nutzungsbedingungen der in Ticket 03 gewählten Cloudflare-Workers/Durable-Objects-Basis und — entscheidend für den User — wie sichergestellt wird, dass **nie unbemerkt etwas von einer Kreditkarte abgebucht** wird.

Graduiert aus der Architektur-Grillung (Ticket 08), als der User die Hosting-Wahl (A = Workers/DO) unter der ausdrücklichen Bedingung akzeptierte, dass Free-Tier und Billing-Sicherheit geprüft sind. Der User ist neu im Game-Dev und will „gratis bis das Spiel wirklich populär wird; Kreditkarte höchstens als Sicherheit, aber keine unerwarteten Abbuchungen".

Zu klären (Primärquellen: offizielle Cloudflare-Pricing-/Docs-Seiten, Stand 2026; bestehende Findings [../research/hosting.md](../research/hosting.md) zuerst lesen und dessen Behauptungen verifizieren/aktualisieren):

- **Kreditkarte:** Verlangt der Workers-**Free**-Plan eine Karte? (Erwartung: nein — verifizieren.)
- **Durable Objects auf Free (kritischster Punkt):** Sind DOs auf dem Free-Plan wirklich nutzbar, oder brauchen sie Workers Paid? Historisch brauchten DOs den Paid-Plan; Ticket 03 behauptet „Free Plan" — das muss hart belegt werden. SQLite-backed DO vs. KV-backed DO auf Free ausdrücklich unterscheiden.
- **Limits für unseren Workload:** Trägt der Free-Plan eine always-on-Arena (20-Hz-Tick, WebSocket-Hibernation, ~10–100 Spieler)? Konkrete Request-/CPU-/Duration-/WebSocket-Limits nennen; DO-CPU-Budget pro Invocation/Tick.
- **Billing-Sicherheit:** Wie garantiert man „kein Überraschungs-Abbuchen"? Gibt es harte Spend-Limits / Billing-Alerts? Bucht der 5-$-Paid-Plan Overage automatisch ab oder stoppt er hart? Wie deckelt man das?
- **Upgrade-Schwelle:** Ab wann reicht Free nicht mehr (eine Arena → wann Paid nötig)? Was kostet der erste Schritt genau, was ist inklusive?
- **Fallbacks kurz:** Oracle Always-Free (Karte nur zur Identitäts-Verifikation — bestätigen, dass für Always-Free-Ressourcen nichts abgebucht wird) und Fly.io (weiches, nutzungsbasiertes Billing = reales Abbuchungsrisiko) einordnen.

Findings als Datei unter `.scratch/draw-race/research/free-tier-billing-sicherheit.md`, mit zitierten Primärquellen (URL + Datum), Unsicherheiten explizit markiert.

Entscheidungs-Ausgang: Findings-Dokument, das die Hosting-Wahl aus Ticket 03/08 **bestätigt oder einen Dealbreaker aufzeigt**, plus eine Billing-Sicherungs-Checkliste (Spend-Limits/Alerts konkret einrichten) für die Spec (Ticket 10).

## Answer

Bestätigt gegen Primärquellen (Findings: [../research/free-tier-billing-sicherheit.md](../research/free-tier-billing-sicherheit.md), Stand 2026-07-19):

- **Gratis + abbuchungssicher: JA** — solange auf dem Free-Plan **und keine Kreditkarte hinterlegt**. Free verlangt keine Karte („no credit card required, never expires, commercial use allowed"); Limit-Überschreitung = **harter Stopp mit Fehler, keine Rechnung**. Ohne hinterlegte Karte auf Free ist eine Belastung strukturell unmöglich.
- **DOs auf Free: JA, aber nur SQLite-backed** (KV-backed braucht Paid; seit Changelog 2026-07-09 sind neue Namespaces ohnehin SQLite-only — „the Workers Free plan has only ever supported SQLite-backed Durable Objects"). Für uns vorteilhaft: SQLite-DO ist gleich die Persistenzschicht (Raum-Registry, s. Ticket 08/Frage 5).
- **Engpässe (Free):** 100'000 Requests/Tag; eingehende WS-Messages zählen **20:1** (≈2 Mio./Tag) → **Input-Batching Pflicht** (prägt das Protokoll-Paket). Duration **13'000 GB-s/Tag** ≈ **genau eine** 24/7-Arena (~85 %, da 1 aktives DO ≈ 128 MB × Wall-Clock ≈ 10'800 GB-s/Tag). Pro DO: 1 GB SQLite, 30 s CPU/Invocation (Reset bei jeder Nachricht), 5 Mio. Row-Reads/100k Row-Writes pro Tag; **Anzahl DOs unbegrenzt**.
- **Konsequenz private Räume (Frage 4):** leere/Lobby-Räume **hibernieren → ~0 Kosten**; das Rest-Budget nach der öffentlichen Arena trägt grob **eine Handvoll aktiver Raum-Stunden/Tag**. Sicherung: nur ticken, wenn ein Spiel mit Spielern läuft; leere Räume sofort schlafen legen.
- **Vorbehalt (wichtig für die Spec):** Workers **Paid ($5/Mt.) hat KEINEN harten Spend-Cap** — Overage wird automatisch abgebucht, Budget-Alerts sind rein informativ, Threshold-Billing nicht modifizierbar. → **Abbuchungssicherheit = auf Free bleiben, keine Karte hinterlegen**; ein Upgrade ist eine bewusste Kosten-Entscheidung.
- **Kein Dealbreaker.** Hosting-/Runtime-Wahl A (Workers/DO) aus Ticket 03/08 ist bestätigt.
