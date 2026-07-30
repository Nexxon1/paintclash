import { describe, expect, it } from 'vitest';

import { SFX_CUES } from './sfx-cues.js';
import { MASTER_GAIN, SfxEngine } from './sfx.js';

import type {
  AudioBufferLike,
  AudioContextLike,
  AudioNodeLike,
  AudioParamLike,
  BiquadFilterLike,
  BufferSourceLike,
  GainNodeLike,
  OscillatorLike,
} from './sfx.js';

/**
 * A fake Web Audio context: it records the graph instead of making sound, so
 * the engine's rules — one context, one master gain, one persistent loop
 * source, no node churn while looping — are checkable headlessly.
 */
class FakeParam implements AudioParamLike {
  value = 0;
  /** Every scheduled change, in call order: [method, value, time]. */
  readonly calls: [string, number, number][] = [];

  setValueAtTime(value: number, time: number): void {
    this.calls.push(['set', value, time]);
    this.value = value;
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.calls.push(['linear', value, time]);
    this.value = value;
  }

  exponentialRampToValueAtTime(value: number, time: number): void {
    this.calls.push(['exp', value, time]);
    this.value = value;
  }

  setTargetAtTime(value: number, time: number, constant: number): void {
    this.calls.push(['target', value, time]);
    expect(constant).toBeGreaterThan(0);
    this.value = value;
  }
}

class FakeNode implements AudioNodeLike {
  readonly outputs: AudioNodeLike[] = [];

  connect(destination: AudioNodeLike): void {
    this.outputs.push(destination);
  }
}

class FakeGain extends FakeNode implements GainNodeLike {
  readonly gain = new FakeParam();
}

class FakeSource extends FakeNode {
  started: number | null = null;
  stopped: number | null = null;

  start(when?: number): void {
    this.started = when ?? 0;
  }

  stop(when?: number): void {
    this.stopped = when ?? 0;
  }
}

class FakeOscillator extends FakeSource implements OscillatorLike {
  type = 'sine';
  readonly frequency = new FakeParam();
}

class FakeBufferSource extends FakeSource implements BufferSourceLike {
  buffer: AudioBufferLike | null = null;
  loop = false;
}

class FakeFilter extends FakeNode implements BiquadFilterLike {
  type = 'lowpass';
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
}

class FakeBuffer implements AudioBufferLike {
  private readonly channels: Float32Array[];

  constructor(channels: number, length: number) {
    this.channels = Array.from({ length: channels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    const data = this.channels[channel];
    if (!data) throw new Error(`no channel ${String(channel)}`);
    return data;
  }
}

class FakeContext implements AudioContextLike {
  currentTime = 0;
  readonly sampleRate = 48_000;
  state = 'suspended';
  readonly destination = new FakeNode();
  readonly gains: FakeGain[] = [];
  readonly oscillators: FakeOscillator[] = [];
  readonly sources: FakeBufferSource[] = [];
  readonly filters: FakeFilter[] = [];
  readonly buffers: FakeBuffer[] = [];
  resumes = 0;

  /** Nodes built so far — the "no allocation per tick" measure. */
  get nodeCount(): number {
    return this.gains.length + this.oscillators.length + this.sources.length + this.filters.length;
  }

  createGain(): GainNodeLike {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  createOscillator(): OscillatorLike {
    const osc = new FakeOscillator();
    this.oscillators.push(osc);
    return osc;
  }

  createBufferSource(): BufferSourceLike {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source;
  }

  createBiquadFilter(): BiquadFilterLike {
    const filter = new FakeFilter();
    this.filters.push(filter);
    return filter;
  }

  createBuffer(channels: number, length: number): AudioBufferLike {
    const buffer = new FakeBuffer(channels, length);
    this.buffers.push(buffer);
    return buffer;
  }

  resume(): Promise<void> {
    this.resumes += 1;
    this.state = 'running';
    return Promise.resolve();
  }
}

/** An engine over a fresh fake context, already unlocked unless told not to. */
function engineOn(muted = false): { engine: SfxEngine; context: FakeContext } {
  const context = new FakeContext();
  const engine = new SfxEngine(muted, () => context);
  engine.unlock();
  return { engine, context };
}

describe('the audio context (spec §4.4: implicitly unlocked on the join click)', () => {
  it('builds nothing before the gesture, and stays silent if asked to play', () => {
    const context = new FakeContext();
    let created = 0;
    const engine = new SfxEngine(false, () => {
      created += 1;
      return context;
    });
    // Autoplay policy: a context built at page load would be born suspended.
    expect(created).toBe(0);
    expect(engine.stats.contextState).toBe(null);
    engine.play('fill');
    engine.setEating(true);
    expect(context.nodeCount).toBe(0);

    engine.unlock();
    expect(created).toBe(1);
    expect(engine.stats.contextState).toBe('running');
    expect(context.resumes).toBe(1);
    // ONE shared context and ONE master gain, however often the gesture comes.
    engine.unlock();
    expect(created).toBe(1);
    expect(context.gains).toHaveLength(1);
  });

  it('hangs everything off one master gain into the destination', () => {
    const { context } = engineOn();
    const master = context.gains[0];
    expect(master?.gain.value).toBe(MASTER_GAIN);
    expect(master?.outputs).toEqual([context.destination]);
  });

  it('survives a browser without Web Audio at all', () => {
    const engine = new SfxEngine(false, () => null);
    engine.unlock();
    // Every entry point stays a no-op rather than throwing into the frame loop.
    for (const cue of SFX_CUES) engine.play(cue);
    engine.setEating(true);
    engine.setMuted(true);
    expect(engine.stats.contextState).toBe(null);
  });

  it('reports what it has done, for the E2E to see', () => {
    const { engine, context } = engineOn();
    expect(engine.stats.contextState).toBe('running');
    engine.play('spawn');
    engine.play('spawn');
    engine.setEating(true);
    expect(engine.stats.played.spawn).toBe(2);
    expect(engine.stats.played.fill).toBe(0);
    expect(engine.stats.eating).toBe(true);
    expect(engine.stats.muted).toBe(false);
    expect(context.nodeCount).toBeGreaterThan(1);
  });
});

describe('the five one-shots (spec §4.4: procedural, 0 asset bytes)', () => {
  it('gives every cue its own voice — a started, stopped, enveloped node', () => {
    for (const cue of SFX_CUES) {
      const { engine, context } = engineOn();
      const before = context.nodeCount;
      engine.play(cue);
      expect(context.nodeCount).toBeGreaterThan(before);
      // Every voice runs on a schedule (start AND stop): a one-shot that
      // forgets to stop is a node that plays forever.
      const voices = [...context.oscillators, ...context.sources].filter((v) => v.started !== null);
      expect(voices.length).toBeGreaterThan(0);
      for (const voice of voices) {
        expect(voice.stopped).not.toBe(null);
        expect(voice.stopped ?? 0).toBeGreaterThan(voice.started ?? 0);
      }
      // And through a gain envelope, so nothing clicks in or out.
      const envelopes = context.gains.slice(1);
      expect(envelopes.length).toBeGreaterThan(0);
      for (const envelope of envelopes) {
        expect(envelope.gain.calls.length).toBeGreaterThan(1);
        expect(envelope.outputs).toContain(context.gains[0]);
      }
    }
  });

  it('keeps the kill out of the ear’s alarm band, and fades its noise in', () => {
    // The first version of this voice was a wide noise burst at 1900 Hz with
    // the default 12 ms attack. 2–4 kHz is where hearing is most sensitive (it
    // is where alarms are designed to sit), so it read as tinny AND far louder
    // than its modest level, and the fast onset made it startle. Both
    // properties are guarded, because both are easy to reintroduce by "just"
    // retuning a number.
    const { engine, context } = engineOn();
    engine.play('kill');
    for (const filter of context.filters) {
      expect(filter.frequency.value).toBeLessThan(1000);
    }
    // Creation order in `play('kill')`: the noise knock's envelope is the first
    // gain after the master bus.
    const knock = context.gains[1];
    const opened = knock?.gain.calls.find(([method]) => method === 'set')?.[2] ?? 0;
    const peaked = knock?.gain.calls.find(([method]) => method === 'linear')?.[2] ?? 0;
    expect(peaked - opened).toBeGreaterThanOrEqual(0.02);
  });

  it('never stacks a cue past the bus, and keeps the reward the loudest', () => {
    const peaks = new Map<string, number>();
    for (const cue of SFX_CUES) {
      const { engine, context } = engineOn();
      engine.play(cue);
      const sum = context.gains
        .slice(1)
        .flatMap((gain) => gain.gain.calls.filter(([method]) => method === 'linear'))
        .reduce((total, [, value]) => total + value, 0);
      peaks.set(cue, sum);
      // Voices of one cue overlap by design — together they must still leave
      // the master bus headroom rather than clip it.
      expect(sum, cue).toBeLessThan(1);
    }
    const fill = peaks.get('fill') ?? 0;
    for (const [cue, peak] of peaks) {
      // The reward is the loudest thing in the game (spec §4.4: "die Belohnung,
      // das Herz"). A punishing cue that shouts over it makes the game feel
      // hostile — which is exactly what the kill did before it was retuned.
      expect(peak, cue).toBeLessThanOrEqual(fill);
    }
  });

  it('spends no nodes at all while muted', () => {
    const { engine, context } = engineOn(true);
    const before = context.nodeCount;
    for (const cue of SFX_CUES) engine.play(cue);
    expect(context.nodeCount).toBe(before);
    // Counted anyway: the cue happened, it was just not heard.
    expect(engine.stats.played.fill).toBe(1);
  });

  it('schedules against the context clock, not against zero', () => {
    const { engine, context } = engineOn();
    context.currentTime = 12.5;
    engine.play('kill');
    const voices = [...context.oscillators, ...context.sources];
    for (const voice of voices) expect(voice.started).toBeGreaterThanOrEqual(12.5);
  });
});

describe('the eat loop (spec §4.4: ONE persistent source, faded)', () => {
  it('builds its graph once and then only moves the fade', () => {
    const { engine, context } = engineOn();
    engine.setEating(true);
    const built = context.nodeCount;
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0]?.loop).toBe(true);
    expect(context.sources[0]?.started).not.toBe(null);
    const loopGain = context.gains.at(-1);
    const fades = loopGain?.gain.calls.length ?? 0;
    expect(fades).toBeGreaterThan(0);

    // Sixty frames of eating: not one new node (spec §4.4: no allocation per
    // tick), and no second fade either — the state did not change.
    for (let i = 0; i < 60; i++) engine.setEating(true);
    expect(context.nodeCount).toBe(built);
    expect(loopGain?.gain.calls.length).toBe(fades);

    // Off and on again reuses the same source; only the gain moves.
    engine.setEating(false);
    engine.setEating(true);
    expect(context.nodeCount).toBe(built);
    expect(context.sources).toHaveLength(1);
    expect(loopGain?.gain.calls.length).toBe(fades + 2);
    expect(context.sources[0]?.stopped).toBe(null);
  });

  it('fades out to silence, and to nothing louder than a whisper in', () => {
    const { engine, context } = engineOn();
    engine.setEating(true);
    const loopGain = context.gains.at(-1);
    const loud = loopGain?.gain.value ?? 0;
    expect(loud).toBeGreaterThan(0);
    // "leise" (spec §4.4): the loop is a background texture under the
    // one-shots, not a voice competing with them.
    expect(loud).toBeLessThan(MASTER_GAIN / 2);
    engine.setEating(false);
    expect(loopGain?.gain.value).toBe(0);
    // Faded, never switched: a hard cut on a running noise source clicks.
    expect(loopGain?.gain.calls.every(([method]) => method === 'target')).toBe(true);
  });

  it('is silent while muted, and picks up when the sound comes back', () => {
    const { engine, context } = engineOn(true);
    engine.setEating(true);
    // Muted: not even the loop graph is worth building yet.
    expect(context.sources).toHaveLength(0);
    engine.setMuted(false);
    expect(context.sources).toHaveLength(1);
    expect(context.gains.at(-1)?.gain.value).toBeGreaterThan(0);
    // And muting again while eating shuts the loop up.
    engine.setMuted(true);
    expect(context.gains.at(-1)?.gain.value).toBe(0);
  });

  it('goes quiet when the game is torn down', () => {
    const { engine, context } = engineOn();
    engine.setEating(true);
    engine.silence();
    expect(context.gains.at(-1)?.gain.value).toBe(0);
    expect(engine.stats.eating).toBe(false);
  });
});

describe('mute (spec §4.4: binary, the HUD toggle owns it)', () => {
  it('closes and reopens the master gain', () => {
    const { engine, context } = engineOn();
    const master = context.gains[0];
    engine.setMuted(true);
    expect(master?.gain.value).toBe(0);
    expect(engine.stats.muted).toBe(true);
    engine.setMuted(false);
    expect(master?.gain.value).toBe(MASTER_GAIN);
  });

  it('starts muted when the stored setting says so, before any context exists', () => {
    const context = new FakeContext();
    const engine = new SfxEngine(true, () => context);
    expect(engine.stats.muted).toBe(true);
    engine.unlock();
    expect(context.gains[0]?.gain.value).toBe(0);
  });
});
