/**
 * Browser bootstrap: DOM, WebSocket and the fixed-timestep loop — all real
 * I/O lives here, the logic lives in `game/` (headless-tested) and the
 * rendering in `render/`. Exercised by the Playwright E2E.
 */

import { TICK_DT_MS } from '@paintclash/shared';

import { KeyTracker } from './game/input.js';
import { ClientSession } from './game/session.js';
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

const keys = new KeyTracker();
window.addEventListener('keydown', (event) => {
  if (event.key.startsWith('Arrow')) event.preventDefault();
  keys.down(event.key);
});
window.addEventListener('keyup', (event) => {
  keys.up(event.key);
});

function start(name: string): void {
  const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  const session = new ClientSession((frame) => {
    ws.send(frame);
  }, name);
  window.__paintclash = { session };

  ws.addEventListener('open', () => {
    session.join();
  });
  ws.addEventListener('message', (event: MessageEvent<ArrayBuffer | string>) => {
    if (typeof event.data !== 'string') session.receive(event.data);
  });
  ws.addEventListener('close', () => {
    status.textContent = 'Verbindung getrennt — neu laden zum Wiederverbinden.';
    overlay.style.display = 'grid';
  });

  const scene = new ArenaScene(canvas);
  window.__paintclash.scene = scene;
  window.addEventListener('resize', () => {
    scene.resize();
  });

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
  const simStep = (): void => {
    const now = performance.now();
    // Clamp long gaps instead of fast-forwarding hundreds of ticks.
    accumulator = Math.min(accumulator + (now - lastSim), 10 * TICK_DT_MS);
    lastSim = now;
    const ticks = Math.floor(accumulator / TICK_DT_MS);
    if (ticks > 0) {
      accumulator -= ticks * TICK_DT_MS;
      lastTickAt = now - accumulator;
      // Bursts (post-stall catch-up) glide instead of leaping on screen.
      session.advance(keys.turn(), ticks);
    }
  };
  const simTimer = setInterval(simStep, TICK_DT_MS / 2);
  ws.addEventListener('close', () => {
    clearInterval(simTimer);
  });

  let lastFrame = performance.now();
  let hidden = false;
  const frame = (now: number): void => {
    const frameDtMs = now - lastFrame;
    lastFrame = now;
    // Decay yesterday's correction offsets BEFORE folding new ones in.
    session.frame(frameDtMs);
    simStep(); // freshest possible tick right before rendering
    if (session.ready() && !hidden) {
      hidden = true;
      overlay.style.display = 'none';
    }
    const alpha = Math.min((performance.now() - lastTickAt) / TICK_DT_MS, 1);
    const renderState = session.renderSample(alpha, frameDtMs);
    if (window.__paintclash) window.__paintclash.lastRender = renderState;
    scene.update(renderState);
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
