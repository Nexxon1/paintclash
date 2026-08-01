# Betrieb — was läuft wo, und was zugesagt ist

Ergebnis-Dokument zu **Bau-Ticket 16**. Verbindlich für das, was der Betrieb dieser
Grundversion **verspricht** (spec §7, §8.5) und wie man ihm beim Laufen zusieht.

## Die Zusage: best effort, und das ist kein Kleingedrucktes

**Verfügbarkeit ist ausdrücklich „best effort" — es gibt keine Uptime-Garantie.**
Das ist keine Absicherung, sondern die direkte Folge einer bewussten Entscheidung: der
harte Free-Tages-Stopp **ist** die Abbuchungssicherheit (spec §7.3, ADR-0001), und wer
einen harten Stopp will, bekommt Ausfälle statt Rechnungen. Der Worst Case eines
erfolgreichen DoS ist deshalb: **die Arena parkt bis zum Tages-Reset.** Kein
Kostenrisiko, keine Rechnung, kein Anruf.

Konkret bestätigt für diese Installation:

- **Cloudflare Free-Plan, keine Kreditkarte hinterlegt.** Ohne hinterlegte Karte ist eine
  Belastung strukturell unmöglich; Limit-Überschreitung endet in einem Fehler, nicht in
  einer Rechnung.
- **Kein Upgrade „aus Versehen".** Workers Paid ($5/Mt.) hat **keinen** harten Spend-Cap —
  Overage wird abgebucht, Budget-Alerts sind rein informativ (spec §7.3). Ein Upgrade ist
  darum immer eine bewusste Kosten-Entscheidung, nie eine Reaktion auf einen roten Tag.
- **Nur Free-sichere Bindings.** `wrangler.jsonc` nutzt Static Assets, SQLite-backed
  Durable Objects und Observability — nichts, was eine Karte verlangt.

## Was läuft

Ein Worker, zwei Durable-Object-Klassen, ein Bündel statischer Dateien:

| Teil | Wo | Adresse |
| --- | --- | --- |
| Router + statischer Client | Worker `paintclash` + Workers Static Assets (`packages/client/dist`) | die Deploy-URL |
| Öffentliche Arena | `ArenaDO`, **eine** feste Adresse (`idFromName('public')`, ADR-0004) | intern |
| Privater Raum | `ArenaDO`, eine pro Raum-Code (`idFromName(code)`, Ticket 14) | intern |
| Per-IP-Budgets | `RoomGateDO`, ein Objekt (`idFromName('rooms')`, Ticket 15) | intern |

**Platzierung:** jeder Stub wird mit `locationHint: 'weur'` gezogen (spec §7.1,
`ARENA_LOCATION_HINT` in `router.ts`). Der Hint wirkt **nur bei der Erstellung** — ein
Objekt, das es schon gibt, bleibt, wo es entstanden ist. Für neu entstehende Räume gilt er
ab sofort; die öffentliche Arena und das Gate wandern erst, wenn sie je zerstört und neu
angelegt werden.

**„Always-on" heißt feste Adresse, nicht Dauerlast.** Die öffentliche Arena ist immer
unter derselben Adresse erreichbar und wacht beim ersten Join auf; **getickt wird nur,
solange Sockets offen sind** (spec §7.2: „nur ticken, wenn ein Spiel mit Spielern läuft").
Das ist kein Sparmodus, sondern Arithmetik: ein durchgehend aktives DO kostet ~10 800 GB-s
am Tag von ~13 000 verfügbaren — eine leer tickende Arena würde also 85 % des Tagesbudgets
für niemanden verbrauchen und die echten Spieler am Abend aussperren.

## Deployen

Der reguläre Weg ist das **CD-Tor** in `.github/workflows/ci.yml`: ein Push auf `main`
durchläuft `typecheck → lint + format:check → tests + Coverage → build → e2e`, und erst
wenn **alle** grün sind, deployt der `deploy`-Job (`needs:` auf allen). Danach prüft der
Job über `/api/health`, dass die Deploy-URL wirklich **diesen** Commit ausliefert — ein
Rollout, der „erfolgreich" meldet, aber eine alte Version bedient, ist sonst genau der
Fehler, den ein grünes Tor verstecken würde.

Benötigte GitHub-Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
Optionale Repo-Variable: `DEPLOY_URL` (Default ist die Referenz-URL unten).

Von Hand — für einen Spike oder wenn CI nicht der Weg ist:

```sh
pnpm build                                  # baut u. a. packages/client/dist
pnpm --filter @paintclash/server run deploy # stempelt den Git-SHA in COMMIT_SHA
```

## Zusehen

Zwei Endpunkte, beide öffentlich und beide ohne jede Spielerinformation:

```sh
curl -s https://paintclash.secure-data.workers.dev/api/health      # lebt es, und mit welchem Commit?
curl -s https://paintclash.secure-data.workers.dev/api/arena-stats # was kostet der Tick gerade?
```

`/api/arena-stats` ist die einzige Möglichkeit, dem **deployten** Tick beim Rechnen
zuzusehen: workerd friert `Date.now()` während synchroner Arbeit ein, eine Stoppuhr um
`arena.tick()` läse in Produktion immer null. Die Arena meldet ihre Kosten darum über die
**Verspätung** ihrer Ticks — auf Cloudflare ist die Verspätung eines Ticks exakt die
CPU-Zeit des vorherigen. Die Herleitung steht in
[`packages/server/src/tick-cost.ts`](../packages/server/src/tick-cost.ts).

So liest man die Antwort:

- `arena.humans` / `arena.bots` / `arena.vertices` — die Last. Ohne die Vertex-Zahl sagt
  eine Tick-Zeit wenig: mit ihr skaliert der Fill (Tickets 22/23).
- `tick.p95Ms` — die Größe, in der das Kriterium formuliert ist (**p95 ≤ 25 ms**,
  `docs/benchmarks/do-cpu-benchmark.md`).
- `tick.overBudgetTicks` — Ticks, die die vollen 50 ms erreicht haben. Jeder davon ist ein
  kurzer Stillstand für **alle** in der Arena; `0` ist der Normalzustand.
- `tick.observedHz` — die Kadenz nach der Uhr des DO. In Produktion liegt sie bei ~22 Hz
  statt 20, weil die Isolate-Uhr ~10 % neben der Realzeit läuft (Ticket 18, offen). Ein
  Wert **darunter** ist das Warnsignal: dann bremst die Tick-Arbeit den Takt.
- Das Fenster ist das Leben **einer** Arena. Läuft sie leer, verwirft sie ihre Welt
  (ADR-0004) und die Statistik startet mit der nächsten neu.

Dazu die Worker-Logs (`observability` ist in `wrangler.jsonc` an):
`pnpm --filter @paintclash/server exec wrangler tail`.

Eine Messung unter kontrollierter Last fährt
[`bench/prod-arena`](../bench/prod-arena/) — echte Sockets, malende Headless-Clients,
danach ein Blick auf `/api/arena-stats`.

## Wenn es klemmt

| Symptom | Erste Frage | Wo nachsehen |
| --- | --- | --- |
| Alles hakt für alle gleichzeitig | `overBudgetTicks` > 0? `vertices` hoch? | Fill-Kosten — Ticket 23; Notbremse ist die Populationsgrenze in `LIMITS.maxPlayers` |
| „Arena voll" bei wenigen Spielern | Hängen tote Sockets? | `arena.connections` vs. `arena.humans` |
| `429` beim Beitreten | Teilen sich viele Spieler eine Adresse? | Per-IP-Budgets, spec §8.3 Punkt 3 — bewusst CGNAT-tolerant |
| Nichts antwortet mehr | Ist das Tagesbudget aufgebraucht? | Cloudflare-Dashboard — **das ist der gewollte harte Stopp, kein Bug** |

## Referenzen

- Spec §7 (Hosting & Betrieb), §8.5 (Betriebshaltung), §9.5 (CI/CD)
- [ADR-0001](adr/0001-runtime-und-hosting-cloudflare-workers-durable-objects.md) ·
  [ADR-0004](adr/0004-arena-prozess-und-persistenzmodell.md)
- [DO-CPU-Benchmark](benchmarks/do-cpu-benchmark.md) — die Zahlen hinter der
  Populationsgrenze
