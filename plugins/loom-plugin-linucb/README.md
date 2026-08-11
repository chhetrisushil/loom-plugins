# `loom-plugin-linucb`

A **LinUCB contextual bandit** for Loom — a third-party implementation of the
[`Policy` SPI](https://github.com/chhetrisushil/loom/tree/main/packages/learning) from
`@loom/learning`.

This package exists to demonstrate the division of labour loom settled on:

| | Who owns it |
|---|---|
| the durable `(context, action, propensity, reward)` record | **loom** (`ctx.decide`, ADR 0079) |
| credit assignment, off-policy evaluation, promotion gate | **loom** (`@loom/learning`, ADR 0080) |
| **the learning algorithm** | **this package** — third-party |

Loom deliberately ships no reinforcement learning. It ships the substrate, and the maths lives
out here where it can be swapped without touching a kernel.

## Install

```console
$ pnpm add loom-plugin-linucb
```

Requires `@loom/learning` as a peer.

## Use

```ts
import { decideWithPolicy } from "@loom/learning";
import { LinUcbPolicy, numericFeatures } from "loom-plugin-linucb";

const policy = new LinUcbPolicy<string>({
  version: "2026-08-12",
  ...numericFeatures(["tokens", "retries"]),  // → features + dimension
  alpha: 1,        // confidence width; higher explores more
  epsilon: 0.05,   // keeps the log evaluable — see below
});

// inside a flow
const route = await decideWithPolicy(ctx, "route", policy, { tokens, retries }, routes);
```

Training happens **offline**, from logs the runtime already wrote:

```ts
import { trajectories, steps } from "@loom/learning";

const policy = new LinUcbPolicy<string>({ ...numericFeatures(["tokens", "retries"]) });
const applied = policy.fit(steps(trajectories(events)));
console.log(applied, policy.evidence());   // how much evidence, per arm

fs.writeFileSync("policy.json", JSON.stringify(policy.snapshot()));
```

Then evaluate the new snapshot against real traffic *before* shipping it:

```console
$ loom learn eval --db ./loom.db --policy ./candidate.js
```

## Set `epsilon`

With `epsilon: 0` (the default) LinUCB is deterministic: every choice is logged with
propensity `1`, and a log produced that way **contains no counterfactuals**. It can never
support an unbiased off-policy estimate of the *next* candidate — the loop trains itself into
a corner and the evaluation report will tell you so.

A small `epsilon` (0.05–0.1) buys the exploration that keeps the log evaluable. The propensity
reported is exact:

```
P(a) = ε/k + (1−ε)·1[a = argmax]
```

An over- or under-reported propensity silently biases every later evaluation and nothing
downstream can detect it, so this is tested as a distribution that sums to 1.

## How it works

Disjoint LinUCB keeps one ridge-regression model per arm:

```
score(a) = θₐ·x + α·√(xᵀ Aₐ⁻¹ x)          θₐ = Aₐ⁻¹ bₐ
```

The first term predicts the reward; the second is the width of that prediction's confidence
interval — so an arm whose model is uncertain **in this context** gets tried even when its
current mean is unimpressive. That is the contextual counterpart of `ucb1` in
`@loom/reasoning` ([ADR 0078](https://github.com/chhetrisushil/loom/blob/main/docs/adr/0078-exploration-in-the-routing-seam.md)),
which explores per-arm without looking at the observation.

`Aₐ⁻¹` is maintained directly via Sherman–Morrison:

```
(A + xxᵀ)⁻¹ = A⁻¹ − (A⁻¹x)(A⁻¹x)ᵀ / (1 + xᵀA⁻¹x)
```

so `select` and `update` are both **O(d²)** with no matrix inversion anywhere. An unseen arm
starts at `A⁻¹ = I`, `b = 0` — zero predicted reward, maximum uncertainty — so it is
guaranteed a trial rather than being starved.

## Featurizers

- `numericFeatures(["tokens", "retries"])` — intercept + named numeric keys; missing or
  non-numeric values become `0`.
- `oneHotFeatures("intent", ["summarize", "code", "chat"])` — intercept + one-hot; an unknown
  category degrades to the intercept instead of throwing, so a new category never breaks a run.

Bring your own by passing `{ features, dimension }` directly. A mismatch between the two
throws rather than corrupting a model.

## Caveats

- **Rewards should be on a comparable scale.** `alpha` is the knob if yours are not.
- **`select` must stay cheap and pure.** `decideWithPolicy` calls it before `ctx.decide`, so on
  replay it runs and its answer is discarded.
- **Arm identity is the action's string form.** Object actions are keyed by `JSON.stringify`.
- **Snapshots are model state, not a promotion.** Pin a version only after
  `promotionGate` passes on an evaluation of that exact snapshot.
