# 09 — Teststrategie & Qualitätsstandards

Type: grilling
Status: resolved
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

## Answer

Verbindliche Teststrategie & Qualitätsstandards der Grundversion, entlang des Modulschnitts aus [ADR-0002](../../../docs/adr/0002-monorepo-mit-geteiltem-deterministischem-sim-core.md) und des Netcode-/Determinismus-Modells aus [ADR-0003](../../../docs/adr/0003-netcode-und-determinismus.md). Grundprinzip des Users: **hohe Abdeckung kritischer Pfade, keine Shortcuts — mechanisch erzwungen statt als guter Vorsatz.** Ausgang wird in Ticket 10 ins Qualitäts-Kapitel der `spec.md` gegossen; operative Kurzfassung → `CLAUDE.md`, Begriffe → `CONTEXT.md`.

### 1. Testpyramide (Gewichtung entlang der Pakete)

| Paket | Testarten | Gewicht |
|---|---|---|
| **`sim-core`** (rein, deterministisch) | Unit + **Property-based** + **Replay-Determinismus/Golden-Fixtures** — Fill, Trail-Schnitt, Kollision, Tod-Bedingungen, Loop-Schluss, Kopf-an-Kopf, Barriere | **tragend** (Haupt-Investition) |
| **`protocol`** | Round-trip-Property (`decode(encode(x))==x`) + Golden-Byte-Tests (Wire-Format festnageln) | mittel, billig |
| **`shared`** | nur Sanity (Wertebereiche/Balance gültig) | minimal |
| **`server`** (Workers/DO) | Integration via `@cloudflare/vitest-pool-workers` gegen echtes DO — Raum-Lifecycle, Tick treibt Sim, Input-Validierung, Bot-Injektion, Join/Leave, Reconnect | mittel |
| **`client`** | Rendering (three.js) pragmatisch **ausgenommen**; Prediction/Reconciliation-**Logik** headless getestet (nutzt `sim-core`) | dünn |

Darüber zwei **stack-durchgreichende** Schichten (Kern-Mechanik als Regressions-Wächter, damit Änderungen keine Core-Konzepte zerstören):

- **Szenario-Tests (headless, Arbeitsgaul):** echter Server (Workers-Pool) + **zwei/mehr Sim-Clients über das echte Binärprotokoll**, ohne Browser/Rendering. Deterministisch, schnell, stabil. Trägt die „Core-Konzepte dürfen nicht kaputtgehen"-Garantie (z. B. „A schneidet Trail von B → B stirbt, Gebiet neutral"; „Loop-Schluss → Gebiet erscheint bei allen Clients"; „Totalverlust → Tod").
- **Playwright-E2E (kuratiert obendrauf):** eine Handvoll derselben essentiellen Mechaniken als Akzeptanztest im echten Browser + das, was **nur** der Browser prüft (Input-Devices Maus/Touch/Tastatur, Render-Wiring, Reconnect, zwei reale Clients in einer Arena). Substanziell, aber nicht als breite flaky Suite.

### 2. `sim-core`-Tiefe (Pflicht-Gattungen)

- **Property-based (`fast-check`)** auf Regel-Invarianten: Flächenanteile aller Spieler + neutral = 100 % (nie negativ/> Karte); Fill erzeugt nie Loch/Überlappung; geschlossener Loop vergrössert eigenes Gebiet ≥ eingeschlossene Fläche; Tod ⇒ Gebiet komplett neutral. Automatisches Shrinking auf minimale Gegenbeispiele.
- **Replay-Determinismus als First-Class-Test:** `schritt(zustand, inputs, dt)` rein, fixes `dt`, gesäter RNG, keine Uhr (ADR-0003). Test: gleiche Input-Sequenz + gleicher Seed ⇒ **bit-identischer Zustands-Hash** nach N Ticks. Lebensversicherung gegen Nicht-Determinismus-Lecks (`Date.now`, `Math.random`, Map-Iterationsreihenfolge) — Basis für Prediction/Reconciliation.
- **Golden-Replay-Fixtures:** eingecheckte Input-Logs + erwarteter End-Hash.

### 3. Coverage (CI-Gate, harte Untergrenze)

Pro-Paket-Schwellen statt Pauschalquote, **Branch-Coverage** wo es zählt:

| Paket | Schwelle (Boden) | Anspruch |
|---|---|---|
| `sim-core` | ≥ 95 % Branch | **Vollabdeckung**, wo nicht sinnvoll: `c8 ignore` + Begründung |
| `protocol` | ≥ 90 % | — |
| `shared` | ausgenommen | — |
| `server` | ≥ 75 % Zeilen | **Vollabdeckung**, schwer erreichbare Zweige (Hibernation/Reconnect) begründet ausnehmbar |
| `client`-Logik | ≥ 80 % (Render ausgenommen) | — |
| Szenario/E2E | zählen **nicht** in %; getrackt als Szenario-Checkliste | — |

Regeln: Schwellen sind ein **Boden, der nur steigt** (kein Runterschrauben für grünen Build); Coverage-Ausnahmen nur mit Begründungskommentar.

**Mutation-Testing (Stryker):** **rein, aber gezielt** — nur auf `sim-core`, als separater **nächtlicher/manueller** Job (`pnpm mutation`), **nicht** PR-Pflicht-Check (zu langsam für schnelles Feedback), Ziel-**Mutation-Score ≥ 80 %**. Wächter gegen „hohe Coverage, schwache Assertions".

### 4. Toolchain

- **pnpm-Workspaces** (Monorepo, strikte `node_modules`)
- **Vitest** (v8-Coverage), **`fast-check`**, **`@cloudflare/vitest-pool-workers`** (Server/DO-Tests im echten workerd/Miniflare)
- **ESLint** Flat Config + `typescript-eslint` **strict-type-checked** (typ-bewusst)
- **Prettier** + `eslint-config-prettier` (Format ⟂ Lint)
- **tsconfig** `strict` **plus** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `isolatedModules`
- **Playwright** (E2E)

### 5. CI/CD — GitHub Actions

Pipeline bei **jedem PR** und **Push auf `main`**:

1. `typecheck` (`tsc --noEmit`, alle Pakete)
2. `lint` (ESLint strict-type-checked) + `format:check` (Prettier)
3. **Tests** Unit/Property/Replay (`sim-core`) + Protocol-Round-trip + Server-Integration + headless **Szenario-Tests** (Workers-Pool) **+ Coverage-Gate** (pro-Paket)
4. **Playwright-E2E** (kuratierte Kern-Mechanik, headless) — **Pflicht-Check**
5. `build` (alle Pakete)

**CD-Tor:** Der **Deploy-Job** (Cloudflare Workers/DO + statischer Client) hängt via `needs:` an **allen** vorherigen grünen Jobs → ein roter Push auf `main` rollt **nichts** aus. Mutation-Job läuft separat (nächtlich), nicht blockierend.

### 6. Enforcement („keine Shortcuts" mechanisch)

- **Lint = Fehler**, nicht Warnung (bricht den Build).
- **Escape-Hatches nur mit Begründung:** `no-explicit-any` = error; `@ts-ignore` raus zugunsten `@ts-expect-error` **mit Pflicht-Begründung** (`ban-ts-comment`); `eslint-disable` nur zeilenweise mit Pflicht-Begründung (`eslint-comments/require-description`); kein `.only` (Vitest `forbidOnly` in CI); `.skip` nur mit Kommentar-Verweis auf offenes Ticket.
- **Pre-commit-Hooks** (husky + lint-staged): Format + Lint + Typecheck auf staged Dateien; **commit-msg-Hook** (commitlint) für Conventional Commits.
- **CI ist die Autorität:** Hooks sind lokaler Komfort (`--no-verify`-umgehbar), CI läuft dieselben Gates unumgehbar.

### 7. Konventionen & Definition of Done

- **Branching:** Solo-Projekt → **Direkt-Push auf `main` erlaubt**; Schutz = Gates + CD-Tor (kein fehlerhafter Stand wird ausgerollt). **Upgrade-Pfad** (sobald nicht mehr solo): kurzlebige Feature-Branches + PR auf **geschütztem `main`** (Required Checks), Squash-Merge.
- **Commits:** Conventional Commits (via commitlint).
- **Definition of Done** (Pflicht-Checkliste pro Änderung):
  1. Code **und** Tests zusammen; kritische Pfade abgedeckt, pro-Paket-Coverage erfüllt.
  2. Alle CI-Gates grün (typecheck, lint, format, tests, coverage, E2E, build).
  3. Neue/geänderte Domänenbegriffe → `CONTEXT.md`; architektonische Entscheidungen → ADR.
  4. Keine unbegründeten Escape-Hatches.
  5. Änderung an Kern-Mechanik ⇒ Szenario-/E2E-Abdeckung mitgezogen.
  6. Kein toter Code; öffentliche Modul-APIs knapp dokumentiert.

### 8. Test-Datei-Konventionen

- Colocated `*.test.ts` neben dem Code (Unit/Property/Replay).
- **Szenario-Tests** separat unter `tests/scenario/` (echter Server + Sim-Clients).
- **Playwright** unter `tests/e2e/`.

### 9. Doku-Verortung

- **`spec.md` → Qualitäts-Kapitel** = maßgebliche Fassung (real geschrieben in Ticket 10).
- **`CLAUDE.md`** = operative, agenten-gerichtete Kurzfassung (DoD, „vor Fertig: Gates grün", Conventional Commits, keine unbegründeten Escape-Hatches, Begriffe→CONTEXT, Architektur→ADR) — Pointer, keine Volltext-Dopplung.
- **`CONTEXT.md`** = nur Vokabular. Neu ergänzt: **Sim-Client, Szenario-Test, Replay-Determinismus, Golden-Fixture**.

### Abgrenzung / kein Loch

- **GitHub-Remote + Actions einrichten** = Aufgabe beim **Implementierungs-Start** (nach der Spec), keine Entscheidung dieses Tickets. *(Die Map-Notiz „Kein Git-Repo" ist überholt: das Verzeichnis ist inzwischen ein Git-Repo, aber ohne Remote.)*
- **Accessibility** (Canvas/WebGL — HUD/Menü-Belange) → UI-Spec, nicht Test-Kapitel.
- **Performance-/Last-Budget pro Arena** → [Ticket 14](14-do-cpu-benchmark.md) (DO-CPU-Benchmark, nach der Spec).
- **Balance-Startwerte** → [Ticket 11](11-balance-parameter.md).
