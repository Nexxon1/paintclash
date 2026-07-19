# 09 — Teststrategie & Qualitätsstandards

Type: grilling
Status: open
Blocked by: 08

## Question

Wie stellen wir „sauber, gängige Standards, keine Shortcuts, gute Testabdeckung" konkret sicher — als verbindliche, in der Spec dokumentierte Regeln statt guter Vorsätze?

Zu entscheiden (via /grilling):

- **Testpyramide:** Unit-Tests für den deterministischen Sim-Core (der Hauptgewinn des Architektur-Schnitts — Regeln wie Fill/Kollision komplett ohne Netz/Rendering testbar, inkl. Property-based Tests?), Integrationstests für Server-Räume und Protokoll, E2E (Playwright: zwei Browser-Clients in einer Arena?) — was davon gehört in die Grundversion, was ist übertrieben?
- **Coverage:** Zielwerte pro Paket (Sim-Core hoch, Rendering pragmatisch) statt Pauschalquote?
- **Tooling:** ESLint (strict, welche Presets), Prettier, tsconfig-strictness, Vitest o. ä., CI (GitHub Actions? — Achtung: Repo ist bisher kein Git-Repo, das gehört dann eingerichtet).
- **Konventionen:** Projektstruktur-Regeln, Commit-/PR-Konventionen, Definition of Done — was davon in CLAUDE.md/CONTEXT.md festgeschrieben wird.

Blockiert durch 08, weil die Testpyramide direkt am Modulschnitt hängt.

Entscheidungs-Ausgang: Qualitäts-Kapitel der Spec.
