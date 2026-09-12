/**
 * Smart Chips (PRD §5, §20): pre-validated patterns for the corporate data
 * types a derived column extracts — Email, Date, Currency, Company, Country,
 * Parenthetical, After dash, Before dash. Each is written in the subset of
 * syntax RE2 accepts (no lookaround, no backreferences, no nested unbounded
 * quantifiers over overlapping classes) so it runs in linear time and never
 * backtracks catastrophically; `isRe2Safe` holds a user-typed pattern to the
 * same rule.
 *
 * Execution belongs in a Web Worker with a timeout (`apps/web/src/workers`);
 * `handleChipRequest` is the message handler both the Worker and the
 * main-thread fallback call, so the request/response pair is the whole API.
 */
import { matches, type Match } from './algebra.js';
import { richFromText, type RichDoc } from './types.js';

export const CHIP_IDS = [
  'email',
  'date',
  'currency',
  'company',
  'country',
  'parenthetical',
  'afterDash',
  'beforeDash',
] as const;
export type ChipId = (typeof CHIP_IDS)[number];

export interface ChipPattern {
  readonly id: ChipId;
  readonly label: string;
  /** Regex source, RE2-compatible and JS-compatible (`u` flag). */
  readonly source: string;
  readonly flags: string;
}

const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';
const CURRENCY_CODES = 'SGD|MYR|PHP|IDR|USD|INR';
const CURRENCY_SYMBOLS = 'S\\$|US\\$|RM|Rp|₱|₹|\\$';
const AMOUNT = '-?\\d[\\d,]*(?:\\.\\d+)?';
const COMPANY_SUFFIX =
  'Pte\\.? Ltd|Sdn\\.? Bhd|Private Limited|Limited|Ltd|LLC|LLP|Inc|Corp|Corporation|GmbH|Co|PLC|Bhd';
const COUNTRIES = [
  'Singapore',
  'Malaysia',
  'Philippines',
  'Indonesia',
  'India',
  'Thailand',
  'Vietnam',
  'Cambodia',
  'Laos',
  'Myanmar',
  'Brunei',
  'Timor-Leste',
  'Sri Lanka',
  'Bangladesh',
  'Nepal',
  'Pakistan',
  'China',
  'Hong Kong',
  'Taiwan',
  'Japan',
  'South Korea',
  'Korea',
  'Australia',
  'New Zealand',
  'United States of America',
  'United States',
  'USA',
  'Canada',
  'Mexico',
  'Brazil',
  'United Kingdom',
  'UK',
  'Ireland',
  'France',
  'Germany',
  'Netherlands',
  'Belgium',
  'Switzerland',
  'Austria',
  'Spain',
  'Portugal',
  'Italy',
  'Sweden',
  'Norway',
  'Denmark',
  'Finland',
  'Poland',
  'United Arab Emirates',
  'UAE',
  'Saudi Arabia',
  'Qatar',
  'Israel',
  'Turkey',
  'Egypt',
  'South Africa',
  'Kenya',
  'Nigeria',
];

export const CHIP_PATTERNS: Readonly<Record<ChipId, ChipPattern>> = {
  email: {
    id: 'email',
    label: 'Email',
    source: "[\\p{L}\\p{N}._%+'-]+@[\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)*\\.\\p{L}{2,}",
    flags: 'u',
  },
  date: {
    id: 'date',
    label: 'Date',
    source: `\\b(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}|\\d{1,2} (?:${MONTHS})[a-z]* \\d{4})\\b`,
    flags: 'u',
  },
  currency: {
    id: 'currency',
    label: 'Currency',
    source: `(?:(?:${CURRENCY_CODES}|${CURRENCY_SYMBOLS}) ?${AMOUNT}|${AMOUNT} ?(?:${CURRENCY_CODES})\\b)`,
    flags: 'u',
  },
  company: {
    id: 'company',
    label: 'Company',
    source: `([\\p{Lu}\\p{N}][\\p{L}\\p{N}&'.-]*(?: [\\p{Lu}&][\\p{L}\\p{N}&'.-]*){0,5} (?:${COMPANY_SUFFIX})\\.?)(?:[^\\p{L}\\p{N}]|$)`,
    flags: 'u',
  },
  country: {
    id: 'country',
    label: 'Country',
    source: `\\b(?:${COUNTRIES.join('|')})\\b`,
    flags: 'u',
  },
  parenthetical: {
    id: 'parenthetical',
    label: 'Parenthetical',
    source: '\\(([^()]*)\\)',
    flags: 'u',
  },
  afterDash: {
    id: 'afterDash',
    label: 'After dash',
    source: '(?:\\s-|[–—])\\s*([^\\n]*)$',
    flags: 'mu',
  },
  beforeDash: {
    id: 'beforeDash',
    label: 'Before dash',
    source: '^([^\\n]*?)\\s*(?:\\s-\\s|[–—])',
    flags: 'mu',
  },
};

/** Compile a chip; the patterns are constants, so this never throws. */
export function chipRegExp(chip: ChipId): RegExp {
  const p = CHIP_PATTERNS[chip];
  return new RegExp(p.source, p.flags);
}

/**
 * Syntax RE2 rejects (and that can backtrack without bound in JS):
 * lookaround, backreferences, named backreferences, conditionals. A pattern
 * that fails this check is refused before it reaches a Worker.
 */
const RE2_UNSAFE = /\(\?[=!]|\(\?<[=!]|\\[1-9]|\\k<|\(\?\(/;
export const MAX_PATTERN_LENGTH = 512;

export type PatternCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function isRe2Safe(source: string, flags = 'u'): PatternCheck {
  if (source.length > MAX_PATTERN_LENGTH) {
    return { ok: false, reason: `pattern longer than ${MAX_PATTERN_LENGTH} characters` };
  }
  if (RE2_UNSAFE.test(source)) {
    return { ok: false, reason: 'lookaround and backreferences are not supported' };
  }
  try {
    new RegExp(source, flags);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'invalid pattern' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Message-shaped API (the Worker contract)
// ---------------------------------------------------------------------------

export type ChipRequest =
  | { readonly id: number; readonly kind: 'chip'; readonly chip: ChipId; readonly text: string }
  | {
      readonly id: number;
      readonly kind: 'regex';
      readonly source: string;
      readonly flags?: string;
      readonly text: string;
    };

export type ChipResponse =
  | { readonly id: number; readonly ok: true; readonly matches: readonly Match[] }
  | { readonly id: number; readonly ok: false; readonly error: string };

/** Run one request. Never throws: a bad pattern is an `ok: false` response. */
export function handleChipRequest(request: ChipRequest): ChipResponse {
  const d: RichDoc = richFromText(request.text);
  if (request.kind === 'chip') {
    if (!(CHIP_IDS as readonly string[]).includes(request.chip)) {
      return { id: request.id, ok: false, error: `unknown chip ${request.chip}` };
    }
    return { id: request.id, ok: true, matches: matches(d, chipRegExp(request.chip)) };
  }
  const flags = request.flags ?? 'u';
  const check = isRe2Safe(request.source, flags);
  if (!check.ok) return { id: request.id, ok: false, error: check.reason };
  return { id: request.id, ok: true, matches: matches(d, new RegExp(request.source, flags)) };
}

/** Runtime guard for a message arriving at the Worker. */
export function isChipRequest(value: unknown): value is ChipRequest {
  if (typeof value !== 'object' || value === null) return false;
  if (!('id' in value) || typeof value.id !== 'number') return false;
  if (!('text' in value) || typeof value.text !== 'string') return false;
  if (!('kind' in value)) return false;
  if (value.kind === 'chip') return 'chip' in value && typeof value.chip === 'string';
  if (value.kind === 'regex') return 'source' in value && typeof value.source === 'string';
  return false;
}
