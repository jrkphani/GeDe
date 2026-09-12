import clsx from 'clsx';
import { useEffect, useId, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { GedeDoc, SearchMatch } from '@gede/core';
import { Button, Collapsible, Icon, Menu, Toast, Tooltip, type MenuEntry } from '@gede/ui';

import { ARIA_KEYS, LABELS } from '../../../doc/shortcuts.js';
import { formatNumber } from '../../../intl.js';
import { activeLocale } from '../../../locale.js';
import { describeMatch } from './match-geometry.js';
import { counterText, skippedText, type Find } from './useFind.js';

export interface FindBarProps {
  gd: GedeDoc;
  find: Find;
  /** SHARE-03 / RESP-02: Replace is disabled with the reason when false; absent on phone. */
  editable: boolean;
  phone: boolean;
}

/**
 * The Find bar (FIND-01, FIND-02): gear · field · "n of m" · ‹ › · Done,
 * floating at the foot of the canvas (iCloud Numbers style) and never
 * displacing content. Enter and ⇧Enter in the field step through matches;
 * ⌘G / ⇧⌘G do the same from anywhere (bound in the shell's shortcut map).
 */
export function FindBar({ gd, find, editable, phone }: FindBarProps) {
  const { state, actions, inputRef, focusTick } = find;
  const fieldId = useId();
  const replaceId = useId();

  // FIND-01: opening focuses the field and selects any existing query.
  useEffect(() => {
    if (!state.open) return;
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    input.select();
  }, [state.open, focusTick, inputRef]);

  if (!state.open) return null;

  const total = state.matches.length;
  const counter = counterText(total, state.current, state.query);
  const none = total === 0;
  const onFieldKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    // I18N-01: `keyCode === 229` is the legacy IME signal some engines still send.
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- required by the IME contract
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      if (e.shiftKey) actions.previous();
      else actions.next();
    }
  };
  const replaceDisabled = editable ? undefined : 'you have view-only access';
  const gear: MenuEntry[] = [
    {
      kind: 'check',
      id: 'fuzzy',
      label: 'Fuzzy matching',
      checked: state.options.fuzzy,
      onCheckedChange: (on) => {
        actions.setOption('fuzzy', on);
      },
    },
    {
      kind: 'check',
      id: 'replace',
      label: 'Find and replace',
      checked: state.replaceShown,
      onCheckedChange: actions.setReplaceShown,
      shortcut: LABELS.findReplace,
      disabledReason: phone ? 'view only on phone' : undefined,
    },
    { kind: 'separator', id: 'scope' },
    {
      kind: 'check',
      id: 'formulas',
      label: 'Search formulas',
      checked: state.options.formulas,
      onCheckedChange: (on) => {
        actions.setOption('formulas', on);
      },
    },
    {
      kind: 'check',
      id: 'documents',
      label: 'Include workscape names',
      checked: state.options.documents,
      onCheckedChange: (on) => {
        actions.setOption('documents', on);
      },
    },
  ];

  return (
    <div
      className={clsx('gd-find', { 'gd-find--replace': state.replaceShown && !phone })}
      role="search"
      aria-label="Find"
      data-testid="find-bar"
    >
      <div className="gd-find__row">
        <Menu
          label="Find options"
          entries={gear}
          trigger={
            <Button
              size="sm"
              variant="ghost"
              className="gd-find__gear"
              icon={<Icon name="settings" size={15} />}
              aria-label="Find options"
              title="Find options"
            />
          }
        />
        <div className="gd-find__field">
          <Icon name="search" size={13} className="gd-find__glass" />
          <label htmlFor={fieldId} className="gd-visually-hidden">
            Find
          </label>
          <input
            ref={inputRef}
            id={fieldId}
            type="text"
            className="gd-find__input"
            value={state.query}
            placeholder="Find in this workscape"
            autoComplete="off"
            spellCheck={false}
            aria-keyshortcuts={ARIA_KEYS.find}
            aria-describedby={`${fieldId}-count`}
            onChange={(e) => {
              actions.setQuery(e.target.value);
            }}
            onKeyDown={onFieldKeyDown}
          />
          <span
            id={`${fieldId}-count`}
            className={clsx('gd-mono', 'gd-find__count', { 'gd-find__count--none': none })}
            data-testid="find-count"
          >
            {counter}
          </span>
        </div>
        <div className="gd-find__nav">
          <Tooltip content={<span>Previous match ({LABELS.findPrevious})</span>}>
            <Button
              size="sm"
              variant="ghost"
              icon={<Icon name="chevron-left" size={15} />}
              aria-label="Previous match"
              aria-keyshortcuts={ARIA_KEYS.findPrevious}
              title={`Previous match (${LABELS.findPrevious})`}
              disabled={none}
              onClick={actions.previous}
            />
          </Tooltip>
          <Tooltip content={<span>Next match ({LABELS.findNext})</span>}>
            <Button
              size="sm"
              variant="ghost"
              icon={<Icon name="chevron-right" size={15} />}
              aria-label="Next match"
              aria-keyshortcuts={ARIA_KEYS.findNext}
              title={`Next match (${LABELS.findNext})`}
              disabled={none}
              onClick={actions.next}
            />
          </Tooltip>
        </div>
        <Collapsible
          open={state.listOpen && !none}
          onOpenChange={actions.setListOpen}
          className="gd-find__results"
          contentClassName="gd-find__panel"
          trigger={
            <Button
              size="sm"
              variant="ghost"
              className="gd-find__list-toggle"
              aria-label={`Results${none ? '' : ` (${formatNumber(activeLocale(), total)})`}`}
              title="Show the result list"
              disabled={none}
            >
              Results
            </Button>
          }
        >
          <ResultList
            gd={gd}
            matches={state.matches}
            current={state.current}
            onPick={actions.goTo}
          />
        </Collapsible>
        <Button size="sm" variant="secondary" className="gd-find__done" onClick={actions.close}>
          Done
        </Button>
      </div>

      {state.replaceShown && !phone && (
        <div className="gd-find__row gd-find__row--replace">
          <span className="gd-find__gear-spacer" aria-hidden="true" />
          <div className="gd-find__field">
            <label htmlFor={replaceId} className="gd-visually-hidden">
              Replace with
            </label>
            <input
              id={replaceId}
              type="text"
              className="gd-find__input"
              value={state.replacement}
              placeholder="Replace with"
              autoComplete="off"
              spellCheck={false}
              disabled={!editable}
              onChange={(e) => {
                actions.setReplacement(e.target.value);
              }}
              onKeyDown={(e) => {
                // eslint-disable-next-line @typescript-eslint/no-deprecated -- required by the IME contract
                if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                if (e.code === 'Enter' || e.code === 'NumpadEnter') {
                  e.preventDefault();
                  actions.replaceCurrent();
                }
              }}
            />
          </div>
          <div className="gd-find__nav">
            <Button
              size="sm"
              variant="secondary"
              aria-disabled={replaceDisabled !== undefined || none || undefined}
              title={
                replaceDisabled === undefined
                  ? 'Replace the current match'
                  : `Replace — ${replaceDisabled}`
              }
              onClick={replaceDisabled === undefined && !none ? actions.replaceCurrent : undefined}
            >
              Replace
            </Button>
            <Button
              size="sm"
              variant="secondary"
              aria-disabled={replaceDisabled !== undefined || none || undefined}
              title={
                replaceDisabled === undefined
                  ? 'Replace every match in scope'
                  : `Replace all — ${replaceDisabled}`
              }
              onClick={replaceDisabled === undefined && !none ? actions.replaceAll : undefined}
            >
              All
            </Button>
          </div>
          {skippedText(state.skipped) !== '' && (
            <span className="gd-find__skipped" data-testid="find-skipped">
              {skippedText(state.skipped)}
            </span>
          )}
        </div>
      )}
      {/* ARCHITECTURE §3: a background operation that was retried automatically is a toast. */}
      <Toast
        open={state.notice !== null}
        onOpenChange={(o) => {
          if (!o) actions.dismissNotice();
        }}
        title={state.notice ?? ''}
      />
    </div>
  );
}

interface ResultListProps {
  gd: GedeDoc;
  matches: readonly SearchMatch[];
  current: number;
  onPick: (index: number) => void;
}

const GROUP_LABELS = { cell: 'Cells', graph: 'Graphs', document: 'Workscapes' } as const;
type GroupKind = keyof typeof GROUP_LABELS;
/** Header cells belong with the cells (DOC-06: they are addressable cells). */
function groupOf(match: SearchMatch): GroupKind {
  return match.target.kind === 'header' ? 'cell' : match.target.kind;
}

/**
 * FIND-06: the result list, in sync with the bar. Grouped by kind (cells,
 * graphs, workscape names — the last navigates). Each row is a button so it
 * is reachable with Tab and arrows; the current row carries `aria-current`.
 */
function ResultList({ gd, matches, current, onPick }: ResultListProps) {
  const groups: {
    kind: GroupKind;
    items: { match: SearchMatch; index: number }[];
  }[] = [];
  matches.forEach((match, index) => {
    const kind = groupOf(match);
    let group = groups.find((g) => g.kind === kind);
    if (group === undefined) {
      group = { kind, items: [] };
      groups.push(group);
    }
    group.items.push({ match, index });
  });
  return (
    <div className="gd-find__list" data-testid="find-results">
      {groups.map((group) => (
        <section key={group.kind} className="gd-find__group" aria-label={GROUP_LABELS[group.kind]}>
          <h3 className="gd-mono gd-find__group-label">{GROUP_LABELS[group.kind]}</h3>
          <ol className="gd-find__items">
            {group.items.map(({ match, index }) => (
              <li key={match.id}>
                <button
                  type="button"
                  className={clsx('gd-find__item', { 'gd-find__item--current': index === current })}
                  aria-current={index === current ? 'true' : undefined}
                  onClick={() => {
                    onPick(index);
                  }}
                >
                  <span className="gd-mono gd-find__item-where">{describeMatch(gd, match)}</span>
                  <span className="gd-find__item-text">{match.text}</span>
                  {match.distance > 0 && (
                    <span className="gd-mono gd-find__item-near" title="Fuzzy match">
                      ~{match.distance}
                    </span>
                  )}
                  {match.readOnly && match.target.kind !== 'document' && (
                    <Icon
                      name="locked"
                      size={13}
                      label="Not editable"
                      className="gd-find__item-lock"
                    />
                  )}
                </button>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
