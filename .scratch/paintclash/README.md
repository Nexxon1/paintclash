# paintclash — Bauphase (Implementierungs-Effort)

Dieser Effort setzt die abgenommene Spec um. Er ist bewusst getrennt vom
Wayfinding-Effort [`../draw-race/`](../draw-race/), der die Spec *produziert* hat.

- **Maßgebliche Spec:** [`../draw-race/spec.md`](../draw-race/spec.md) — implementierungsreif, gelockt (2026-07-19). Die Tickets referenzieren sie kapitelweise („spec §2.5").
- **Bau-Tickets:** [`issues/`](issues/) — 16 Tracer-Bullet-Slices, `01`–`16` in Abhängigkeits-Reihenfolge (Blocker zuerst), jeweils mit `Blocked by:`-Zeile und `Status: ready-for-agent`.
- **Domänen-Vokabular:** [`../../CONTEXT.md`](../../CONTEXT.md) · **ADRs:** [`../../docs/adr/`](../../docs/adr/)

## Ablauf

Die Frontier Ticket für Ticket mit `/implement` abarbeiten (Kontext zwischen Tickets leeren). Die Frontier ist jedes Ticket in `issues/`, dessen `Blocked by:` vollständig erledigt ist — bei Gleichstand gewinnt die niedrigere Nummer.

Erste startbare Tickets (nur durch `01` bzw. nichts geblockt): **01** (Monorepo-Gerüst + GitHub-Remote + CI/CD), danach **02** (DO-CPU-Benchmark) und **03** (Walking Skeleton).

## Warum ein eigener Slug?

`draw-race` durchlief `/wayfinder` → `/to-spec`; dabei füllte sich `draw-race/issues/` mit den **Entscheidungs-Tickets** (01–15). `/to-tickets` legt die **Bau-Tickets** ebenfalls in einem `issues/` ab (ab 01) — ein eigener Effort-Slug (`paintclash`, = der finale Projektname) gibt ihnen ein frisches `issues/`, statt die Wayfinding-Tickets zu überschreiben. `draw-race/` bleibt unverändertes Wayfinding-Archiv (Map, Entscheidungs-Tickets, Research, Prototypen, Spec).
