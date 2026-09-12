import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig, type Plugin } from 'vite';
import appConfig from '../vite.config.js';

/**
 * E2E build of the web app. Identical to the production build except:
 *
 * 1. Output goes to `e2e/dist/`, never `dist/` — the pipeline deploys `dist/`.
 * 2. `/config.json` is emitted from `e2e/fixtures/config.json` (the public
 *    production client ids) instead of relying on `public/config.json`, so the
 *    fixture never lands in the deployable bundle.
 * 3. A second HTML entry, `e2e/harness/`, mounts the real `ErrorCell` for a
 *    status chosen in the query string. Without a backend the router only ever
 *    throws a 404, so the other seven catalogue pages have no reachable route.
 */
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function e2eRuntimeConfig(): Plugin {
  return {
    name: 'gede-e2e-runtime-config',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'config.json',
        source: readFileSync(path.join(webRoot, 'e2e/fixtures/config.json'), 'utf8'),
      });
    },
  };
}

export default mergeConfig(
  appConfig,
  defineConfig({
    root: webRoot,
    plugins: [e2eRuntimeConfig()],
    build: {
      outDir: 'e2e/dist',
      sourcemap: false,
      rollupOptions: {
        input: {
          index: path.join(webRoot, 'index.html'),
          harness: path.join(webRoot, 'e2e/harness/index.html'),
          richtext: path.join(webRoot, 'e2e/harness/richtext/index.html'),
        },
      },
    },
  }),
);
