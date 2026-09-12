#!/usr/bin/env node
/**
 * Brand asset generator (DESIGN-SYSTEM-DIGEST §3 "Asset files"). Dev-only;
 * the outputs are committed under `apps/web/public/` and served as static files.
 *
 *   npx --yes --package=@resvg/resvg-js node apps/web/scripts/brand-assets.mjs
 *
 * Renders the brand mark — the same geometry as `packages/ui` BrandMark — into:
 *   favicon.ico              16 / 32 / 48 (PNG-compressed ICO)
 *   icon-192.png             launcher icon, forest tile, rounded
 *   icon-512.png             same at 512
 *   icon-maskable-512.png    full-bleed forest, mark inside the maskable safe zone
 *   apple-touch-icon.png     180, opaque forest, 20 % padding
 *   safari-pinned-tab.svg    monochrome mask; Safari tints it with the link colour
 *   og-card.png              1200 × 630 link preview on the forest field
 *
 * Colours are read from packages/tokens/src/tokens.css — nothing is hard-coded here.
 * The renderer is @resvg/resvg-js (a prebuilt binary); it is not a dependency of
 * the app, so it is resolved from the `npx --package` install when not installed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const repoRoot = path.resolve(webRoot, '../..');
const outDir = path.join(webRoot, 'public');

// ---------------------------------------------------------------------------
// Tokens

const tokensCss = readFileSync(path.join(repoRoot, 'packages/tokens/src/tokens.css'), 'utf8');
function token(name) {
  const m = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(tokensCss);
  if (!m) throw new Error(`tokens.css has no hex value for ${name}`);
  return m[1];
}
const forest700 = token('--forest-700');
const forest100 = token('--forest-100');
const white = token('--slate-0');

// ---------------------------------------------------------------------------
// Geometry (packages/ui/src/components/BrandMark.tsx, verbatim rules)

/** The mark on its 40 × 40 viewBox at a given rendered size, in `color`. */
function markSvgInner(renderedPx, color) {
  const tiny = renderedPx < 20;
  const showLines = renderedPx >= 32;
  return [
    `<rect x="2" y="2" width="36" height="36" rx="${tiny ? 3 : 4}" fill="none" stroke="${color}" stroke-width="${tiny ? 3 : 2.5}"/>`,
    showLines
      ? `<path d="M2 13h36M13 2v36" fill="none" stroke="${color}" stroke-width="1.4" opacity="0.55"/>`
      : '',
    `<circle cx="${tiny ? 25 : 26}" cy="${tiny ? 25 : 26}" r="${tiny ? 7 : 5}" fill="${color}"/>`,
  ].join('');
}

/** A standalone mark, `size` px square, transparent background. */
function markSvg(size, color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 40 40">${markSvgInner(size, color)}</svg>`;
}

/**
 * A tile: `size` px square of `bg` with the mark centred at `markFraction` of
 * the tile, corners rounded by `radiusFraction` (0 for full-bleed).
 */
function tileSvg(size, { bg, fg, markFraction, radiusFraction }) {
  const mark = size * markFraction;
  const offset = (size - mark) / 2;
  const scale = mark / 40;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" rx="${size * radiusFraction}" fill="${bg}"/>` +
    `<g transform="translate(${offset} ${offset}) scale(${scale})">${markSvgInner(mark, fg)}</g>` +
    `</svg>`
  );
}

/** 1200 × 630 link preview: the forest field, the lockup, the two-line headline. */
function ogCardSvg() {
  const w = 1200;
  const h = 630;
  const markSize = 96;
  const font = `'Helvetica Neue', Helvetica, Arial, sans-serif`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="${forest700}"/>` +
    // Ring motif from the sign-in field (option 1c), faint, off to the right.
    `<g fill="none" stroke="${white}" stroke-width="2" opacity="0.14" transform="translate(940 330)">` +
    `<circle r="200"/><circle r="130"/>` +
    `<path d="M0 0L0 -200M0 0L173 100M0 0L-173 100"/>` +
    `<circle cx="0" cy="-200" r="9" fill="${white}"/><circle cx="173" cy="100" r="9" fill="${white}"/><circle cx="-173" cy="100" r="9" fill="${white}"/>` +
    `</g>` +
    `<g transform="translate(96 96) scale(${markSize / 40})">${markSvgInner(markSize, white)}</g>` +
    `<text x="216" y="168" font-family="${font}" font-weight="600" font-size="72" letter-spacing="-2.5" fill="${white}">GeDe</text>` +
    `<text x="96" y="372" font-family="${font}" font-weight="600" font-size="64" letter-spacing="-2.5" fill="${white}">Text is the data.</text>` +
    `<text x="96" y="448" font-family="${font}" font-weight="600" font-size="64" letter-spacing="-2.5" fill="${white}">The canvas is the grid.</text>` +
    `<text x="96" y="530" font-family="${font}" font-weight="400" font-size="28" fill="${forest100}">Tables, formulas and context graphs on one shared sheet.</text>` +
    `</svg>`
  );
}

// ---------------------------------------------------------------------------
// ICO container: PNG frames are valid ICO entries (Vista and later, every browser).

function ico(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(frames.length, 4);
  const dir = Buffer.alloc(16 * frames.length);
  let offset = header.length + dir.length;
  frames.forEach(({ size, png }, i) => {
    const at = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, at);
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1);
    dir.writeUInt8(0, at + 2); // palette
    dir.writeUInt8(0, at + 3); // reserved
    dir.writeUInt16LE(1, at + 4); // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...frames.map((f) => f.png)]);
}

// ---------------------------------------------------------------------------
// Renderer

async function loadResvg() {
  try {
    return await import('@resvg/resvg-js');
  } catch {
    // `npx --package` puts the package's bin dir first on PATH; its node_modules sits beside.
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      const candidate = path.join(dir, '..', '@resvg', 'resvg-js', 'index.js');
      if (existsSync(candidate)) return import(pathToFileURL(candidate).href);
    }
    throw new Error(
      'Cannot find @resvg/resvg-js. Run: npx --yes --package=@resvg/resvg-js node apps/web/scripts/brand-assets.mjs',
    );
  }
}

const { Resvg } = await loadResvg();

function png(svg, width) {
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { loadSystemFonts: true },
  });
  return Buffer.from(r.render().asPng());
}

// ---------------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });
const write = (name, data) => {
  writeFileSync(path.join(outDir, name), data);
  console.error(`brand-assets: wrote public/${name} (${data.length} bytes)`);
};

const tile = { bg: forest700, fg: white };
// "any" launcher icons: a rounded forest tile with the mark at 60 %.
write('icon-192.png', png(tileSvg(192, { ...tile, markFraction: 0.6, radiusFraction: 0.2 }), 192));
write('icon-512.png', png(tileSvg(512, { ...tile, markFraction: 0.6, radiusFraction: 0.2 }), 512));
// Maskable: full-bleed; the mark stays inside the central safe-zone circle (r = 40 %).
write(
  'icon-maskable-512.png',
  png(tileSvg(512, { ...tile, markFraction: 0.5, radiusFraction: 0 }), 512),
);
// iOS home screen: opaque, 20 % padding, iOS rounds the corners itself.
write(
  'apple-touch-icon.png',
  png(tileSvg(180, { ...tile, markFraction: 0.6, radiusFraction: 0 }), 180),
);
// Legacy tab icon: the mark in forest on transparent, favicon rules at 16.
write(
  'favicon.ico',
  ico([16, 32, 48].map((size) => ({ size, png: png(markSvg(size, forest700), size) }))),
);
// Safari pinned tab: monochrome black, Safari applies the `color` from the <link>.
write('safari-pinned-tab.svg', `${markSvg(16, '#000000')}\n`);
write('og-card.png', png(ogCardSvg(), 1200));
