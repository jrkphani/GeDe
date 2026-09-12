/**
 * Incremental dependency graph (PRD §20 "DAG state engine", FX-06).
 *
 * Nodes are stable cell ids — never A1 addresses, which change under insert and
 * delete. Edges point from a formula cell to the cells it reads. Editing a cell
 * marks it and everything downstream dirty; `topologicalBatches()` then yields
 * the dirty nodes in an order where every node's inputs are evaluated before it.
 * A cycle is reported as the path of ids that closes it so the renderer can put
 * `⚠ circular` on each member.
 *
 * All operations are O(touched nodes + edges); Maps and Sets keep 10k-node
 * graphs comfortably inside the 50 ms recompute budget.
 */

export interface TopologyResult {
  /** Dirty nodes grouped so that every node in batch *n* depends only on nodes in batches < *n* or on clean nodes. */
  readonly batches: readonly (readonly string[])[];
  /** Dirty nodes that could not be ordered because they sit on or downstream of a cycle. */
  readonly blocked: readonly string[];
  /** One cycle among the blocked nodes, as a closed path (`['a', 'b', 'a']`), or `null` when acyclic. */
  readonly cycle: readonly string[] | null;
}

export class DependencyGraph {
  /** id → ids it reads. */
  private readonly reads = new Map<string, Set<string>>();
  /** id → ids that read it. */
  private readonly readBy = new Map<string, Set<string>>();
  private readonly dirty = new Set<string>();

  get size(): number {
    return this.reads.size;
  }

  hasNode(id: string): boolean {
    return this.reads.has(id);
  }

  addNode(id: string): void {
    if (!this.reads.has(id)) {
      this.reads.set(id, new Set());
      this.readBy.set(id, new Set());
    }
  }

  /** Remove a node and its edges. Nodes that read it become dirty — their input is gone. */
  removeNode(id: string): void {
    const deps = this.reads.get(id);
    if (!deps) return;
    for (const dep of deps) this.readBy.get(dep)?.delete(id);
    const dependents = this.readBy.get(id) ?? new Set<string>();
    for (const dependent of dependents) this.reads.get(dependent)?.delete(id);
    this.reads.delete(id);
    this.readBy.delete(id);
    this.dirty.delete(id);
    for (const dependent of dependents) this.markDirty(dependent);
  }

  /**
   * Replace the set of ids `id` reads. Unknown ids are added as nodes. The node
   * itself is marked dirty (its formula changed), which cascades downstream.
   */
  setDeps(id: string, deps: Iterable<string>): void {
    this.addNode(id);
    const next = new Set<string>();
    for (const dep of deps) {
      if (dep === id) {
        // A self-reference is the smallest cycle; keep it so detection reports it.
        next.add(dep);
        continue;
      }
      this.addNode(dep);
      next.add(dep);
    }
    const current = this.reads.get(id) ?? new Set<string>();
    for (const dep of current) {
      if (!next.has(dep)) this.readBy.get(dep)?.delete(id);
    }
    for (const dep of next) {
      if (!current.has(dep)) this.readBy.get(dep)?.add(id);
    }
    this.reads.set(id, next);
    this.markDirty(id);
  }

  dependenciesOf(id: string): ReadonlySet<string> {
    return this.reads.get(id) ?? new Set<string>();
  }

  dependentsOf(id: string): ReadonlySet<string> {
    return this.readBy.get(id) ?? new Set<string>();
  }

  /** Mark `id` and every transitive dependent dirty. Returns the number of newly dirtied nodes. */
  markDirty(id: string): number {
    if (!this.reads.has(id)) return 0;
    let added = 0;
    const stack: string[] = [id];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined || this.dirty.has(current)) continue;
      this.dirty.add(current);
      added += 1;
      const dependents = this.readBy.get(current);
      if (dependents) {
        for (const dependent of dependents) {
          if (!this.dirty.has(dependent)) stack.push(dependent);
        }
      }
    }
    return added;
  }

  isDirty(id: string): boolean {
    return this.dirty.has(id);
  }

  dirtyNodes(): ReadonlySet<string> {
    return this.dirty;
  }

  /** Clear the dirty flag on the given ids, or on every node when none are given. */
  clearDirty(ids?: Iterable<string>): void {
    if (ids === undefined) {
      this.dirty.clear();
      return;
    }
    for (const id of ids) this.dirty.delete(id);
  }

  /**
   * Order the dirty nodes for evaluation (Kahn's algorithm over the dirty
   * subgraph). Clean nodes are treated as already-evaluated inputs. Does not
   * clear dirty flags — call `clearDirty` once the batches have been evaluated.
   */
  topologicalBatches(): TopologyResult {
    const indegree = new Map<string, number>();
    for (const id of this.dirty) {
      let n = 0;
      const deps = this.reads.get(id);
      if (deps) {
        for (const dep of deps) if (this.dirty.has(dep)) n += 1;
      }
      indegree.set(id, n);
    }

    const batches: string[][] = [];
    let frontier: string[] = [];
    for (const [id, n] of indegree) if (n === 0) frontier.push(id);

    let ordered = 0;
    while (frontier.length > 0) {
      batches.push(frontier);
      ordered += frontier.length;
      const next: string[] = [];
      for (const id of frontier) {
        const dependents = this.readBy.get(id);
        if (!dependents) continue;
        for (const dependent of dependents) {
          const n = indegree.get(dependent);
          if (n === undefined) continue; // clean node: not part of this pass
          if (n === 1) {
            indegree.set(dependent, 0);
            next.push(dependent);
          } else {
            indegree.set(dependent, n - 1);
          }
        }
      }
      frontier = next;
    }

    if (ordered === this.dirty.size) {
      return { batches, blocked: [], cycle: null };
    }

    const blocked: string[] = [];
    for (const [id, n] of indegree) if (n > 0) blocked.push(id);
    const blockedSet = new Set(blocked);
    return { batches, blocked, cycle: this.findCycleWithin(blockedSet) };
  }

  /**
   * Find a cycle anywhere in the graph, dirty or not. Returns the closed path or
   * `null`. Iterative depth-first search with three colours; O(V + E).
   */
  findCycle(): readonly string[] | null {
    return this.findCycleWithin(null);
  }

  private findCycleWithin(within: ReadonlySet<string> | null): readonly string[] | null {
    const WHITE = 0;
    const GREY = 1;
    const BLACK = 2;
    const colour = new Map<string, 0 | 1 | 2>();
    const candidates = within ?? this.reads.keys();

    for (const start of candidates) {
      if ((colour.get(start) ?? WHITE) !== WHITE) continue;
      // Each frame: the node and an iterator over its dependencies.
      const path: string[] = [];
      const stack: { id: string; deps: Iterator<string> }[] = [];
      colour.set(start, GREY);
      path.push(start);
      stack.push({ id: start, deps: this.depsIterator(start, within) });

      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (frame === undefined) break;
        const step = frame.deps.next();
        if (step.done === true) {
          colour.set(frame.id, BLACK);
          stack.pop();
          path.pop();
          continue;
        }
        const dep = step.value;
        const c = colour.get(dep) ?? WHITE;
        if (c === GREY) {
          const from = path.indexOf(dep);
          return [...path.slice(from), dep];
        }
        if (c === WHITE) {
          colour.set(dep, GREY);
          path.push(dep);
          stack.push({ id: dep, deps: this.depsIterator(dep, within) });
        }
      }
    }
    return null;
  }

  private depsIterator(id: string, within: ReadonlySet<string> | null): Iterator<string> {
    const deps = this.reads.get(id) ?? new Set<string>();
    if (within === null) return deps.values();
    const filtered: string[] = [];
    for (const dep of deps) if (within.has(dep)) filtered.push(dep);
    return filtered.values();
  }
}
