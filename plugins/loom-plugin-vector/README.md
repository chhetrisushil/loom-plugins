# loom-plugin-vector

A `MemoryStore` for [Loom](https://github.com/chhetrisushil/loom) that retrieves by
**vector similarity** instead of by keyword match, with the embedder as a parameter.

```ts
import { VectorMemoryStore } from "loom-plugin-vector";
import { defineConfig } from "@loom/app";

defineConfig({
  memoryStore: new VectorMemoryStore({
    embed: (text) => myModel.embed(text),   // any (text) => number[]
    minScore: 0.35,
  }),
});
```

Then use it the way any memory is used — the store is invisible above the seam:

```ts
const passages = await memory.recallRelevant("semantic", userId, question, {
  decide: ctx.decide,
  limit: 5,
});
```

## Why this package exists

Loom's `MemoryStore.search` shipped with two implementations, and both were keyword
indexes: SQLite FTS5 and Postgres `tsvector`. A seam with one *kind* of implementation
is a description of that implementation until something unlike it arrives.

This is the unlike one. It indexes the same `searchableText(entry)` and rejects
term-less queries with the same `tokenize`, because those are the contract — and then
answers with cosine similarity over embeddings rather than BM25 over an inverted index.
**`runMemoryStoreConformance` passes unmodified**, which is the result the package was
written to produce: the seam is a contract, not a shape.

SPI **2.1.0** added the other half of that contract and, in doing so, named this store as
its exception: a *term-based* backend must derive its terms with `queryTerms`, which
deduplicates and caps them, because OR-ing one word 20,000 times cannot change which rows
match and cost SQLite 32.7 seconds to say so. A similarity backend derives no terms to OR,
and truncating a question would move it in embedding space rather than shorten a boolean
expression — so this one embeds the whole query, at a cost linear in its length. The clause
exists because the seam has an implementation unlike the others; this is that implementation
reading it back.

## The one thing a similarity backend must decide

Cosine similarity is defined against *every* stored entry. Ranked and unthresholded,
`search("k", "unrelated")` returns the whole scope in order — including, at the top, the
least-unrelated thing you have. The MemoryStore contract says a query that matches
nothing returns `[]`, so "matches" has to mean something, and for a vector store the
only available meaning is a **floor**: `minScore`.

`limit` is a different matter and not tunable: it goes through `@loom/memory`'s
`clampSearchLimit`, which every backend must use. Passed through raw, a negative limit means
`.slice(0, -1)` in an array-backed store and *no limit at all* on an SQL one — so the SPI fixed
the meaning rather than leaving each backend to pick. The seam's own conformance kit caught this
plugin the day that case was added.

That floor is a property of your embedder, not of this package. The default of `0.1` is
tuned for the built-in hashing embedder and is not portable to a real model — measure it
against your own before trusting it. A test here pins both directions: a strict floor
turns a partial match into `[]`, a lenient one lets it through.

## The default embedder is honest, not clever

`hashingEmbedder()` is the hashing trick: bag-of-words counts hashed into 512 buckets,
signed, L2-normalised. Offline, deterministic, dependency-free — and **not semantic**.
"saturated" and "exhausted" are as far apart in it as any two unrelated words. It exists
so the store runs and tests without a model.

The suite makes that explicit rather than leaving it to the prose: one test shows a
hand-authored toy embedder matching a passage that shares *no words* with the query
(which an inverted index cannot do by construction), and the next test shows the shipped
default failing exactly that case. If the second ever starts passing, this README has
become a lie and the test says so.

## `remove` is where a similarity backend differs most from a keyword one

`MemoryStore.remove(key, ids)` (SPI 2.1.0) is optional, and the runtime falls back to
read-filter-`replace` when a backend omits it. That fallback is correct everywhere and
uniquely expensive *here*: `replace` re-indexes the list it is given, so on this store
deleting one document's passages would re-embed every surviving passage in the corpus.
Implementing `remove` drops the survivors' vectors untouched — one embedding call instead
of a hundred thousand — which is the same reason the SQL backends implement it as one
indexed `DELETE` rather than a rewrite.

The conformance kit's six `remove` cases run against this store unmodified, including the
one a similarity backend is most likely to get wrong: a removed entry must leave the
*index*, not merely the rows. Here they are the same map, so it is free; in a real vector
database they are not.

## Persistence

Entries and vectors live in memory. An embedding is derived data — losing it is a
re-embed, not a recovery problem — and `@loom/memory` is deliberately separate from the
durable event log. For a durable corpus, back it with a real vector database: the cosine
loop in `search` is what such an index does faster, not differently.

## Development

```bash
pnpm install     # needs ../loom checked out beside loom-plugins
pnpm -r build
pnpm -r test
```
