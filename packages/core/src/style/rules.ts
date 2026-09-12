/**
 * Conditional highlighting rules (INSP-05; PRD §8 "Semantic & Pattern
 * Highlighting"): per column, evaluated against the cell's text — never in
 * React. Triggers are the PRD's: lexical (contains / does not contain),
 * metrics (character or word count over / under a threshold), pattern (the
 * text matches, or fails to match, a Smart Chip). Outputs are a fill, a text
 * colour and an inline mark; because no state is carried by hue alone
 * (A11Y-04), every matched cell also carries the rule's name as a glyph with
 * a text label, whatever the outputs.
 */
import { CHIP_IDS, CHIP_PATTERNS, chipRegExp, type ChipId } from '../text/chips.js';
import {
  isHighlightToken,
  isTextColourToken,
  isToggleMark,
  type HighlightToken,
  type TextColourToken,
  type ToggleMark,
} from '../text/types.js';
import { readableTextColour } from './contrast.js';
import { readCellBorder, type CellBorder } from './types.js';

export const RULE_TRIGGERS = [
  'contains',
  'notContains',
  'charsOver',
  'charsUnder',
  'wordsOver',
  'wordsUnder',
  'matchesChip',
  'failsChip',
] as const;
export type RuleTrigger = (typeof RULE_TRIGGERS)[number];

export const RULE_TRIGGER_LABELS: Readonly<Record<RuleTrigger, string>> = {
  contains: 'Text contains',
  notContains: 'Text does not contain',
  charsOver: 'Characters over',
  charsUnder: 'Characters under',
  wordsOver: 'Words over',
  wordsUnder: 'Words under',
  matchesChip: 'Matches chip',
  failsChip: 'Fails chip',
};

export type RuleCondition =
  | { readonly trigger: 'contains' | 'notContains'; readonly text: string }
  | {
      readonly trigger: 'charsOver' | 'charsUnder' | 'wordsOver' | 'wordsUnder';
      readonly count: number;
    }
  | { readonly trigger: 'matchesChip' | 'failsChip'; readonly chip: ChipId };

/**
 * What a matched rule applies (PRD §8: "cell background color, borders, or
 * applies rich text presets"). The mark reuses the rich-text vocabulary
 * (KEYS-05); the border is the matrix's own shape.
 */
export interface RuleStyle {
  readonly fill?: HighlightToken;
  readonly textColour?: TextColourToken;
  readonly mark?: ToggleMark;
  readonly border?: CellBorder;
}

export interface ConditionalRule {
  readonly id: string;
  readonly when: RuleCondition;
  readonly style: RuleStyle;
}

/** A rule with the chip name, threshold or text spelled out, for the glyph's label and the list. */
export function describeRule(rule: ConditionalRule): string {
  const w = rule.when;
  switch (w.trigger) {
    case 'contains':
      return `contains “${w.text}”`;
    case 'notContains':
      return `does not contain “${w.text}”`;
    case 'charsOver':
      return `over ${String(w.count)} characters`;
    case 'charsUnder':
      return `under ${String(w.count)} characters`;
    case 'wordsOver':
      return `over ${String(w.count)} words`;
    case 'wordsUnder':
      return `under ${String(w.count)} words`;
    case 'matchesChip':
      return `matches ${CHIP_PATTERNS[w.chip].label}`;
    case 'failsChip':
      return `fails ${CHIP_PATTERNS[w.chip].label}`;
  }
}

const compiled = new Map<ChipId, RegExp>();
function chipTest(chip: ChipId, text: string): boolean {
  let re = compiled.get(chip);
  if (re === undefined) {
    re = chipRegExp(chip);
    compiled.set(chip, re);
  }
  re.lastIndex = 0;
  return re.test(text);
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/u).length;
}

/** Whether one rule matches the text. Pure; no exceptions. */
export function ruleMatches(rule: ConditionalRule, text: string): boolean {
  const w = rule.when;
  switch (w.trigger) {
    case 'contains':
      return w.text !== '' && text.toLocaleLowerCase().includes(w.text.toLocaleLowerCase());
    case 'notContains':
      return w.text !== '' && !text.toLocaleLowerCase().includes(w.text.toLocaleLowerCase());
    case 'charsOver':
      return Array.from(text).length > w.count;
    case 'charsUnder':
      return Array.from(text).length < w.count;
    case 'wordsOver':
      return wordCount(text) > w.count;
    case 'wordsUnder':
      return wordCount(text) < w.count;
    case 'matchesChip':
      return chipTest(w.chip, text);
    case 'failsChip':
      return !chipTest(w.chip, text);
  }
}

export interface RuleOutcome {
  /** The first matching rule, in list order; its name is the cell's cue (A11Y-04). */
  readonly rule: ConditionalRule;
  readonly fill: HighlightToken | undefined;
  /** Auto-adjusted to `ink` when the pair with `fill` is under 4.5:1. */
  readonly textColour: TextColourToken | undefined;
  readonly mark: ToggleMark | undefined;
  readonly border: CellBorder | undefined;
}

/**
 * The first rule the text matches, with its style, or null. First match wins
 * so the list order is the priority, as in every spreadsheet's rule list.
 */
export function evaluateRules(rules: readonly ConditionalRule[], text: string): RuleOutcome | null {
  for (const rule of rules) {
    if (ruleMatches(rule, text)) return ruleOutcome(rule);
  }
  return null;
}

/** The outcome of a rule known to have matched (the Worker answers with rule ids; this rebuilds the style). */
export function ruleOutcome(rule: ConditionalRule): RuleOutcome {
  return {
    rule,
    fill: rule.style.fill,
    textColour: readableTextColour(rule.style.fill, rule.style.textColour),
    mark: rule.style.mark,
    border: rule.style.border,
  };
}

// ---------------------------------------------------------------------------
// Storage guards: rules live on the column map as plain objects.
// ---------------------------------------------------------------------------

function readCondition(value: unknown): RuleCondition | null {
  if (typeof value !== 'object' || value === null || !('trigger' in value)) return null;
  const v = value as Record<string, unknown>;
  const trigger = v.trigger;
  switch (trigger) {
    case 'contains':
    case 'notContains':
      return typeof v.text === 'string' ? { trigger, text: v.text } : null;
    case 'charsOver':
    case 'charsUnder':
    case 'wordsOver':
    case 'wordsUnder':
      return typeof v.count === 'number' && Number.isFinite(v.count)
        ? { trigger, count: Math.max(0, Math.round(v.count)) }
        : null;
    case 'matchesChip':
    case 'failsChip':
      return (CHIP_IDS as readonly unknown[]).includes(v.chip)
        ? { trigger, chip: v.chip as ChipId }
        : null;
    default:
      return null;
  }
}

function readRuleStyle(value: unknown): RuleStyle {
  if (typeof value !== 'object' || value === null) return {};
  const v = value as Record<string, unknown>;
  const out: { -readonly [K in keyof RuleStyle]?: RuleStyle[K] } = {};
  if (isHighlightToken(v.fill)) out.fill = v.fill;
  if (isTextColourToken(v.textColour)) out.textColour = v.textColour;
  if (typeof v.mark === 'string' && isToggleMark(v.mark)) out.mark = v.mark;
  const border = readCellBorder(v.border);
  if (border !== undefined && border.edges !== 'none') out.border = border;
  return out;
}

export function readRule(value: unknown): ConditionalRule | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const when = readCondition(v.when);
  if (when === null || typeof v.id !== 'string') return null;
  return { id: v.id, when, style: readRuleStyle(v.style) };
}

/** A stored rule list with malformed entries dropped. */
export function readRules(value: unknown): readonly ConditionalRule[] {
  if (!Array.isArray(value)) return [];
  const out: ConditionalRule[] = [];
  for (const entry of value) {
    const rule = readRule(entry);
    if (rule !== null) out.push(rule);
  }
  return out;
}
