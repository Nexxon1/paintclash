/**
 * Load probe for a DEPLOYED arena (ticket 16). Opens real WebSockets to a
 * running paintclash — local `wrangler dev` or the production Worker — flies
 * headless clients that paint, and reads back what the arena reports about
 * itself (`GET /api/arena-stats`).
 *
 * Why it exists beside `bench/do-cpu` and `bench/fill-budget`, and what a run
 * costs on the Free plan: [`../README.md`](../README.md). What it can and
 * cannot measure: `TickMark` below, and `packages/server/src/tick-cost.ts`.
 */

import type { ArenaStatsPayload } from '@paintclash/server/arena';
import { LIMITS, TICK_DT_MS, type Territory } from '@paintclash/shared';
import { SimClient } from '@paintclash/sim-client';

import { LoopPilot, type Pose } from './pilot.js';

/**
 * The newest server tick a client has seen, stamped with the local wall clock.
 *
 * This is the production stopwatch, and on Cloudflare it is the ONLY one. The
 * arena's own clock is slaved to its timer schedule — it reports a perfect
 * 50.00 ms cadence no matter what a tick really cost (ticket 16/18, see
 * `tick-cost.ts`). Snapshots arriving out here cannot be faked that way: if a
 * tick overruns, the next snapshot is simply late, and the rate drops.
 */
interface TickMark {
  tick: number;
  atMs: number;
}

export interface ProbeOptions {
  /** `http://127.0.0.1:8787` or `https://paintclash.<subdomain>.workers.dev`. */
  baseUrl: string;
  /** Painting clients to hold in the arena. */
  clients: number;
  /** Wall-clock seconds to hold them there. */
  seconds: number;
  /** Seconds between stats samples — the curve, not just the endpoint. */
  sampleEverySeconds?: number;
}

export interface ProbeResult {
  options: ProbeOptions;
  /** Clients that actually spawned; below `clients` means the arena refused some. */
  joined: number;
  /** Loops closed and lives lost, as the clients themselves saw them. */
  fills: number;
  deaths: number;
  /**
   * `/api/arena-stats` at join time and then every `sampleEverySeconds`, each
   * paired with the newest tick a client had seen at that moment (`TickMark`).
   */
  samples: { atSeconds: number; stats: ArenaStatsPayload; mark: TickMark | null }[];
}

/** `http(s)://host` → `ws(s)://host`. */
function socketBase(baseUrl: string): string {
  return baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '');
}

export async function fetchStats(baseUrl: string): Promise<ArenaStatsPayload> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/arena-stats`);
  if (!response.ok) throw new Error(`arena-stats answered ${String(response.status)}`);
  return (await response.json()) as ArenaStatsPayload;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One painting client on the wire, with the counters its run is judged by. */
interface Painter {
  socket: WebSocket;
  client: SimClient;
  fills: number;
  deaths: number;
  /** Newest snapshot seen and when — the client-side view of the tick rate. */
  mark: TickMark | null;
}

/** Server ticks per real second between two marks; `null` if there is no span. */
function rateBetween(from: TickMark | null, to: TickMark | null): number | null {
  if (!from || !to) return null;
  const seconds = (to.atMs - from.atMs) / 1000;
  if (seconds <= 0 || to.tick <= from.tick) return null;
  return (to.tick - from.tick) / seconds;
}

/**
 * Connect one client and put it to work. The autopilot runs off `onSnapshot`,
 * i.e. on the server's own cadence rather than on a local timer — which is the
 * point: a probe that steered on its own clock would drift against an arena
 * whose real cadence is its own business (ticket 18) and slowly stop painting.
 */
async function connect(baseUrl: string, name: string): Promise<Painter> {
  const socket = new WebSocket(`${socketBase(baseUrl)}/ws`);
  socket.binaryType = 'arraybuffer';
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(new Error(`${name} could not open a socket to ${baseUrl}`));
    });
  });
  const client = new SimClient((frame) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(frame);
  }, name);
  const painter: Painter = { socket, client, fills: 0, deaths: 0, mark: null };
  socket.addEventListener('message', (event: MessageEvent) => {
    if (event.data instanceof ArrayBuffer) client.receive(event.data);
  });
  client.onTerritory = (update) => {
    if (update.playerId === client.playerId && update.reason === 'fill') painter.fills += 1;
  };
  client.onDeath = (death) => {
    if (death.victimId === client.playerId) painter.deaths += 1;
  };

  let pilot: LoopPilot | null = null;
  let sinceFlush = 0;
  client.onSnapshot = (snapshot) => {
    // Stamped for EVERY snapshot, before anything can bail out: this pair is
    // the only honest stopwatch a deployed arena has (see `TickMark`).
    painter.mark = { tick: snapshot.tick, atMs: Date.now() };
    const id = client.playerId;
    const size = client.arenaSizeWU;
    if (id === null || size === null) return;
    pilot ??= new LoopPilot(size);
    const self: Pose | undefined = snapshot.players.find((player) => player.id === id);
    if (!self) return;
    const territory: Territory = client.territories.get(id) ?? [];
    client.queueTurn(pilot.steer(self, territory));
    sinceFlush += 1;
    // The same batching the browser client does (spec §6.3): incoming messages
    // bill 20:1 on Free, so a probe that flushed every tick would cost three
    // times what playing costs and measure traffic no player produces.
    if (sinceFlush >= LIMITS.inputFlushTicks) {
      sinceFlush = 0;
      client.flush();
    }
  };
  client.join();
  return painter;
}

/**
 * Hold `clients` painters in the deployed arena for `seconds`, sampling its
 * self-report as they go.
 *
 * The joins are staggered. Sixteen sockets opened in the same instant from one
 * address is exactly the shape the join-rate budget exists to slow down (spec
 * §8.3 point 3) — and a real arena fills up over seconds, not in one frame.
 */
export async function runLoad(options: ProbeOptions): Promise<ProbeResult> {
  const { baseUrl, clients, seconds } = options;
  const sampleEverySeconds = options.sampleEverySeconds ?? 30;
  const painters: Painter[] = [];
  const samples: ProbeResult['samples'] = [];
  try {
    for (let i = 0; i < clients; i++) {
      painters.push(await connect(baseUrl, `probe-${String(i + 1).padStart(2, '0')}`));
      await sleep(150);
    }
    // Everyone spawned before the clock starts: a sample taken while the arena
    // is still filling up would average an empty arena into the result.
    const spawnDeadline = Date.now() + 20_000;
    while (Date.now() < spawnDeadline && painters.some((p) => p.client.self() === null)) {
      await sleep(100);
    }
    const joined = painters.filter((p) => p.client.self() !== null).length;

    // The newest tick any client has seen. Newest rather than a single fixed
    // client, so a painter that dies, reconnects or simply stalls cannot make
    // the arena look slow — the fastest observer is the least wrong one.
    const newestMark = (): TickMark | null =>
      painters.reduce<TickMark | null>(
        (best, painter) =>
          painter.mark && (!best || painter.mark.tick > best.tick) ? painter.mark : best,
        null,
      );

    const started = Date.now();
    samples.push({ atSeconds: 0, stats: await fetchStats(baseUrl), mark: newestMark() });
    for (;;) {
      const elapsed = (Date.now() - started) / 1000;
      if (elapsed >= seconds) break;
      await sleep(Math.min(sampleEverySeconds, seconds - elapsed) * 1000);
      samples.push({
        atSeconds: Math.round((Date.now() - started) / 1000),
        stats: await fetchStats(baseUrl),
        mark: newestMark(),
      });
    }
    return {
      options,
      joined,
      fills: painters.reduce((sum, p) => sum + p.fills, 0),
      deaths: painters.reduce((sum, p) => sum + p.deaths, 0),
      samples,
    };
  } finally {
    // Read the stats BEFORE this runs, always: an arena that empties drops its
    // world and its tick histogram with it (ADR-0004).
    for (const painter of painters) painter.socket.close();
  }
}

/** Difference between two samples — what the arena did in that window alone. */
function windowOf(
  previous: ArenaStatsPayload['tickCost'],
  current: ArenaStatsPayload['tickCost'],
): { ticks: number; overBudget: number } | null {
  if (!previous || !current) return null;
  return {
    ticks: current.ticks - previous.ticks,
    overBudget: current.overBudgetTicks - previous.overBudgetTicks,
  };
}

export function report(result: ProbeResult): string {
  const { baseUrl, clients, seconds } = result.options;
  const samples = result.samples;
  const last = samples[samples.length - 1]?.stats;
  const trusted = last?.tickCost?.clockAdvances ?? false;
  const lines = [
    `${baseUrl} · ${String(clients)} clients (${String(result.joined)} spawned) · ` +
      `${String(seconds)} s`,
    `  ${String(result.fills)} fills · ${String(result.deaths)} deaths`,
    trusted
      ? '  in-DO clock advances during work — the cost columns mean something here'
      : '  in-DO clock is SLAVED TO THE SCHEDULE — the cost columns are structurally ' +
        'zero;\n  read "seen Hz" (client side), which the arena cannot fake',
    '',
    '  t(s)  entities  vertices   ticks  DO Hz  seen Hz     mean     p95     max   over',
  ];
  let previousTick: ArenaStatsPayload['tickCost'] = null;
  let previousMark: TickMark | null = null;
  for (const { atSeconds, stats, mark } of samples) {
    const load = stats.load;
    const tick = stats.tickCost;
    if (!load || !tick) {
      lines.push(`  ${String(atSeconds).padStart(4)}  (no arena running)`);
      continue;
    }
    // Per-window rather than since-start: the fill cost grows with the
    // territories, so an average over the whole run would bury the trend that
    // is the entire question.
    const seenHz = rateBetween(previousMark, mark);
    const window = windowOf(previousTick, tick);
    previousTick = tick;
    previousMark = mark;
    lines.push(
      `  ${String(atSeconds).padStart(4)}  ` +
        `${String(load.humans + load.bots).padStart(8)}  ` +
        `${String(load.vertices).padStart(8)}  ` +
        `${String(tick.ticks).padStart(6)}  ` +
        `${tick.observedHz.toFixed(1).padStart(5)}  ` +
        `${(seenHz === null ? '-' : seenHz.toFixed(2)).padStart(7)}  ` +
        `${tick.meanMs.toFixed(2).padStart(7)}  ` +
        `${tick.p95Ms.toFixed(1).padStart(6)}  ` +
        `${tick.maxMs.toFixed(1).padStart(6)}  ` +
        String(window ? window.overBudget : tick.overBudgetTicks).padStart(5),
    );
  }
  const first = samples[0]?.mark ?? null;
  const final = samples[samples.length - 1]?.mark ?? null;
  const overall = rateBetween(first, final);
  if (last?.tickCost) {
    lines.push(
      '',
      `  buckets (ms, upper bound): ${last.tickCost.buckets.join(' / ')}`,
      `  in-DO lateness: ${String(last.tickCost.overBudgetTicks)} of ` +
        `${String(last.tickCost.ticks)} ticks reached ${String(TICK_DT_MS)} ms` +
        (last.tickCost.clockAdvances ? '' : ' (blind — see above)'),
      `  client-observed tick rate over the whole run: ` +
        (overall === null ? 'unknown' : `${overall.toFixed(2)} Hz`),
    );
    // The number the whole probe exists for. A tick that overruns delays the
    // next one by exactly its overrun (the ticker computes its sleep on a clock
    // that did not move, so it always oversleeps the full remainder). Ticks the
    // arena FAILED to deliver against the nominal grid are therefore the
    // accumulated overrun, in ms — the one quantity that survives both the
    // frozen in-DO clock and network jitter, because it is measured over
    // minutes at the far end of the wire.
    if (first && final && final.atMs > first.atMs) {
      const elapsedMs = final.atMs - first.atMs;
      const nominal = elapsedMs / TICK_DT_MS;
      const delivered = final.tick - first.tick;
      const deficit = nominal - delivered;
      lines.push(
        `  delivered ${String(delivered)} of ${nominal.toFixed(0)} nominal ticks in ` +
          `${(elapsedMs / 1000).toFixed(1)} s → accumulated overrun ` +
          `${(deficit * TICK_DT_MS).toFixed(0)} ms ` +
          `(${((deficit / nominal) * 100).toFixed(2)} % of the run)`,
      );
    }
  }
  return lines.join('\n');
}
