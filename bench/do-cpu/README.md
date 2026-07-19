# bench/do-cpu — DO-CPU-Benchmark (Bau-Ticket 02)

Misst, wie viele Entities eine single-threaded Arena-DO beim 20-Hz-Tick trägt.
Synthetische Last (Bewegung, Trails, Trail-Kollision naive/grid, Fill polygon/raster)
läuft in einem **echten Durable Object** (`BenchArena`) via `@cloudflare/vitest-pool-workers`.

**Ergebnisse & Interpretation:** [`docs/benchmarks/do-cpu-benchmark.md`](../../docs/benchmarks/do-cpu-benchmark.md)

```sh
pnpm --filter @paintclash/bench-do-cpu test    # Unit- & DO-Smoke-Tests (schnell)
pnpm --filter @paintclash/bench-do-cpu bench   # kompletter Sweep (~3 min, druckt Tabellen)
pnpm --filter @paintclash/bench-do-cpu dev     # wrangler dev: POST /setup, GET /run?ticks=N, /run-paced?ticks=N
```

Spike-Paket: läuft bewusst **nicht** im Root-Test/Coverage-Gate (spec §9.3). T16
wiederholt die Messung gegen den echten Build auf echter Cloudflare-Infrastruktur.
