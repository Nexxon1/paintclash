# paintclash

Browser-Multiplayer-Flächenfärbe-Spiel (Trail-/Territory-Genre, splix.io /
Paper.io 2 verwandt) als kostenlos gehostete Grundversion.

> **Status:** Bauphase, Ticket 01 — Monorepo-Gerüst & CI/CD. Noch kein
> Spiel-Verhalten; dieses Ticket stellt das Fundament, das „keine Shortcuts" ab
> jetzt mechanisch erzwingt.

## Struktur

Ein pnpm-Monorepo mit geteiltem, deterministischem Sim-Core (ADR-0002):

| Paket                 | Inhalt                                                                      |
| --------------------- | --------------------------------------------------------------------------- |
| `packages/sim-core`   | Reine, deterministische Spiel-Logik (kein Netz, kein Rendering, keine Uhr). |
| `packages/protocol`   | Binär-Wire-Format (encode/decode) + Nachrichtentypen.                       |
| `packages/shared`     | Balance-Parameter + gemeinsame Konstanten/Typen (inkl. Tickrate).           |
| `packages/server`     | Cloudflare Workers/DO-Schale; fährt `sim-core` autoritativ.                 |
| `packages/client`     | Browser: three.js-Rendering, Input, Prediction, HUD, Sound.                 |
| `packages/sim-client` | Headless Test-Client (fährt `sim-core`, spricht das echte Protokoll).       |

## Entwicklung

```bash
corepack enable            # aktiviert das in package.json gepinnte pnpm
pnpm install
pnpm typecheck             # tsc --noEmit, alle Pakete
pnpm lint                  # ESLint strict-type-checked (Lint = Fehler)
pnpm format:check          # Prettier
pnpm test:coverage         # Vitest + Coverage-Gates pro Paket
pnpm build                 # tsc-Build, alle Pakete
pnpm test:e2e              # Playwright (Skelett)
```

## Referenzen

- **Spec:** [`.scratch/draw-race/spec.md`](.scratch/draw-race/spec.md) (gelockt)
- **Bau-Tickets:** [`.scratch/paintclash/issues/`](.scratch/paintclash/issues/)
- **Domänen-Vokabular:** [`CONTEXT.md`](CONTEXT.md) · **ADRs:** [`docs/adr/`](docs/adr/)

## Deployment

CI/CD läuft über GitHub Actions (`.github/workflows/ci.yml`): `typecheck → lint +
format:check → tests + coverage → build → e2e`, und ein CD-Tor deployt einen
Platzhalter-Worker nach Cloudflare — nur wenn alle Gates grün sind und auf `main`
gepusht wird. Läuft auf dem **Cloudflare Free-Plan ohne hinterlegte Kreditkarte**
(Abbuchungssicherheit, ADR-0001 / spec §7.3).

Benötigte GitHub-Secrets für den Deploy-Job: `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`.
