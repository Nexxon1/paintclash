# ADR-0001 — Runtime & Hosting: Cloudflare Workers + Durable Objects

Status: Angenommen (2026-07-19)
Kontext-Tickets: [03 Hosting](../../.scratch/draw-race/issues/03-hosting-recherche.md), [08 Architektur](../../.scratch/draw-race/issues/08-architektur-erweiterbarkeit.md), [13 Billing-Sicherheit](../../.scratch/draw-race/issues/13-free-tier-billing-sicherheit.md)

## Kontext

TypeScript-Full-Stack ist gesetzt. Anforderungen: dauerhaft **gratis** bis das Spiel populär wird, **von Anfang an skalierbar** ohne Kapazitätsrisiko, **keine unerwarteten Kreditkarten-Abbuchungen**. Die kontinuierliche Bewegung (ADR-0003) verlangt selbstgebauten Netcode; die dafür naheliegende Bibliothek Colyseus läuft nicht auf Workers. Alternativen: VM (Oracle Always-Free / Hetzner) + Node + Colyseus, oder Fly.io.

## Entscheidung

**Cloudflare Workers + Durable Objects (Free-Plan)**, statischer Client über Workers Static Assets. Die Transport-Schicht wird hinter einem Interface abstrahiert (ADR-0002/0003), sodass die Runtime **reversibel** bleibt (späterer Umzug auf eine VM ohne Neubau der Spiellogik). Netcode wird selbst gebaut statt Colyseus.

Begründung gegen den VM/Colyseus-Weg: Colyseus liefert nur Raum-Modell + State-Sync — die harten Teile (Prediction/Reconciliation/Rewind) baut man ohnehin selbst; das Raum-Modell gibt es bei DO gratis (1 DO = 1 Raum). Workers/DO skaliert **automatisch horizontal** (mehr DOs, keine Kapazitätsplanung, kein Load-Balancer) und ist die einzige dauerhaft gratis + kartenlos + hart-gestoppte Option.

## Konsequenzen

- **Skalierung ist horizontal und automatisch** (mehr Arenen = mehr DOs); *eine einzelne* Arena ist durch das DO-CPU-Budget gedeckelt.
- **Free-Grenzen (bestätigt in Ticket 13):** 100'000 Requests/Tag, eingehende WS-Messages zählen 20:1 → **Input-Batching ist Pflicht**; Duration ≈ **genau eine** 24/7-Arena; DO **single-threaded** (kein Web-Worker wie splix) → CPU pro Arena-Tick ist der Engpass → **Benchmark nötig** (Ticket 14, bestimmt die Shard-Grösse).
- **Abbuchungssicherheit:** auf Free bleiben, **keine Karte hinterlegen** (dann strukturell keine Belastung möglich). Der $5-Paid-Plan hat **keinen** harten Spend-Cap → ein Upgrade ist eine bewusste Kosten-Entscheidung.
- DOs sind auf Free nur **SQLite-backed** verfügbar — passt (ADR-0004).
