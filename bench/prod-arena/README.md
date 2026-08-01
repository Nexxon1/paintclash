# bench/prod-arena — Tick-Budget einer **deployten** Arena (Bau-Ticket 16)

Öffnet echte WebSockets gegen ein laufendes paintclash — lokal `wrangler dev` oder den
Produktions-Worker — fliegt malende Headless-Clients hinein und liest zurück, was diese
Arena über die Kosten ihrer eigenen Ticks sagt (`GET /api/arena-stats`, siehe
[`packages/server/src/tick-cost.ts`](../../packages/server/src/tick-cost.ts)).

```sh
pnpm --filter @paintclash/bench-prod-arena test    # Prämisse: malt der Autopilot? (~1 s, ohne Netz)
pnpm --filter @paintclash/bench-prod-arena bench   # die Messung (Default: 16 Clients, 300 s)

# gegen Produktion statt gegen wrangler dev:
PAINTCLASH_BASE_URL=https://paintclash.secure-data.workers.dev \
  pnpm --filter @paintclash/bench-prod-arena bench
```

`PAINTCLASH_CLIENTS` (Default `LIMITS.maxPlayers` = die Populationsgrenze selbst) und
`PAINTCLASH_SECONDS` (Default 300) stellen den Lauf ein.

## Warum es diesen Bench neben den anderen zwei gibt

| Bench                                  | misst                                          | Lücke                      |
| -------------------------------------- | ---------------------------------------------- | -------------------------- |
| [`do-cpu`](../do-cpu/) (T02)           | **synthetische** Last in einem echten DO       | nicht der echte Sim        |
| [`fill-budget`](../fill-budget/) (T22) | den **echten** Sim, ohne DO und ohne Leitung   | nicht Cloudflares Hardware |
| **`prod-arena`** (T16)                 | die **deployte** Arena, über die echte Leitung | —                          |

Beide älteren Benches nennen dieselbe offene Stelle in ihren eigenen Findings: die Zahlen
stammen von einer Entwicklermaschine, und der **4×-Faktor**, der für Cloudflares
Multi-Tenant-Hardware einsteht, ist eine Annahme, die niemand nachgeprüft hat. Dieser Bench
prüft sie nach — anders geht es nicht, denn an eine Produktions-DO lässt sich keine
Stoppuhr hängen: workerd friert `Date.now()` während synchroner Arbeit ein. Die Arena
meldet ihre Kosten darum über die **Verspätung** ihrer Ticks, und dieser Bench erzeugt die
Last, über die zu berichten sich lohnt.

## Kosten eines Laufs (Free-Plan, spec §7.2)

`clients` Sockets, jeder sendet alle `inputFlushTicks` Ticks **einen** gebatchten
Input-Frame. Eingehende WS-Nachrichten zählen 20:1, ein 5-Minuten-Lauf mit 16 Clients sind
also ~32 000 Frames ≈ **1 600 abgerechnete Requests** von 100 000/Tag — plus ein DO, das
diese fünf Minuten eine Arena hält (~38 GB-s von ~13 000/Tag). Ausgehende Snapshots sind
frei. Ein kleiner Bissen, aber kein Nullbissen: darum manuell, nie CI.

## Die Prämisse hat ihren eigenen Test

`pilot.test.ts` fliegt denselben Autopiloten ohne Netz gegen einen lokalen `sim-core` und
verlangt Fills. Ohne diesen Wächter würde ein kaputter Autopilot sechzehn Köpfe im Kreis
fahren lassen, eine Arena messen, in der nie etwas gefüllt wird, und ein bequemes
Tick-Budget aus dem falschen Grund melden — exakt der Fehlmodus, den die synthetische Last
aus Ticket 02 schon einmal hatte.

## Was dieser Bench über sich selbst gelernt hat

Die erste Fassung las die **Verspätung** der Ticks aus dem DO und hielt sie für die
CPU-Zeit des vorherigen Ticks. Auf Cloudflare ist sie identisch null: die Isolate-Uhr ist
an den Timer-Fahrplan gekoppelt und liefert am Tick-Anfang genau den Slot zurück, auf den
gezielt wurde. Darum trägt jeder Report ein **`clockAdvances`** — und darum ist die Spalte,
auf die es ankommt, **`seen Hz`**: gelieferte Snapshot-Ticks gegen die Wanduhr, gemessen am
fernen Ende der Leitung. Die Schlusszeile rechnet daraus das **Tick-Defizit** gegen das
nominelle 20-Hz-Raster aus — den aufsummierten Überhang in ms, die eine Zahl, die weder die
eingefrorene Uhr noch Paket-Jitter verfälschen kann.

**Ergebnisse:** [`docs/benchmarks/do-cpu-benchmark.md`](../../docs/benchmarks/do-cpu-benchmark.md)
(Nachtrag Ticket 16) — Populationsgrenze 16 und Bot-Ziel 8 auf echter Hardware bestätigt,
der 4×-Sicherheitsfaktor als Worst Case widerlegt.
