# ADR-0002 — Monorepo mit geteiltem, deterministischem Sim-Core

Status: Angenommen (2026-07-19)
Kontext-Tickets: [08 Architektur](../../.scratch/draw-race/issues/08-architektur-erweiterbarkeit.md)

## Kontext

Dieselbe Spiellogik läuft an zwei Orten: **autoritativ** auf dem Server und als **Vorhersage** im Browser (ADR-0003). Teilen beide denselben Code, können sie nicht auseinanderdriften. Das gelingt nur mit einem sauberen Modulschnitt.

## Entscheidung

**Monorepo** (ein Repo, mehrere Pakete):

- **`sim-core`** — reine, deterministische Spiel-Logik (Bewegung, Trail, Loop-Schluss, Fill, Kollision, Regeln). **Kein** Netz, **kein** Rendering, **keine** Uhr/Zufall von aussen. Headless testbar.
- **`protocol`** — Binär-Wire-Format (encode/decode) + Nachrichtentypen; Client und Server teilen es exakt.
- **`shared`** — Balance-Parameter (Ticket 11) + gemeinsame Konstanten/Typen; eine Quelle der Wahrheit.
- **`server`** — Workers/DO-Schale: Arenen, Verbindungen, 20-Hz-Tick, Input, Bots; fährt `sim-core` autoritativ; Transport hinter Interface.
- **`client`** — Browser: three.js-Rendering, Input, Prediction (fährt `sim-core` lokal), Reconciliation, Interpolation, HUD.

## Konsequenzen

- Eine Regel-Wahrheit, kein Client/Server-Drift; `sim-core` ist ohne Browser/Server komplett testbar (trägt Ticket 09).
- Transport hinter Interface im `server` = Umzugs-Klappe für die Hosting-Reversibilität aus ADR-0001.
- Balance in `shared` wird von Server *und* Client-Prediction identisch gelesen.
- Konkreter Paketmanager (pnpm-/npm-Workspaces) und Linter/Tooling = **Ticket 09**, nicht hier.
