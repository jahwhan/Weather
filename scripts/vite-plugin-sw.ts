// Vite-Plugin: baut den Service Worker (src/pwa/sw.ts) nach dem App-Build als eigene Datei
// dist/sw.js und setzt die Vorab-Liste (alle Build-Dateien und public/) sowie eine
// Version (Hash über deren Inhalt) ein. Kein Workbox, nur Vite selbst.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { build, type Plugin, type ResolvedConfig } from 'vite';
import { precacheList } from '../src/pwa/rules.ts';

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const it of items) {
    const p = join(dir, it.name);
    if (it.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

export function serviceWorker(opts: { entry?: string; fileName?: string } = {}): Plugin {
  let config: ResolvedConfig;
  const fileName = opts.fileName ?? 'sw.js';
  return {
    name: 'wetterflug-sw',
    apply: 'build',
    enforce: 'post',
    configResolved(c) {
      config = c;
    },
    async writeBundle(output, bundle) {
      const outDir = output.dir ?? resolve(config.root, config.build.outDir);
      const publicFiles = config.publicDir ? (await walk(config.publicDir)).map((f) => relative(config.publicDir, f)) : [];
      const files = precacheList([...Object.keys(bundle), ...publicFiles].map((f) => f.split(sep).join('/')));
      // Version = Hash über Namen und Inhalt aller Vorab-Dateien
      const h = createHash('sha256');
      for (const f of files) {
        h.update(f);
        h.update(await readFile(join(outDir, f)));
      }
      const version = h.digest('hex').slice(0, 12);

      await build({
        configFile: false,
        root: config.root,
        publicDir: false,
        logLevel: 'warn',
        define: {
          __SW_VERSION__: JSON.stringify(version),
          __SW_PRECACHE__: JSON.stringify(files),
        },
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          target: 'es2020',
          minify: true,
          sourcemap: false,
          lib: {
            entry: resolve(config.root, opts.entry ?? 'src/pwa/sw.ts'),
            formats: ['iife'],
            name: 'wetterflugSw',
            fileName: () => fileName,
          },
        },
      });
      config.logger.info(`  Service Worker ${fileName}: Version ${version}, ${files.length} Dateien vorab`);
    },
  };
}
