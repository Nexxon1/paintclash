import { SELF } from 'cloudflare:test';
import { BALANCE, type Point, type Territory, type TurnSignal } from '@paintclash/shared';
import { SimClient } from '@paintclash/sim-client';
import { pointInTerritory, territoryArea } from '@paintclash/sim-core';
import { describe, expect, it } from 'vitest';

/**
 * Scenario (ticket 26, spec §2.2): closing a gap over the real wire with a run
 * that NEVER steers — a real Arena-DO in workerd, one headless sim-client, the
 * real binary protocol.
 *
 * That is the one loop shape a unit test cannot reach through a socket, and the
 * shape players actually use. Driving straight is exactly collinear tick after
 * tick, so the sim folds the whole excursion into TWO trail points
 * (`appendTrailPoint`) — and two points are a line, not a region, so the
 * capture used to be dropped before it could bridge anything. Crossing a small
 * gap is precisely what one drives straight, so the mechanic failed where
 * players reached for it (§9.7 DoD 5: core mechanic ⇒ scenario coverage).
 *
 * Nothing about it can be scripted, so it is a feedback machine in three parts.
 * Each part is shaped by a failure that was measured first — the notes below say
 * which, because that is the difference between a choreography and a bet:
 *
 *   1. **The gap is built, not hoped for.** A crossable gap needs a CONCAVE own
 *      border, and no single fill produces one — every capture is hole-filled,
 *      which convexifies. So the head flies TWO lobes fanned 60° apart (the
 *      lobe maneuver comes from `steal.test.ts`); the wedge between them, closed
 *      at its apex by the start block, is the gap. The accidental reflex corners
 *      of ONE out-and-back were tried first: swept over 5 seeds × 4 rounds
 *      against `sim-core`, they yield gaps of 1,6–4,4 WU with land runs too thin
 *      to launch from, and for one seed nothing at all after four rounds.
 *   2. **The border is read back off the wire, never assumed.**
 *      `findCrossings` searches the polygon the server actually sent, and keeps
 *      only crossings that still cross when shifted `SLACK_WU` sideways — a
 *      pilot arrives off-line. Candidates are ranked, not reduced to a winner,
 *      because the search is deterministic: one that cannot be flown would
 *      otherwise be chosen again forever.
 *   3. **The run is released by prediction, not by an aim tolerance.** Every
 *      tick the pilot asks "if I stopped steering now, would the line I end up
 *      on cross a gap?" — projecting its own pose through `advancePlayer`'s rule
 *      for both ticks the intent could land on. Waiting for an aim to be *close
 *      enough* does not work here in either direction: bang-bang holds a heading
 *      only to within one tick of turn (16°, a 4 WU miss from 14 WU out), and
 *      waiting for a tick that is already unsteered never came (measured: 224
 *      ticks on own land, not one of them idle).
 *
 * Every stage re-plans instead of failing, and records what it did, so a bust
 * budget reports the choreography's own history instead of an opaque timeout.
 */

/**
 * A fresh caller address per socket (README rule 6, ticket 15). Socket opens are
 * rate-limited per address and one address may hold only so many at once
 * (spec §8.3 point 3) — sharing one across a suite that opens dozens would make
 * a choreography fail for a reason that has nothing to do with what it tests.
 */
let nextCaller = 0;
function freshCaller(): string {
  nextCaller += 1;
  return `192.0.2.${String(nextCaller)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until<T>(
  probe: () => T | null | undefined | false,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

async function connect(name: string): Promise<{ client: SimClient; ws: WebSocket }> {
  const response = await SELF.fetch('https://arena/ws', {
    headers: { Upgrade: 'websocket', 'CF-Connecting-IP': freshCaller() },
  });
  const ws = response.webSocket;
  if (!ws) throw new Error('server did not upgrade the connection');
  ws.accept();
  const client = new SimClient((frame) => {
    try {
      ws.send(frame);
    } catch {
      // The test tore this socket down while a queued frame was still
      // flushing. Uncaught, it lands in the DO's event loop as an unhandled
      // TypeError and buries the real failure in a wall of workerd stacks.
    }
  }, name);
  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') client.receive(event.data);
  });
  client.join();
  return { client, ws };
}

interface Pose {
  x: number;
  y: number;
  heading: number;
}

/**
 * What the server was doing while one excursion ran, as of the tick its loop
 * closed: how many ticks the head had been off its own land, how many
 * consecutive ticks the applied turn had been 0, and the turn on the closing
 * tick itself. Together they decide whether the loop's ring was two points.
 */
interface Tally {
  outsideTicks: number;
  unsteeredTicks: number;
  closingTurn: TurnSignal;
}

/** Shortest arc from `from` to `to` in radians. */
function shortestArc(from: number, to: number): number {
  const TWO_PI = 2 * Math.PI;
  let d = (to - from) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return d;
}

/** Bang-bang steering toward a target point, with a small deadband. */
function steerToward(self: Pose, target: Point): TurnSignal {
  const bearing = Math.atan2(target[1] - self.y, target[0] - self.x);
  const diff = shortestArc(self.heading, bearing);
  if (Math.abs(diff) < 0.06) return 0;
  return diff > 0 ? 1 : -1;
}

/**
 * Waypoint autopilot. `fly` plans a route; `shuttle` plans one that wraps back
 * to its first waypoint, so the head keeps sweeping the same corridor instead of
 * arriving and loitering — a bang-bang pilot parked on its target alternates ±1
 * forever, which is no state to launch a straight run from.
 */
class Pilot {
  private waypoints: Point[] = [];
  private index = 0;
  private cyclic = false;

  fly(waypoints: Point[]): void {
    this.waypoints = waypoints;
    this.index = 0;
    this.cyclic = false;
  }

  shuttle(waypoints: Point[]): void {
    this.fly(waypoints);
    this.cyclic = true;
  }

  /** Has the plan been flown to its last leg? The stall watchdog's signal. */
  get spent(): boolean {
    return !this.cyclic && this.index >= this.waypoints.length - 1;
  }

  steer(self: Pose): TurnSignal {
    const last = this.waypoints.length - 1;
    let target = this.waypoints[this.index];
    while (target && (this.cyclic || this.index < last) && this.reached(self, target)) {
      this.index = this.index >= last ? (this.cyclic ? 0 : last) : this.index + 1;
      target = this.waypoints[this.index];
    }
    return target ? steerToward(self, target) : 0;
  }

  private reached(self: Pose, target: Point): boolean {
    return Math.hypot(target[0] - self.x, target[1] - self.y) < 2;
  }
}

const TURN_RAD_PER_TICK = (BALANCE.movement.turnRateDegPerSec * Math.PI) / 180 / 20;
const STEP_WU = BALANCE.movement.speedWuPerSec / 20;

/**
 * Where the head will be, and where it will point, after `ticks` more ticks of
 * holding `turn` — `advancePlayer`'s rule, walls aside (everything here is kept
 * `WALL_MARGIN_WU` clear of them).
 *
 * This is what lets the run be released while the pilot is still steering. The
 * alternative was to wait for a tick with the turn already at 0, and a bang-bang
 * pilot chasing a waypoint is almost never there (measured: 224 ticks on its own
 * land, not one of them idle). Projecting instead asks the question that actually
 * matters — "if I stop steering NOW, does the line I will be on cross a gap?" —
 * and asks it for both ticks the intent could land on.
 */
function project(self: Pose, turn: TurnSignal, ticks: number): Pose {
  let { x, y, heading } = self;
  for (let i = 0; i < ticks; i++) {
    heading += turn * TURN_RAD_PER_TICK;
    x += Math.cos(heading) * STEP_WU;
    y += Math.sin(heading) * STEP_WU;
  }
  return { x, y, heading };
}

/**
 * How far the line must sample own land on the FAR side of the gap. A head moves
 * 0.45 WU per tick, so a run it could step over within a tick or two is a
 * re-entry the sim would never see.
 */
const MIN_LAND_WU = 1.5;
/**
 * And on the near side, where the run is launched from. Much longer, and that is
 * the whole point: the release needs the head to be standing on own land with
 * room ahead of it, so a crossing is only worth flying if its near side is a
 * runway. Chosen at the start block's own width — a line through the block into
 * the wedge beside a lobe has it; a line that clips a lobe's flank does not, and
 * with a 2 WU near side the release window was a single tick wide (measured: 31
 * ticks on own land over a whole approach, never once releasable).
 */
const LAUNCH_LAND_WU = 4;
/** How wide the neutral gap must be — a crossing worth flying. */
const MIN_GAP_WU = 2;
/**
 * And how wide it may be. The report this ticket comes from is about SMALL
 * gaps, and a line across a sprawling territory can leave and re-enter it 50 WU
 * apart — a legal crossing, but a different maneuver, and a much longer flight
 * to hold straight.
 */
const MAX_GAP_WU = 8;
/**
 * Own land the head must still have ahead of it when it stops steering: the
 * intent needs a tick or two to reach the server, and the trail's first segment
 * has to be flown at the final heading, or the ring is three points and the
 * test is measuring a different loop shape than the one it is about. 1.5 WU is
 * more than four ticks of travel.
 */
const RELEASE_LEAD_WU = 2;
/** Lateral miss a chosen crossing must survive: the pilot arrives off-line. */
const SLACK_WU = 0.6;
/** How far before the land the run starts, so it is straight long before it. */
const APPROACH_WU = 14;
/**
 * How far past the crossing the pilot aims, longest first — enough that the head
 * flies THROUGH rather than arriving and orbiting. The shorter fallbacks are for
 * a crossing whose far side points at a wall.
 */
const AIM_OVERSHOOTS_WU = [20, 12, 8];
/** Everything is kept this far off the walls — a clamped head bends its run. */
const WALL_MARGIN_WU = 4;
/** How far the lobes reach out of the block. */
const LOBE_REACH_WU = 14;
/** Half the angle between the two lobes: their wedge is the gap to close. */
const LOBE_SPREAD_RAD = (30 * Math.PI) / 180;
/** The capture that counts as a lobe actually having painted. */
const LOBE_GAIN_WU2 = 1;
/**
 * The capture that counts as a gap actually having been closed. Modest on
 * purpose: a run over a small gap seals the pocket between its line and the own
 * border, which near a wedge's apex is a fraction of a WU² (measured 0,32 for a
 * 2,8 WU gap). It does not need to be big to be decisive — a dead-straight trail
 * encloses NOTHING by itself, and the seal band is worth ≤ 1e-5 WU², so this is
 * still four orders of magnitude above anything but real land.
 */
const POCKET_GAIN_WU2 = 0.05;
const PROBE_STEP_WU = 0.2;
const LOOK_AHEAD_WU = 80;
const DIRECTIONS = 48;
const OFFSET_STEP_WU = 0.4;
/**
 * Wall-clock ceiling for the whole choreography, generous on purpose (see the
 * `until` call). Sibling precedent: `steal.test.ts` gives its raid 150 s inside
 * a 180 s test timeout.
 */
const BUDGET_MS = 150_000;
/** Per-stage patience, in authoritative ticks (20 per second). */
const LOBE_TICKS = 400;
const LOBE_SETTLE_TICKS = 160;
const APPROACH_TICKS = 300;
const COAST_TICKS = 200;

/** Axis-aligned bounds of a territory, or `null` for a player with no land. */
function bounds(
  territory: Territory,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of territory) {
    for (const [x, y] of poly[0] ?? []) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

function centerOf(territory: Territory): Point {
  const box = bounds(territory);
  return box ? [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2] : [0, 0];
}

function insideWalls(p: Point, arenaSizeWU: number): boolean {
  return (
    p[0] >= WALL_MARGIN_WU &&
    p[1] >= WALL_MARGIN_WU &&
    p[0] <= arenaSizeWU - WALL_MARGIN_WU &&
    p[1] <= arenaSizeWU - WALL_MARGIN_WU
  );
}

/** How far a ray may be followed before it would leave the wall margin. */
function spanInsideWalls(from: Point, dir: Point, arenaSizeWU: number): number {
  let t = 0;
  while (t < LOOK_AHEAD_WU) {
    const next = t + PROBE_STEP_WU;
    if (!insideWalls([from[0] + dir[0] * next, from[1] + dir[1] * next], arenaSizeWU)) break;
    t = next;
  }
  return t;
}

function rotate(v: Point, rad: number): Point {
  return [v[0] * Math.cos(rad) - v[1] * Math.sin(rad), v[0] * Math.sin(rad) + v[1] * Math.cos(rad)];
}

/**
 * One lobe: an align dogleg BEHIND the block (a drive back through the own land
 * resets the messy random-heading exit arc), out to the tip, a side gate that
 * forces the U-turn's direction, then home. Straight from `steal.test.ts`,
 * where the same maneuver grows a lobe that has to survive a raid.
 */
function lobeWaypoints(home: Point, dir: Point, side: Point): Point[] {
  const tip: Point = [home[0] + dir[0] * LOBE_REACH_WU, home[1] + dir[1] * LOBE_REACH_WU];
  return [
    [home[0] - dir[0] * 3.5, home[1] - dir[1] * 3.5],
    tip,
    [tip[0] + side[0] * 4, tip[1] + side[1] * 4],
    [home[0] + side[0] * 4, home[1] + side[1] * 4],
    home,
  ];
}

/**
 * The lobes to fly, fanned around the way to the arena center — pointing inward
 * keeps their tips and the wedge between them off the walls. Each lobe's U-turn
 * is forced to its OUTER side, so the extra width the turn paints lands away
 * from the wedge instead of filling it in. The third direction is the fallback
 * for a wedge that came out unusable.
 */
function lobePlan(home: Point, arenaSizeWU: number): { dir: Point; side: Point }[] {
  const toCenter: Point = [arenaSizeWU / 2 - home[0], arenaSizeWU / 2 - home[1]];
  const length = Math.hypot(toCenter[0], toCenter[1]) || 1;
  const inward: Point = [toCenter[0] / length, toCenter[1] / length];
  return [-LOBE_SPREAD_RAD, LOBE_SPREAD_RAD, 3 * LOBE_SPREAD_RAD].map((angle, i) => {
    const dir = rotate(inward, angle);
    return { dir, side: rotate(dir, i === 0 ? -Math.PI / 2 : Math.PI / 2) };
  });
}

/** Where a marched line leaves own land and comes back, as arc lengths. */
interface Marked {
  entry: number;
  gapStart: number;
  gapEnd: number;
  exit: number;
}

/**
 * March a line through the territory and find the first place it leaves own
 * land and comes back: `land → gap → land`, all three long enough to be a
 * crossing rather than a graze. Arc lengths from `origin`.
 *
 * The land runs matter as much as the gap: a head moves 0.45 WU per tick, so a
 * run it could step over in one tick is a crossing the sim would never see.
 */
function crossingOnLine(
  territory: Territory,
  origin: Point,
  dir: Point,
  span: number,
  minNearWU: number,
): Marked | null {
  const runs: { inside: boolean; from: number; to: number }[] = [];
  for (let t = 0; t <= span; t += PROBE_STEP_WU) {
    const inside = pointInTerritory(origin[0] + dir[0] * t, origin[1] + dir[1] * t, territory);
    const open = runs[runs.length - 1];
    if (open && open.inside === inside) open.to = t;
    else runs.push({ inside, from: t, to: t });
  }
  for (let i = 0; i + 2 < runs.length; i++) {
    const land = runs[i];
    const gap = runs[i + 1];
    const far = runs[i + 2];
    if (!land?.inside || gap?.inside !== false || !far?.inside) continue;
    if (land.to - land.from < minNearWU) continue;
    if (gap.to - gap.from < MIN_GAP_WU) continue;
    if (far.to - far.from < MIN_LAND_WU) continue;
    return { entry: land.from, gapStart: gap.from, gapEnd: gap.to, exit: far.to };
  }
  return null;
}

/** Where to start a straight run, and what to aim it at. */
interface Crossing {
  start: Point;
  aim: Point;
  gapWU: number;
}

/**
 * Every gap in the own border a straight run could close, widest first: each
 * direction, each offset across the land. A candidate only counts if the two
 * lines `SLACK_WU` to either side cross the same way — a crossing that works
 * only dead-on is a maneuver that mostly works, which is how this suite goes
 * red on a shared runner (README rule 1).
 *
 * The list is ranked rather than reduced to a winner because the search is
 * deterministic: a crossing the pilot cannot fly (it enters the land too close
 * to the gap to settle onto a straight course) would otherwise be re-chosen
 * forever. The next attempt takes the next-widest instead.
 */
function findCrossings(territory: Territory, arenaSizeWU: number): Crossing[] {
  const box = bounds(territory);
  if (!box) return [];
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const span = Math.hypot(box.maxX - box.minX, box.maxY - box.minY) + 2;
  const found: Crossing[] = [];
  for (let i = 0; i < DIRECTIONS; i++) {
    const angle = (i / DIRECTIONS) * 2 * Math.PI;
    const dir: Point = [Math.cos(angle), Math.sin(angle)];
    const normal: Point = [-dir[1], dir[0]];
    const originAt = (lateral: number): Point => [
      cx + normal[0] * lateral - (dir[0] * span) / 2,
      cy + normal[1] * lateral - (dir[1] * span) / 2,
    ];
    let bestOfDirection: Crossing | null = null;
    for (let lateral = -span / 2; lateral <= span / 2; lateral += OFFSET_STEP_WU) {
      const run = crossingOnLine(territory, originAt(lateral), dir, span, LAUNCH_LAND_WU);
      if (!run) continue;
      const gapWU = run.gapEnd - run.gapStart;
      if (gapWU > MAX_GAP_WU) continue;
      if (bestOfDirection !== null && gapWU <= bestOfDirection.gapWU) continue;
      if (!crossingOnLine(territory, originAt(lateral + SLACK_WU), dir, span, LAUNCH_LAND_WU))
        continue;
      if (!crossingOnLine(territory, originAt(lateral - SLACK_WU), dir, span, LAUNCH_LAND_WU))
        continue;
      const origin = originAt(lateral);
      const along = (t: number): Point => [origin[0] + dir[0] * t, origin[1] + dir[1] * t];
      const start = along(run.entry - APPROACH_WU);
      if (!insideWalls(start, arenaSizeWU)) continue;
      // The aim sits WELL BEYOND the far land, never on it: a waypoint the head
      // arrives at is a waypoint it then orbits, and a bang-bang pilot in orbit
      // alternates ±1 forever — it would never be unsteered long enough to
      // release. (Measured: 224 ticks on its own land, not one of them settled.)
      // The whole run must fit off the walls; the margin box is convex, so its
      // ends vouch for everything between them.
      const aim = AIM_OVERSHOOTS_WU.map((over) => along(run.exit + over)).find((p) =>
        insideWalls(p, arenaSizeWU),
      );
      if (!aim) continue;
      bestOfDirection = { start, aim, gapWU };
    }
    if (bestOfDirection) found.push(bestOfDirection);
  }
  return found.sort((a, b) => b.gapWU - a.gapWU);
}

/**
 * The crossing a straight run from this pose would fly, if it would fly one:
 * how wide the gap is and how much own land lies before it.
 */
function crossingAhead(
  territory: Territory,
  self: Pose,
  arenaSizeWU: number,
): { gapWU: number; leadWU: number } | null {
  const from: Point = [self.x, self.y];
  const dir: Point = [Math.cos(self.heading), Math.sin(self.heading)];
  const run = crossingOnLine(
    territory,
    from,
    dir,
    spanInsideWalls(from, dir, arenaSizeWU),
    RELEASE_LEAD_WU,
  );
  return run ? { gapWU: run.gapEnd - run.gapStart, leadWU: run.gapStart } : null;
}

describe('closing a gap over the real wire (ticket 26)', () => {
  it('a run that never steers paints the pocket it sealed off', { timeout: 180_000 }, async () => {
    const { client, ws } = await connect('gapcloser');
    try {
      await until(() => client.self(), 'spawn snapshot');
      const id = client.playerId ?? -1;
      const arena = client.arenaSizeWU ?? BALANCE.arena.sizeWU;
      await until(() => client.territories.get(id), 'own start block sync');

      const pilot = new Pilot();
      /** What the choreography did, so a bust budget can say it. */
      const log: string[] = [];
      /** The tallies the verdict rests on — see `Tally`. */
      let unsteeredStreak = 0;
      let outsideStreak = 0;
      let closingTally: Tally | null = null;
      let filled = false;
      let deathsSeen = 0;
      let stage: 'lobe' | 'approach' | 'coast' = 'lobe';
      let stageSince = 0;
      let lobeIndex = 0;
      /** Which of the ranked crossings the next hunt takes. */
      let rank = 0;
      let plan = lobePlan(centerOf(client.territories.get(id) ?? []), arena);
      let areaMark = 0;
      let flownGap = 0;
      /** The last intent sent — one may still be in flight to the server. */
      let lastSent: TurnSignal = 0;
      /** Ticks of the current approach spent standing on the own land. */
      let onLand = 0;
      let outcome: (Tally & { gained: number; gapWU: number }) | null = null;

      const mine = (): Territory => client.territories.get(id) ?? [];

      const flyLobe = (tick: number, why: string): void => {
        const spec = plan[lobeIndex % plan.length];
        lobeIndex += 1;
        if (spec) pilot.fly(lobeWaypoints(centerOf(mine()), spec.dir, spec.side));
        areaMark = territoryArea(mine());
        stage = 'lobe';
        stageSince = tick;
        log.push(`t${String(tick)} lobe ${String(lobeIndex)} (${why})`);
      };
      const hunt = (tick: number, why: string): void => {
        const crossings = findCrossings(mine(), arena);
        // A crossing that did not work out is not re-chosen: the search is
        // deterministic, so the next attempt takes the next-widest gap, and
        // once they are exhausted another lobe changes the border itself.
        const found = crossings[rank];
        rank += 1;
        if (!found) {
          rank = 0;
          flyLobe(tick, `${why}, no crossable gap left (${String(crossings.length)} tried)`);
          return;
        }
        pilot.shuttle([found.start, found.aim]);
        areaMark = territoryArea(mine());
        flownGap = 0;
        onLand = 0;
        stage = 'approach';
        stageSince = tick;
        log.push(`t${String(tick)} approach a ${found.gapWU.toFixed(1)} WU gap (${why})`);
      };

      client.onTerritory = (update) => {
        if (update.playerId === id && update.reason === 'fill') filled = true;
      };
      client.onSnapshot = (snapshot) => {
        const self = snapshot.players.find((p) => p.id === id);
        if (!self || outcome) return;
        const tick = snapshot.tick;
        let closed = false;
        if (filled) {
          // The streaks are still last tick's — they describe the excursion
          // that just closed, before this inside pose resets them. `closing`
          // is this tick's own turn: the loop's last segment is flown at it.
          closingTally = {
            outsideTicks: outsideStreak,
            unsteeredTicks: unsteeredStreak,
            closingTurn: self.turn,
          };
          filled = false;
          closed = true;
        }
        unsteeredStreak = self.turn === 0 ? unsteeredStreak + 1 : 0;
        outsideStreak = pointInTerritory(self.x, self.y, mine()) ? 0 : outsideStreak + 1;

        const died = client.deaths.filter((d) => d.victimId === id).length;
        if (died > deathsSeen) {
          deathsSeen = died;
          plan = lobePlan(centerOf(mine()), arena);
          lobeIndex = 0;
          flyLobe(tick, `died ${String(died)}×, starting over on the fresh block`);
        } else if (stage === 'coast') {
          const gained = territoryArea(mine()) - areaMark;
          if (closed) {
            const tally = closingTally ?? { outsideTicks: 0, unsteeredTicks: 0, closingTurn: 0 };
            if (gained > POCKET_GAIN_WU2) {
              outcome = { gained, gapWU: flownGap, ...tally };
              log.push(
                `t${String(tick)} closed it: +${gained.toFixed(2)} WU², ` +
                  `${String(tally.outsideTicks)} ticks outside, ` +
                  `${String(tally.unsteeredTicks)} unsteered`,
              );
            } else {
              hunt(tick, `the run gained only ${gained.toFixed(2)} WU²`);
            }
          } else if (tick - stageSince > COAST_TICKS) {
            hunt(tick, 'the released run never closed');
          }
        } else if (stage === 'lobe') {
          if (territoryArea(mine()) - areaMark > LOBE_GAIN_WU2) {
            // Fresh land, fresh ranking: the crossings just changed.
            rank = 0;
            hunt(tick, `lobe ${String(lobeIndex)} painted`);
          } else if (tick - stageSince > (pilot.spent ? LOBE_SETTLE_TICKS : LOBE_TICKS)) {
            flyLobe(tick, `lobe ${String(lobeIndex)} painted nothing`);
          }
        } else if (tick - stageSince > APPROACH_TICKS) {
          hunt(tick, `the approach never lined up (${String(onLand)} ticks on own land)`);
        }
        // A fill DURING the approach is expected and is not a reason to
        // re-plan: the head flies in from outside, so arriving on its own
        // land closes a loop by definition — and standing on own land is
        // exactly the launch position the release needs. The border it
        // changed is re-read every tick anyway.

        if (outcome) {
          client.queueTurn(0);
          client.flush();
          return;
        }
        let turn: TurnSignal = 0;
        if (stage === 'coast') turn = 0;
        else if (stage === 'approach') {
          // Would stopping now put the head on a line that crosses a gap? Ask
          // for BOTH ticks the intent could take effect on, from the pose the
          // head will actually have then (`project`) — so a release is safe
          // whichever tick the server applies it to.
          const land = mine();
          const ahead = [1, 2]
            .map((ticks) => project(self, lastSent, ticks))
            .map((pose) =>
              pointInTerritory(pose.x, pose.y, land) ? crossingAhead(land, pose, arena) : null,
            );
          // What holds for BOTH of them is what a release can count on.
          const guaranteed = ahead.reduce<{ gapWU: number; leadWU: number } | null>(
            (a, b) =>
              a === null || b === null
                ? null
                : { gapWU: Math.min(a.gapWU, b.gapWU), leadWU: Math.min(a.leadWU, b.leadWU) },
            { gapWU: Infinity, leadWU: Infinity },
          );
          // Launch from ON the own land, always: a head already outside is
          // already drawing a trail, and the turns that got it there would end
          // up in the ring. (Measured: releasing outside produced a 65-tick
          // trail with 2 unsteered ticks at its end.)
          if (
            outsideStreak === 0 &&
            guaranteed !== null &&
            guaranteed.gapWU >= MIN_GAP_WU &&
            guaranteed.leadWU >= RELEASE_LEAD_WU
          ) {
            // Stopping now puts the head on a line that crosses a gap, and it
            // is still standing on its own land — so the trail starts fresh at
            // the border and every one of its segments is flown at this one
            // heading. Nothing else in this test has to be precise.
            flownGap = guaranteed.gapWU;
            stage = 'coast';
            stageSince = tick;
            areaMark = territoryArea(mine());
            log.push(
              `t${String(tick)} released onto a ${guaranteed.gapWU.toFixed(1)} WU gap, ` +
                `${guaranteed.leadWU.toFixed(1)} WU of own land to go`,
            );
          } else {
            if (outsideStreak === 0) onLand += 1;
            turn = pilot.steer(self);
          }
        } else {
          turn = pilot.steer(self);
        }
        lastSent = turn;
        client.queueTurn(turn);
        client.flush();
      };

      flyLobe(client.snapshot?.tick ?? 0, 'first lobe');
      // The choreography's own history is the failure message (README rule
      // 2) — built when it fails, not when it starts, or it would report the
      // first line forever.
      const closedGap = await until(
        () => outcome,
        'an unsteered run to close a gap',
        // A progress budget, not a wall-clock bet (README rule 3): the stages
        // above are bounded in TICKS (900 of them ≈ 45 s of sim time for one
        // full re-plan cycle), so the ceiling here has to leave room for
        // several of those — a slow runner must make this test slower, not red.
        // It runs in 33–37 s locally, and one cycle alone would eat a 60 s cap.
        BUDGET_MS,
      ).catch((error: unknown) => {
        throw new Error(
          `${(error as Error).message}. What the pilot did:\n    ${log.join('\n    ')}`,
        );
      });

      // It was a real excursion, several ticks of it off the own land …
      expect(closedGap.outsideTicks).toBeGreaterThanOrEqual(2);
      // … and the server applied turn 0 for every one of those ticks, plus
      // the closing one. Constant turn ⇒ constant heading ⇒ every movement
      // segment identical ⇒ `appendTrailPoint` folded the whole thing into a
      // two-point ring. That ring is what this ticket is about.
      expect(closedGap.unsteeredTicks).toBeGreaterThanOrEqual(closedGap.outsideTicks);
      expect(closedGap.closingTurn).toBe(0);
      // And it painted. A dead-straight trail encloses nothing at all by
      // itself, so all of this came from the pocket the crossing sealed off
      // against the own border.
      expect(closedGap.gained).toBeGreaterThan(POCKET_GAIN_WU2);
      expect(closedGap.gapWU).toBeGreaterThanOrEqual(MIN_GAP_WU);
    } finally {
      // Stop the pilot before the socket goes: a queued flush on a closing
      // socket throws inside the message handler and buries the real
      // failure under pages of workerd exception noise.
      client.onSnapshot = null;
      client.onTerritory = null;
      ws.close();
    }
  });
});
