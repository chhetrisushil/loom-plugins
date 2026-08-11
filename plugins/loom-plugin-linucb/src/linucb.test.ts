import { runPolicyConformance } from "@loom/conformance";
import type { PolicyContext, TrajectoryStep } from "@loom/learning";
import { describe, expect, it } from "vitest";
import { LinUcbPolicy, numericFeatures, oneHotFeatures } from "./linucb";

/** Deterministic RNG so every exploration test is reproducible. */
function scripted(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length] as number;
}

const twoFeature = numericFeatures(["a"]); // [1, a] — intercept + one signal

describe("LinUcbPolicy — construction", () => {
  it("rejects a nonsense dimension, alpha or epsilon", () => {
    expect(() => new LinUcbPolicy({ ...twoFeature, dimension: 0 })).toThrow(/dimension/);
    expect(() => new LinUcbPolicy({ ...twoFeature, epsilon: 2 })).toThrow(/epsilon/);
    expect(() => new LinUcbPolicy({ ...twoFeature, alpha: -1 })).toThrow(/alpha/);
  });

  it("rejects a featurizer whose output does not match the declared dimension", () => {
    const p = new LinUcbPolicy({ features: () => [1, 2, 3], dimension: 2 });
    expect(() => p.select({}, ["a"])).toThrow(/expected 2/);
  });

  it("rejects non-finite features and rewards rather than corrupting the model", () => {
    const p = new LinUcbPolicy({ features: () => [1, Number.NaN], dimension: 2 });
    expect(() => p.select({}, ["a"])).toThrow(/not finite/);
    const ok = new LinUcbPolicy(twoFeature);
    expect(() => ok.update({ a: 1 }, "x", Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });
});

describe("LinUcbPolicy — exploration", () => {
  it("tries an unseen arm before exploiting a known one", () => {
    const p = new LinUcbPolicy<string>(twoFeature);
    for (let i = 0; i < 20; i++) p.update({ a: 1 }, "known", 1);
    // "fresh" has A⁻¹ = I and b = 0: zero predicted reward but maximum uncertainty.
    expect(p.select({ a: 1 }, ["known", "fresh"])).toMatchObject({ action: "fresh" });
  });

  it("is deterministic with epsilon 0 and reports propensity 1", () => {
    const p = new LinUcbPolicy<string>(twoFeature);
    const first = p.select({ a: 1 }, ["x", "y"]);
    expect(p.select({ a: 1 }, ["x", "y"])).toEqual(first);
    expect(first.propensity).toBe(1);
  });

  it("reports honest epsilon-greedy propensities", () => {
    // alpha 0 so the argmax is decided by the learned mean alone and "x" is it.
    // ε=0.5, k=2 → landing on the argmax: 0.5/2 + 0.5 = 0.75; on the other: 0.25.
    const train = (p: LinUcbPolicy<string>) => {
      for (let i = 0; i < 20; i++) {
        p.update({ a: 1 }, "x", 1);
        p.update({ a: 1 }, "y", 0);
      }
      return p;
    };

    const exploit = train(
      new LinUcbPolicy<string>({ ...twoFeature, alpha: 0, epsilon: 0.5, rng: scripted(0.9) })
    );
    const a = exploit.select({ a: 1 }, ["x", "y"]);
    expect(a.action).toBe("x");
    expect(a.propensity).toBeCloseTo(0.75);

    const explore = train(
      new LinUcbPolicy<string>({
        ...twoFeature,
        alpha: 0,
        epsilon: 0.5,
        rng: scripted(0.1, 0.99), // explore, land on the last index
      })
    );
    const b = explore.select({ a: 1 }, ["x", "y"]);
    expect(b.action).toBe("y");
    expect(b.propensity).toBeCloseTo(0.25);
  });

  it("propensities over the whole action set sum to 1", () => {
    // The property that makes an off-policy estimate valid. Sample every branch of
    // the ε-greedy draw over k=3 and check the reported probabilities are a
    // distribution — an over- or under-reported propensity silently biases every
    // later evaluation, and nothing downstream can detect it.
    const arms = ["x", "y", "z"];
    const eps = 0.3;
    const seen = new Map<string, number>();
    for (const [coin, pick] of [
      [0.9, 0], // exploit
      [0.1, 0.0], // explore → index 0
      [0.1, 0.4], // explore → index 1
      [0.1, 0.9], // explore → index 2
    ] as const) {
      const p = new LinUcbPolicy<string>({
        ...twoFeature,
        alpha: 0,
        epsilon: eps,
        rng: scripted(coin, pick),
      });
      for (let i = 0; i < 20; i++) {
        p.update({ a: 1 }, "x", 1);
        p.update({ a: 1 }, "y", 0);
        p.update({ a: 1 }, "z", 0);
      }
      const choice = p.select({ a: 1 }, arms);
      seen.set(choice.action, choice.propensity as number);
    }
    expect([...seen.keys()].sort()).toEqual(["x", "y", "z"]);
    const total = [...seen.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1);
    expect(seen.get("x")).toBeCloseTo(eps / 3 + (1 - eps)); // the argmax
    expect(seen.get("y")).toBeCloseTo(eps / 3);
  });
});

describe("LinUcbPolicy — it actually learns the context", () => {
  it("picks a different arm in different contexts once trained", () => {
    // Ground truth: arm "hi" pays off when a=1, arm "lo" pays off when a=0.
    const p = new LinUcbPolicy<string>({ ...twoFeature, alpha: 0.1 });
    for (let i = 0; i < 200; i++) {
      p.update({ a: 1 }, "hi", 1);
      p.update({ a: 1 }, "lo", 0);
      p.update({ a: 0 }, "hi", 0);
      p.update({ a: 0 }, "lo", 1);
    }
    expect(p.select({ a: 1 }, ["hi", "lo"]).action).toBe("hi");
    expect(p.select({ a: 0 }, ["hi", "lo"]).action).toBe("lo");
  });

  it("a context-blind bandit cannot do that — which is the point of LinUCB", () => {
    // Same data, but the featurizer sees only the intercept: both arms average 0.5
    // and no amount of training can separate them per-context.
    const blind = new LinUcbPolicy<string>({ features: () => [1], dimension: 1, alpha: 0.1 });
    for (let i = 0; i < 200; i++) {
      blind.update({ a: 1 }, "hi", 1);
      blind.update({ a: 1 }, "lo", 0);
      blind.update({ a: 0 }, "hi", 0);
      blind.update({ a: 0 }, "lo", 1);
    }
    expect(blind.select({ a: 1 }, ["hi", "lo"]).action).toBe(
      blind.select({ a: 0 }, ["hi", "lo"]).action
    );
  });

  it("converges toward the better arm's true mean reward", () => {
    const p = new LinUcbPolicy<string>({ ...twoFeature, alpha: 0 }); // pure exploit
    for (let i = 0; i < 500; i++) {
      p.update({ a: 1 }, "good", 0.9);
      p.update({ a: 1 }, "bad", 0.2);
    }
    expect(p.select({ a: 1 }, ["good", "bad"]).action).toBe("good");
  });
});

describe("LinUcbPolicy — training from Loom trajectories", () => {
  function step(context: PolicyContext | undefined, action: string, reward?: number): TrajectoryStep<string> {
    return {
      decisionId: "route",
      executionId: "x",
      sequence: 1,
      timestamp: 1,
      action,
      ...(context !== undefined && { context }),
      actions: ["good", "bad"],
      ...(reward !== undefined && { reward }),
      rewardSource: reward === undefined ? "none" : "direct",
    };
  }

  it("fits from trajectory steps and skips the ones that teach nothing", () => {
    const p = new LinUcbPolicy<string>(twoFeature);
    const applied = p.fit([
      step({ a: 1 }, "good", 1),
      step({ a: 1 }, "bad", 0),
      step(undefined, "good", 1), // no context
      step({ a: 1 }, "good"), // no reward
    ]);
    expect(applied).toBe(2);
    expect(p.evidence()).toEqual({ good: 1, bad: 1 });
  });

  it("round-trips through a snapshot without changing what it would choose", () => {
    const p = new LinUcbPolicy<string>({ ...twoFeature, alpha: 0.1 });
    for (let i = 0; i < 50; i++) {
      p.update({ a: 1 }, "good", 0.9);
      p.update({ a: 1 }, "bad", 0.1);
    }
    const before = p.select({ a: 1 }, ["good", "bad"]);

    const restored = LinUcbPolicy.fromSnapshot<string>(p.snapshot(), twoFeature);
    expect(restored.select({ a: 1 }, ["good", "bad"])).toEqual(before);
    expect(restored.evidence()).toEqual(p.evidence());
  });

  it("takes a new version on restore, so a report cannot point at the wrong model", () => {
    const p = new LinUcbPolicy<string>({ ...twoFeature, version: "1" });
    p.update({ a: 1 }, "good", 1);
    const next = LinUcbPolicy.fromSnapshot<string>(p.snapshot(), { ...twoFeature, version: "2" });
    expect(next.version).toBe("2");
    expect(LinUcbPolicy.fromSnapshot<string>(p.snapshot(), twoFeature).version).toBe("1");
  });

  it("refuses a malformed snapshot", () => {
    const p = new LinUcbPolicy<string>(twoFeature);
    p.update({ a: 1 }, "good", 1);
    const snap = p.snapshot();
    snap.arms.good = { aInv: [1, 2, 3], b: [0, 0], updates: 1 };
    expect(() => LinUcbPolicy.fromSnapshot(snap, twoFeature)).toThrow(/malformed/);
  });
});

describe("featurizers", () => {
  it("numericFeatures emits an intercept and zero-fills missing keys", () => {
    const { features, dimension } = numericFeatures(["a", "b"]);
    expect(dimension).toBe(3);
    expect(features({ a: 5 })).toEqual([1, 5, 0]);
    expect(features({ a: "not a number", b: 2 })).toEqual([1, 0, 2]);
  });

  it("oneHotFeatures degrades an unknown category to the intercept", () => {
    const { features, dimension } = oneHotFeatures("intent", ["summarize", "code"]);
    expect(dimension).toBe(3);
    expect(features({ intent: "code" })).toEqual([1, 0, 1]);
    expect(features({ intent: "brand-new" })).toEqual([1, 0, 0]);
  });
});

// The SPI kit from @loom/conformance — proves this package satisfies the Policy
// contract itself, not just that its own maths works. Run against the ε-greedy
// configuration, since that is the one with a non-trivial propensity to check.
runPolicyConformance<string>(
  () =>
    new LinUcbPolicy<string>({
      ...twoFeature,
      epsilon: 0.1,
      rng: scripted(0.5, 0.5),
    }),
  ["gemma", "opus", "sonnet"],
  [{ a: 0 }, { a: 1 }, { a: 42 }, {}]
);
