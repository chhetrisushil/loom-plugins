# loom-plugin-graph

A **knowledge graph over Loom's memory seam**: retrieval that expands from a match to its
neighbours, plus a traversal API for the questions retrieval cannot ask.

It is a **decorator**, not a store. It wraps the `MemoryStore` your app already has —
`SqliteMemoryStore`, `PostgresMemoryStore`, or `loom-plugin-vector` — and adds a graph over
the entries in it.

```ts
import { GraphMemoryStore } from "loom-plugin-graph";
import { SqliteMemoryStore } from "@loom/plugin-sqlite";

const memoryStore = new GraphMemoryStore(new SqliteMemoryStore(".loom/events.db"));
export default defineConfig({ storage: sqliteStorage({ dir: ".loom" }), memoryStore });
```

## Why a decorator

`loom-plugin-vector` *replaces* the store, and that is right for it: an embedding index is
derived data, so losing it costs a re-embed and nothing else.

A graph is not always derived. An edge an agent concluded from feedback — *this remedy fixed
that symptom* — is the only copy of something that was learned. So this plugin keeps its
learned edges as ordinary entries in the store it wraps: they ride the same file, the same
database and the same backup as everything else, with no second backend to configure.

Ranking is delegated for the same reason. Seeds come from the inner store's own `search`, so
the graph composes with FTS5, `tsvector` or cosine instead of reimplementing any of them.

## Two kinds of knowledge

|  | Derived edges | Learned edges |
| --- | --- | --- |
| Where from | a document's own content (`meta.links` by default) | `store.link(key, edge)` at run time |
| Lifecycle | rebuilt on every write; a revised document replaces its edges | persist until `unlink` or `clear` |
| Fits | an authored corpus — a wiki, a runbook set, a docs directory | an agent's feedback loop |

**Keep them in different scopes.** `KnowledgeBase.sync` is a destructive reconcile: it deletes
every document not in the set you pass. One `sync` of a wiki export would erase everything an
agent learned if the two shared a scope. This plugin cannot prevent that — it sees keys, not
corpora — so it is said here rather than implied.

## Retrieval

```ts
const passages = await kb.retrieve("checkout is timing out", { decide: ctx.decide, limit: 5 });
```

The inner store answers first. Expansion then adds the neighbours of what it found, scored by
the seed's rank and discounted per hop (`hopDecay`, default 0.4), so **a neighbour can never
outrank a direct match** — it is evidence that something *related* matched, never that this
entry did.

Two properties are worth knowing:

- **With no edges declared, this store IS the inner store.** That is why it passes
  `runMemoryStoreConformance` unmodified — the kit's fixtures declare no edges, so there is
  nothing to expand along. The kit cannot test expansion; this plugin's own suite does.
- **A query that matches nothing still returns `[]`.** A similarity backend has to choose a
  score floor to make that true; a graph gets it free, because with no seed there is nothing
  to expand *from*. A connected corpus does not become a machine that always answers.

## Traversal

For the questions that are not "what is relevant to this text":

```ts
await store.neighbours(key, "symptom:checkout-timeout", { hops: 2, rel: "fixed-by" });
await store.subgraph(key, "svc:checkout", { hops: 2 });   // nodes + the edges among them
await store.path(key, "symptom:x", "remedy:y");           // shortest path, or null
await store.link(key, { from: "symptom:x", to: "remedy:y", rel: "fixed-by" });
```

**A traversal that feeds a prompt must be recorded.** Wrap it in `ctx.decide`, for exactly the
reason `recallRelevant` requires one: the graph changes as documents are revised and as the
agent learns, so an unrecorded traversal replays into a different prompt. `link` is a write
and needs no recording; reading the graph to build a prompt is the part that does.

Every walk is **bounded** (`hops`, default 1; `maxHops` on `path`, default 4) and **sorted**,
so the same graph walks the same way whatever order its documents were ingested in — a
recorded traversal has to replay to the same nodes.

## Over a `KnowledgeBase`

The defaults are `@loom/knowledge`'s conventions, so a corpus becomes a graph with no
configuration: `nodeOf` reads the document id out of the passage id (`docId#index`), and
`edgesOf` reads `meta.links`. Declaring links in a document is enough, and `sync` maintains
them — revise the document and its edges are rewritten with it.

```ts
await kb.sync([
  { id: "RB-101", text: "…", meta: { links: ["RB-204"] } },
  { id: "RB-204", text: "…" },
]);
```

Override both when your nodes are not documents (a node per service, per user, per incident).

## Options

| Option | Default | |
| --- | --- | --- |
| `nodeOf` | `docId` from `docId#index` | which node an entry belongs to |
| `edgesOf` | `content.meta.links` | edges derived from an entry |
| `expandHops` | `1` | how far `search` expands; `0` disables expansion |
| `hopDecay` | `0.4` | per-hop discount, in `(0, 1]` — must be < 1 or a neighbour could win |
| `direction` | `"both"` | which way edges are followed |

## Limits, stated

- **The index is per key, lazy, and dropped on write.** The first graph query after a write
  re-reads that key. A decorator does not own the storage, so maintaining an index
  incrementally would mean trusting that nothing else writes to the same store — an assumption
  a decorator cannot make.
- **`nodeOf`'s default couples to `@loom/knowledge`'s id convention.** That is a default, not a
  requirement; pass your own and nothing else changes.
- **Edges are not typed or validated.** `rel` is your vocabulary — this plugin filters by it
  and never interprets it.

## Development

```bash
pnpm install     # needs ../loom checked out beside loom-plugins
pnpm -r build
pnpm -r test
```
