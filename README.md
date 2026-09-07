# loom-plugins

Community home for **third-party (3P) Loom plugins** — and the reference template for writing
your own. You do **not** have to host your plugin here: a Loom plugin is just a package you
publish under any name/scope; this repo is the curated, discoverable index plus a starting point.

For the framework itself, see [loom](https://github.com/chhetrisushil/loom). First-party (1P)
plugins live in that repo under `plugins/` as `@loom/plugin-*`; the canonical plugin docs are
[`docs/plugins.md`](https://github.com/chhetrisushil/loom/blob/main/docs/plugins.md) and
[ADR 0043](https://github.com/chhetrisushil/loom/blob/main/docs/adr/0043-plugin-packaging-and-1p-3p-separation.md).

## What a Loom plugin is

A package that contributes a concrete implementation of an existing Loom **seam** and/or a
**preset** — a pure function returning a `Partial<LoomConfig>` (or a singleton value like a
`StorageConfig`). It is **statically imported** and, for every seam but one, passed to
`defineConfig`. There is no plugin runtime, no discovery, no hook bus, no lifecycle — using a
plugin is always an explicit `import` plus one line of config.

**`loom plugin seams` is the authoritative list** — it prints each seam's SPI, whether a
conformance kit exists, and the exact line that wires it, straight from the seam registry rather
than from a copy in prose. Ten seams today:

| Seam | Implements | Seam | Implements |
| --- | --- | --- | --- |
| `store` | `EventStore` (+ `SnapshotStore`, `BranchRegistry`) | `projection` | `ProjectionRuntime` |
| `dispatcher` | `ExecutionDispatcher` | `worker` | `WorkerRuntime` |
| `telemetry` | `TelemetryAdapter` | `llm` | `LlmProvider` |
| `middleware` | `EffectMiddleware` | `authorizer` | `CapabilityAuthorizer` |
| `timer` | `TimerStore` | `policy` | `Policy` (flow code, not `defineConfig`) |

A *renderer* is not a seam — renderers consume the projection/surface output, and ship as ordinary
packages.

### The contract

1. implement an existing **SPI** and/or export a **preset** `(opts) => Partial<LoomConfig>`;
2. be **statically imported** and passed to `defineConfig` — no `node_modules` scanning (P5);
3. contribute only to **existing seams** — never a kernel hook, never a reducer into the replay
   fold (durable custom facts are ordinary app events folded by user-space projections);
4. be **byte-identical to hand-wiring** after boot (zero runtime overhead);
5. ship **conformance tests** for each SPI you implement (`@loom/conformance` — the import
   `loom plugin check` looks for);
6. be **sugar, never a gate** — everything a plugin does, an app can also hand-wire.

## Naming & discovery

- Name it **`loom-plugin-<name>`** (or `@yourscope/loom-plugin-<name>`).
- Add the npm keyword **`loom-plugin`** so it is discoverable.
- Depend only on the `@loom/*` **SPI** packages, not on kernel internals. (They are not on npm
  yet — inside this repo they resolve via the root `pnpm.overrides`, which `link:` them from a
  sibling `../loom` checkout; see the template's README for what to do when you copy it out.)

## Quick start

Copy [`templates/loom-plugin-template`](templates/loom-plugin-template), rename it, and implement
your seam. Wiring it into an app is symmetric with a first-party plugin — no privileged `kind:`:

```ts
import { defineConfig } from "@loom/app";
import { myStorage } from "loom-plugin-mystore";

export const app = defineConfig({ storage: myStorage({ url: process.env.DB_URL! }) });
```

**The `policy` seam is the exception**, and it is worth knowing before you assume the shape
above. A `Policy` ([`loom-plugin-linucb`](plugins/loom-plugin-linucb)) is consumed from *flow
code*, never from the composition root:

```ts
import { decideWithPolicy } from "@loom/learning";

const route = await decideWithPolicy(ctx, "route", policy, context, actions);
```

That is deliberate: the runtime never learns a policy exists, so a learned choice can only reach
a run through `ctx.decide`, where it stays recorded, replayable and auditable. Everything else
about authoring one is identical — same naming, same peer-dependency rule, same conformance
requirement.

## Security (read this)

A preset and any adapter constructor run at **composition time with full host authority, and
cannot be sandboxed** — K7 data-plane isolation governs *tool effects at runtime*, not the code
that builds your runtime. Importing a plugin grants it boot-time authority, exactly like any
dependency you `import`. Vet 3P plugins as you would any dependency; a plugin listed here is
**not** vetted by Loom core (that is what the `@loom/` first-party scope is for).

## Submitting a plugin

Open a PR adding your published package to the index below (name, one-line description, the SPI it
implements, and a link). Listing is discovery, not endorsement.

## Index

| Plugin | Seam | Description |
|---|---|---|
| [`loom-plugin-linucb`](plugins/loom-plugin-linucb) | `Policy` (`@loom/learning`) | LinUCB contextual bandit — picks per-observation, with honest ε-greedy propensities so the log stays evaluable |
| [`loom-plugin-vector`](plugins/loom-plugin-vector) | `MemoryStore` (`@loom/memory`) | Retrieval by vector similarity with a pluggable `Embedder` — the unlike implementation of a seam whose only two backends were keyword indexes; passes the published conformance kit unmodified |
| _(your plugin here)_ | | |
