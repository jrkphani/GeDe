#!/usr/bin/env node
// Usage: node packages/tokens/bin/check-literals.mjs <dir> [<dir>...]
// Scans .ts/.tsx/.css under each directory (relative to the repo root) for
// literal hex colours, px radii and ms durations. Exits 1 when any are found.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const built = resolve(here, '../dist/check-literals.js');
if (!existsSync(built)) {
  console.error('check-literals: build packages/tokens first (`npx tsc -b packages/tokens`).');
  process.exit(2);
}
const { scanDirectories, formatFindings } = await import(built);

const root = resolve(here, '../../..');
const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('check-literals: pass at least one directory, e.g. `apps packages/ui`.');
  process.exit(2);
}
const findings = scanDirectories(root, dirs);
if (findings.length > 0) {
  console.error(formatFindings(findings));
  console.error(
    `\ncheck-literals: ${findings.length} literal(s) found. Use tokens from packages/tokens.`,
  );
  process.exit(1);
}
console.error(`check-literals: clean (${dirs.join(', ')}).`);
