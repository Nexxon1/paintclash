/**
 * Browser bootstrap: DOM, WebSocket and the fixed-timestep loop — all real
 * I/O lives here, the logic lives in `game/` (headless-tested) and the
 * rendering in `render/`. Exercised by the Playwright E2E.
 */

import { TICK_DT_MS } from '@paintclash/shared';

import { KeyTracker } from './game/input.js';
import { LocalRecords } from './game/records.js';
import { recordsText } from './game/score.js';
import { ClientSession } from './game/session.js';
import { LeaderboardHud, ScoreHud } from './render/hud.js';
import { ArenaScene } from './render/scene.js';

import type { RenderState } from './game/session.js';

declare global {
  interface Window {
    /** Debug/E2E hook: the running session, the pose actually drawn, and
     * the count of blocked non-finite poses (see ArenaScene.poseAnomalies). */
    __paintclash?: { session: ClientSession; lastRender?: RenderState; scene?: ArenaScene };
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
const status = query('#status', HTMLParagraphElement);
const canvas = query('#game', HTMLCanvasElement);
const leaderboard = new LeaderboardHud(query('#leaderboard', HTMLDivElement));
const scoreHud = new ScoreHud(query('#score', HTMLDivElement));
const recordsLine = query('#records', HTMLParagraphElement);

/**
 * Local records (spec §2.5, ADR-0006 seam 4) — read once at startup, so the
 * join card can already show them, and folded forward at every own death.
 */
const records = new LocalRecords();
function showRecords(): void {
  recordsLine.textContent = recordsText(records.records);
}
showRecords();

const keys = new KeyTracker();
window.addEventListener('keydown', (event) => {
  if (event.key.startsWith('Arrow')) event.preventDefault();
  keys.down(event.key);
});
window.addEventListener('keyup', (event) => {
  keys.up(event.key);
});

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
  window.__paintclash = { session };
  let stopped = false;

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
      session.advance(keys.turn(), ticks);
    }
  };
  const simTimer = setInterval(simStep, TICK_DT_MS / 2);

  stopCurrentGame = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(simTimer);
    window.removeEventListener('resize', onResize);
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
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  status.textContent = 'Verbinde …';
  start(nameInput.value.trim() || 'Gast');
});

// Only now is a click safe (no native submit/reload) — see index.html.
query('#join-form button', HTMLButtonElement).disabled = false;
