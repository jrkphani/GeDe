#!/usr/bin/env node
// Usage: npm run generate -w packages/mail
// Writes src/generated/palette.ts from packages/tokens/src/tokens.css.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { derivePalette, renderPaletteModule } from './palette-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tokensCss = resolve(here, '../../tokens/src/tokens.css');
const out = resolve(here, '../src/generated/palette.ts');

writeFileSync(out, renderPaletteModule(derivePalette(readFileSync(tokensCss, 'utf8'))));
console.error(`wrote ${out}`);
