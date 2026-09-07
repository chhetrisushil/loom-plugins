import type { MemoryEntry, MemorySearchOptions, MemoryStore } from "@loom/memory";
import { clampSearchLimit, searchableText, tokenize } from "@loom/memory";
import { type Embedder, cosine, hashingEmbedder } from "./embed";

export { hashingEmbedder, cosine, normalize } from "./embed";
export type { Embedder } from "./embed";

export interface VectorMemoryStoreOptions {
  /** How text becomes a vector. Defaults to the offline hashing embedder. */
  embed?: Embedder;
  /**
   * The similarity floor for a hit, in [0, 1]. Default 0.1.
   *
   * A vector store needs one, and that is the whole difference between this seam
   * and a ranking function. Cosine similarity is defined against EVERY stored
   * entry, so an unthresholded `search` returns the entire scope ordered by score
   * — including, for "unrelated", the least-unrelated thing in the corpus. The
   * MemoryStore contract says a query that matches nothing returns `[]`, so
   * "matches" has to mean something, and for a similarity backend the only
   * available meaning is a floor.
   *
   * Tune it against your embedder, not against this default: what counts as a
   * near-miss is a property of the model, and the number is not portable between
   * one embedder and another.
   */
  minScore?: number;
}

interface Indexed {
  entry: MemoryEntry;
  vector: number[];
}

/**
 * A {@link MemoryStore} that retrieves by **vector similarity** rather than by
 * keyword match — the second, unlike implementation of `MemoryStore.search`, and
 * the one that says whether that seam was a general contract or a description of
 * an inverted index.
 *
 * It is not: the store indexes `searchableText(entry)` and rejects term-less
 * queries with `tokenize`, exactly as the SQLite and Postgres backends do, and
 * then answers with cosine similarity over embeddings instead of BM25 over an
 * inverted index. The published `runMemoryStoreConformance` passes unchanged.
 *
 * Entries and vectors are held in memory: an embedding is derived data, and
 * rebuilding it is a re-embed, not a recovery problem. Persist by pairing this
 * with a durable store, or by replacing the maps with your vector database — the
 * cosine search below is what a real index does faster, not differently.
 */
export class VectorMemoryStore implements MemoryStore {
  private readonly entries = new Map<string, Indexed[]>();
  private readonly embed: Embedder;
  private readonly minScore: number;

  constructor(options: VectorMemoryStoreOptions = {}) {
    this.embed = options.embed ?? hashingEmbedder();
    this.minScore = options.minScore ?? 0.1;
  }

  private index(entry: MemoryEntry): Indexed {
    return { entry, vector: this.embed(searchableText(entry)) };
  }

  async append(key: string, entry: MemoryEntry): Promise<void> {
    this.entries.set(key, [...(this.entries.get(key) ?? []), this.index(entry)]);
  }

  async read(key: string): Promise<MemoryEntry[]> {
    return (this.entries.get(key) ?? []).map((row) => row.entry);
  }

  async clear(key: string): Promise<void> {
    this.entries.delete(key);
  }

  /** OPTIONAL: the whole list at once, so eviction cannot half-apply. */
  async replace(key: string, entries: readonly MemoryEntry[]): Promise<void> {
    if (entries.length === 0) this.entries.delete(key);
    else this.entries.set(key, entries.map((entry) => this.index(entry)));
  }

  /**
   * OPTIONAL: delete by entry id, keeping the survivors in append order.
   *
   * Cheap here for the same reason it is cheap in an inverted index and expensive in a
   * naive one: the vectors of the entries that stay are untouched, so a document revised
   * in a corpus of 100,000 passages re-embeds its own passages and nothing else. Without
   * this the runtime rewrites the whole key through `replace` above — which, on THIS
   * backend, re-embeds every surviving entry. The fallback is correct, and it is the
   * difference between one embedding call and a hundred thousand.
   */
  async remove(key: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const rows = this.entries.get(key);
    if (rows === undefined) return;
    const doomed = new Set(ids);
    // `row.entry.id === undefined` first: an entry with no id must never match, and a
    // Set lookup would happily succeed if `undefined` were ever passed in as an id.
    const kept = rows.filter((row) => row.entry.id === undefined || !doomed.has(row.entry.id));
    if (kept.length === rows.length) return;
    if (kept.length === 0) this.entries.delete(key);
    else this.entries.set(key, kept);
  }

  /**
   * OPTIONAL: relevance retrieval, best first.
   *
   * Ranked by cosine similarity and cut at {@link VectorMemoryStoreOptions.minScore}.
   * Ties break toward the more recently appended entry, so the order is total and a
   * result set is reproducible — a store whose ranking wobbled between two equally
   * scored entries would make the recorded retrieval depend on sort stability.
   */
  async search(key: string, query: string, opts: MemorySearchOptions = {}): Promise<MemoryEntry[]> {
    // Same gate the keyword backends apply: a query with no terms is not a query.
    // Skipping it would let punctuation embed to a vector that still has a nearest
    // neighbour, and `search("k", "?!")` would return the corpus.
    if (tokenize(query).length === 0) return [];
    const rows = this.entries.get(key);
    if (rows === undefined || rows.length === 0) return [];

    const queryVector = this.embed(query);
    const scored = rows
      .map((row, index) => ({ row, index, score: cosine(queryVector, row.vector) }))
      .filter((hit) => hit.score >= this.minScore);
    scored.sort((a, b) => b.score - a.score || b.index - a.index);
    // Through the shared clamp, like every other backend: raw, a negative limit means
    // `.slice(0, -1)` here and NO LIMIT on an SQL backend, so the seam's own conformance
    // kit caught this plugin the moment the case existed.
    return scored.slice(0, clampSearchLimit(opts.limit)).map((hit) => hit.row.entry);
  }
}
