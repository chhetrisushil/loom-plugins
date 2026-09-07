import { runMemoryStoreConformance } from "@loom/conformance";
import { KnowledgeBase } from "@loom/knowledge";
import { InMemoryMemoryStore, TieredMemory } from "@loom/memory";
import type { MemoryEntry } from "@loom/memory";
import { describe, expect, it } from "vitest";
import { GraphMemoryStore } from "./index";

// ── The published contract, unmodified ───────────────────────────────────────
//
// The kit's fixtures declare no edges, so there is nothing to expand along and this
// store behaves exactly as the one it wraps. That is the point rather than a loophole:
// a graph backend that changed what `search` means for an UNLINKED corpus would be a
// different seam wearing the same interface.
runMemoryStoreConformance(
  () => new GraphMemoryStore(new InMemoryMemoryStore()),
  "GraphMemoryStore (over InMemoryMemoryStore)"
);

const entry = (id: string, content: unknown): MemoryEntry => ({ id, content, timestamp: 1_000 });
const doc = (id: string, text: string, links?: string[]): MemoryEntry =>
  entry(`${id}#0`, { text, ...(links !== undefined && { meta: { links } }) });

const contentOf = (entries: MemoryEntry[]): string[] =>
  entries.map((e) => (e.content as { text: string }).text);

describe("graph-expanded retrieval", () => {
  it("returns a neighbour of a match that the inner store would never have found", async () => {
    const inner = new InMemoryMemoryStore();
    const store = new GraphMemoryStore(inner);
    await store.append("k", doc("RB-101", "replica lag is the replay delay", ["RB-204"]));
    await store.append("k", doc("RB-204", "recycle the pool before raising the ceiling"));

    // The wrapped store, asked directly: one hit, because only one document says "replica".
    expect(contentOf(await (inner.search as NonNullable<typeof inner.search>)("k", "replica lag")))
      .toEqual(["replica lag is the replay delay"]);

    const hits = await store.search("k", "replica lag");
    expect(contentOf(hits)).toEqual([
      "replica lag is the replay delay",
      "recycle the pool before raising the ceiling",
    ]);
  });

  it("never lets a neighbour outrank a direct match", async () => {
    // The property that makes expansion safe to leave on. A neighbour is evidence that
    // something RELATED matched; ranked above a direct hit it would answer a different
    // question than the one asked.
    const store = new GraphMemoryStore(new InMemoryMemoryStore());
    await store.append("k", doc("A", "checkpoint tuning", ["HUB"]));
    await store.append("k", doc("B", "checkpoint spikes and flushes", ["HUB"]));
    await store.append("k", doc("HUB", "unrelated hub document"));

    const hits = await store.search("k", "checkpoint");
    const texts = contentOf(hits);
    expect(texts.slice(0, 2).every((t) => t.includes("checkpoint"))).toBe(true);
    expect(texts[texts.length - 1]).toBe("unrelated hub document");
  });

  it("expands zero hops when told to, and is then exactly the inner store", async () => {
    const inner = new InMemoryMemoryStore();
    const store = new GraphMemoryStore(inner, { expandHops: 0 });
    await store.append("k", doc("RB-101", "replica lag", ["RB-204"]));
    await store.append("k", doc("RB-204", "pool exhaustion"));
    expect(contentOf(await store.search("k", "replica lag"))).toEqual(["replica lag"]);
  });

  it("returns [] for a query that matches nothing, however connected the graph is", async () => {
    // The floor a similarity backend has to choose, and that a graph gets for free: with
    // no seed there is nothing to expand FROM, so a connected corpus does not become a
    // machine that always answers.
    const store = new GraphMemoryStore(new InMemoryMemoryStore());
    await store.append("k", doc("A", "alpha", ["B"]));
    await store.append("k", doc("B", "bravo", ["A"]));
    expect(await store.search("k", "nothing-matches-this")).toEqual([]);
  });

  it("honours limit across seeds AND neighbours", async () => {
    const store = new GraphMemoryStore(new InMemoryMemoryStore());
    for (const id of ["A", "B", "C"]) await store.append("k", doc(id, `shared term ${id}`, ["Z"]));
    await store.append("k", doc("Z", "the hub"));
    expect(await store.search("k", "shared", { limit: 2 })).toHaveLength(2);
  });

  it("terminates on a cycle", async () => {
    const store = new GraphMemoryStore(new InMemoryMemoryStore(), { expandHops: 10 });
    await store.append("k", doc("A", "alpha", ["B"]));
    await store.append("k", doc("B", "bravo", ["C"]));
    await store.append("k", doc("C", "charlie", ["A"]));
    expect(contentOf(await store.search("k", "alpha")).sort()).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("refuses to wrap a store that cannot search", async () => {
    const bare = {
      append: async () => {},
      read: async () => [],
      clear: async () => {},
    };
    const store = new GraphMemoryStore(bare);
    await expect(store.search("k", "anything")).rejects.toThrow(/does not implement search/);
  });

  it("rejects a decay that would let a neighbour win", () => {
    expect(() => new GraphMemoryStore(new InMemoryMemoryStore(), { hopDecay: 1.5 })).toThrow(
      /hopDecay/
    );
    expect(() => new GraphMemoryStore(new InMemoryMemoryStore(), { expandHops: -1 })).toThrow(
      /expandHops/
    );
  });
});

describe("traversal", () => {
  const populated = async (): Promise<GraphMemoryStore> => {
    const store = new GraphMemoryStore(new InMemoryMemoryStore());
    await store.append("k", doc("symptom", "checkout times out", ["cause"]));
    await store.append("k", doc("cause", "pool saturated", ["remedy"]));
    await store.append("k", doc("remedy", "recycle the pool"));
    await store.append("k", doc("unrelated", "vacuum tuning"));
    return store;
  };

  it("walks outward by hops, nearest first", async () => {
    const store = await populated();
    expect(await store.neighbours("k", "symptom", { hops: 1 })).toEqual(["cause"]);
    expect(await store.neighbours("k", "symptom", { hops: 2 })).toEqual(["cause", "remedy"]);
    expect(await store.neighbours("k", "unrelated", { hops: 3 })).toEqual([]);
  });

  it("follows direction: what this points AT is not what points at this", async () => {
    const store = await populated();
    expect(await store.neighbours("k", "cause", { direction: "out" })).toEqual(["remedy"]);
    expect(await store.neighbours("k", "cause", { direction: "in" })).toEqual(["symptom"]);
  });

  it("finds the shortest path, and refuses one longer than the bound", async () => {
    const store = await populated();
    expect(await store.path("k", "symptom", "remedy")).toEqual(["symptom", "cause", "remedy"]);
    expect(await store.path("k", "symptom", "remedy", { maxHops: 1 })).toBeNull();
    expect(await store.path("k", "symptom", "unrelated")).toBeNull();
  });

  it("returns a bounded subgraph with the edges among its nodes", async () => {
    const store = await populated();
    const sub = await store.subgraph("k", "symptom", { hops: 2 });
    expect(sub.nodes.map((n) => n.node)).toEqual(["symptom", "cause", "remedy"]);
    expect(sub.edges).toEqual([
      { from: "cause", to: "remedy", rel: "links" },
      { from: "symptom", to: "cause", rel: "links" },
    ]);
  });

  it("is deterministic — the same graph walks the same way whatever the ingest order", async () => {
    // A traversal that feeds a prompt is recorded through ctx.decide, so it must replay to
    // the same nodes. Map iteration is insertion order, which is the order documents
    // happened to be written in.
    const forward = new GraphMemoryStore(new InMemoryMemoryStore());
    const backward = new GraphMemoryStore(new InMemoryMemoryStore());
    const docs = [doc("A", "a", ["X", "M", "B"]), doc("B", "b"), doc("M", "m"), doc("X", "x")];
    for (const d of docs) await forward.append("k", d);
    for (const d of [...docs].reverse()) await backward.append("k", d);
    expect(await forward.neighbours("k", "A")).toEqual(await backward.neighbours("k", "A"));
    expect(await forward.neighbours("k", "A")).toEqual(["B", "M", "X"]);
  });
});

describe("learned edges — knowledge that came from a feedback loop", () => {
  it("persists an edge the agent wrote, across a restart", async () => {
    // The reason this is a DECORATOR. An embedding index is derived data and can be
    // rebuilt; an edge an agent concluded from feedback is the only copy of what it
    // learned. It goes in the store the app already has, and survives with it.
    const inner = new InMemoryMemoryStore();
    const first = new GraphMemoryStore(inner);
    await first.append("k", doc("symptom", "checkout times out"));
    await first.append("k", doc("remedy", "recycle the pool"));
    await first.link("k", { from: "symptom", to: "remedy", rel: "fixed-by" });

    // A second process over the same store — no graph state carried across.
    const second = new GraphMemoryStore(inner);
    expect(await second.neighbours("k", "symptom")).toEqual(["remedy"]);
    expect(contentOf(await second.search("k", "checkout"))).toEqual([
      "checkout times out",
      "recycle the pool",
    ]);
  });

  it("is idempotent, and unlink removes it", async () => {
    const store = new GraphMemoryStore(new InMemoryMemoryStore());
    const edge = { from: "a", to: "b", rel: "fixed-by" };
    await store.link("k", edge);
    await store.link("k", edge);
    expect(await store.edgeCount("k")).toBe(1);
    await store.unlink("k", edge);
    await store.unlink("k", edge);
    expect(await store.edgeCount("k")).toBe(0);
  });

  it("keeps relations apart, so one loop's edges do not answer another's question", async () => {
    const store = new GraphMemoryStore(new InMemoryMemoryStore());
    await store.link("k", { from: "symptom", to: "remedy", rel: "fixed-by" });
    await store.link("k", { from: "symptom", to: "note", rel: "mentions" });
    expect(await store.neighbours("k", "symptom", { rel: "fixed-by" })).toEqual(["remedy"]);
    expect(await store.neighbours("k", "symptom", { rel: "mentions" })).toEqual(["note"]);
    expect(await store.neighbours("k", "symptom")).toEqual(["note", "remedy"]);
  });

  it("survives a document being revised — a learned edge is not derived from the text", async () => {
    // The distinction that matters for a feedback loop: re-ingesting the document the
    // edge points at must not delete the edge, or every corpus sync would erase what the
    // agent learned about it.
    const store = new GraphMemoryStore(new InMemoryMemoryStore());
    await store.append("k", doc("symptom", "checkout times out"));
    await store.link("k", { from: "symptom", to: "remedy", rel: "fixed-by" });
    await store.remove("k", ["symptom#0"]);
    await store.append("k", doc("symptom", "checkout times out (revised)"));
    expect(await store.neighbours("k", "symptom")).toEqual(["remedy"]);
  });

  it("clearing the key clears its learned edges too", async () => {
    // A graph that outlives its corpus answers questions about documents nobody can read.
    const store = new GraphMemoryStore(new InMemoryMemoryStore());
    await store.link("k", { from: "a", to: "b", rel: "fixed-by" });
    await store.clear("k");
    expect(await store.edgeCount("k")).toBe(0);
  });
});

describe("over a KnowledgeBase corpus", () => {
  const corpus = async (): Promise<{ kb: KnowledgeBase; store: GraphMemoryStore }> => {
    const store = new GraphMemoryStore(new InMemoryMemoryStore());
    const kb = new KnowledgeBase({
      memory: new TieredMemory({ tiers: { semantic: {} }, store }),
      scope: "runbooks",
    });
    return { kb, store };
  };

  it("takes a document's nodes and edges straight from `meta`, with no configuration", async () => {
    // `nodeOf` defaults to the `docId#index` convention and `edgesOf` to `meta.links`, so a
    // corpus becomes a graph by declaring links in the documents — and `sync` maintains
    // them, because a revised document's passages are rewritten with it.
    const { kb, store } = await corpus();
    await kb.sync([
      { id: "RB-101", title: "Replica lag", text: "Cancel the blocking query.", meta: { links: ["RB-204"] } },
      { id: "RB-204", title: "Pool", text: "Recycle the pool first." },
    ]);
    expect(await store.neighbours("semantic::runbooks", "RB-101")).toEqual(["RB-204"]);

    const passages = await kb.retrieve("blocking query", { decide: async (_k, c) => c() });
    // The pool runbook has no matching term; it is here because the replica-lag runbook
    // links to it.
    expect(passages.map((p) => p.docId)).toEqual(["RB-101", "RB-204"]);
  });

  it("drops a document's derived edges when the document is retired", async () => {
    const { kb, store } = await corpus();
    await kb.sync([
      { id: "RB-101", text: "Cancel the blocking query.", meta: { links: ["RB-204"] } },
      { id: "RB-204", text: "Recycle the pool first." },
    ]);
    await kb.sync([{ id: "RB-204", text: "Recycle the pool first." }]);
    expect(await store.neighbours("semantic::runbooks", "RB-101")).toEqual([]);
  });
});
