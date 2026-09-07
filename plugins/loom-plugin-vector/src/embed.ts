import { tokenize } from "@loom/memory";

/**
 * Turn text into a dense vector. THE seam of this plugin — swap in a real model
 * (`text-embedding-3-small`, a local sentence-transformer, a hosted endpoint) and
 * nothing else changes.
 *
 * Must be deterministic for a given input: the store embeds an entry once at write
 * time and the query at read time, and a replay that re-ran retrieval against a
 * drifting embedder would rank a different set. (Loom records the retrieval through
 * `ctx.decide`, so a replay does not re-run it — but the first run is what gets
 * recorded, and an embedder that is nondeterministic within one run is simply broken.)
 */
export type Embedder = (text: string) => number[];

/** FNV-1a over UTF-16 code units — small, fast, and stable across processes. */
function hash(term: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < term.length; i++) {
    h ^= term.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The default embedder: the **hashing trick** — bag-of-words counts hashed into a
 * fixed number of buckets, L2-normalised.
 *
 * Offline, dependency-free, deterministic, and honest about what it is: this gives
 * you a genuine vector space with cosine similarity, and NOT semantics. "saturated"
 * and "exhausted" are as far apart here as any two unrelated words. It exists so the
 * store is runnable and testable without a model; the moment you want a query to
 * match a passage that shares no words with it, pass a real `embed`.
 */
export function hashingEmbedder(dimensions = 512): Embedder {
  return (text: string): number[] => {
    const vector = new Array<number>(dimensions).fill(0);
    for (const term of tokenize(text)) {
      const bucket = hash(term) % dimensions;
      // Signed hashing: a second bit decides the sign, which cancels rather than
      // compounds the bias when two terms collide.
      vector[bucket] = (vector[bucket] as number) + ((hash(`${term}#sign`) & 1) === 0 ? 1 : -1);
    }
    return normalize(vector);
  };
}

/** Scale to unit length, so cosine similarity is a plain dot product. */
export function normalize(vector: number[]): number[] {
  let sumOfSquares = 0;
  for (const value of vector) sumOfSquares += value * value;
  if (sumOfSquares === 0) return vector;
  const length = Math.sqrt(sumOfSquares);
  return vector.map((value) => value / length);
}

/** Cosine similarity of two ALREADY-normalised vectors. Mismatched lengths ⇒ 0. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number);
  return dot;
}
