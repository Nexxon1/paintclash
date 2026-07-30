/**
 * The SFX core (spec §4.4): six sounds, made of nothing but Web Audio nodes —
 * **0 asset bytes**, no license, versioned as code. Oscillators plus gain
 * envelopes for the one-shots, filtered noise where a tone will not do (the
 * kill and the "eat" loop).
 *
 * The seam is `play('fill')`: which voice a cue gets — procedural today, a CC0
 * sample later if one turns out to sound better (spec §4.4 fallback) — is
 * invisible to every caller. `sfx-cues.ts` decides WHICH cues a frame owes,
 * this module only knows how they sound.
 *
 * THE THREE RUNTIME RULES the spec sets, all visible in the code below:
 *   1. ONE shared context and ONE master gain — the master gain IS the mute.
 *   2. The "eat" loop is ONE persistent source, moved by its gain envelope.
 *      Starting and stopping a source per frame is the classic Web Audio leak.
 *   3. No allocation per tick: one-shots are short throwaway nodes (a handful
 *      per event, not per frame), the loop allocates once for the whole page.
 *
 * The context is built inside `unlock()` — called from the join click, which
 * is a user gesture, so the autoplay policy is satisfied without ever showing
 * an "enable sound" prompt (spec §4.4). A context built at page load would be
 * born suspended, and the first fill would be silent.
 *
 * Web Audio itself is injected (like `storage.ts`): the whole engine is then
 * unit-testable headlessly against a fake context, which is what keeps rule 2
 * and rule 3 checkable rather than aspirational.
 */

import type { SfxCue } from './sfx-cues.js';

/* ------------------------------------------------------------------ *
 * The slice of Web Audio this module uses — structurally satisfied by
 * the real nodes, and small enough for a test to fake completely.
 * ------------------------------------------------------------------ */

export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, time: number): void;
  linearRampToValueAtTime(value: number, time: number): void;
  exponentialRampToValueAtTime(value: number, time: number): void;
  setTargetAtTime(value: number, time: number, timeConstant: number): void;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): void;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

export interface OscillatorLike extends AudioNodeLike {
  type: string;
  readonly frequency: AudioParamLike;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface BiquadFilterLike extends AudioNodeLike {
  type: string;
  readonly frequency: AudioParamLike;
  readonly Q: AudioParamLike;
}

export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
}

export interface BufferSourceLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  loop: boolean;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  /** 'suspended' until the gesture resumes it. */
  readonly state: string;
  readonly destination: AudioNodeLike;
  createGain(): GainNodeLike;
  createOscillator(): OscillatorLike;
  createBiquadFilter(): BiquadFilterLike;
  createBufferSource(): BufferSourceLike;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  resume(): Promise<void>;
}

/** `AudioContext` where the browser has one; null in node and in workers. */
export function browserAudioContext(): AudioContextLike | null {
  try {
    if (typeof AudioContext === 'undefined') return null;
    return new AudioContext();
  } catch {
    // A browser may refuse to build one (policy, exhausted contexts).
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Levels and timings. Deliberately modest: this is feedback over a
 * game, not a soundtrack, and six events must never sum to a clipped
 * master bus.
 * ------------------------------------------------------------------ */

/** Level of the master bus when unmuted — mute takes it to 0. */
export const MASTER_GAIN = 0.7;

/**
 * Default attack of a one-shot envelope: long enough not to click. A voice may
 * ask for a slower one — the startle in a bright sound is its ONSET, not its
 * level (which is how alarms are built), so anything with energy up where the
 * ear is most sensitive fades in instead of hitting.
 */
const ATTACK_SEC = 0.012;
/** Exponential ramps cannot reach 0 — this is "off" for them. */
const SILENT = 0.0001;
/** Tail after the envelope before the node is stopped. */
const RELEASE_PAD_SEC = 0.02;

/** Level of the "eat" loop: "leise" (spec §4.4) — texture, not a voice. */
const EAT_GAIN = 0.075;
/** Fade time constant of the loop — the "sanft ein-/ausgeblendet" of §4.4. */
const EAT_FADE_SEC = 0.09;
/** Mute ramp: fast enough to feel instant, slow enough not to click. */
const MUTE_FADE_SEC = 0.02;
/** Seconds of white noise generated once and looped for every noise voice. */
const NOISE_SEC = 1;

/* ------------------------------------------------------------------ *
 * The voices — one named entry per sound in the spec §4.4 event
 * table, so the table can be read here rather than reverse-engineered
 * from arguments at the call sites.
 * ------------------------------------------------------------------ */

/** The attack/decay shape every voice is played under. */
interface VoiceEnvelope {
  peak: number;
  durationSec: number;
  /** Fade-in; omitted = ATTACK_SEC. Longer takes the startle out of a voice. */
  attackSec?: number;
}

/** An oscillator sweeping `fromHz` → `toHz` under one attack/decay envelope. */
interface ToneVoice extends VoiceEnvelope {
  wave: string;
  fromHz: number;
  /** Equal to `fromHz` for a steady note (no sweep is scheduled then). */
  toHz: number;
}

/** White noise through a band-pass under the same envelope. */
interface NoiseVoice extends VoiceEnvelope {
  centerHz: number;
  q: number;
}

/** Event 1, the reward: a rising fifth, plus a sparkle a beat behind it. */
const FILL_CHIME: ToneVoice = {
  wave: 'sine',
  fromHz: 523.25,
  toHz: 1046.5,
  peak: 0.3,
  durationSec: 0.26,
};
const FILL_SPARKLE: ToneVoice = {
  wave: 'triangle',
  fromHz: 784,
  toHz: 1568,
  peak: 0.12,
  durationSec: 0.22,
};
const FILL_SPARKLE_DELAY_SEC = 0.055;

/**
 * Event 2, the kill: a warm impact — a body that drops in pitch, with a soft
 * knock for definition.
 *
 * Retuned after listening (spec §10: start values get adjusted against a
 * playable build). The first version put a wide noise burst at 1900 Hz with a
 * 12 ms attack, which is the recipe for an alarm: 2–4 kHz is where the ear is
 * most sensitive, so it read as tinny AND much louder than its 0.2 suggested,
 * and the fast onset made it a startle. Three changes: the noise moved down to
 * a narrow band around 560 Hz (a wooden knock instead of a hiss) at a third of
 * the level and with a slow fade-in; the body carries the event instead, as a
 * TRIANGLE (a square's odd harmonics were half the metallic character); and it
 * lands at 110 Hz rather than 90 — low enough to feel like weight, high enough
 * that a laptop speaker still reproduces it.
 */
const KILL_KNOCK: NoiseVoice = {
  centerHz: 560,
  q: 2.2,
  peak: 0.09,
  durationSec: 0.09,
  attackSec: 0.022,
};
const KILL_THUMP: ToneVoice = {
  wave: 'triangle',
  fromHz: 260,
  toHz: 110,
  peak: 0.28,
  durationSec: 0.19,
};

/** Event 3, the own death: the long fall, the only voice that takes its time. */
const DEATH_FALL: ToneVoice = {
  wave: 'sawtooth',
  fromHz: 300,
  toHz: 55,
  peak: 0.26,
  durationSec: 0.7,
};

/** Event 4, join/respawn: soft and short — a life starts, it does not brag. */
const SPAWN_BLIP: ToneVoice = {
  wave: 'triangle',
  fromHz: 330,
  toHz: 660,
  peak: 0.16,
  durationSec: 0.2,
};

/** Event 5, the climb: two steady notes, the second a fourth above (G → D). */
const RANKUP_FIRST: ToneVoice = {
  wave: 'triangle',
  fromHz: 784,
  toHz: 784,
  peak: 0.14,
  durationSec: 0.11,
};
const RANKUP_SECOND: ToneVoice = {
  wave: 'triangle',
  fromHz: 1174.7,
  toHz: 1174.7,
  peak: 0.14,
  durationSec: 0.14,
};
const RANKUP_SECOND_DELAY_SEC = 0.1;

/** Event 6, the "eat" loop: a low chewing rumble, not a hiss. */
const EAT_BAND: Pick<NoiseVoice, 'centerHz' | 'q'> = { centerHz: 620, q: 0.9 };

/** What the engine has done — the E2E's only window into a real browser. */
export interface SfxStats {
  /** The context's state, or null when there is none (yet, or ever). */
  contextState: string | null;
  muted: boolean;
  eating: boolean;
  /** One-shots handed to `play()`, counted even while muted. */
  played: Record<SfxCue, number>;
}

export class SfxEngine {
  private readonly create: () => AudioContextLike | null;
  private context: AudioContextLike | null = null;
  private master: GainNodeLike | null = null;
  /** The one looping noise source of the "eat" sound, plus its fader. */
  private eatGain: GainNodeLike | null = null;
  private noise: AudioBufferLike | null = null;
  private mute: boolean;
  private eating = false;
  private readonly played: Record<SfxCue, number> = {
    fill: 0,
    kill: 0,
    death: 0,
    spawn: 0,
    rankup: 0,
  };

  constructor(muted = false, create: () => AudioContextLike | null = browserAudioContext) {
    this.mute = muted;
    this.create = create;
  }

  /**
   * What the engine has done so far. `contextState` is null until the gesture
   * builds a context (and stays null in a browser without Web Audio), which is
   * also the "is anything able to sound?" answer.
   */
  get stats(): SfxStats {
    return {
      contextState: this.context?.state ?? null,
      muted: this.mute,
      eating: this.eating,
      played: this.played,
    };
  }

  /**
   * Build (once) and resume the shared context. Must be called from inside a
   * user gesture — the join click — which is what makes the unlock implicit.
   */
  unlock(): void {
    if (!this.context) {
      const context = this.create();
      if (!context) return; // no Web Audio here: the game plays on, silently
      this.context = context;
      const master = context.createGain();
      // Set, not ramped: nothing is connected yet, so there is nothing to click.
      master.gain.value = this.mute ? 0 : MASTER_GAIN;
      master.connect(context.destination);
      this.master = master;
    }
    // A context a mobile browser parked while backgrounded comes back here.
    // A refused resume is not an error worth surfacing — it means this call
    // carried no user activation, and the next gesture will try again.
    if (this.context.state !== 'running') {
      this.context.resume().catch(() => {
        /* stays suspended: silent, never broken */
      });
    }
  }

  /** Sound off (spec §4.4: binary, persisted by the HUD toggle). */
  setMuted(muted: boolean): void {
    this.mute = muted;
    const context = this.context;
    if (!context || !this.master) return;
    this.master.gain.setTargetAtTime(muted ? 0 : MASTER_GAIN, context.currentTime, MUTE_FADE_SEC);
    // The loop keeps its own fade: unmuting mid-bite must bring it back, and
    // muting must not leave it humming under a closed master gain.
    this.applyEating(context);
  }

  /** Fire one one-shot (spec §4.4 events 1–5). */
  play(cue: SfxCue): void {
    this.played[cue] += 1;
    const context = this.context;
    // Muted spends no nodes at all — a graph nobody can hear is pure cost.
    if (!context || !this.master || this.mute) return;
    const now = context.currentTime;
    switch (cue) {
      case 'fill':
        this.tone(context, FILL_CHIME, now);
        this.tone(context, FILL_SPARKLE, now + FILL_SPARKLE_DELAY_SEC);
        break;
      case 'kill':
        this.noiseVoice(context, KILL_KNOCK, now);
        this.tone(context, KILL_THUMP, now);
        break;
      case 'death':
        this.tone(context, DEATH_FALL, now);
        break;
      case 'spawn':
        this.tone(context, SPAWN_BLIP, now);
        break;
      case 'rankup':
        this.tone(context, RANKUP_FIRST, now);
        this.tone(context, RANKUP_SECOND, now + RANKUP_SECOND_DELAY_SEC);
        break;
    }
  }

  /**
   * The "eat" loop (spec §4.4 event 6) on or off. Called every frame with the
   * current state; only a CHANGE touches the audio graph, and no call ever
   * allocates after the first one.
   */
  setEating(on: boolean): void {
    const context = this.context;
    // Before the unlock the state is deliberately NOT remembered: it would
    // read as "unchanged" on the first real frame and never start the loop.
    if (!context) return;
    if (on === this.eating) return;
    this.eating = on;
    this.applyEating(context);
  }

  /** Cut the loop — the game (or the tab) is going away. */
  silence(): void {
    this.eating = false;
    if (this.context) this.applyEating(this.context);
  }

  /** Move the loop's fader to where mute and eating say it belongs. */
  private applyEating(context: AudioContextLike): void {
    const wanted = this.eating && !this.mute;
    // Nothing to fade down if the loop was never built (e.g. muted all game).
    if (!wanted && !this.eatGain) return;
    const gain = this.eatGain ?? this.buildEatLoop(context);
    gain.gain.setTargetAtTime(wanted ? EAT_GAIN : 0, context.currentTime, EAT_FADE_SEC);
  }

  /**
   * The one persistent loop source of the whole session: looping noise through
   * a band-pass, into a fader that is the only thing ever touched again.
   */
  private buildEatLoop(context: AudioContextLike): GainNodeLike {
    const { source, out } = this.noiseThroughBand(context, EAT_BAND);
    const gain = context.createGain();
    // Starts closed and is only ever faded — see the `every('target')` rule
    // in the tests: a hard cut on a running noise source clicks.
    gain.gain.value = 0;
    out.connect(gain);
    if (this.master) gain.connect(this.master);
    source.start(context.currentTime);
    this.eatGain = gain;
    return gain;
  }

  /**
   * One oscillator voice under an attack/decay envelope, straight into the
   * master bus.
   *
   * The nodes are not disconnected afterwards: a stopped source releases
   * itself and takes its unreferenced downstream chain with it. A handful of
   * nodes per event is not a graph that grows.
   */
  private tone(context: AudioContextLike, voice: ToneVoice, at: number): void {
    const osc = context.createOscillator();
    osc.type = voice.wave;
    osc.frequency.setValueAtTime(voice.fromHz, at);
    if (voice.toHz !== voice.fromHz) {
      osc.frequency.exponentialRampToValueAtTime(voice.toHz, at + voice.durationSec);
    }
    osc.connect(this.envelope(context, voice, at));
    osc.start(at);
    osc.stop(at + voice.durationSec + RELEASE_PAD_SEC);
  }

  /** One noise voice: band-passed white noise under the same envelope. */
  private noiseVoice(context: AudioContextLike, voice: NoiseVoice, at: number): void {
    const { source, out } = this.noiseThroughBand(context, voice);
    out.connect(this.envelope(context, voice, at));
    source.start(at);
    source.stop(at + voice.durationSec + RELEASE_PAD_SEC);
  }

  /**
   * The chain both noise users need: the shared noise buffer, looped, through
   * a band-pass. The caller schedules the source and wires `out` onward — the
   * one-shot into an envelope, the eat loop into its fader.
   */
  private noiseThroughBand(
    context: AudioContextLike,
    band: Pick<NoiseVoice, 'centerHz' | 'q'>,
  ): { source: BufferSourceLike; out: AudioNodeLike } {
    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer(context);
    // Looped so a burst longer than the buffer still has material; a one-shot
    // is stopped by its own schedule either way.
    source.loop = true;
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = band.centerHz;
    filter.Q.value = band.q;
    source.connect(filter);
    return { source, out: filter };
  }

  /** A fresh attack/decay gain into the master bus — the shape of every cue. */
  private envelope(context: AudioContextLike, voice: VoiceEnvelope, at: number): GainNodeLike {
    const env = context.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(voice.peak, at + (voice.attackSec ?? ATTACK_SEC));
    env.gain.exponentialRampToValueAtTime(SILENT, at + voice.durationSec);
    if (this.master) env.connect(this.master);
    return env;
  }

  /** One second of white noise, generated once and shared by every voice. */
  private noiseBuffer(context: AudioContextLike): AudioBufferLike {
    if (this.noise) return this.noise;
    const buffer = context.createBuffer(
      1,
      Math.floor(context.sampleRate * NOISE_SEC),
      context.sampleRate,
    );
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buffer;
    return buffer;
  }
}
