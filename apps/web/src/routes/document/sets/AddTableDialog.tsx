/**
 * SET-01, DOC-02 (ADR-056): Add table asks the table's kind. Plain table is preselected,
 * so Enter adds today's table. A computed kind reads "Pick sets" and opens a second step,
 * the operand picker; every confirm that adds reads "Add table". Built on the Radix dialog
 * and radio group (`@gede/ui`): focus is trapped, Escape closes, focus returns to the opener.
 */
import { Button, Dialog, RadioCards, type RadioCardOption } from '@gede/ui';
import {
  listSections,
  sectionAtColumn,
  SET_DEGREE,
  type GedeDoc,
  type Id,
  type TableKind,
} from '@gede/core';
import { useId, useState } from 'react';

import { useYVersion } from '../../../doc/use-y.js';
import { formatNumber } from '../../../intl.js';
import { useLocale, type Locale } from '../../../locale.js';
import { useMessages, type MessageKey } from '../../../i18n/index.js';
import { previewPick, type ResultPreview } from './preview.js';
import { defaultPick, SetPicker } from './SetPicker.js';
import {
  FORMULA_OPERATIONS,
  isComputedKind,
  pickDisplay,
  pickName,
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

const FIRST = '+1\u00B0';
const FIRST_MEMBER = '+1.1\u00B0';
const { meta: META, title: TITLE, header: HEADER } = SET_DEGREE;

/** The rows each kind starts with: their degree (SET-07) and what the row holds. */
const STARTS: Readonly<Record<TableKind, readonly (readonly [string, MessageKey])[]>> = {
  plain: [
    [HEADER, 'addTable.rows.plain.header'],
    [FIRST, 'addTable.rows.plain.first'],
  ],
  simple: [
    [META, 'addTable.rows.simple.meta'],
    [TITLE, 'addTable.rows.simple.title'],
    [HEADER, 'addTable.rows.simple.header'],
    [FIRST, 'addTable.rows.simple.first'],
  ],
  family: [
    [META, 'addTable.rows.family.meta'],
    [TITLE, 'addTable.rows.family.title'],
    [HEADER, 'addTable.rows.family.header'],
    [FIRST, 'addTable.rows.family.first'],
    [FIRST_MEMBER, 'addTable.rows.family.member'],
  ],
  computed: [
    [META, 'addTable.rows.computed.meta'],
    [TITLE, 'addTable.rows.computed.title'],
    [HEADER, 'addTable.rows.computed.header'],
    [FIRST, 'addTable.rows.computed.first'],
  ],
  product: [
    [META, 'addTable.rows.product.meta'],
    [TITLE, 'addTable.rows.product.title'],
    [HEADER, 'addTable.rows.product.header'],
    [FIRST, 'addTable.rows.product.first'],
  ],
};

export interface AddTableDialogProps {
  gd: GedeDoc;
  /** The sheet the table goes on; its set tables are the operands offered. */
  sheetId: Id;
  /** The lattice column the table lands in: names its section when the sheet has sections. */
  col: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Add the table; the shell places, reveals, selects and announces it. */
  onAdd: (kind: TableKind, pick?: SetPick) => void;
}

/** Mounted only while open, so each opening starts at Plain table. */
export function AddTableDialog(props: AddTableDialogProps) {
  return props.open ? <AddTableSteps {...props} /> : null;
}

function AddTableSteps({ gd, sheetId, col, open, onOpenChange, onAdd }: AddTableDialogProps) {
  const t = useMessages();
  const [locale] = useLocale();
  const [kind, setKind] = useState<TableKind>('plain');
  const startsId = useId();
  const [step, setStep] = useState<'kind' | 'sets'>('kind');
  // The sets are read from the document on every change to it: a set a peer renames or
  // deletes while the dialog is open shows as it is.
  useYVersion(gd.tables);
  const sets = setsOnSheet(gd, sheetId);
  const [pick, setPick] = useState<SetPick>(() => defaultPick('Union', sets));
  const ready = pickReady(gd, pick);
  const section = sectionAtColumn(listSections(gd, sheetId), col);

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
        description={
          section === null
            ? t('addTable.changeHint')
            : `${t('addTable.section', { name: section.name })} ${t('addTable.changeHint')}`
        }
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
        <section className="gd-add-table__starts" aria-labelledby={startsId}>
          <h3 className="gd-add-table__starts-title gd-mono" id={startsId}>
            {t('addTable.rows')}
          </h3>
          <ol className="gd-add-table__starts-list" aria-live="polite">
            {STARTS[kind].map(([degree, key]) => (
              <li key={key} className="gd-add-table__start">
                <span className="gd-mono gd-add-table__degree" aria-hidden="true">
                  {degree}
                </span>
                <span>{t(key)}</span>
              </li>
            ))}
          </ol>
        </section>
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
        autoFocus
      />
      {ready && <ResultPreviewPanel gd={gd} pick={pick} locale={locale} />}
    </Dialog>
  );
}

/** The Derive design's preview: the table's tag, name and count, header and first rows. */
function ResultPreviewPanel({ gd, pick, locale }: { gd: GedeDoc; pick: SetPick; locale: Locale }) {
  const t = useMessages();
  const name = pickName(gd, pick);
  const preview: ResultPreview | null = previewPick(gd, pick, t('set.column.range'));
  return (
    <section className="gd-add-preview" aria-label={t('addTable.preview')}>
      <h3 className="gd-add-preview__title">{t('addTable.preview')}</h3>
      <p className="gd-add-preview__meta">
        <span className="gd-mono gd-add-preview__tag">{t('set.tag.computed')}</span>
        <span className="gd-mono">{pickDisplay(gd, pick)}</span>
      </p>
      {preview === null ? (
        <p className="gd-add-preview__note">{t('addTable.preview.large')}</p>
      ) : (
        <>
          <p className="gd-add-preview__name">
            <strong>{name}</strong>
            <span className="gd-mono">{`|${name}| = ${formatNumber(locale, preview.total)}`}</span>
          </p>
          {preview.total === 0 ? (
            <p className="gd-add-preview__note">{t('addTable.preview.empty')}</p>
          ) : (
            <table className="gd-add-preview__table">
              <thead>
                <tr>
                  <th scope="col" className="gd-mono">
                    {HEADER}
                  </th>
                  {preview.heads.map((head, i) => (
                    <th key={i} scope="col">
                      {head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((cells, r) => (
                  <tr key={r}>
                    <th scope="row" className="gd-mono">{`+${String(r + 1)}\u00B0`}</th>
                    {cells.map((cell, c) => (
                      <td key={c}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {preview.total > preview.rows.length && (
            <p className="gd-add-preview__note">
              {t('addTable.preview.more', {
                n: formatNumber(locale, preview.total - preview.rows.length),
              })}
            </p>
          )}
        </>
      )}
    </section>
  );
}
