/**
 * The adjacency index and the walks over it.
 *
 * Kept separate from the store because it is the half with no I/O and no SPI: given
 * nodes and directed, labelled edges, answer "what is near this" deterministically and
 * within a bound. Everything the store and the traversal API do is one of these three
 * walks.
 */

/** A directed, labelled edge. `rel` is the caller's vocabulary — this file never reads it. */
export interface Edge {
  from: string;
  to: string;
  rel: string;
}

/** One node reached by a walk: how far, and which seed got there first. */
export interface Reached {
  node: string;
  hops: number;
  /** The seed this node was reached from. A seed's own `seed` is itself. */
  seed: string;
}

/**
 * A directed multigraph with an incoming index.
 *
 * Both directions are stored because a knowledge graph is asked questions in both:
 * "what does this cite" and "what cites this" are different questions, and a corpus
 * only ever declares one of them. Building the reverse index at write time makes the
 * second question O(neighbours) instead of O(edges).
 */
export class Adjacency {
  private readonly out = new Map<string, Map<string, Set<string>>>();
  private readonly in = new Map<string, Map<string, Set<string>>>();

  add(edge: Edge): void {
    index(this.out, edge.from, edge.to, edge.rel);
    index(this.in, edge.to, edge.from, edge.rel);
  }

  /** Drop every edge touching `node` in either direction. */
  remove(node: string): void {
    for (const [target] of this.out.get(node) ?? []) this.in.get(target)?.delete(node);
    for (const [source] of this.in.get(node) ?? []) this.out.get(source)?.delete(node);
    this.out.delete(node);
    this.in.delete(node);
  }

  clear(): void {
    this.out.clear();
    this.in.clear();
  }

  get size(): number {
    let n = 0;
    for (const targets of this.out.values()) n += targets.size;
    return n;
  }

  /** Direct neighbours, in the given direction, optionally filtered by relation. */
  adjacent(node: string, direction: Direction, rel?: string): string[] {
    const maps =
      direction === "out"
        ? [this.out]
        : direction === "in"
          ? [this.in]
          : [this.out, this.in];
    const found = new Set<string>();
    for (const map of maps) {
      for (const [target, rels] of map.get(node) ?? []) {
        if (rel === undefined || rels.has(rel)) found.add(target);
      }
    }
    // Sorted, always. A recorded retrieval built from a traversal has to replay to the
    // same prompt, and Map iteration order is insertion order — which depends on the
    // order documents happened to be ingested in.
    return [...found].sort();
  }

  /**
   * Breadth-first walk from `seeds`, bounded by `maxHops`, returning each node once at
   * the SHORTEST distance it was reached at.
   *
   * Bounded on purpose: an unbounded walk over a well-connected corpus returns the whole
   * corpus, which is the graph equivalent of an unthresholded similarity search — it
   * always finds something, so "related" stops meaning anything. Seeds are returned at
   * hop 0, so a caller can tell a match from a neighbour of a match.
   */
  walk(seeds: readonly string[], maxHops: number, direction: Direction, rel?: string): Reached[] {
    const seen = new Map<string, Reached>();
    let frontier: Reached[] = [];
    // Seeds sorted, so a node reachable from two of them at the same distance is always
    // attributed to the same one — a caller scoring by seed must not depend on input order.
    for (const seed of [...seeds].sort()) {
      if (seen.has(seed)) continue;
      const reached = { node: seed, hops: 0, seed };
      seen.set(seed, reached);
      frontier.push(reached);
    }
    for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
      const next: Reached[] = [];
      for (const from of frontier) {
        for (const neighbour of this.adjacent(from.node, direction, rel)) {
          // First visit wins: BFS reaches a node at its shortest distance, and a cycle
          // only ever offers a longer one. The seed travels with it, so a caller can score
          // a neighbour against the match it actually hangs off.
          if (seen.has(neighbour)) continue;
          const reached = { node: neighbour, hops: hop, seed: from.seed };
          seen.set(neighbour, reached);
          next.push(reached);
        }
      }
      frontier = next;
    }
    return [...seen.values()];
  }

  /**
   * The shortest path from `from` to `to`, inclusive, or `null` if none within `maxHops`.
   *
   * Bidirectional would be faster; this is deliberately the simple BFS, because the bound
   * is small (a path over 4 hops is not evidence of anything a prompt should cite) and one
   * comprehensible implementation beats a faster one nobody re-derives.
   */
  path(from: string, to: string, maxHops: number, direction: Direction): string[] | null {
    if (from === to) return [from];
    const parent = new Map<string, string>([[from, from]]);
    let frontier = [from];
    for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const neighbour of this.adjacent(node, direction)) {
          if (parent.has(neighbour)) continue;
          parent.set(neighbour, node);
          if (neighbour === to) return rebuild(parent, from, to);
          next.push(neighbour);
        }
      }
      frontier = next;
    }
    return null;
  }

  /** Every edge whose endpoints are both in `nodes`, sorted. */
  edgesWithin(nodes: Iterable<string>): Edge[] {
    const inside = new Set(nodes);
    const edges: Edge[] = [];
    for (const from of inside) {
      for (const [to, rels] of this.out.get(from) ?? []) {
        if (!inside.has(to)) continue;
        for (const rel of rels) edges.push({ from, to, rel });
      }
    }
    return edges.sort(
      (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.rel.localeCompare(b.rel)
    );
  }
}

/** Which way an edge may be followed. `both` treats the graph as undirected. */
export type Direction = "out" | "in" | "both";

function index(
  map: Map<string, Map<string, Set<string>>>,
  from: string,
  to: string,
  rel: string
): void {
  let targets = map.get(from);
  if (targets === undefined) {
    targets = new Map();
    map.set(from, targets);
  }
  let rels = targets.get(to);
  if (rels === undefined) {
    rels = new Set();
    targets.set(to, rels);
  }
  rels.add(rel);
}

function rebuild(parent: Map<string, string>, from: string, to: string): string[] {
  const path = [to];
  let at = to;
  while (at !== from) {
    at = parent.get(at) as string;
    path.push(at);
  }
  return path.reverse();
}
