/**
 * Browser bootstrap: DOM, WebSocket and the fixed-timestep loop — all real
 * I/O lives here, the logic lives in `game/` (headless-tested) and the
 * rendering in `render/`. Exercised by the Playwright E2E.
 */

import { TICK_DT_MS, sanitizeNickname } from '@paintclash/shared';

import { Steering, type PointerSample } from './game/input.js';
import { nicknameHint } from './game/nickname-hint.js';
import { LocalRecords } from './game/records.js';
import { recordsText } from './game/score.js';
import { ClientSession } from './game/session.js';
import { Settings } from './game/settings.js';
import { SfxCues } from './game/sfx-cues.js';
import { SfxEngine } from './game/sfx.js';
import { ControlsHud, JoystickHud, LeaderboardHud, ScoreHud, SoundHud } from './render/hud.js';
import { ArenaScene } from './render/scene.js';

import type { RenderState } from './game/session.js';

declare global {
  interface Window {
    /** Debug/E2E hook: the running session, the pose actually drawn, the
     * count of blocked non-finite poses (see ArenaScene.poseAnomalies) and the
     * SFX core (whose context state only a real browser can show). */
    __paintclash?: {
      session: ClientSession;
      lastRender?: RenderState;
      scene?: ArenaScene;
      sfx: SfxEngine;
    };
  }
}

function query<T extends HTMLElement>(selector: string, type: new () => T): T {
  const el = document.querySelector(selector);
  if (!(el instanceof type)) throw new Error(`missing element ${selector}`);
  return el;
}

const overlay = query('#overlay', HTMLDivElement);
const form = query('#join-form', HTMLFormElement);
const nameInput = query('#name', HTMLInputElement);
const nameHint = query('#name-hint', HTMLParagraphElement);
const status = query('#status', HTMLParagraphElement);
const canvas = query('#game', HTMLCanvasElement);
const leaderboard = new LeaderboardHud(query('#leaderboard', HTMLDivElement));
const scoreHud = new ScoreHud(query('#score', HTMLDivElement));
const recordsLine = query('#records', HTMLParagraphElement);
const joystickHud = new JoystickHud(query('#joystick', HTMLDivElement));

/**
 * Local records (spec §2.5, ADR-0006 seam 4) — read once at startup, so the
 * join card can already show them, and folded forward at every own death.
 */
const records = new LocalRecords();
function showRecords(): void {
  recordsLine.textContent = recordsText(records.records);
}
showRecords();

/**
 * Steering (spec §3): the persisted mode plus every device it reads. All of it
 * lives for the whole page — a mode switch, a held key or a resting cursor must
 * survive a reconnect, unlike the per-game listeners inside `start()`.
 */
const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
const settings = new Settings(coarsePointer);
const steering = new Steering(settings.controlMode);
const controlsHud = new ControlsHud(
  query('#controls', HTMLDivElement),
  settings.modes,
  coarsePointer,
  (mode) => {
    settings.controlMode = mode; // persisted right here (localStorage)
    steering.setMode(mode);
    controlsHud.update(mode);
  },
);
controlsHud.update(settings.controlMode);

/**
 * Sound (spec §4.4): the SFX core lives for the whole page, like the steering —
 * the shared `AudioContext` must survive a reconnect (a second one per game
 * would leak an audio thread each time), and the mute choice is a setting, not
 * a property of one game. The context itself is only built on the join click
 * below, which is the user gesture the autoplay policy wants.
 */
const sfx = new SfxEngine(settings.muted);
// No reference kept: the button paints its own state, and nothing else in the
// page has an opinion about how it looks.
new SoundHud(query('#controls', HTMLDivElement), settings.muted, (muted) => {
  settings.muted = muted; // persisted right here (localStorage)
  sfx.setMuted(muted);
});

const syncViewport = (): void => {
  steering.resize(window.innerWidth, window.innerHeight);
};
syncViewport();
window.addEventListener('resize', syncViewport);

window.addEventListener('keydown', (event) => {
  if (event.key.startsWith('Arrow')) event.preventDefault();
  steering.keyDown(event.key);
});
window.addEventListener('keyup', (event) => {
  steering.keyUp(event.key);
});

/** A DOM pointer event as the input layer wants it (no DOM below this line). */
function sampleOf(event: PointerEvent): PointerSample {
  return {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    // A mouse still rests somewhere after its button goes up; a finger does not.
    touch: event.pointerType !== 'mouse',
  };
}

// Presses come from the CANVAS — a tap on the HUD panels is UI, not steering —
// and the canvas captures the pointer, so a gesture that wanders onto a panel
// or off screen still belongs to the stick that started it. Moves and releases
// listen on the window: in follow mode the cursor must keep aiming while it
// passes over a panel, and a release anywhere has to let go.
canvas.addEventListener('pointerdown', (event) => {
  canvas.setPointerCapture(event.pointerId);
  steering.pointerDown(sampleOf(event));
});
window.addEventListener('pointermove', (event) => {
  steering.pointerMove(sampleOf(event));
});
for (const type of ['pointerup', 'pointercancel'] as const) {
  window.addEventListener(type, (event) => {
    steering.pointerUp(sampleOf(event));
  });
}

/** Tears down the previous game (loop, timer, socket, listeners). */
let stopCurrentGame: (() => void) | null = null;

function start(name: string): void {
  // Without a full teardown, a re-submit after a disconnect would stack a
  // second live game onto the same canvas: two render loops fighting, a
  // dead session still consuming keys and clobbering the debug hook.
  stopCurrentGame?.();

  const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  const session = new ClientSession((frame) => {
    ws.send(frame);
  }, name);
  window.__paintclash = { session, sfx };
  let stopped = false;
  // The cue rules are per GAME (the join cue, the own rank, the pending
  // respawn) while the engine is per page — a reconnect starts a new life and
  // must greet it, but must not build a second audio context.
  const sfxCues = new SfxCues();

  ws.addEventListener('open', () => {
    session.join();
  });
  ws.addEventListener('message', (event: MessageEvent<ArrayBuffer | string>) => {
    if (typeof event.data !== 'string') session.receive(event.data);
  });
  ws.addEventListener('close', () => {
    stopCurrentGame?.();
    status.textContent = 'Verbindung getrennt — erneut auf Spielen klicken.';
    // A life that ends by disconnect never gets a `final` frame, but it was
    // still played: commit it, or a long survival would only ever count if it
    // ended in a death (spec §2.5 lists max-% and survival as records).
    const unfinished = session.currentLife();
    if (unfinished) records.commit(unfinished);
    // The card is visible again — with whatever the session just achieved.
    showRecords();
    overlay.style.display = 'grid';
  });

  const scene = new ArenaScene(canvas);
  window.__paintclash.scene = scene;
  const onResize = (): void => {
    scene.resize();
  };
  window.addEventListener('resize', onResize);

  // The simulation is deliberately DECOUPLED from requestAnimationFrame:
  // browsers throttle rAF under GPU contention (two game windows), occlusion
  // or backgrounding — if inputs stopped with it, the server would move on
  // without us and every wake-up would be a divergence (fast-forward feel,
  // kicks after the idle timeout). A timer keeps the fixed-timestep loop and
  // input flow alive; even hidden tabs still fire ~1/s, which beats the
  // server's 10 s idle timeout. rAF is pure rendering.
  let lastSim = performance.now();
  let accumulator = 0;
  let lastTickAt = performance.now();
  let tickInterval = TICK_DT_MS;
  const simStep = (): void => {
    const now = performance.now();
    // The interval is servo-shifted to the server's REAL tick rate — the
    // tick-mapped input timeline (seq ≡ tick) depends on matching it.
    tickInterval = session.simIntervalMs();
    // Clamp long gaps instead of fast-forwarding hundreds of ticks.
    accumulator = Math.min(accumulator + (now - lastSim), 10 * tickInterval);
    lastSim = now;
    const ticks = Math.floor(accumulator / tickInterval);
    if (ticks > 0) {
      accumulator -= ticks * tickInterval;
      lastTickAt = now - accumulator;
      // Bursts (post-stall catch-up) glide instead of leaping on screen.
      // Whatever the mode, what reaches the wire is only a steer intent
      // (spec §3/§6.4) — the aiming modes need the head's heading to pick
      // the shorter way there.
      session.advance(steering.turn(session.headHeading()), ticks);
    }
  };
  const simTimer = setInterval(simStep, TICK_DT_MS / 2);

  stopCurrentGame = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(simTimer);
    window.removeEventListener('resize', onResize);
    // The stick is drawn from the render loop that is dying with this game — a
    // finger still down would leave the ring frozen over the join card.
    joystickHud.update(null);
    // Same for the "eat" loop: the frame loop that would fade it out is gone,
    // so a player who died mid-bite would hear it chew over the join card.
    sfx.silence();
    scene.dispose();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  };

  let lastFrame = performance.now();
  let hidden = false;
  const frame = (now: number): void => {
    if (stopped) return; // torn down — let this loop die
    const frameDtMs = now - lastFrame;
    lastFrame = now;
    // Decay yesterday's correction offsets BEFORE folding new ones in.
    session.frame(frameDtMs);
    simStep(); // freshest possible tick right before rendering
    if (session.ready() && !hidden) {
      hidden = true;
      overlay.style.display = 'none';
    }
    const alpha = Math.min((performance.now() - lastTickAt) / tickInterval, 1);
    const renderState = session.renderSample(alpha, frameDtMs);
    if (window.__paintclash) window.__paintclash.lastRender = renderState;
    scene.update(renderState);
    leaderboard.update(renderState.leaderboard, renderState.selfId);
    // A closed life lands exactly once (the sample drains it) — fold it into
    // the local records BEFORE painting, so a new record shows immediately.
    if (renderState.finishedLife) records.commit(renderState.finishedLife);
    scoreHud.update(renderState.liveScore, records.records);
    joystickHud.update(steering.joystickView());
    // Sound reads the very frame that was just drawn (spec §4.4: additive to
    // the visuals, never a channel of its own) — after the scene, so a cue can
    // never be heard before the thing it comments on is on screen.
    const audio = sfxCues.sample(renderState, frameDtMs);
    for (const cue of audio.cues) sfx.play(cue);
    sfx.setEating(audio.eating);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/**
 * The nickname pre-check (spec §2.8, ticket 13) — UX only: the server runs the
 * same rule and has the last word. Shown live so a player learns about a
 * refusal or a filtered character while the field still has focus.
 */
function showNameHint(): void {
  const hint = nicknameHint(nameInput.value);
  nameHint.textContent = hint.text ?? '';
  nameHint.classList.toggle('blocked', hint.blocked);
}
nameInput.addEventListener('input', showNameHint);

form.addEventListener('submit', (event) => {
  event.preventDefault();
  status.textContent = 'Verbinde …';
  // Inside the gesture that started the game: the autoplay policy only lets a
  // context start here (spec §4.4 — no separate "enable sound" prompt). Before
  // the socket, so a slow connect cannot cost us the activation.
  sfx.unlock();
  // Sanitized, not judged: filtering saves the wire from cutting a name by code
  // point (which could split a character), while a name the blocklist refuses
  // is sent as-is and REPLACED BY THE SERVER — the hint above already said so.
  // Refusing the join here instead would make the client the authority on a
  // rule it only pre-checks (ticket 13: "Server erzwingt"), and would cost a
  // player their game over a cosmetic string. An empty name stays empty: only
  // the server can number the guest (`Gast-####`).
  start(sanitizeNickname(nameInput.value));
});

// Only now is a click safe (no native submit/reload) — see index.html.
query('#join-form button', HTMLButtonElement).disabled = false;
