# paintclash — Bauphase (Implementierungs-Effort)

Dieser Effort setzt die abgenommene Spec um. Er ist bewusst getrennt vom
Wayfinding-Effort [`../draw-race/`](../draw-race/), der die Spec *produziert* hat.

- **Maßgebliche Spec:** [`../draw-race/spec.md`](../draw-race/spec.md) — implementierungsreif, gelockt (2026-07-19). Die Tickets referenzieren sie kapitelweise („spec §2.5").
- **Bau-Tickets:** [`issues/`](issues/) — 16 Tracer-Bullet-Slices, `01`–`16` in Abhängigkeits-Reihenfolge (Blocker zuerst), jeweils mit `Blocked by:`-Zeile und `Status: ready-for-agent`.
- **Domänen-Vokabular:** [`../../CONTEXT.md`](../../CONTEXT.md) · **ADRs:** [`../../docs/adr/`](../../docs/adr/)

## Ablauf

Die Frontier Ticket für Ticket mit `/implement` abarbeiten (Kontext zwischen Tickets leeren). Die Frontier ist jedes Ticket in `issues/`, dessen `Blocked by:` vollständig erledigt ist — bei Gleichstand gewinnt die niedrigere Nummer.

Erste startbare Tickets (nur durch `01` bzw. nichts geblockt): **01** (Monorepo-Gerüst + GitHub-Remote + CI/CD), danach **02** (DO-CPU-Benchmark) und **03** (Walking Skeleton).

## Szenario-Tests: die Regeln gegen rote Pipelines

Die Suite unter [`../../tests/scenario/`](../../tests/scenario/) war über mehrere Tickets hinweg die häufigste Quelle roter CI-Läufe — nie wegen einer verletzten Regel, fast immer weil die **Prämisse** eines Tests nicht zustande kam (ein Kopf musste erst in einen Zustand *geflogen* werden). Fünf Regeln, seit Ticket 11 durchgesetzt:

1. **Der Seed ist gepinnt** (`tests/scenario/wrangler.jsonc` → `ARENA_SEED`). Spawns sind in Produktion zufällig; in der Suite wären sie eine Zufallsvariable pro Lauf, und jede Choreografie damit ein Manöver, das *meistens* klappt. Gepinnt gilt: was lokal grün ist, ist in CI grün — und was in CI fällt, fällt lokal reproduzierbar. (Belegt: zwei aufeinanderfolgende Läufe zeigen bis auf ~20 ms identische Test-Laufzeiten, d. h. denselben geflogenen Pfad.)
2. **Jeder Prämissen-Fehlschlag benennt sich selbst.** „Hat nicht geklappt" kostet die nächste Sitzung eine Debugging-Runde; die Fehlermeldung nennt die Stufe (Weitungs-Runde, Orbit, Angriff) und den Messwert.
3. **Fortschritts-Budgets, keine Wanduhr-Wetten.** Stufen warten auf Sim-Zustand (Fläche, `pointInTerritory`-Streak, Tode), mit großzügiger Wanduhr-Decke — ein langsamer Runner macht einen Test langsamer, nicht rot.
4. **Kein Retry.** Anders als bei Playwright (das echtes Frame-Pacing auf geteilten Runnern *messt* und deshalb einen Versuch nachlegt) soll diese Suite **stabil** sein, nicht neu gewürfelt. Ein Retry würde genau das Signal verstecken, das sagt „diese Choreografie ist fragil geworden". Wird ein Test rot, nennt seine Meldung die Stufe — dann wird die Ursache behoben, nicht der Lauf wiederholt.
5. **Keine Bots in den Choreografien** (seit Ticket 12, `ARENA_BOTS`). Dieselbe Begründung wie Regel 1: sieben zusätzliche Entities, die durch die Szene malen, stehlen und töten, machen aus jeder Choreografie ein Manöver, das *meistens* klappt. Die Aufteilung:
   - `wrangler.jsonc` **Top-Level** = Arena wie in Produktion, Bots an. Nur `bots.test.ts` läuft dort, über `vitest.bots.config.ts`.
   - `wrangler.jsonc` **`env.hermetic`** (`ARENA_BOTS: "0"`) = alle anderen Dateien, über `vitest.config.ts`. Eine neue Szenario-Datei landet automatisch hier.
   - Playwright läuft ebenfalls bot-frei (`e2e:server` → `--var ARENA_BOTS:0`); mit voller Arena fällt z. B. die zweite Browser-Zeile aus den Top 5 und der Leaderboard-Test wird zu Recht rot.

Vor jedem Commit lokal fahren: `pnpm test:scenario` (~160 s, **zwei** Durchläufe: hermetisch + Bots) **und** `pnpm test:e2e` (~45 s, `wrangler dev` läuft unter WSL2 einwandfrei — die alte „stallt"-Notiz gilt nicht mehr).

## Warum ein eigener Slug?

`draw-race` durchlief `/wayfinder` → `/to-spec`; dabei füllte sich `draw-race/issues/` mit den **Entscheidungs-Tickets** (01–15). `/to-tickets` legt die **Bau-Tickets** ebenfalls in einem `issues/` ab (ab 01) — ein eigener Effort-Slug (`paintclash`, = der finale Projektname) gibt ihnen ein frisches `issues/`, statt die Wayfinding-Tickets zu überschreiben. `draw-race/` bleibt unverändertes Wayfinding-Archiv (Map, Entscheidungs-Tickets, Research, Prototypen, Spec).
