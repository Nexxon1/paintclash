/**
 * The pure simulation step (ADR-0003): fixed dt, no clock, no I/O — the same
 * function runs authoritatively in the Arena-DO and as prediction in the
 * browser. Mutates the passed state in place (hot path, 20 Hz × N players);
 * callers that need history clone first (`cloneSimState`).
 *
 * Since ticket 04 the step returns the tick's `TickEvents`: which players
 * closed a loop (fill is strictly server-only per spec §6.1 — the server
 * turns these into territory broadcasts; prediction ignores them).
 */

import { BALANCE, LIMITS } from '@paintclash/shared';

import { detectDeaths, type Death } from './collision.js';
import { closeLoop, spawnTerritory } from './fill.js';
import { appendTrailPoint, distanceToTerritory, pointInTerritory } from './geometry.js';
import { recordHistory, retireTrail, viewedBy } from './history.js';
import { mapSharePct } from './leaderboard.js';
import { nextRandom } from './rng.js';
import { lifeStats, type LifeStats } from './score.js';
import type { HeadPose, PlayerSim, SimState, TurnSignal } from './state.js';

/** Everything that can happen in one tick, in processing order. */
export interface TickInputs {
  /** Player ids to spawn this tick (already-present ids are ignored). */
  joins?: readonly number[];
  /**
   * Bot ids to spawn this tick (ADR-0005, ticket 12) — spawned exactly like
   * `joins` and steered through the same intents; the only difference is that
   * they never count as company for anyone's score (spec §10.5). Processed
   * after `joins`, so the spawn order stays deterministic.
   */
  botJoins?: readonly number[];
  /** Player ids to remove this tick. */
  leaves?: readonly number[];
  /** Steer intents; multiple per id coalesce to the last one (spec §8.3). */
  turns?: readonly { id: number; turn: TurnSignal }[];
  /**
   * Rewind view delays (ticket 07): how many ticks each player's pilot sees
   * opponents in the past. Persists like `turn` until replaced; clamped to
   * `LIMITS.rewindMaxTicks` — the sim never trusts the transport.
   */
  views?: readonly { id: number; viewDelayTicks: number }[];
}

/** What one tick decided beyond pure movement. */
export interface TickEvents {
  /**
   * Players that closed a loop this tick — their trail reset and their
   * territory was replaced (or kept, for sub-sliver loops, spec §2.2).
   */
  fills: number[];
  /**
   * Players whose territory lost land to a fill this tick and who still
   * hold some (ticket 06) — the server re-syncs exactly these. A player
   * stolen down to nothing is a total-loss death instead (in `deaths`,
   * whose respawn sync covers the territory change).
   */
  steals: number[];
  /**
   * Deaths of this tick (spec §2.1), already applied: each victim's old
   * land is neutral and they respawned on a fresh start block. Fills
   * resolve first — closing the loop in the same tick saves the runner.
   * Total-loss deaths (ticket 06) precede the collision deaths.
   */
  deaths: Death[];
  /**
   * Lives that ENDED this tick (ticket 09, spec §2.5): one entry per death,
   * captured before the respawn reset the counters. The score is personal, so
   * the server hands each entry to exactly the pilot whose life it was.
   */
  endedLives: LifeStats[];
}

const TURN_RATE_RAD = (BALANCE.movement.turnRateDegPerSec * Math.PI) / 180;
const TWO_PI = 2 * Math.PI;
/** Spawn candidates drawn before settling for the best available spot. */
const SPAWN_TRIES = 16;

/**
 * Advance one head by one fixed timestep: clamp the turn, move at constant
 * speed, slide along the soft barrier. Exactly this function is what client
 * prediction replays — server and client cannot drift (ADR-0002/0003).
 */
export function advancePlayer(p: HeadPose, arenaSizeWU: number, dtSec: number): void {
  let heading = p.heading + p.turn * TURN_RATE_RAD * dtSec;
  heading %= TWO_PI;
  if (heading < 0) heading += TWO_PI;
  p.heading = heading;
  const stepWU = BALANCE.movement.speedWuPerSec * dtSec;
  // Soft barrier (spec §2.4): clamping preserves the along-wall velocity
  // component, so the head glides along the edge instead of dying or sticking.
  p.x = Math.min(arenaSizeWU, Math.max(0, p.x + Math.cos(heading) * stepWU));
  p.y = Math.min(arenaSizeWU, Math.max(0, p.y + Math.sin(heading) * stepWU));
}

/** Distance from a point to the closest threat of an existing player. */
function distanceToPlayer(x: number, y: number, p: PlayerSim): number {
  const toHead = Math.hypot(x - p.x, y - p.y);
  // Territory counts too (spec §2.3) — exact edge distance, however the
  // territory has grown.
  return Math.min(toHead, distanceToTerritory(x, y, p.territory));
}

/**
 * Roll a fresh spawn (spot, heading, start block) from the state's RNG: random
 * candidates, first that honors the 25 WU minimum distance wins; under
 * crowding the best candidate found wins instead of failing (spec §2.3
 * "bestmögliche freie Stelle"). The start block is carved around existing
 * land so territories stay pairwise disjoint. `except` is the player being
 * respawned — their own head must not repel the roll.
 */
function rollSpawn(
  state: SimState,
  except: PlayerSim | null,
): Pick<PlayerSim, 'x' | 'y' | 'heading' | 'territory'> {
  const others = state.players.filter((p) => p !== except);
  // An arena smaller than the start block (tiny private rooms) must still
  // spawn inside — clamp the block to what fits.
  const blockWU = Math.min(BALANCE.spawn.startBlockWU, state.arenaSizeWU);
  const half = blockWU / 2;
  const range = Math.max(0, state.arenaSizeWU - blockWU);
  let bestX = state.arenaSizeWU / 2;
  let bestY = state.arenaSizeWU / 2;
  let bestDist = -Infinity;
  for (let i = 0; i < SPAWN_TRIES; i++) {
    const rx = nextRandom(state.rng);
    const ry = nextRandom(rx.state);
    state.rng = ry.state;
    const x = half + rx.value * range;
    const y = half + ry.value * range;
    let minDist = Infinity;
    for (const p of others) {
      minDist = Math.min(minDist, distanceToPlayer(x, y, p));
    }
    if (minDist > bestDist) {
      bestDist = minDist;
      bestX = x;
      bestY = y;
    }
    if (minDist >= BALANCE.spawn.minDistanceWU) break;
  }
  const rh = nextRandom(state.rng);
  state.rng = rh.state;
  return {
    x: bestX,
    y: bestY,
    heading: rh.value * TWO_PI,
    territory: spawnTerritory(
      bestX,
      bestY,
      half,
      others.map((p) => p.territory),
    ),
  };
}

function spawnPlayer(state: SimState, id: number, isBot: boolean): void {
  const spawn = rollSpawn(state, null);
  state.players.push({
    id,
    turn: 0,
    trail: [],
    viewDelayTicks: 0,
    trailEpoch: 0,
    retiredTrails: [],
    history: [],
    isBot,
    lifeTicks: 0,
    // The fresh start block is the life's peak until a fill beats it.
    peakPct: mapSharePct(spawn.territory, state.arenaSizeWU),
    otherHumanTicks: 0,
    ...spawn,
  });
}

/**
 * Apply one tick's deaths (spec §2.1): every victim's whole territory turns
 * neutral FIRST — then each respawns in place (array position kept: order is
 * the determinism contract, ADR-0003), so one victim's abandoned land never
 * constrains another victim's respawn. `safeIds` is updated along the way: a
 * respawned head stands on its fresh block, which is what this tick's
 * history entry must record.
 */
function applyDeaths(state: SimState, deaths: readonly Death[], safeIds: Set<number>): void {
  const victims: PlayerSim[] = [];
  for (const death of deaths) {
    const victim = state.players.find((p) => p.id === death.victimId);
    if (!victim) continue;
    victim.territory = [];
    // Death ends the rewind past with the life (ticket 07): a lagged cut of
    // THIS life's trail must never kill the respawned next one — that would
    // be the double death the rewind must not introduce. Only fill resets
    // stay rewound-cuttable (retireTrail); here the whole past is purged.
    victim.trail = [];
    victim.trailEpoch += 1;
    victim.retiredTrails = [];
    victim.history = [];
    victims.push(victim);
  }
  for (const victim of victims) {
    Object.assign(victim, rollSpawn(state, victim));
    victim.turn = 0;
    // A new life starts a new score (spec §2.5: the score is per life) —
    // the closing counters were already captured into `endedLives`.
    victim.lifeTicks = 0;
    victim.otherHumanTicks = 0;
    victim.peakPct = mapSharePct(victim.territory, state.arenaSizeWU);
    safeIds.add(victim.id);
  }
}

/**
 * Fold this tick into every player's life counters (spec §10.5): one lived
 * tick each, plus the number of OTHER humans alive alongside them — the time
 * integral whose average is the score's ØandereMenschen. Bots count nobody
 * as company and are company to nobody, so an arena padded with bots (or a
 * private room full of them) grants no multiplier at all.
 */
function accrueLifeCounters(players: readonly PlayerSim[]): void {
  let humans = 0;
  for (const p of players) if (!p.isBot) humans += 1;
  for (const p of players) {
    p.lifeTicks += 1;
    p.otherHumanTicks += p.isBot ? humans : humans - 1;
  }
}

/**
 * Post-movement trail bookkeeping for one player (spec §2.1/2.2): outside
 * the own territory the head draws a trail; re-entering closes the loop and
 * captures the enclosed area. Inside there is no trail — safespace.
 * Records into `safeIds` whoever ended the tick on their own land: the
 * head-on shield (spec §2.1) and the rewind history's `safe` flag both come
 * from this one verdict, decided where it is already computed.
 */
function trackTrail(
  state: SimState,
  p: PlayerSim,
  prevX: number,
  prevY: number,
  events: TickEvents,
  safeIds: Set<number>,
): void {
  // No land, no loop to return to (only possible under pathological spawn
  // crowding): such a player draws no trail until territory exists again.
  if (p.territory.length === 0) return;
  const inside = pointInTerritory(p.x, p.y, p.territory);
  if (inside) safeIds.add(p.id);
  if (p.trail.length === 0) {
    if (!inside) {
      // Seed with the last pose *inside* — the loop ring later connects to
      // the territory without on-boundary degeneracy.
      p.trail.push([prevX, prevY]);
      appendTrailPoint(p.trail, p.x, p.y);
    }
    return;
  }
  appendTrailPoint(p.trail, p.x, p.y);
  if (!inside) return;
  // Loop closed. Fills earlier in this tick's iteration order are already
  // visible to later ones — deterministic by the stable player order.
  const others = state.players.filter((q) => q.id !== p.id);
  const outcome = closeLoop(
    p.territory,
    p.trail,
    others.map((q) => q.territory),
  );
  if (outcome) {
    p.territory = outcome.territory;
    // A fill is the ONLY way land grows (spawn aside), so this is where the
    // score's peak share can move — cheaper and exact, versus re-measuring
    // every territory every tick (spec §10.5).
    p.peakPct = Math.max(p.peakPct, mapSharePct(p.territory, state.arenaSizeWU));
    others.forEach((victim, i) => {
      const updated = outcome.others[i];
      if (updated === undefined || updated === victim.territory) return;
      const hadLand = victim.territory.length > 0;
      victim.territory = updated;
      // Stolen to nothing = total-loss death (spec §2.1) — the enclosure
      // itself never kills, running out of land does. A victim whose head
      // was just enclosed keeps standing (now on foreign land); their trail
      // starts when their own trackTrail sees them outside — same tick for
      // players later in the array, next tick for earlier ones (both
      // deterministic). Their head-on shield drops THIS tick either way:
      // `step` re-checks inside-ness for steal victims before judging.
      if (updated.length === 0 && hadLand) {
        events.deaths.push({ victimId: victim.id, killerId: p.id, cause: 'totalLoss' });
      } else if (!events.steals.includes(victim.id)) {
        events.steals.push(victim.id);
      }
    });
  }
  retireTrail(p);
  events.fills.push(p.id);
}

/**
 * Sanitize a view delay reaching the sim: whole ticks within the rewind
 * window. The server already bounds what it derives from a client report
 * (`ArenaCore.rewindDepth`, which can also weigh the connection's measured
 * timing); this is the sim's own guard, so bots, tests and replays cannot
 * hand it a depth the history could never answer either.
 */
function clampViewDelay(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(LIMITS.rewindMaxTicks, Math.max(0, Math.trunc(value)));
}

/** One authoritative tick: leaves → joins → intents → movement → trails/fills → deaths. */
export function step(state: SimState, inputs: TickInputs, dtSec: number): TickEvents {
  const events: TickEvents = { fills: [], steals: [], deaths: [], endedLives: [] };
  if (inputs.leaves) {
    for (const id of inputs.leaves) {
      const idx = state.players.findIndex((p) => p.id === id);
      if (idx !== -1) state.players.splice(idx, 1);
    }
  }
  for (const [ids, isBot] of [
    [inputs.joins, false],
    [inputs.botJoins, true],
  ] as const) {
    for (const id of ids ?? []) {
      if (!state.players.some((p) => p.id === id)) spawnPlayer(state, id, isBot);
    }
  }
  const byId = (id: number): PlayerSim | undefined => state.players.find((p) => p.id === id);
  if (inputs.turns) {
    for (const { id, turn } of inputs.turns) {
      const p = byId(id);
      if (p) p.turn = turn;
    }
  }
  if (inputs.views) {
    for (const { id, viewDelayTicks } of inputs.views) {
      const p = byId(id);
      if (p) p.viewDelayTicks = clampViewDelay(viewDelayTicks);
    }
  }
  // Post-movement "stands on own land" — the head-on shield (spec §2.1) and
  // this tick's history `safe` flag, from one verdict per player.
  const safeIds = new Set<number>();
  for (const p of state.players) {
    const prevX = p.x;
    const prevY = p.y;
    advancePlayer(p, state.arenaSizeWU, dtSec);
    trackTrail(state, p, prevX, prevY, events, safeIds);
  }
  // A fill may have re-shaded the ground under a head that already had its
  // verdict taken (steal, total loss) — re-check those before judging.
  for (const id of [...events.steals, ...events.deaths.map((d) => d.victimId)]) {
    const p = byId(id);
    if (!p) continue;
    if (pointInTerritory(p.x, p.y, p.territory)) safeIds.add(p.id);
    else safeIds.delete(p.id);
  }
  // Collision deaths join the total-loss deaths the fills above produced.
  // A total-loss victim's trail still cuts this tick (simultaneity, ticket
  // 05) — but they die only once, under the earlier cause.
  const judgedTick = state.tick + 1;
  const dying = new Set(events.deaths.map((d) => d.victimId));
  const collisionDeaths = detectDeaths(state.players, {
    safeIds,
    viewedBy: (actor, target) => viewedBy(actor, target, judgedTick),
  });
  for (const death of collisionDeaths) {
    if (!dying.has(death.victimId)) {
      events.deaths.push(death);
      dying.add(death.victimId);
    }
  }
  // A steal survivor who still died this tick (e.g. cut while their land
  // shrank) is a death, not a steal — the respawn sync covers them.
  events.steals = events.steals.filter((id) => !dying.has(id));
  // Everyone lived through this tick — including whoever dies at its end, who
  // is credited the tick before their life is closed and their counters reset.
  accrueLifeCounters(state.players);
  for (const death of events.deaths) {
    const victim = byId(death.victimId);
    if (victim) events.endedLives.push(lifeStats(victim));
  }
  applyDeaths(state, events.deaths, safeIds);
  state.tick += 1;
  recordHistory(state.players, state.tick, safeIds);
  return events;
}
