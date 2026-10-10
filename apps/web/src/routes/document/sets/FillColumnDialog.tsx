/**
 * SET-10, MENU-03 (ADR-056): Fill column with formula…, the one route to a computed
 * column. The column menu opens it on an empty column; the body is the operand picker,
 * every set operation offered, and a Cross asks where each tuple goes (SET-09).
 */
import { Button, Dialog } from '@gede/ui';
import type { GedeDoc, Id } from '@gede/core';
import { useState } from 'react';

import { useMessages } from '../../../i18n/index.js';
import { defaultPick, SetPicker } from './SetPicker.js';
import { pickReady, setsOnSheet, type SetOperation, type SetPick } from './set-tables.js';

const OPERATIONS: readonly SetOperation[] = ['Union', 'Inter', 'Diff', 'Power', 'Cross'];

export interface FillColumnDialogProps {
  gd: GedeDoc;
  sheetId: Id;
  /** The column's label, for the title. */
  column: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFill: (pick: SetPick) => void;
}

/** Mounted only while open, so each opening starts from the sheet's first sets. */
export function FillColumnDialog(props: FillColumnDialogProps) {
  return props.open ? <FillColumnBody {...props} /> : null;
}

function FillColumnBody({
  gd,
  sheetId,
  column,
  open,
  onOpenChange,
  onFill,
}: FillColumnDialogProps) {
  const t = useMessages();
  const sets = setsOnSheet(gd, sheetId);
  const [pick, setPick] = useState<SetPick>(() => defaultPick('Cross', sets));
  const ready = pickReady(gd, pick);
  const confirm = () => {
    if (ready) onFill(pick);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('fill.title', { column })}
      description={t('fill.description')}
      className="gd-add-table"
      actions={
        <>
          <Button
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t('addTable.cancel')}
          </Button>
          <Button variant="primary" disabled={!ready} onClick={confirm}>
            {t('fill.confirm')}
          </Button>
        </>
      }
    >
      <SetPicker
        gd={gd}
        sets={sets}
        operations={OPERATIONS}
        value={pick}
        onChange={setPick}
        onEnter={confirm}
      />
    </Dialog>
  );
}
