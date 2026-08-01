/**
 * Load probe for a DEPLOYED arena (ticket 16). Opens real WebSockets to a
 * running paintclash — local `wrangler dev` or the production Worker — flies
 * headless clients that paint, and reads back what the arena says its own ticks
 * cost (`GET /api/arena-stats`, see `packages/server/src/tick-cost.ts`).
 *
 * ## Why this exists next to the other two benches
 *
 * `bench/do-cpu` (ticket 02) measures a SYNTHETIC load in a real Durable
 * Object; `bench/fill-budget` (ticket 22) measures the REAL sim with no DO and
 * no wire. Both leave the same gap, and both say so in their own findings: the
 * numbers come off a dev machine, and the 4× factor standing in for
 * Cloudflare's multi-tenant hardware is an assumption nobody has checked.
 *
 * This one closes that gap the only way it can be closed — by measuring the
 * deployed thing. There is no stopwatch to attach: production freezes
 * `Date.now()` during synchronous work, so the arena reports its own cost
 * through the lateness of its ticks, and this probe is what produces the load
 * worth reporting on.
 *
 * ## What it costs to run
 *
 * Against the Free plan (spec §7.2): `clients` sockets, each sending one
 * batched input frame every `inputFlushTicks` ticks. Incoming WS messages bill
 * 20:1, so a 5-minute run with 16 clients is ~32 000 frames ≈ 1 600 billed
 * requests of the 100 000/day — plus one DO holding one arena for those five
 * minutes. Outgoing snapshots are free. It is a small bite, but it is not zero,
 * and that is why this is a manual `pnpm bench` and never CI.
 */

import { LIMITS, TICK_DT_MS, type Territory } from '@paintclash/shared';
import { SimClient } from '@paintclash/sim-client';

import { LoopPilot, type Pose } from './pilot.js';

/** The shape `GET /api/arena-stats` answers with (`arena-do.ts`). */
export interface ArenaStats {
  live: boolean;
  arena: {
    tick: number;
    sizeWU: number;
    connections: number;
    humans: number;
    bots: number;
    vertices: number;
  } | null;
  tick: {
    ticks: number;
    windowMs: number;
    meanMs: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
    overBudgetTicks: number;
    observedHz: number;
    buckets: number[];
  } | null;
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
  /** `/api/arena-stats` at join time and then every `sampleEverySeconds`. */
  samples: { atSeconds: number; stats: ArenaStats }[];
}

/** `http(s)://host` → `ws(s)://host`. */
function socketBase(baseUrl: string): string {
  return baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '');
}

export async function fetchStats(baseUrl: string): Promise<ArenaStats> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/arena-stats`);
  if (!response.ok) throw new Error(`arena-stats answered ${String(response.status)}`);
  return (await response.json()) as ArenaStats;
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
}

/**
 * Connect one client and put it to work. The autopilot runs off `onSnapshot`,
 * i.e. on the server's own cadence rather than on a local timer — which is the
 * point: a probe that steered on its own clock would drift against a
 * production arena that ticks ~22 Hz (ticket 18) and slowly stop painting.
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
  const painter: Painter = { socket, client, fills: 0, deaths: 0 };
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

    const started = Date.now();
    samples.push({ atSeconds: 0, stats: await fetchStats(baseUrl) });
    for (;;) {
      const elapsed = (Date.now() - started) / 1000;
      if (elapsed >= seconds) break;
      await sleep(Math.min(sampleEverySeconds, seconds - elapsed) * 1000);
      samples.push({
        atSeconds: Math.round((Date.now() - started) / 1000),
        stats: await fetchStats(baseUrl),
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
  previous: ArenaStats['tick'],
  current: ArenaStats['tick'],
): { ticks: number; overBudget: number } | null {
  if (!previous || !current) return null;
  return {
    ticks: current.ticks - previous.ticks,
    overBudget: current.overBudgetTicks - previous.overBudgetTicks,
  };
}

export function report(result: ProbeResult): string {
  const { baseUrl, clients, seconds } = result.options;
  const last = result.samples[result.samples.length - 1]?.stats;
  const lines = [
    `${baseUrl} · ${String(clients)} clients (${String(result.joined)} spawned) · ` +
      `${String(seconds)} s`,
    `  ${String(result.fills)} fills · ${String(result.deaths)} deaths`,
    '',
    '  t(s)  entities  vertices   ticks   Hz    mean     p50     p95     max   over  new-over',
  ];
  let previous: ArenaStats['tick'] = null;
  for (const { atSeconds, stats } of result.samples) {
    const arena = stats.arena;
    const tick = stats.tick;
    if (!arena || !tick) {
      lines.push(`  ${String(atSeconds).padStart(4)}  (no arena running)`);
      continue;
    }
    const window = windowOf(previous, tick);
    previous = tick;
    lines.push(
      `  ${String(atSeconds).padStart(4)}  ` +
        `${String(arena.humans + arena.bots).padStart(8)}  ` +
        `${String(arena.vertices).padStart(8)}  ` +
        `${String(tick.ticks).padStart(6)}  ` +
        `${tick.observedHz.toFixed(1).padStart(4)}  ` +
        `${tick.meanMs.toFixed(2).padStart(6)}  ` +
        `${tick.p50Ms.toFixed(1).padStart(6)}  ` +
        `${tick.p95Ms.toFixed(1).padStart(6)}  ` +
        `${tick.maxMs.toFixed(1).padStart(6)}  ` +
        `${String(tick.overBudgetTicks).padStart(4)}  ` +
        (window ? String(window.overBudget).padStart(8) : '       -'),
    );
  }
  if (last?.tick) {
    lines.push(
      '',
      `  buckets (ms, upper bound): ${last.tick.buckets.join(' / ')}`,
      `  budget ${String(TICK_DT_MS)} ms/tick · ` +
        `${String(last.tick.overBudgetTicks)} of ${String(last.tick.ticks)} ticks over it`,
    );
  }
  return lines.join('\n');
}
