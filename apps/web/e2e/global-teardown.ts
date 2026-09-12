import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { AXE_DIR, type AxeRecord } from './fixtures/test.js';

/**
 * Fold every per-screen axe record into `test-results/axe/summary.json` and
 * print a one-line-per-screen table, so the CodeBuild log and the artifact
 * both say what was scanned and what was found (docs/TESTING.md explains how
 * to read it).
 */
export default function globalTeardown(): void {
  if (!existsSync(AXE_DIR)) return;
  const files = readdirSync(AXE_DIR).filter((f) => f.endsWith('.json') && f !== 'summary.json');
  const records = files.map((f) => {
    const record = JSON.parse(readFileSync(path.join(AXE_DIR, f), 'utf8')) as AxeRecord;
    return { file: f, ...record };
  });
  const count = (r: AxeRecord, impact: string) =>
    r.violations.filter((v) => v.impact === impact).length;
  const summary = {
    generatedAt: new Date().toISOString(),
    screens: records.length,
    totals: {
      critical: records.reduce((n, r) => n + count(r, 'critical'), 0),
      serious: records.reduce((n, r) => n + count(r, 'serious'), 0),
      moderate: records.reduce((n, r) => n + count(r, 'moderate'), 0),
      minor: records.reduce((n, r) => n + count(r, 'minor'), 0),
    },
    perScreen: records.map((r) => ({
      screen: r.screen,
      file: r.file,
      viewport: r.viewport,
      deviceScaleFactor: r.deviceScaleFactor,
      passes: r.passes,
      incomplete: r.incomplete,
      critical: count(r, 'critical'),
      serious: count(r, 'serious'),
      moderate: count(r, 'moderate'),
      minor: count(r, 'minor'),
      rules: r.violations.map((v) => v.id),
    })),
  };
  writeFileSync(path.join(AXE_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

  const lines = summary.perScreen.map(
    (s) =>
      `${s.screen.padEnd(44)} ${String(s.viewport?.width ?? '-').padStart(5)}px x${s.deviceScaleFactor}` +
      `  crit ${s.critical}  ser ${s.serious}  mod ${s.moderate}  min ${s.minor}  pass ${s.passes}`,
  );
  process.stdout.write(
    [
      '',
      `axe summary: ${summary.screens} screens, ` +
        `${summary.totals.critical} critical, ${summary.totals.serious} serious, ` +
        `${summary.totals.moderate} moderate, ${summary.totals.minor} minor`,
      ...lines,
      `full records: ${AXE_DIR}`,
      '',
    ].join('\n') + '\n',
  );
}
