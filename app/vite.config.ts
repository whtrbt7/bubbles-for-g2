import { defineConfig } from 'vite';

// Relative base so assets resolve when loaded from a packed .ehpk.
export default defineConfig({
  base: './',
  server: { host: true, port: 5173, strictPort: true },
  build: { target: 'es2022' },
});
