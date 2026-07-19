# 01 — Monorepo-Gerüst, Tooling & CI/CD-Skelett (+ GitHub-Remote)

**What to build:** Ein lauffähiges Monorepo-Fundament, auf dem alle weiteren Tickets grün landen können. Nach diesem Ticket kann man das Repo klonen, `pnpm install`, alle Pakete bauen und testen; ein Push auf `main` durchläuft die vollständige CI-Pipeline, und das CD-Tor deployt einen Platzhalter-Worker nach Cloudflare — aber nur, wenn alle Gates grün sind. Kein Spiel-Verhalten, sondern das Gerüst, das „keine Shortcuts" ab jetzt mechanisch erzwingt.

**Blocked by:** None — can start immediately.

**Status:** done — offene Account-Verdrahtung (GitHub-Remote + Cloudflare-Secrets), s. Comments

- [x] pnpm-Workspace mit sechs Paket-Stubs — `sim-core`, `protocol`, `shared`, `server`, `client`, `sim-client` — jeweils build-bar, mit Trivial-Export + Trivial-Test (ADR-0002).
- [x] tsconfig `strict` **plus** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `isolatedModules` (§9.4).
- [x] ESLint Flat Config + `typescript-eslint` strict-type-checked, Prettier + `eslint-config-prettier`; Lint = **Fehler**. `no-explicit-any`=error, `ban-ts-comment` (Pflicht-Begründung), `eslint-comments/require-description`, `forbidOnly` in CI (§9.6).
- [x] Vitest (v8-Coverage) eingerichtet; Coverage-Gate-Mechanik **pro Paket** vorhanden (Schwellen §9.3, auf den Stubs erfüllt — 100 %).
- [x] husky + lint-staged (Format/Lint/Typecheck auf staged Dateien) + commit-msg-Hook (commitlint, Conventional Commits).
- [~] GitHub-Remote eingerichtet (Repo hat aktuell **keins**, §11) + Actions-Pipeline: typecheck → lint + format:check → tests + Coverage-Gate → build, plus Playwright-E2E-Job-Skelett (Pflicht-Check). — **Pipeline-Datei fertig** (`.github/workflows/ci.yml`); **Remote fehlt** (kein `gh`/Auth in dieser Umgebung → User-Schritt).
- [~] CD-Tor: Deploy-Job hängt via `needs:` an **allen** grünen Jobs; deployt einen Platzhalter-Worker (Workers + Static Assets) nach Cloudflare; ein roter `main`-Push rollt **nichts** aus (§9.5). — **Gate-Logik + wrangler-Config fertig & dry-run-validiert**; **Deploy nicht mit echtem CF-Account verdrahtet** (Secrets → User-Schritt).
- [x] Läuft auf Cloudflare **Free-Plan, keine Kreditkarte hinterlegt** (Abbuchungssicherheit, ADR-0001 / §7.3). — `wrangler.jsonc` nutzt nur Free-sichere Features (Static Assets + observability, keine bezahlten Bindings).

_Referenz: spec §5.1, §9.3–9.6, §11; ADR-0001, ADR-0002._

## Comments

**2026-07-19 — Umsetzung (`/implement`), Commit `2cc316d`.**

Lokal alles grün und verifiziert: `typecheck`, `lint`, `format:check`, `test:coverage`
(6 Dateien / 12 Tests / **100 %**, Per-Paket-Gates greifen), `build`, `test:e2e` (Skelett).
Git-Hooks live geprüft: commitlint weist Nicht-Conventional-Messages ab; pre-commit
(lint-staged) läuft. `wrangler deploy --dry-run` bündelt den Platzhalter-Worker und meldet
das `env.ASSETS`-Binding korrekt.

**Zwei Checklisten-Punkte sind bewusst offen — sie brauchen deine Accounts, nicht Code:**

1. **GitHub-Remote** — diese Umgebung hat kein `gh`-CLI und keine Auth. Anlegen z. B.:
   `gh repo create paintclash --private --source=. --remote=origin --push`
   (oder Remote manuell hinzufügen und pushen). Erst danach läuft die CI-Pipeline überhaupt,
   und der E2E-Job kann als **Required Check** (Branch-Protection) gesetzt werden.
2. **Cloudflare-Deploy** — Repo-Secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
   setzen (Free-Plan, **keine Kreditkarte** hinterlegen). Dann deployt der `deploy`-Job den
   Platzhalter-Worker beim nächsten grünen `main`-Push.

Danach ist Ticket 01 vollständig; nächste Frontier: **02** (DO-CPU-Benchmark) und **03**
(Walking Skeleton).
