/**
 * The per-viewer view store (ADR-026, SORT-01..06, AUTH-09): one entry per
 * (user, document) on the device, one view per table, validated on read,
 * gone at sign-out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_VIEW } from '@gede/core';

import {
  clearViewState,
  NULL_VIEW_STORE,
  openViewStore,
  readGroupBy,
  VIEW_STATE_PREFIX,
  viewStateKey,
} from './view-state.js';

beforeEach(() => {
  localStorage.clear();
});

describe('view store', () => {
  it('SORT-01 stores one view per table under the (user, document) key and notifies subscribers', () => {
    const store = openViewStore('sub-1', 'doc-a');
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.get('t1')).toBe(EMPTY_VIEW);
    store.set('t1', { sortBy: { colId: 'c', mode: 'az' }, filter: null, groupBy: 'c' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(readGroupBy(store, 't1')).toBe('c');
    expect(readGroupBy(store, 't2')).toBeNull();
    const key = viewStateKey('sub-1', 'doc-a');
    expect(key).toBe(`${VIEW_STATE_PREFIX}sub-1.doc-a`);
    expect(JSON.parse(localStorage.getItem(key) ?? '{}')).toEqual({
      t1: { sortBy: { colId: 'c', mode: 'az' }, filter: null, groupBy: 'c' },
    });
    // Another user or document never sees it; the same pair reads it back.
    expect(openViewStore('sub-2', 'doc-a').get('t1')).toBe(EMPTY_VIEW);
    expect(openViewStore('sub-1', 'doc-b').get('t1')).toBe(EMPTY_VIEW);
    expect(openViewStore('sub-1', 'doc-a').get('t1').groupBy).toBe('c');
    // An empty view removes the entry; the last entry removes the key.
    store.set('t1', EMPTY_VIEW);
    expect(localStorage.getItem(key)).toBeNull();
    store.clear('t1');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('SORT-01 a stored value of the wrong shape reads as none rather than throwing', () => {
    const key = viewStateKey('sub-1', 'doc-a');
    localStorage.setItem(key, 'not json');
    expect(openViewStore('sub-1', 'doc-a').get('t1')).toBe(EMPTY_VIEW);
    localStorage.setItem(
      key,
      JSON.stringify({ t1: { sortBy: { colId: 'c', mode: 'sideways' }, groupBy: 7 }, t2: 'x' }),
    );
    const store = openViewStore('sub-1', 'doc-a');
    expect(store.get('t1')).toBe(EMPTY_VIEW);
    expect(store.get('t2')).toBe(EMPTY_VIEW);
  });

  it('AUTH-09 clearViewState removes every view on the device and nothing else', () => {
    openViewStore('sub-1', 'doc-a').set('t', { sortBy: null, filter: null, groupBy: 'c' });
    openViewStore('sub-2', 'doc-b').set('t', { sortBy: null, filter: null, groupBy: 'c' });
    localStorage.setItem('gede.locale', 'ta-IN');
    expect(clearViewState().sort()).toEqual([
      viewStateKey('sub-1', 'doc-a'),
      viewStateKey('sub-2', 'doc-b'),
    ]);
    expect(localStorage.getItem('gede.locale')).toBe('ta-IN');
    expect(localStorage.length).toBe(1);
  });

  it('SORT-01 the null store holds nothing, for a document opened without a signed-in user', () => {
    NULL_VIEW_STORE.set('t', { sortBy: null, filter: null, groupBy: 'c' });
    expect(NULL_VIEW_STORE.get('t')).toBe(EMPTY_VIEW);
    expect(localStorage.length).toBe(0);
  });
});
