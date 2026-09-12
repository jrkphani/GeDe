import { describe, expect, test } from 'vitest';

import { DependencyGraph } from './graph.js';

function flat(batches: readonly (readonly string[])[]): string[] {
  return batches.flatMap((b) => [...b]);
}

describe('DependencyGraph', () => {
  test('FX-06 editing a cell marks it and every transitive dependent dirty', () => {
    const g = new DependencyGraph();
    g.setDeps('b', ['a']);
    g.setDeps('c', ['b']);
    g.setDeps('d', ['c']);
    g.setDeps('x', []);
    g.clearDirty();

    expect(g.markDirty('a')).toBe(4);
    expect([...g.dirtyNodes()].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(g.isDirty('x')).toBe(false);
    expect(g.markDirty('missing')).toBe(0);
  });

  test('FX-06 topologicalBatches evaluates inputs before the formulas that read them', () => {
    const g = new DependencyGraph();
    g.setDeps('sum', ['a', 'b']);
    g.setDeps('concat', ['sum', 'c']);
    g.setDeps('total', ['sum', 'concat']);
    g.clearDirty();
    g.markDirty('a');

    const { batches, blocked, cycle } = g.topologicalBatches();
    expect(cycle).toBeNull();
    expect(blocked).toEqual([]);
    expect(batches).toEqual([['a'], ['sum'], ['concat'], ['total']]);
  });

  test('FX-06 clean nodes are inputs, not batch members', () => {
    const g = new DependencyGraph();
    g.setDeps('f', ['a', 'b']);
    g.clearDirty();
    g.markDirty('b');
    expect(g.topologicalBatches().batches).toEqual([['b'], ['f']]);
  });

  test('FX-06 independent formulas share a batch', () => {
    const g = new DependencyGraph();
    g.setDeps('f1', ['a']);
    g.setDeps('f2', ['a']);
    g.setDeps('g', ['f1', 'f2']);
    g.clearDirty();
    g.markDirty('a');
    const order = g.topologicalBatches().batches;
    expect(order[0]).toEqual(['a']);
    expect([...(order[1] ?? [])].sort()).toEqual(['f1', 'f2']);
    expect(order[2]).toEqual(['g']);
  });

  test('FX-06 a cycle is reported as a closed path and its members are blocked (⚠ circular)', () => {
    const g = new DependencyGraph();
    g.setDeps('a', ['c']);
    g.setDeps('b', ['a']);
    g.setDeps('c', ['b']);
    g.setDeps('downstream', ['c']);
    g.setDeps('upstream', []);
    g.setDeps('a', ['c', 'upstream']);

    const result = g.topologicalBatches();
    expect(result.batches).toEqual([['upstream']]);
    expect([...result.blocked].sort()).toEqual(['a', 'b', 'c', 'downstream']);
    expect(result.cycle).not.toBeNull();
    const cycle = result.cycle ?? [];
    expect(cycle[0]).toBe(cycle[cycle.length - 1]);
    expect(new Set(cycle)).toEqual(new Set(['a', 'b', 'c']));
    expect(g.findCycle()).not.toBeNull();
  });

  test('FX-06 a self-reference is the smallest cycle', () => {
    const g = new DependencyGraph();
    g.setDeps('a', ['a']);
    expect(g.topologicalBatches().cycle).toEqual(['a', 'a']);
  });

  test('FX-06 breaking the cycle by re-setting deps clears it', () => {
    const g = new DependencyGraph();
    g.setDeps('a', ['b']);
    g.setDeps('b', ['a']);
    expect(g.findCycle()).not.toBeNull();
    g.setDeps('b', []);
    expect(g.findCycle()).toBeNull();
    expect(flat(g.topologicalBatches().batches)).toEqual(['b', 'a']);
  });

  test('FX-06 removing a node drops its edges and dirties what read it', () => {
    const g = new DependencyGraph();
    g.setDeps('f', ['a']);
    g.clearDirty();
    g.removeNode('a');
    expect(g.hasNode('a')).toBe(false);
    expect(g.dependenciesOf('f').size).toBe(0);
    expect(g.isDirty('f')).toBe(true);
    expect(g.size).toBe(1);
  });

  test('FX-06 setDeps replaces edges in both directions', () => {
    const g = new DependencyGraph();
    g.setDeps('f', ['a', 'b']);
    g.setDeps('f', ['b', 'c']);
    expect([...g.dependenciesOf('f')].sort()).toEqual(['b', 'c']);
    expect(g.dependentsOf('a').size).toBe(0);
    expect(g.dependentsOf('c').has('f')).toBe(true);
  });

  test('FX-06 10k-node chain: dirty cascade and ordering stay under 200 ms', () => {
    const g = new DependencyGraph();
    const n = 10_000;
    for (let i = 1; i < n; i += 1) g.setDeps(`c${i}`, [`c${i - 1}`]);
    g.addNode('c0');
    g.clearDirty();

    const started = performance.now();
    g.markDirty('c0');
    const result = g.topologicalBatches();
    const elapsed = performance.now() - started;

    expect(result.cycle).toBeNull();
    expect(result.batches.length).toBe(n);
    expect(result.batches[0]).toEqual(['c0']);
    expect(result.batches[n - 1]).toEqual([`c${n - 1}`]);
    expect(elapsed).toBeLessThan(200);
  });

  test('FX-06 10k-node fan-in with a cycle at the tail still resolves quickly', () => {
    const g = new DependencyGraph();
    const inputs: string[] = [];
    for (let i = 0; i < 9_998; i += 1) inputs.push(`in${i}`);
    g.setDeps('sum', inputs);
    g.setDeps('loop', ['sum', 'loop2']);
    g.setDeps('loop2', ['loop']);
    g.clearDirty();

    const started = performance.now();
    for (const id of inputs) g.markDirty(id);
    const result = g.topologicalBatches();
    const elapsed = performance.now() - started;

    expect(result.batches.length).toBe(2);
    expect([...result.blocked].sort()).toEqual(['loop', 'loop2']);
    expect(result.cycle).not.toBeNull();
    expect(elapsed).toBeLessThan(200);
  });
});
