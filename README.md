# paintclash

Browser-Multiplayer-Flächenfärbe-Spiel (Trail-/Territory-Genre, splix.io /
Paper.io 2 verwandt) als kostenlos gehostete Grundversion.

> **Status:** Bauphase — der Kern-Loop ist spielbar: server-autoritative
> Bewegung, Trail → Loop → Fill, Tod, Gebiet stehlen/Totalverlust (Tickets
> 01–06). Aktueller Stand: [`Bau-Tickets`](.scratch/paintclash/issues/).

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

## Lokal starten

Voraussetzungen: Node ≥ 20 und pnpm (`corepack enable` aktiviert das in
`package.json` gepinnte pnpm).

```bash
pnpm install
pnpm run e2e:server        # baut den Client und startet wrangler dev auf Port 8787
```

Dann <http://localhost:8787> im Browser öffnen — Name eingeben, losfahren
(A/D bzw. Pfeiltasten). Für Mehrspieler-Tests einfach mehrere Tabs öffnen;
alle landen in derselben lokalen Arena.

Varianten:

```bash
pnpm run dev:small         # dasselbe mit 50×50-WU-Mini-Arena (schnellere Duelle)
pnpm run soak              # headless Soak-Client gegen einen laufenden Server
```

Hinweis WSL2: `wrangler dev` kann dort stallen. Fallback ist die deployte
Referenzumgebung (<https://paintclash.secure-data.workers.dev>, Deploy via
`pnpm run deploy` in `packages/server`) — sie ist ohnehin die Referenz für
Netcode-Tests, weil sie echte Latenz und die reale DO-Tickrate zeigt.

## Entwicklung

```bash
pnpm typecheck             # tsc --noEmit, alle Pakete
pnpm lint                  # ESLint strict-type-checked (Lint = Fehler)
pnpm format:check          # Prettier
pnpm test:coverage         # Vitest + Coverage-Gates pro Paket
pnpm test:scenario         # Szenario-Tests (echtes DO in workerd + Sim-Clients)
pnpm build                 # Build, alle Pakete
pnpm test:e2e              # Playwright (baut Client + startet Server selbst)
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
