/**
 * Which sounds this frame owes the player (spec §4.4, CONTEXT: SFX-Kern) —
 * the whole rule set of the SFX core, decided here and nowhere else.
 *
 * Pure and headless: it reads the same `RenderState` the scene and the HUD
 * read, and returns cue names. Nothing about Web Audio, the DOM or a clock
 * leaks in — `sfx.ts` turns the names into sound, `main.ts` owns the frame
 * loop. That keeps the whole *rule* layer (which events sound, and when)
 * under unit coverage while the audio graph hangs off an injectable seam.
 *
 * STRICTLY EGOCENTRIC (CONTEXT: Egozentrischer Ton): every cue below is
 * about the local player. A foreign fill, a foreign kill, a foreign death
 * are silent — a busy arena would otherwise be a permanent rattle, and the
 * player could not tell their own reward from someone else's.
 *
 * Decoupled from `sim-core`'s determinism (ADR-0002/0003): this reads what
 * was rendered, never the other way round, so muting or missing a cue cannot
 * change a single simulated tick. Sound is additive to the visual feedback
 * (spec §4.4: never an accessibility channel of its own).
 */

import { pointInTerritory } from '@paintclash/sim-core';

import type { DeathView, RenderState } from './session.js';

/**
 * The five one-shots of the SFX core (spec §4.4 events 1–5) — the vocabulary
 * `sfx.ts` gives voices to. Event 6, the "eat" loop, is a state rather than a
 * cue and rides along in `SfxFrame.eating`.
 */
export const SFX_CUES = ['fill', 'kill', 'death', 'spawn', 'rankup'] as const;

export type SfxCue = (typeof SFX_CUES)[number];

/**
 * What one frame sounds like: the one-shots to fire, plus whether the "eat"
 * loop (event 6) should be running.
 *
 * REUSED between samples — read it and act on it, do not keep it. One frame's
 * worth of cues is a handful of strings sixty times a second; allocating a
 * fresh array and object each time is exactly the per-frame garbage spec §4.4
 * rules out ("keine Allokation pro Tick").
 */
export interface SfxFrame {
  readonly cues: readonly SfxCue[];
  readonly eating: boolean;
}

/**
 * How long after the own death the respawn cue follows. The server respawns
 * in the SAME tick as the death (`arena.ts` sends the death frame, then the
 * fresh territory), so without a beat in between the two one-shots would sound
 * as one muddled noise — and the death, the more important message of the two,
 * would be the one that got buried.
 */
export const RESPAWN_CUE_DELAY_MS = 420;

export class SfxCues {
  /** The own head has been seen alive — the join cue is spent. */
  private spawned = false;
  /** Own rank on the last board that carried it; null until it appears. */
  private rank: number | null = null;
  /** Board revision the rank above was read from (boards replace, §2.5). */
  private rankRev = -1;
  /** Milliseconds left until the pending respawn cue, or null when none. */
  private respawnInMs: number | null = null;
  /** The one reused result (see `SfxFrame`) — `cues` is its live buffer. */
  private readonly frame: { cues: SfxCue[]; eating: boolean } = { cues: [], eating: false };

  /**
   * The cues owed for this rendered frame. `frameDtMs` is the time the
   * previous frame was visible — the only clock this module has, which is
   * what keeps it pure (and what the respawn delay counts down on).
   */
  sample(state: RenderState, frameDtMs: number): SfxFrame {
    const cues = this.frame.cues;
    cues.length = 0;
    this.frame.eating = false;
    const selfId = state.selfId;
    // Before the welcome there is no "own" anything to be egocentric about.
    if (selfId === null) return this.frame;

    // 1) Deaths — the own one (spec §4.4 event 3) and the ones the local
    // player caused (event 2). Both can land in the same frame, and each is
    // its own message: dying does not un-cut the trail you cut.
    const ownDeath = state.deaths.find((death) => death.victimId === selfId);
    if (ownDeath) {
      cues.push('death');
      this.respawnInMs = RESPAWN_CUE_DELAY_MS;
      // A life that ends in the very frame it was first drawn in still spent
      // its join cue — the respawn above is the one that owes a sound now.
      if (state.self !== null) this.spawned = true;
    }
    // One kill cue per frame, however many enemies fell into the same trail:
    // two overlapping copies of the same sound are just louder, not better.
    if (state.deaths.some((death) => this.isOwnKill(death, selfId, ownDeath))) cues.push('kill');

    // 2) The reward (spec §4.4: "die Belohnung, das Herz").
    if (state.fills.includes(selfId)) cues.push('fill');

    // 3) Join, and the respawn a death armed.
    if (!this.spawned && state.self !== null) {
      this.spawned = true;
      cues.push('spawn');
      this.respawnInMs = null;
    } else if (this.respawnInMs !== null) {
      this.respawnInMs -= frameDtMs;
      if (this.respawnInMs <= 0) {
        this.respawnInMs = null;
        cues.push('spawn');
      }
    }

    // 4) Climbing the board. Only a fresh board can change the rank, and the
    // first one to carry the own row is a baseline: arriving is not a climb.
    if (state.leaderboard.rev !== this.rankRev) {
      this.rankRev = state.leaderboard.rev;
      const own = state.leaderboard.rows.find((row) => row.playerId === selfId);
      // A board without the own row says nothing about the own rank — it is
      // not evidence of a drop, so the last known rank stands.
      if (own) {
        if (this.rank !== null && own.rank < this.rank) cues.push('rankup');
        this.rank = own.rank;
      }
    }

    // 5) The loop: is the own trail eating through FOREIGN land right now?
    // A life that just ended is not eating anything, whatever the frame that
    // drew it still holds.
    this.frame.eating = !ownDeath && this.isEating(state, selfId);
    return this.frame;
  }

  /**
   * Is this death one the local player gets the kill cue for (spec §4.4
   * event 2: "Gegner-Trail geschnitten / Kopf-an-Kopf gewonnen")?
   *
   * Three things it is deliberately NOT:
   *   - a self-cut, which names the victim as their own killer (sim-core);
   *   - a `totalLoss`, where the killer is whoever painted the last of the
   *     victim's land away (sim-core `step.ts`) — the spec lists Totalverlust
   *     under the own-death cue, not under Kill, and the fill that caused it
   *     is already sounding its own reward this very frame;
   *   - a head-on that killed BOTH heads (spec §2.1: "Beide exakt draußen im
   *     selben Tick → beide sterben") — that duel was not won. A head-on with
   *     someone ELSE, in the frame a third player cuts you, still counts.
   */
  private isOwnKill(death: DeathView, selfId: number, ownDeath: DeathView | undefined): boolean {
    if (death.victimId === selfId || death.killerId !== selfId) return false;
    if (death.cause === 'totalLoss') return false;
    const mutual = ownDeath?.cause === 'headOn' && ownDeath.killerId === death.victimId;
    return !mutual;
  }

  /**
   * Eating = the own trail is running through another player's territory
   * (spec §4.4: only there — neutral ground and the own land are silent).
   *
   * Hung off the TRAIL rather than off the position, because that is what the
   * spec says is doing the eating; the trail's existence is also the cheap
   * gate that keeps the point-in-polygon tests off every home-ground frame.
   */
  private isEating(state: RenderState, selfId: number): boolean {
    if (!state.self) return false;
    if (!state.trails.some((trail) => trail.playerId === selfId)) return false;
    const { x, y } = state.self;
    return state.territories.some(
      (view) => view.playerId !== selfId && pointInTerritory(x, y, view.territory),
    );
  }
}
