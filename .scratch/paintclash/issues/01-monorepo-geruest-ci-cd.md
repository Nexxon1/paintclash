# 01 — Monorepo-Gerüst, Tooling & CI/CD-Skelett (+ GitHub-Remote)

**What to build:** Ein lauffähiges Monorepo-Fundament, auf dem alle weiteren Tickets grün landen können. Nach diesem Ticket kann man das Repo klonen, `pnpm install`, alle Pakete bauen und testen; ein Push auf `main` durchläuft die vollständige CI-Pipeline, und das CD-Tor deployt einen Platzhalter-Worker nach Cloudflare — aber nur, wenn alle Gates grün sind. Kein Spiel-Verhalten, sondern das Gerüst, das „keine Shortcuts" ab jetzt mechanisch erzwingt.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] pnpm-Workspace mit sechs Paket-Stubs — `sim-core`, `protocol`, `shared`, `server`, `client`, `sim-client` — jeweils build-bar, mit Trivial-Export + Trivial-Test (ADR-0002).
- [ ] tsconfig `strict` **plus** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `isolatedModules` (§9.4).
- [ ] ESLint Flat Config + `typescript-eslint` strict-type-checked, Prettier + `eslint-config-prettier`; Lint = **Fehler**. `no-explicit-any`=error, `ban-ts-comment` (Pflicht-Begründung), `eslint-comments/require-description`, `forbidOnly` in CI (§9.6).
- [ ] Vitest (v8-Coverage) eingerichtet; Coverage-Gate-Mechanik **pro Paket** vorhanden (Schwellen §9.3, auf den Stubs erfüllt).
- [ ] husky + lint-staged (Format/Lint/Typecheck auf staged Dateien) + commit-msg-Hook (commitlint, Conventional Commits).
- [ ] GitHub-Remote eingerichtet (Repo hat aktuell **keins**, §11) + Actions-Pipeline: typecheck → lint + format:check → tests + Coverage-Gate → build, plus Playwright-E2E-Job-Skelett (Pflicht-Check).
- [ ] CD-Tor: Deploy-Job hängt via `needs:` an **allen** grünen Jobs; deployt einen Platzhalter-Worker (Workers + Static Assets) nach Cloudflare; ein roter `main`-Push rollt **nichts** aus (§9.5).
- [ ] Läuft auf Cloudflare **Free-Plan, keine Kreditkarte hinterlegt** (Abbuchungssicherheit, ADR-0001 / §7.3).

_Referenz: spec §5.1, §9.3–9.6, §11; ADR-0001, ADR-0002._
