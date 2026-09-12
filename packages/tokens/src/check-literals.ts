/**
 * Literal-token check: fails on hex colours, `px` radii and `ms` durations in
 * component source. The only place those may be written is `packages/tokens`.
 *
 * A line may opt out with the marker `literal-ok` in a trailing comment; the
 * marker is meant for the two or three places (favicon, theme-color meta) that
 * genuinely cannot reference a custom property.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

export type LiteralKind = 'hex-colour' | 'px-radius' | 'ms-duration';

export interface Finding {
  file: string;
  line: number;
  kind: LiteralKind;
  text: string;
}

export const SCANNED_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.css'];
export const EXCLUDED_DIRS: readonly string[] = ['node_modules', 'dist', 'packages/tokens'];
export const IGNORE_MARKER = 'literal-ok';

const HEX = /#[0-9a-f]{3,8}\b/gi;
const PX_RADIUS = /border-radius\s*:[^;{}]*?\b\d+(?:\.\d+)?px/gi;
const MS_DURATION = /\b\d+(?:\.\d+)?ms\b/g;

/** Replace comment bodies with spaces so line numbers survive. */
export function stripComments(source: string, ext: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ');
  let out = source.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (ext !== '.css') {
    // Line comments; a `//` that follows `:` (as in `https://`) is a URL, not a comment.
    out = out.replace(
      /(^|[^:\\])\/\/[^\n]*/g,
      (m, lead: string) => lead + blank(m.slice(lead.length)),
    );
  }
  return out;
}

export function scanSource(source: string, ext: string, file = '<memory>'): Finding[] {
  const findings: Finding[] = [];
  const lines = stripComments(source, ext).split('\n');
  const rawLines = source.split('\n');
  const patterns: [LiteralKind, RegExp][] = [
    ['hex-colour', HEX],
    ['px-radius', PX_RADIUS],
    ['ms-duration', MS_DURATION],
  ];
  lines.forEach((line, i) => {
    if (rawLines[i]?.includes(IGNORE_MARKER)) return;
    for (const [kind, re] of patterns) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        findings.push({ file, line: i + 1, kind, text: m[0] });
      }
    }
  });
  return findings;
}

export function isTestFile(file: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

function isExcludedDir(root: string, dir: string): boolean {
  const rel = relative(root, dir).split(sep).join('/');
  return EXCLUDED_DIRS.some(
    (ex) => rel === ex || rel.endsWith(`/${ex}`) || rel.startsWith(`${ex}/`),
  );
}

/** Recursively list scannable files under `dir` (paths relative to `root`). */
export function listFiles(root: string, dir: string = root): string[] {
  if (isExcludedDir(root, dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDED_DIRS.includes(entry)) continue;
      out.push(...listFiles(root, full));
    } else if (SCANNED_EXTENSIONS.includes(extname(entry)) && !isTestFile(entry)) {
      out.push(full);
    }
  }
  return out;
}

export function scanDirectories(root: string, dirs: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  for (const d of dirs) {
    for (const file of listFiles(root, join(root, d))) {
      findings.push(...scanSource(readFileSync(file, 'utf8'), extname(file), relative(root, file)));
    }
  }
  return findings;
}

export function formatFindings(findings: readonly Finding[]): string {
  return findings.map((f) => `${f.file}:${f.line}  ${f.kind}  ${f.text}`).join('\n');
}
