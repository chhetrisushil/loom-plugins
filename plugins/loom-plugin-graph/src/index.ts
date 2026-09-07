import type { MemoryEntry, MemorySearchOptions, MemoryStore } from "@loom/memory";
import { clampSearchLimit } from "@loom/memory";
import { Adjacency, type Direction, type Edge } from "./graph";

export { Adjacency } from "./graph";
export type { Direction, Edge, Reached } from "./graph";

/**
 * Where an edge came from. The distinction is not cosmetic: a DERIVED edge is a fact about
 * the current text of a document and is rebuilt whenever that text is rewritten, while a
 * LEARNED edge is the only copy of something an agent worked out and must survive both a
 * re-ingest and a restart.
 */
export type EdgeSource = "derived" | "learned";

export interface GraphMemoryStoreOptions {
  /**
   * The node an entry belongs to. Defaults to the part of the entry id before `#`, which
   * is `@loom/knowledge`'s passage convention (`docId#index`) — so a corpus's nodes are
   * its documents with no configuration. Entries with no id are their own node.
   *
   * Override it when your nodes are not documents (a node per user, per service, per
   * incident), and the rest of this store follows.
   */
  nodeOf?: (entry: MemoryEntry) => string;
  /**
   * Edges DERIVED from an entry's content, re-read on every write. The default reads
   * `content.meta.links` — an array of node ids — because `KnowledgeDoc.meta` travels onto
   * every passage, so a document can declare its own edges and `sync` maintains them for
   * free: revise the document and its edges are replaced with it.
   *
   * Return `[]` for content that declares none. This is called per entry, so keep it cheap.
   */
  edgesOf?: (entry: MemoryEntry, node: string) => readonly Edge[];
  /** How far `search` expands from a keyword/similarity match. Default 1; 0 disables expansion. */
  expandHops?: number;
  /**
   * How much a neighbour's score is discounted per hop, in (0, 1]. Default 0.4.
   *
   * It is strictly less than 1 by contract, not by taste: a neighbour is evidence that
   * something RELATED matched, never that this entry did, so it must not outrank a direct
   * hit. With a decay of 1 a well-connected node would win every query it is two hops from.
   */
  hopDecay?: number;
  /** Which way edges are followed when expanding a search. Default "both". */
  direction?: Direction;
}

/** A subgraph as a caller gets it back: nodes at their distance, plus the edges among them. */
export interface Subgraph {
  nodes: { node: string; hops: number }[];
  edges: Edge[];
}

const DEFAULT_HOPS = 1;
const DEFAULT_DECAY = 0.4;
/**
 * The key learned edges are persisted under, per graph key.
 *
 * They are stored as ORDINARY ENTRIES in the inner store, which is the whole reason this is
 * a decorator: a learned edge goes wherever the app's memory already goes — the SQLite file,
 * the Postgres database — and survives a restart with no second backend to configure. The
 * vector plugin can call its index derived data and rebuild it; an edge an agent worked out
 * from feedback is not derived from anything, and losing it loses the learning.
 */
const EDGE_KEY_SUFFIX = "::edges";

/** The default `nodeOf`: `@loom/knowledge`'s `docId#index` convention. */
export function documentNode(entry: MemoryEntry): string {
  const id = entry.id;
  if (id === undefined) return "";
  const cut = id.lastIndexOf("#");
  return cut > 0 ? id.slice(0, cut) : id;
}

/** The default `edgesOf`: `content.meta.links`, an array of node ids, related as "links". */
export function metaLinks(entry: MemoryEntry, node: string): Edge[] {
  const meta = (entry.content as { meta?: { links?: unknown } } | null)?.meta;
  const links = meta?.links;
  if (!Array.isArray(links)) return [];
  return links
    .filter((to): to is string => typeof to === "string" && to.length > 0)
    .map((to) => ({ from: node, to, rel: "links" }));
}

/**
 * A `MemoryStore` **decorator** that adds a graph over the entries of the store it wraps:
 * retrieval that expands from a match to its neighbours, and a traversal API for the cases
 * where retrieval is not the question.
 *
 * ## Why a decorator and not a store
 *
 * The other third-party backend (`loom-plugin-vector`) replaces the store, because an
 * embedding index is derived data — lose it and you re-embed. A graph is not always derived:
 * an edge an agent concluded from feedback ("this remedy fixed that symptom") is the only
 * copy of a thing that was learned. So this wraps the store the app already has — SQLite,
 * Postgres, or a vector store — and keeps learned edges in it as ordinary entries. Ranking
 * is delegated too: seeds come from the inner store's own `search`, so the graph composes
 * with FTS5, `tsvector` or cosine rather than reimplementing any of them.
 *
 * ## What it does to `search`
 *
 * Seeds are whatever the inner store matched. Expansion adds their neighbours, scored by
 * the seed's rank and discounted per hop, so a neighbour can never outrank a direct match.
 * **With no edges declared, this store IS the inner store** — which is why it passes
 * `runMemoryStoreConformance` unmodified: the kit's fixtures declare no edges, so there is
 * nothing to expand along. The kit cannot test expansion, and this plugin's own suite does.
 *
 * ## Two kinds of knowledge, and a warning
 *
 * DERIVED edges come from document text and are rebuilt on every write. LEARNED edges are
 * written through {@link link} and persist. Keep learned knowledge in a DIFFERENT SCOPE from
 * an authored corpus: `KnowledgeBase.sync` is a destructive reconcile — it deletes every
 * document not in the set you pass — so one `sync` of a wiki export would erase everything
 * an agent learned if the two shared a scope. This store cannot prevent that (it sees keys,
 * not corpora), so it is said here and in the README rather than implied.
 */
export class GraphMemoryStore implements MemoryStore {
  private readonly nodeOf: (entry: MemoryEntry) => string;
  private readonly edgesOf: (entry: MemoryEntry, node: string) => readonly Edge[];
  private readonly expandHops: number;
  private readonly hopDecay: number;
  private readonly direction: Direction;
  /** Per-key index, built lazily and dropped on any write to that key. */
  private readonly indexes = new Map<string, KeyIndex>();

  constructor(
    private readonly inner: MemoryStore,
    options: GraphMemoryStoreOptions = {}
  ) {
    this.nodeOf = options.nodeOf ?? documentNode;
    this.edgesOf = options.edgesOf ?? metaLinks;
    this.expandHops = options.expandHops ?? DEFAULT_HOPS;
    this.hopDecay = options.hopDecay ?? DEFAULT_DECAY;
    this.direction = options.direction ?? "both";
    if (!Number.isInteger(this.expandHops) || this.expandHops < 0) {
      throw new TypeError(`GraphMemoryStore: expandHops must be a non-negative integer`);
    }
    if (!(this.hopDecay > 0 && this.hopDecay <= 1)) {
      throw new TypeError(
        "GraphMemoryStore: hopDecay must be in (0, 1] — at 1 a neighbour ties with a direct match, above it a neighbour would outrank one"
      );
    }
  }

  // ── MemoryStore: storage is the inner store's, invalidation is ours ─────────

  async append(key: string, entry: MemoryEntry): Promise<void> {
    await this.inner.append(key, entry);
    this.indexes.delete(key);
  }

  async read(key: string): Promise<MemoryEntry[]> {
    return this.inner.read(key);
  }

  async clear(key: string): Promise<void> {
    await this.inner.clear(key);
    // The learned edges go too: they name nodes that no longer have entries, and a
    // graph that outlives its corpus answers questions about documents nobody can read.
    await this.inner.clear(edgeKey(key));
    this.indexes.delete(key);
  }

  async replace(key: string, entries: readonly MemoryEntry[]): Promise<void> {
    if (this.inner.replace === undefined) {
      await this.inner.clear(key);
      for (const entry of entries) await this.inner.append(key, entry);
    } else {
      await this.inner.replace(key, entries);
    }
    this.indexes.delete(key);
  }

  async remove(key: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    if (this.inner.remove === undefined) {
      const kept = await this.inner.read(key);
      const doomed = new Set(ids);
      await this.replace(
        key,
        kept.filter((e) => e.id === undefined || !doomed.has(e.id))
      );
      return;
    }
    await this.inner.remove(key, ids);
    this.indexes.delete(key);
  }

  async close(): Promise<void> {
    await this.inner.close?.();
  }

  /**
   * Relevance retrieval, expanded along edges.
   *
   * The inner store answers the question it is good at; this adds the neighbours of what it
   * found. `limit` bounds the FINAL result, and seeds are fetched at the same limit — so an
   * expansion cannot push a direct match out of the page it belongs on.
   */
  async search(
    key: string,
    query: string,
    opts: MemorySearchOptions = {}
  ): Promise<MemoryEntry[]> {
    if (this.inner.search === undefined) {
      throw new Error(
        "GraphMemoryStore: the wrapped store does not implement search(). Graph expansion starts from a keyword or similarity match, so there is nothing to expand from — wrap a store that searches (SqliteMemoryStore, PostgresMemoryStore, InMemoryMemoryStore, loom-plugin-vector)."
      );
    }
    const limit = clampSearchLimit(opts.limit);
    const seeds = await this.inner.search(key, query, { limit });
    if (seeds.length === 0 || this.expandHops === 0) return seeds.slice(0, limit);

    const index = await this.indexFor(key);
    const seedIds = new Set(seeds.map((e) => e.id ?? ""));
    // Rank position stands in for the inner store's score, which the SPI does not expose:
    // the contract is "best first", so position IS the ranking, and it is the only thing
    // portable across BM25, ts_rank and cosine.
    const scored = new Map<string, number>();
    seeds.forEach((entry, i) => {
      const score = 1 / (i + 1);
      const node = this.nodeOf(entry);
      scored.set(node, Math.max(scored.get(node) ?? 0, score));
    });

    const reached = index.adjacency.walk(
      [...scored.keys()],
      this.expandHops,
      this.direction
    );
    const out: { entry: MemoryEntry; score: number; order: number }[] = seeds.map((entry, i) => ({
      entry,
      score: 1 / (i + 1),
      order: i,
    }));
    let order = seeds.length;
    for (const { node, hops, seed } of reached) {
      if (hops === 0) continue;
      // Scored against the seed it actually hangs off, not the best seed anywhere: a
      // neighbour of the fifth-ranked match is weaker evidence than a neighbour of the first.
      const score = (scored.get(seed) ?? 0) * this.hopDecay ** hops;
      for (const entry of index.byNode.get(node) ?? []) {
        if (seedIds.has(entry.id ?? "")) continue;
        out.push({ entry, score, order: order++ });
      }
    }
    // Descending score; ties by the order they were produced, which is seed rank then a
    // sorted BFS — deterministic, so a recorded retrieval replays to the same passages.
    out.sort((a, b) => b.score - a.score || a.order - b.order);
    return out.slice(0, limit).map((s) => s.entry);
  }

  // ── The traversal API: for when retrieval is not the question ───────────────

  /**
   * Record a LEARNED edge, durably.
   *
   * This is the write path a feedback loop uses: an agent concludes that one thing relates
   * to another and writes it down. It is stored as an entry in the inner store, so it
   * outlives the process and rides the same backup as everything else.
   *
   * Idempotent — the same triple written twice is one edge. `rel` is your vocabulary; this
   * store never interprets it, it only filters by it.
   *
   * NOT recorded through `ctx.decide`, because it is a WRITE. Reading the graph to build a
   * prompt is the part that needs recording — see {@link neighbours}.
   */
  async link(key: string, edge: Edge): Promise<void> {
    if (edge.from.length === 0 || edge.to.length === 0) {
      throw new TypeError("GraphMemoryStore.link: an edge needs a non-empty `from` and `to`");
    }
    const id = edgeId(edge);
    const existing = await this.inner.read(edgeKey(key));
    if (existing.some((e) => e.id === id)) return;
    await this.inner.append(edgeKey(key), { id, content: edge, timestamp: 0 });
    this.indexes.delete(key);
  }

  /** Remove a learned edge. Idempotent; a derived edge is removed by editing its document. */
  async unlink(key: string, edge: Edge): Promise<void> {
    const id = edgeId(edge);
    if (this.inner.remove !== undefined) await this.inner.remove(edgeKey(key), [id]);
    else {
      const kept = (await this.inner.read(edgeKey(key))).filter((e) => e.id !== id);
      await this.inner.clear(edgeKey(key));
      for (const e of kept) await this.inner.append(edgeKey(key), e);
    }
    this.indexes.delete(key);
  }

  /**
   * The nodes within `hops` of `node`, nearest first, EXCLUDING the node itself.
   *
   * A flow that puts these in a prompt must record them — wrap the call in `ctx.decide`.
   * The graph changes as documents are revised and as the agent learns, so an unrecorded
   * traversal replays into a different prompt, for exactly the reason `recallRelevant`
   * requires `decide`. This store cannot enforce that (it has no execution), so the rule
   * lives here and in the README.
   */
  async neighbours(
    key: string,
    node: string,
    opts: { hops?: number; rel?: string; direction?: Direction } = {}
  ): Promise<string[]> {
    const index = await this.indexFor(key);
    return index.adjacency
      .walk([node], opts.hops ?? 1, opts.direction ?? this.direction, opts.rel)
      .filter((r) => r.hops > 0)
      .sort((a, b) => a.hops - b.hops || a.node.localeCompare(b.node))
      .map((r) => r.node);
  }

  /** The bounded subgraph around `node`: nodes at their distance, and the edges among them. */
  async subgraph(
    key: string,
    node: string,
    opts: { hops?: number; direction?: Direction } = {}
  ): Promise<Subgraph> {
    const index = await this.indexFor(key);
    const nodes = index.adjacency
      .walk([node], opts.hops ?? 1, opts.direction ?? this.direction)
      .sort((a, b) => a.hops - b.hops || a.node.localeCompare(b.node));
    return { nodes, edges: index.adjacency.edgesWithin(nodes.map((n) => n.node)) };
  }

  /** The shortest path between two nodes, inclusive, or `null` if none within `maxHops`. */
  async path(
    key: string,
    from: string,
    to: string,
    opts: { maxHops?: number; direction?: Direction } = {}
  ): Promise<string[] | null> {
    const index = await this.indexFor(key);
    return index.adjacency.path(from, to, opts.maxHops ?? 4, opts.direction ?? this.direction);
  }

  /** Every entry belonging to a node, in append order. */
  async entriesOf(key: string, node: string): Promise<MemoryEntry[]> {
    return [...((await this.indexFor(key)).byNode.get(node) ?? [])];
  }

  /** Edge count, for tests and for an operator asking whether the graph is populated at all. */
  async edgeCount(key: string): Promise<number> {
    return (await this.indexFor(key)).adjacency.size;
  }

  /**
   * Build (or reuse) the index for a key.
   *
   * Lazy and whole-key: the first graph operation after a write re-reads the key. That is
   * one read of a scope on a path that is already doing retrieval, and the alternative —
   * maintaining the index incrementally through a decorator that does not own the storage —
   * would have to trust that nothing else writes to the same store, which is exactly the
   * assumption a decorator cannot make.
   */
  private async indexFor(key: string): Promise<KeyIndex> {
    const cached = this.indexes.get(key);
    if (cached !== undefined) return cached;

    const adjacency = new Adjacency();
    const byNode = new Map<string, MemoryEntry[]>();
    for (const entry of await this.inner.read(key)) {
      const node = this.nodeOf(entry);
      if (node.length === 0) continue;
      const list = byNode.get(node);
      if (list === undefined) byNode.set(node, [entry]);
      else list.push(entry);
      for (const edge of this.edgesOf(entry, node)) adjacency.add(edge);
    }
    for (const entry of await this.inner.read(edgeKey(key))) {
      const edge = entry.content as Edge;
      if (typeof edge?.from === "string" && typeof edge?.to === "string") adjacency.add(edge);
    }
    const index: KeyIndex = { adjacency, byNode };
    this.indexes.set(key, index);
    return index;
  }
}

interface KeyIndex {
  adjacency: Adjacency;
  byNode: Map<string, MemoryEntry[]>;
}

const edgeKey = (key: string): string => `${key}${EDGE_KEY_SUFFIX}`;
/** Stable, so writing the same triple twice is one edge on any backend. */
const edgeId = (edge: Edge): string => `${edge.from} ${edge.rel} ${edge.to}`;
