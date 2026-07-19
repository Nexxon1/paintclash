/**
 * Browser bootstrap: DOM, WebSocket and the fixed-timestep loop — all real
 * I/O lives here, the logic lives in `game/` (headless-tested) and the
 * rendering in `render/`. Exercised by the Playwright E2E.
 */

import { TICK_DT_MS } from '@paintclash/shared';

import { KeyTracker } from './game/input.js';
import { ClientSession } from './game/session.js';
import { ArenaScene } from './render/scene.js';

declare global {
  interface Window {
    /** Debug/E2E hook: read-only view into the running session. */
    __paintclash?: { session: ClientSession };
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
  window.addEventListener('resize', () => {
    scene.resize();
  });

  let last = performance.now();
  let accumulator = 0;
  let hidden = false;
  const frame = (now: number): void => {
    // Clamp long tab-away gaps instead of fast-forwarding hundreds of ticks.
    accumulator = Math.min(accumulator + (now - last), 10 * TICK_DT_MS);
    last = now;
    while (accumulator >= TICK_DT_MS) {
      session.simTick(keys.turn());
      accumulator -= TICK_DT_MS;
    }
    if (session.ready() && !hidden) {
      hidden = true;
      overlay.style.display = 'none';
    }
    scene.update(session.renderSample(accumulator / TICK_DT_MS));
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  status.textContent = 'Verbinde …';
  start(nameInput.value.trim() || 'Gast');
});
