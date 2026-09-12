#!/usr/bin/env node
/**
 * Requirement traceability report.
 *
 * Run with:  node scripts/traceability.mjs
 * (root package.json exposes it as `npm run traceability`)
 *
 * 1. Reads every `**XXX-nn**` id from docs/REQUIREMENTS.md. Ids are `AREA-nn` (two or three
 *    digits, e.g. `GRID-03`, `ONB-14`) or `AREA-Ln` with a letter sub-area and one to three
 *    digits, exactly as the PRD spells them (`LIB-D1`, `LIB-D11`). The area of `LIB-D1` is `LIB-D`.
 * 2. Scans apps/, packages/ and services/ for *.test.ts, *.test.tsx and *.spec.ts files
 *    (node_modules, dist, cdk.out and coverage are skipped).
 * 3. Collects the ids that appear in it( / test( / describe( names. An id followed by a
 *    parenthesised qualifier such as `AUTH-08 (button only)` or `X-01 (partial)` is a
 *    declared partial and is NOT counted — the requirement stays uncovered until a test
 *    without the qualifier exists.
 * 4. Writes docs/TRACEABILITY.md: one row per requirement with the tests that name it,
 *    plus a per-area summary. Exit code is 0 either way; the report is informative.
 *
 * The output is formatted the way prettier formats markdown tables (aligned columns),
 * so `npm run format:check` stays green without a prettier run.
 *
 * No dependencies beyond Node 22.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requirementsPath = join(root, 'docs', 'REQUIREMENTS.md');
const outputPath = join(root, 'docs', 'TRACEABILITY.md');
const scanRoots = ['apps', 'packages', 'services'];
const skipDirs = new Set(['node_modules', 'dist', 'cdk.out', 'coverage', '.vite', 'test-results']);
const testFilePattern = /\.(test\.tsx?|spec\.ts)$/;
// `AUTH-01`, `GRID-11`, `ONB-14` (two or three digits) or `LIB-D1`, `LIB-D11` (letter sub-area,
// one to three digits — the PRD does not zero-pad these).
const idPattern = /\b([A-Z][A-Z0-9]{1,5})-([A-Z]\d{1,3}|\d{2,3})\b/g;
// Area of an id: `AUTH-01` → `AUTH`, `LIB-D1` → `LIB-D`.
const areaOf = (id) => id.replace(/-?\d+$/, '');
const partialQualifier = /^\s*\((?:partial|button only)\b[^)]*\)/;
const testNamePattern =
  /\b(?:it|test|describe)(?:\.(?:only|skip|todo|concurrent|sequential|each))?\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

// ---------------------------------------------------------------------------
// 1. Requirements

function readRequirements() {
  const text = readFileSync(requirementsPath, 'utf8');
  const requirements = [];
  const areaOrder = [];
  const linePattern = /^- \*\*([A-Z][A-Z0-9]*-[A-Z]?\d+)\*\*\s+[—-]\s+(.*)$/;
  for (const line of text.split('\n')) {
    const match = linePattern.exec(line);
    if (!match) continue;
    const [, id, description] = match;
    const area = areaOf(id);
    if (!areaOrder.includes(area)) areaOrder.push(area);
    requirements.push({ id, area, description: description.trim() });
  }
  return { requirements, areaOrder };
}

// ---------------------------------------------------------------------------
// 2. Test files

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (skipDirs.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, out);
    else if (stats.isFile() && testFilePattern.test(entry)) out.push(full);
  }
  return out;
}

function findTestFiles() {
  const files = [];
  for (const scanRoot of scanRoots) walk(join(root, scanRoot), files);
  return files.sort();
}

// ---------------------------------------------------------------------------
// 3. Ids in test names

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function collectTestReferences(files) {
  /** @type {Map<string, {file: string, line: number}[]>} */
  const references = new Map();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const rel = relative(root, file);
    for (const match of text.matchAll(testNamePattern)) {
      const name = match[2];
      const line = lineNumberAt(text, match.index);
      for (const idMatch of name.matchAll(idPattern)) {
        if (partialQualifier.test(name.slice(idMatch.index + idMatch[0].length))) continue;
        const id = `${idMatch[1]}-${idMatch[2]}`;
        if (!references.has(id)) references.set(id, []);
        const list = references.get(id);
        if (!list.some((r) => r.file === rel && r.line === line)) list.push({ file: rel, line });
      }
    }
  }
  return references;
}

// ---------------------------------------------------------------------------
// 4. Markdown output, aligned the way prettier aligns tables

function stringWidth(text) {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) continue; // control
    if (code >= 0x300 && code <= 0x36f) continue; // combining marks
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f900 && code <= 0x1f9ff) ||
      (code >= 0x20000 && code <= 0x3fffd)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function escapeCell(text) {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function truncate(text, max) {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max).join('').trimEnd()}…`;
}

function renderTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(3, stringWidth(h), ...rows.map((r) => stringWidth(r[i]))),
  );
  const pad = (cell, i) => cell + ' '.repeat(widths[i] - stringWidth(cell));
  const line = (cells) => `| ${cells.map(pad).join(' | ')} |`;
  const delimiter = `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`;
  return [line(headers), delimiter, ...rows.map(line)].join('\n');
}

function buildReport({ requirements, areaOrder }, references, testFiles) {
  const known = new Set(requirements.map((r) => r.id));
  const rows = requirements.map((req) => {
    const refs = references.get(req.id) ?? [];
    const tests = refs.length ? refs.map((r) => `\`${r.file}:${r.line}\``).join(', ') : '—';
    return [
      req.id,
      escapeCell(truncate(req.description, 80)),
      tests,
      refs.length ? 'covered' : 'uncovered',
    ];
  });

  const summaryRows = areaOrder.map((area) => {
    const inArea = requirements.filter((r) => r.area === area);
    const covered = inArea.filter((r) => (references.get(r.id) ?? []).length > 0).length;
    return [area, String(inArea.length), String(covered), String(inArea.length - covered)];
  });
  const total = requirements.length;
  const totalCovered = requirements.filter((r) => (references.get(r.id) ?? []).length > 0).length;
  summaryRows.push([
    '**Total**',
    String(total),
    String(totalCovered),
    String(total - totalCovered),
  ]);

  const unknown = [...references.keys()].filter((id) => !known.has(id)).sort();
  const unknownRows = unknown.map((id) => [
    id,
    references
      .get(id)
      .map((r) => `\`${r.file}:${r.line}\``)
      .join(', '),
  ]);

  const percent = total ? Math.round((totalCovered / total) * 100) : 0;
  const lines = [
    '# Requirement traceability',
    '',
    'Generated by `node scripts/traceability.mjs`. Do not edit by hand; edit the tests.',
    '',
    `Source: \`docs/REQUIREMENTS.md\` (${total} requirements). Tests scanned: ${testFiles.length} files under \`apps/\`, \`packages/\`, \`services/\`. A requirement is covered when its id appears in an \`it\`, \`test\` or \`describe\` name.`,
    '',
    `Coverage: ${totalCovered} of ${total} (${percent} %).`,
    '',
    '## Summary by area',
    '',
    renderTable(['Area', 'Requirements', 'Covered', 'Uncovered'], summaryRows),
    '',
    '## Requirements',
    '',
    renderTable(['ID', 'Requirement', 'Tests (file:line)', 'Status'], rows),
    '',
  ];
  if (unknownRows.length) {
    lines.push(
      '## Ids in tests that are not in REQUIREMENTS.md',
      '',
      'Either a typo in the test name or a requirement that was never numbered. Fix one or the other.',
      '',
      renderTable(['ID', 'Tests (file:line)'], unknownRows),
      '',
    );
  }
  return { markdown: lines.join('\n'), total, totalCovered, percent, unknown: unknown.length };
}

// ---------------------------------------------------------------------------

const requirements = readRequirements();
const testFiles = findTestFiles();
const references = collectTestReferences(testFiles);
const report = buildReport(requirements, references, testFiles);
writeFileSync(outputPath, report.markdown);

process.stdout.write(
  `traceability: ${report.totalCovered}/${report.total} requirements covered (${report.percent} %), ` +
    `${testFiles.length} test files scanned, ${report.unknown} unknown ids → ${relative(root, outputPath)}\n`,
);
