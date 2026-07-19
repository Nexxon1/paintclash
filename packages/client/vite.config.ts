import { defineConfig } from 'vite';

/**
 * Client build: static bundle served by the Worker's assets binding
 * (`packages/server/wrangler.jsonc` points at `../client/dist`).
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
