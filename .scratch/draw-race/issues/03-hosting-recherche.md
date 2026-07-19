# 03 — Kostenloses Hosting für den Echtzeit-Server

Type: research
Status: resolved
Blocked by: —

## Question

Welche Hosting-Optionen tragen in Phase 1 **kostenlos** einen always-on TypeScript-Echtzeitserver (WebSockets, eine Arena, ~10–100 gleichzeitige Spieler) plus statisches Client-Hosting — und welcher Upgrade-Pfad existiert, wenn das Spiel wächst?

Zu prüfen (Primärquellen: offizielle Pricing-/Docs-Seiten, Stand heute):

- Kandidaten Server: Cloudflare Workers + Durable Objects (Free Tier), Deno Deploy, Fly.io, Render, Railway, Glitch, Oracle Cloud Always-Free-VM, Google Cloud Free Tier (e2-micro), AWS Free Tier; ergänzend „fast gratis" (Hetzner o. ä.) als Referenz.
- Kriterien: echter WebSocket-Support (lange Verbindungen!), Idle-/Sleep-Verhalten (schläft der Prozess ein?), CPU-/RAM-/Traffic-Limits, Verbindungs-Limits, EU-Region/Latenz, Kreditkarten-Pflicht, Kostenfallen bei Überschreitung, Eignung für einen zustandsbehafteten Game-Loop (Tick-Rate ~10–30/s), Persistenz-Angebot für Kleinkram (Rekorde, Raum-Codes).
- Kandidaten Client (statisch): Cloudflare Pages, GitHub Pages, Netlify — nur kurz, das ist der einfache Teil.
- Upgrade-Pfad: Was kostet die jeweils erste Bezahlstufe, und wie sähe horizontale Skalierung (mehrere Arenen) auf der Plattform aus?

Rahmen: TypeScript full-stack ist gesetzt; die Runtime (Node/Deno/Bun/Workers) darf sich nach dem Hosting-Ergebnis richten — Wechselwirkung mit Ticket 08 explizit benennen.

Entscheidungs-Ausgang: Empfehlung (1. Wahl + Fallback) mit Begründung; fliesst in Ticket 08 (Architektur) ein.

## Answer

**1. Wahl: Cloudflare Workers + Durable Objects (Free Plan), Client auf Workers Static Assets** — einzige Option, die dauerhaft gratis ist und den Workload trägt: 1 Arena = 1 DO mit `setInterval`-Tick, WebSocket Hibernation bei leerer Arena, SQLite (5 GB) für Rekorde/Raum-Codes, EU via `weur`-Hint, keine Kreditkarte, harter Stopp statt Kostenfalle. Grenzen: Free-Duration trägt genau **eine** 24/7-Arena, Request-Budget (WS-Messages 20:1) erzwingt Input-Batching; Upgrade-Pfad Workers Paid 5 $/Monat deckt eine Dauer-Arena ab, weitere Arenen = weitere DOs (unbegrenzt). **Fallback: Oracle Always Free A1-VM in Frankfurt** (2 OCPU/12 GB/10 TB Egress, Node/Deno frei wählbar), aber mit Kreditkarten-Pflicht, Kapazitätslotterie und Idle-Reclaim-Risiko; „fast gratis"-Referenz Hetzner CX22 (3,79 €/Monat). Glitch (eingestellt), Fly.io (kein Free Tier), Railway, Render, Deno Deploy, GCP, AWS scheiden für gratis-always-on aus. Für Ticket 08: 1. Wahl fixiert Runtime auf Workers (workerd) — Spiellogik runtime-agnostisch schneiden. Details: [../research/hosting.md](../research/hosting.md)
