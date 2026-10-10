/**
 * SET-01, DOC-02 (ADR-056): Add table asks the table's kind. Plain table is preselected,
 * so Enter adds today's table. A computed kind reads "Pick sets" and opens a second step,
 * the operand picker; every confirm that adds reads "Add table". Built on the Radix dialog
 * and radio group (`@gede/ui`): focus is trapped, Escape closes, focus returns to the opener.
 */
import { Button, Dialog, RadioCards, type RadioCardOption } from '@gede/ui';
import type { GedeDoc, Id, TableKind } from '@gede/core';
import { useState } from 'react';

import { useMessages, type MessageKey } from '../../../i18n/index.js';
import { defaultPick, SetPicker } from './SetPicker.js';
import {
  FORMULA_OPERATIONS,
  isComputedKind,
  pickReady,
  setsOnSheet,
  TABLE_KINDS,
  type SetPick,
} from './set-tables.js';

const GLYPH: Readonly<Record<TableKind, string>> = {
  plain: '⊞',
  simple: '{ a, b, c }',
  family: '{ {a}, {b} }',
  computed: 'A ∪ B',
  product: 'A × B',
};

const LABEL: Readonly<Record<TableKind, readonly [MessageKey, MessageKey]>> = {
  plain: ['addTable.kind.plain', 'addTable.kind.plain.hint'],
  simple: ['addTable.kind.simple', 'addTable.kind.simple.hint'],
  family: ['addTable.kind.family', 'addTable.kind.family.hint'],
  computed: ['addTable.kind.computed', 'addTable.kind.computed.hint'],
  product: ['addTable.kind.product', 'addTable.kind.product.hint'],
};

export interface AddTableDialogProps {
  gd: GedeDoc;
  /** The sheet the table goes on; its set tables are the operands offered. */
  sheetId: Id;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Add the table; the shell places, reveals, selects and announces it. */
  onAdd: (kind: TableKind, pick?: SetPick) => void;
}

/** Mounted only while open, so each opening starts at Plain table. */
export function AddTableDialog(props: AddTableDialogProps) {
  return props.open ? <AddTableSteps {...props} /> : null;
}

function AddTableSteps({ gd, sheetId, open, onOpenChange, onAdd }: AddTableDialogProps) {
  const t = useMessages();
  const [kind, setKind] = useState<TableKind>('plain');
  const [step, setStep] = useState<'kind' | 'sets'>('kind');
  const sets = setsOnSheet(gd, sheetId);
  const [pick, setPick] = useState<SetPick>(() => defaultPick('Union', sets));
  const ready = pickReady(gd, pick);

  const confirmKind = () => {
    if (!isComputedKind(kind)) {
      onAdd(kind);
      return;
    }
    setPick(defaultPick(kind === 'product' ? 'Cross' : 'Union', sets));
    setStep('sets');
  };
  const confirmSets = () => {
    if (ready) onAdd(kind, pick);
  };

  const kinds: RadioCardOption<TableKind>[] = TABLE_KINDS.map((k) => ({
    value: k,
    label: t(LABEL[k][0]),
    description: t(LABEL[k][1]),
    glyph: GLYPH[k],
  }));
  const cancel = (
    <Button
      onClick={() => {
        onOpenChange(false);
      }}
    >
      {t('addTable.cancel')}
    </Button>
  );

  if (step === 'kind') {
    return (
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={t('addTable.title')}
        className="gd-add-table"
        actions={
          <>
            {cancel}
            <Button variant="primary" onClick={confirmKind}>
              {isComputedKind(kind) ? t('addTable.pickSets') : t('addTable.add')}
            </Button>
          </>
        }
      >
        <RadioCards<TableKind>
          label={t('addTable.kinds')}
          options={kinds}
          value={kind}
          onChange={setKind}
          onEnter={confirmKind}
        />
      </Dialog>
    );
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('pick.title')}
      description={t('pick.description')}
      className="gd-add-table"
      actions={
        <>
          <Button
            onClick={() => {
              setStep('kind');
            }}
          >
            {t('addTable.back')}
          </Button>
          {cancel}
          <Button variant="primary" disabled={!ready} onClick={confirmSets}>
            {t('addTable.add')}
          </Button>
        </>
      }
    >
      <SetPicker
        gd={gd}
        sets={sets}
        operations={kind === 'product' ? ['Cross'] : FORMULA_OPERATIONS}
        value={pick}
        onChange={setPick}
        onEnter={confirmSets}
      />
    </Dialog>
  );
}
