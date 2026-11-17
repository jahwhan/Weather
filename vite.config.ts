import { defineConfig } from 'vite';
import { serviceWorker } from './scripts/vite-plugin-sw';

export default defineConfig({
  // relative Pfade, damit dist/ auf jedem statischen Host (auch in Unterordnern) läuft
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1600,
  },
  server: { host: true },
  // PWA: Service Worker als eigener Einstieg nach dist/sw.js
  plugins: [serviceWorker()],
});
