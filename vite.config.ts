import { defineConfig } from 'vite';

export default defineConfig({
  // relative Pfade, damit dist/ auf jedem statischen Host (auch in Unterordnern) läuft
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1600,
  },
  server: { host: true },
});
