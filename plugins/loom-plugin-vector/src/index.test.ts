import { runMemoryStoreConformance } from "@loom/conformance";
import { describe, expect, it } from "vitest";
import type { Embedder } from "./index";
import { VectorMemoryStore, cosine, hashingEmbedder } from "./index";

// The published kit, unmodified, against a store that answers by cosine similarity
// instead of by inverted index. This is the point of the package: it says whether
// `MemoryStore.search` was a general contract or a description of FTS.
runMemoryStoreConformance(() => new VectorMemoryStore(), "VectorMemoryStore");

const entry = (content: unknown, timestamp = 1): { content: unknown; timestamp: number } => ({
  content,
  timestamp,
});

describe("VectorMemoryStore ranks by similarity", () => {
  it("puts the closer passage first even though both match", async () => {
    const store = new VectorMemoryStore();
    await store.append("k", entry("connection pool saturated and queueing"));
    await store.append("k", entry("pool of contractors for the annual report"));
    const hits = await store.search("k", "connection pool saturated");
    expect(hits[0]?.content).toBe("connection pool saturated and queueing");
  });

  it("returns [] rather than the nearest thing in the corpus", async () => {
    // The behaviour that separates a store from a ranking function. Cosine is
    // defined against every entry, so without a floor "unrelated" would return the
    // least-unrelated passage and `search` would never be empty on a non-empty scope.
    const store = new VectorMemoryStore();
    await store.append("k", entry("checkpoint tuning notes"));
    expect(await store.search("k", "unrelated")).toEqual([]);
  });

  it("lets the floor be tuned per embedder", async () => {
    const store = new VectorMemoryStore({ minScore: 0.99 });
    await store.append("k", entry("vacuum finished"));
    // A near-miss under a strict floor, a hit under the default one.
    expect(await store.search("k", "why did the vacuum take so long")).toEqual([]);
    const lenient = new VectorMemoryStore({ minScore: 0.05 });
    await lenient.append("k", entry("vacuum finished"));
    expect(await lenient.search("k", "why did the vacuum take so long")).toHaveLength(1);
  });
});

describe("the Embedder seam", () => {
  // A toy embedder with a hand-authored vocabulary — NOT shipped, and not a
  // suggestion. It exists to demonstrate the one thing the hashing default cannot
  // do and a real model can: match a passage that shares no words with the query.
  const VOCAB: Record<string, number[]> = {
    // axis 0: "database is out of capacity", axis 1: "scheduling", axis 2: unrelated
    saturated: [1, 0, 0],
    exhausted: [0.98, 0.02, 0],
    pool: [0.9, 0, 0.1],
    connections: [0.92, 0, 0.08],
    cron: [0, 1, 0],
    schedule: [0, 0.97, 0.03],
    pottery: [0, 0, 1],
  };
  const toyEmbedder: Embedder = (text) => {
    const vector = [0, 0, 0];
    for (const term of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      const known = VOCAB[term];
      if (known === undefined) continue;
      for (let i = 0; i < 3; i++) vector[i] = (vector[i] as number) + (known[i] as number);
    }
    const length = Math.hypot(...vector);
    return length === 0 ? vector : vector.map((v) => v / length);
  };

  it("finds a passage that shares NO words with the query", async () => {
    const store = new VectorMemoryStore({ embed: toyEmbedder, minScore: 0.5 });
    await store.append("k", entry("the connections pool is exhausted"));
    await store.append("k", entry("the cron schedule slipped"));

    // Not one term in common with the stored passage — an inverted index returns
    // nothing here, by construction.
    const hits = await store.search("k", "saturated");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toBe("the connections pool is exhausted");
  });

  it("the shipped default cannot do that, and says so", async () => {
    // Honesty check on the README's claim: hashing gives a vector space, not
    // semantics. If this ever starts passing, the default changed and the docs lie.
    const store = new VectorMemoryStore({ minScore: 0.1 });
    await store.append("k", entry("the connections pool is exhausted"));
    expect(await store.search("k", "saturated")).toEqual([]);
  });
});

describe("hashingEmbedder", () => {
  it("is deterministic and unit-length", () => {
    const embed = hashingEmbedder(64);
    const a = embed("replica lag");
    expect(embed("replica lag")).toEqual(a);
    expect(Math.hypot(...a)).toBeCloseTo(1, 10);
  });

  it("scores identical text at 1 and disjoint text at 0", () => {
    const embed = hashingEmbedder();
    expect(cosine(embed("replica lag"), embed("replica lag"))).toBeCloseTo(1, 10);
    expect(cosine(embed("replica lag"), embed("pottery kiln"))).toBeCloseTo(0, 10);
  });

  it("embeds term-less text to a zero vector, which cannot be anyone's neighbour", () => {
    const embed = hashingEmbedder();
    expect(cosine(embed("?! ,."), embed("anything"))).toBe(0);
  });
});
