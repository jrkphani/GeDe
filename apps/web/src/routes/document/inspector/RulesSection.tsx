/**
 * INSP-05: conditional highlighting rules on the selected cell's column
 * (PRD §8). The triggers are the PRD's — lexical (contains / does not
 * contain), metrics (characters or words over / under a count) and pattern
 * (matches or fails a Smart Chip); the outputs a fill, a text colour and an
 * inline mark. Rules are evaluated in the rules Worker, never here; first
 * match wins, so the list order is the priority. A matched cell always
 * carries a glyph with the rule's words beside any colour (A11Y-04).
 */
import { useState } from 'react';
import { Select, TextField } from '@gede/ui';
import {
  BORDER_EDGE_LABELS,
  BORDER_EDGES,
  BORDER_WEIGHTS,
  CHIP_IDS,
  CHIP_PATTERNS,
  describeRule,
  HIGHLIGHT_TOKENS,
  RULE_TRIGGER_LABELS,
  RULE_TRIGGERS,
  TEXT_COLOUR_TOKENS,
  TOGGLE_MARKS,
  type BorderEdges,
  type BorderWeight,
  type ChipId,
  type ColumnRecord,
  type ConditionalRule,
  type HighlightToken,
  type RuleCondition,
  type RuleTrigger,
  type TextColourToken,
  type ToggleMark,
} from '@gede/core';

import type { GridCommands } from '../grid/commands.js';
import { useMessages, type MessageKey, type Translate } from '../../../i18n/index.js';
import { ReasonedButton, Section } from './controls.js';

export interface RulesSectionProps {
  tableId: string;
  column: ColumnRecord | null;
  disabledReason: string | undefined;
  commands: GridCommands;
}

const FILL_LABELS: Readonly<Record<HighlightToken, MessageKey>> = {
  amber: 'inspector.amber',
  forest: 'inspector.forest',
  slate: 'inspector.slate',
};
export const TEXT_COLOUR_LABELS: Readonly<Record<TextColourToken, MessageKey>> = {
  ink: 'inspector.colour.ink',
  'ink-muted': 'inspector.colour.muted',
  brand: 'inspector.colour.brand',
  live: 'inspector.colour.live',
  success: 'inspector.colour.success',
  warning: 'inspector.colour.warning',
  danger: 'inspector.colour.danger',
  info: 'inspector.colour.info',
};
export const MARK_LABELS: Readonly<Record<ToggleMark, MessageKey>> = {
  bold: 'inspector.markBold',
  italic: 'inspector.markItalic',
  underline: 'inspector.markUnderline',
  strikethrough: 'inspector.markStrikethrough',
  superscript: 'inspector.markSuperscript',
  subscript: 'inspector.markSubscript',
};

type RuleBorderEdges = Exclude<BorderEdges, 'none'>;

interface Draft {
  trigger: RuleTrigger;
  text: string;
  count: string;
  chip: ChipId;
  fill: HighlightToken | '';
  textColour: TextColourToken | '';
  mark: ToggleMark | '';
  border: RuleBorderEdges | '';
  weight: BorderWeight;
}

const EMPTY_DRAFT: Draft = {
  trigger: 'contains',
  text: '',
  count: '40',
  chip: CHIP_IDS[0],
  fill: 'amber',
  textColour: '',
  mark: '',
  border: '',
  weight: 'hairline',
};

const RULE_BORDER_EDGES = BORDER_EDGES.filter((e): e is RuleBorderEdges => e !== 'none');

const WEIGHT_LABELS: Readonly<Record<BorderWeight, MessageKey>> = {
  hairline: 'inspector.hairline',
  strong: 'inspector.strong',
  accent: 'inspector.accent',
};

function conditionOf(d: Draft): RuleCondition | null {
  switch (d.trigger) {
    case 'contains':
    case 'notContains':
      return d.text.trim() === '' ? null : { trigger: d.trigger, text: d.text };
    case 'charsOver':
    case 'charsUnder':
    case 'wordsOver':
    case 'wordsUnder': {
      const count = Number(d.count);
      return Number.isInteger(count) && count >= 0 ? { trigger: d.trigger, count } : null;
    }
    case 'matchesChip':
    case 'failsChip':
      return { trigger: d.trigger, chip: d.chip };
  }
}

function styleWords(rule: ConditionalRule, t: Translate): string {
  const parts: string[] = [];
  if (rule.style.fill !== undefined) parts.push(`${t(FILL_LABELS[rule.style.fill])} fill`);
  if (rule.style.textColour !== undefined)
    parts.push(`${t(TEXT_COLOUR_LABELS[rule.style.textColour])} text`);
  if (rule.style.mark !== undefined) parts.push(t(MARK_LABELS[rule.style.mark]).toLowerCase());
  if (rule.style.border !== undefined)
    parts.push(
      `${t(WEIGHT_LABELS[rule.style.border.weight]).toLowerCase()} border, ${BORDER_EDGE_LABELS[rule.style.border.edges].toLowerCase()}`,
    );
  return parts.length === 0 ? t('inspector.glyphOnly') : parts.join(', ');
}

export function RulesSection({ tableId, column, disabledReason, commands }: RulesSectionProps) {
  const t = useMessages();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const condition = conditionOf(draft);
  const hasOutput =
    draft.fill !== '' || draft.textColour !== '' || draft.mark !== '' || draft.border !== '';
  const addReason =
    disabledReason ??
    (condition === null
      ? t('reason.ruleNeedsText')
      : hasOutput
        ? undefined
        : t('reason.ruleNeedsOutput'));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const textual = draft.trigger === 'contains' || draft.trigger === 'notContains';
  const counted =
    draft.trigger === 'charsOver' ||
    draft.trigger === 'charsUnder' ||
    draft.trigger === 'wordsOver' ||
    draft.trigger === 'wordsUnder';
  const rules = column?.rules ?? [];

  return (
    <Section
      label={t('inspector.conditionalHighlighting')}
      hint={
        column === null
          ? 'Select a cell to add rules to its column.'
          : `Rules apply to every cell of ${column.label}, first match first. Each match shows a flag with the rule's words.`
      }
    >
      <div className="gd-insp__stack">
        {rules.length > 0 && (
          <ol className="gd-insp__rules" aria-label={t('inspector.rules')}>
            {rules.map((rule, i) => (
              <li key={rule.id} className="gd-insp__rule">
                <span className="gd-mono gd-insp__rule-index">{i + 1}</span>
                <span className="gd-insp__rule-text">
                  {describeRule(rule)}{' '}
                  <span className="gd-insp__rule-style">{styleWords(rule, t)}</span>
                </span>
                {/* Priority is list order: up and down move a rule one place (INSP-05). */}
                <span className="gd-insp__rule-keys">
                  <MoveRule
                    label={`Move rule ${String(i + 1)} up`}
                    reason={disabledReason ?? (i === 0 ? t('reason.alreadyFirst') : undefined)}
                    onClick={() => {
                      if (column !== null) commands.moveRule(tableId, column.id, rule.id, 'up');
                    }}
                  >
                    ↑
                  </MoveRule>
                  <MoveRule
                    label={`Move rule ${String(i + 1)} down`}
                    reason={
                      disabledReason ??
                      (i === rules.length - 1 ? t('reason.alreadyLast') : undefined)
                    }
                    onClick={() => {
                      if (column !== null) commands.moveRule(tableId, column.id, rule.id, 'down');
                    }}
                  >
                    ↓
                  </MoveRule>
                </span>
                <ReasonedButton
                  variant="ghost"
                  label={t('inspector.removeRule')}
                  aria-label={`Remove rule ${String(i + 1)}: ${describeRule(rule)}`}
                  reason={disabledReason}
                  onClick={() => {
                    if (column !== null) commands.removeRule(tableId, column.id, rule.id);
                  }}
                >
                  Remove
                </ReasonedButton>
              </li>
            ))}
          </ol>
        )}
        <Select
          label={t('inspector.whenTheText')}
          value={draft.trigger}
          disabledReason={disabledReason}
          onValueChange={(trigger) => {
            set('trigger', trigger);
          }}
          options={RULE_TRIGGERS.map((t) => ({ value: t, label: RULE_TRIGGER_LABELS[t] }))}
        />
        {textual && (
          <TextField
            label={t('inspector.text')}
            value={draft.text}
            disabled={disabledReason !== undefined}
            onChange={(e) => {
              set('text', e.currentTarget.value);
            }}
          />
        )}
        {counted && (
          <TextField
            label={t('inspector.count')}
            type="number"
            inputMode="numeric"
            min={0}
            value={draft.count}
            disabled={disabledReason !== undefined}
            onChange={(e) => {
              set('count', e.currentTarget.value);
            }}
          />
        )}
        {!textual && !counted && (
          <Select
            label={t('inspector.chip')}
            value={draft.chip}
            disabledReason={disabledReason}
            onValueChange={(chip) => {
              set('chip', chip);
            }}
            options={CHIP_IDS.map((id) => ({ value: id, label: CHIP_PATTERNS[id].label }))}
          />
        )}
        <Select
          label={t('inspector.fill')}
          value={draft.fill}
          placeholder={t('inspector.none')}
          clearLabel={t('inspector.none')}
          disabledReason={disabledReason}
          onValueChange={(fill) => {
            set('fill', fill);
          }}
          options={HIGHLIGHT_TOKENS.map((h) => ({ value: h, label: t(FILL_LABELS[h]) }))}
        />
        <Select
          label={t('inspector.textColour')}
          value={draft.textColour}
          placeholder={t('inspector.inherit')}
          clearLabel={t('inspector.inherit')}
          disabledReason={disabledReason}
          onValueChange={(textColour) => {
            set('textColour', textColour);
          }}
          options={TEXT_COLOUR_TOKENS.map((c) => ({ value: c, label: t(TEXT_COLOUR_LABELS[c]) }))}
        />
        <Select
          label={t('inspector.mark')}
          value={draft.mark}
          placeholder={t('inspector.none')}
          clearLabel={t('inspector.none')}
          disabledReason={disabledReason}
          onValueChange={(mark) => {
            set('mark', mark);
          }}
          options={TOGGLE_MARKS.map((m) => ({ value: m, label: t(MARK_LABELS[m]) }))}
        />
        <Select
          label={t('inspector.border')}
          value={draft.border}
          placeholder={t('inspector.none')}
          clearLabel={t('inspector.none')}
          disabledReason={disabledReason}
          onValueChange={(border) => {
            set('border', border);
          }}
          options={RULE_BORDER_EDGES.map((e) => ({ value: e, label: BORDER_EDGE_LABELS[e] }))}
        />
        {draft.border !== '' && (
          <Select
            label={t('inspector.borderWeight')}
            value={draft.weight}
            disabledReason={disabledReason}
            onValueChange={(weight) => {
              set('weight', weight);
            }}
            options={BORDER_WEIGHTS.map((w) => ({ value: w, label: t(`inspector.${w}`) }))}
          />
        )}
        <ReasonedButton
          label={t('inspector.addARule')}
          reason={addReason}
          onClick={() => {
            if (column === null || condition === null) return;
            const created = commands.addRule(tableId, column.id, {
              when: condition,
              style: {
                ...(draft.fill === '' ? {} : { fill: draft.fill }),
                ...(draft.textColour === '' ? {} : { textColour: draft.textColour }),
                ...(draft.mark === '' ? {} : { mark: draft.mark }),
                ...(draft.border === ''
                  ? {}
                  : { border: { edges: draft.border, weight: draft.weight } }),
              },
            });
            if (created !== null) setDraft({ ...EMPTY_DRAFT, trigger: draft.trigger });
          }}
        />
      </div>
    </Section>
  );
}

function MoveRule({
  label,
  reason,
  onClick,
  children,
}: {
  label: string;
  reason: string | undefined;
  onClick: () => void;
  children: string;
}) {
  return (
    <ReasonedButton
      variant="ghost"
      label={label}
      aria-label={label}
      reason={reason}
      onClick={onClick}
    >
      {children}
    </ReasonedButton>
  );
}
