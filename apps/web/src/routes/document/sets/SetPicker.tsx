/**
 * The operand picker (SET-08, SET-09; the derive board of the GeDe Sets canvas): the
 * operation, the sets in order, and where a Cross puts each tuple. The second step of a
 * computed kind at Add table, and the body of Fill column with formula…. It holds no
 * document data: the sets are read from the sheet each render, the pick is the dialog's.
 */
import { Button, Icon, RadioCards, Select, type RadioCardOption } from '@gede/ui';
import type { GedeDoc, Id } from '@gede/core';
import { useEffect, useId, useRef } from 'react';

import { useMessages, type MessageKey } from '../../../i18n/index.js';
import {
  elementsPreview,
  operandCount,
  pickDisplay,
  type ProductShape,
  type SetOperation,
  type SetPick,
  type SheetSet,
} from './set-tables.js';

const SYMBOL: Readonly<Record<SetOperation, string>> = {
  Union: '∪',
  Inter: '∩',
  Diff: '∖',
  Power: '𝒫',
  Cross: '×',
};

const HINT: Readonly<Record<SetOperation, MessageKey>> = {
  Union: 'pick.op.Union',
  Inter: 'pick.op.Inter',
  Diff: 'pick.op.Diff',
  Power: 'forms.power.hint',
  Cross: 'pick.op.Cross',
};

/** A first pick over the sheet's sets: the first ones, in sheet order, as many as `op` takes. */
export function defaultPick(op: SetOperation, sets: readonly SheetSet[]): SetPick {
  const ids = sets.map((s) => s.tableId);
  const first = ids[0];
  const count = operandCount(op).min;
  const picked =
    first === undefined
      ? []
      : Array.from({ length: count }, (_, i) => ids[i] ?? ids[ids.length - 1] ?? first);
  return { op, sets: picked, shape: 'spread' };
}

/** Re-fit a pick to another operation: its sets kept in order, trimmed or padded to fit. */
export function withOperation(pick: SetPick, op: SetOperation, sets: readonly SheetSet[]) {
  const { min, max } = operandCount(op);
  const kept = pick.sets.slice(0, max);
  const pad = sets[0]?.tableId;
  while (kept.length < min && pad !== undefined) kept.push(kept[kept.length - 1] ?? pad);
  return { ...pick, op, sets: kept };
}

export interface SetPickerProps {
  gd: GedeDoc;
  sets: readonly SheetSet[];
  /** The operations offered; one hides the operation step (a Cartesian product is Cross). */
  operations: readonly SetOperation[];
  value: SetPick;
  onChange: (pick: SetPick) => void;
  /** Enter on a card: the dialog's confirm. */
  onEnter: () => void;
  /**
   * Focus the first field when the picker mounts — the checked operation card, else the
   * first set — for a dialog that reaches the picker as its second step, where the
   * dialog's own focus would land on the dialog itself.
   */
  autoFocus?: boolean | undefined;
}

export function SetPicker({
  gd,
  sets,
  operations,
  value,
  onChange,
  onEnter,
  autoFocus = false,
}: SetPickerProps) {
  const t = useMessages();
  const root = useRef<HTMLDivElement>(null);
  const operationId = useId();
  const shapeId = useId();
  useEffect(() => {
    if (!autoFocus) return;
    const first = root.current?.querySelector<HTMLElement>(
      '[role="radio"][aria-checked="true"], button:not([disabled])',
    );
    first?.focus();
    // On mount only: the step's first field, not on every pick.
  }, []);
  if (sets.length === 0) {
    return <p className="gd-set-picker__empty">{t('pick.noSets')}</p>;
  }
  const opOptions: RadioCardOption<SetOperation>[] = operations.map((op) => ({
    value: op,
    label: op,
    glyph: SYMBOL[op],
    description: t(HINT[op]),
  }));
  const options = sets.map((s) => ({
    value: s.tableId,
    label: s.title,
    description: elementsPreview(s),
  }));
  const setAt = (index: number, tableId: Id) => {
    onChange({ ...value, sets: value.sets.map((id, i) => (i === index ? tableId : id)) });
  };
  const cross = value.op === 'Cross';
  const binaryLabels = [t('pick.firstSet'), t('pick.secondSet')];
  return (
    <div className="gd-set-picker" ref={root}>
      {operations.length > 1 && (
        <div className="gd-set-picker__group">
          <p className="gd-set-picker__legend" id={operationId}>
            {t('pick.operation')}
          </p>
          <RadioCards<SetOperation>
            labelledBy={operationId}
            layout="grid"
            options={opOptions}
            value={value.op}
            onChange={(op) => {
              onChange(withOperation(value, op, sets));
            }}
            onEnter={onEnter}
          />
        </div>
      )}
      <fieldset className="gd-set-picker__group">
        <legend className="gd-set-picker__legend">{t('pick.sets')}</legend>
        <ol className="gd-set-picker__sets">
          {value.sets.map((tableId, index) => {
            const n = index + 1;
            const label = cross
              ? t('pick.factor', { n })
              : value.op === 'Power'
                ? t('pick.set')
                : (binaryLabels[index] ?? t('pick.set'));
            return (
              <li key={index} className="gd-set-picker__set">
                {cross && (
                  <span className="gd-mono gd-set-picker__index" aria-hidden="true">
                    x{n}
                  </span>
                )}
                <Select<Id>
                  label={label}
                  hideLabel={cross}
                  value={tableId}
                  onValueChange={(next) => {
                    setAt(index, next);
                  }}
                  options={options}
                  className="gd-set-picker__select"
                />
                {cross && value.sets.length > operandCount('Cross').min && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('pick.removeFactor', { n })}
                    icon={<Icon name="delete" size={13} />}
                    onClick={() => {
                      onChange({ ...value, sets: value.sets.filter((_, i) => i !== index) });
                    }}
                  />
                )}
              </li>
            );
          })}
        </ol>
        {cross && (
          <>
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="plus" size={13} />}
              onClick={() => {
                const last = value.sets[value.sets.length - 1] ?? sets[0]?.tableId;
                if (last !== undefined) onChange({ ...value, sets: [...value.sets, last] });
              }}
            >
              {t('pick.addFactor')}
            </Button>
            <p className="gd-set-picker__note">{t('pick.order')}</p>
          </>
        )}
      </fieldset>
      {cross && (
        <div className="gd-set-picker__group">
          <p className="gd-set-picker__legend" id={shapeId}>
            {t('pick.shape')}
          </p>
          <RadioCards<ProductShape>
            labelledBy={shapeId}
            layout="grid"
            options={[
              {
                value: 'column',
                label: t('pick.shape.column'),
                description: t('pick.shape.column.hint'),
              },
              {
                value: 'spread',
                label: t('pick.shape.spread'),
                description: t('pick.shape.spread.hint'),
              },
            ]}
            value={value.shape}
            onChange={(shape) => {
              onChange({ ...value, shape });
            }}
            onEnter={onEnter}
          />
        </div>
      )}
      <p className="gd-set-picker__formula">
        <span className="gd-set-picker__formula-label">{t('pick.formula')}</span>{' '}
        <output className="gd-mono" data-testid="set-picker-formula">
          {pickDisplay(gd, value)}
        </output>
      </p>
    </div>
  );
}
