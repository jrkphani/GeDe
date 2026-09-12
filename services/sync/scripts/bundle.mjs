// Bundles the sync service into a single ESM file for the container image and
// copies the SQL migrations next to it, so the runtime stage needs no
// node_modules at all. Run after `tsc -b` (the workspace packages resolve to
// their built `dist`).
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
// `||`, not `??`: the Dockerfile exports GEDE_VERSION as an empty string when the build arg is unset.
const version = process.env.GEDE_VERSION || pkg.version;

const outDir = resolve(root, 'dist');
const migrationsSrc = resolve(root, '../../packages/db/migrations');
const migrationsOut = resolve(outDir, 'migrations');

await build({
  entryPoints: [resolve(root, 'src/main.ts')],
  outfile: resolve(outDir, 'main.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
  // Optional native accelerators. Each is loaded inside a try/catch by its
  // package and is not installed here; leaving them external keeps esbuild
  // from failing on the unresolved require.
  external: ['pg-native', 'bufferutil', 'utf-8-validate'],
  define: {
    __GEDE_BUILD_VERSION__: JSON.stringify(version),
  },
  banner: {
    // CJS dependencies (pg, fastify internals) use `require`, `__dirname`
    // and `__filename`; give the ESM bundle equivalents.
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __pathDirname(__filename);',
    ].join('\n'),
  },
});

rmSync(migrationsOut, { recursive: true, force: true });
mkdirSync(migrationsOut, { recursive: true });
cpSync(migrationsSrc, migrationsOut, {
  recursive: true,
  filter: (src) => src === migrationsSrc || src.endsWith('.sql'),
});

console.error(`bundled services/sync ${version} → dist/main.js (+ dist/migrations)`);
