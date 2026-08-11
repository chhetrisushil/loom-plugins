import type { Policy, PolicyChoice, PolicyContext, TrajectoryStep } from "@loom/learning";

// ── LinUCB (disjoint), a third-party Policy for Loom ─────────────────────────
//
// This is the "math" half that the framework deliberately does not ship. Loom
// gives us the (context, action, propensity, reward) record and the machinery to
// evaluate a candidate before it goes live; this package decides what to choose.
//
// Disjoint LinUCB keeps one ridge-regression model per arm:
//
//     score(a) = θₐ·x + α·√(xᵀ Aₐ⁻¹ x)          θₐ = Aₐ⁻¹ bₐ
//
// The first term is the predicted reward, the second is the width of its
// confidence interval — so an arm whose model is uncertain in THIS context gets
// tried even when its current mean is unimpressive. That is the contextual
// version of what `ucb1` does per-arm in @loom/reasoning.
//
// `Aₐ⁻¹` is maintained directly by the Sherman–Morrison identity
//
//     (A + xxᵀ)⁻¹ = A⁻¹ − (A⁻¹x)(A⁻¹x)ᵀ / (1 + xᵀA⁻¹x)
//
// so both `select` and `update` are O(d²) with no matrix inversion anywhere.

export interface LinUcbOptions {
  /** Stable identity for the algorithm. Default "linucb". */
  id?: string;
  /** Version of THIS trained snapshot. Default "1". Bump when you retrain. */
  version?: string;
  /** Turn an observation into a fixed-length numeric feature vector. */
  features: (context: PolicyContext) => number[];
  /** Length of that vector. Mismatches throw rather than corrupting a model. */
  dimension: number;
  /** Confidence width. Higher explores more. Default 1. */
  alpha?: number;
  /**
   * Probability of ignoring the model and sampling uniformly.
   *
   * Default 0, which makes this policy DETERMINISTIC — every choice is logged with
   * propensity 1, and a log produced that way contains no counterfactuals, so it
   * can never support an unbiased off-policy estimate of the next candidate. Set a
   * small epsilon (0.05–0.1) in production if you intend to keep learning.
   */
  epsilon?: number;
  /** Injectable RNG for tests and DST runs. Default Math.random. */
  rng?: () => number;
}

/** Serializable model state — what you persist between training runs. */
export interface LinUcbSnapshot {
  id: string;
  version: string;
  dimension: number;
  alpha: number;
  epsilon: number;
  arms: Record<string, { aInv: number[]; b: number[]; updates: number }>;
}

interface Arm {
  /** Row-major d×d inverse design matrix, seeded to the identity. */
  aInv: Float64Array;
  b: Float64Array;
  updates: number;
}

function armKey(action: unknown): string {
  return typeof action === "string" ? action : JSON.stringify(action);
}

export class LinUcbPolicy<A = string> implements Policy<A> {
  readonly id: string;
  readonly version: string;
  private readonly d: number;
  private readonly alpha: number;
  private readonly epsilon: number;
  private readonly rng: () => number;
  private readonly featurize: (context: PolicyContext) => number[];
  private readonly arms = new Map<string, Arm>();

  constructor(opts: LinUcbOptions) {
    if (!Number.isInteger(opts.dimension) || opts.dimension <= 0) {
      throw new Error(`LinUcbPolicy: dimension must be a positive integer, got ${opts.dimension}`);
    }
    const epsilon = opts.epsilon ?? 0;
    if (!(epsilon >= 0 && epsilon <= 1)) {
      throw new Error(`LinUcbPolicy: epsilon must be in [0,1], got ${epsilon}`);
    }
    const alpha = opts.alpha ?? 1;
    if (!(alpha >= 0)) throw new Error(`LinUcbPolicy: alpha must be >= 0, got ${alpha}`);

    this.id = opts.id ?? "linucb";
    this.version = opts.version ?? "1";
    this.d = opts.dimension;
    this.alpha = alpha;
    this.epsilon = epsilon;
    this.rng = opts.rng ?? Math.random;
    this.featurize = opts.features;
  }

  /** A fresh arm: A⁻¹ = I, b = 0 — maximum uncertainty, so it gets explored. */
  private arm(key: string): Arm {
    let a = this.arms.get(key);
    if (a === undefined) {
      const aInv = new Float64Array(this.d * this.d);
      for (let i = 0; i < this.d; i++) aInv[i * this.d + i] = 1;
      a = { aInv, b: new Float64Array(this.d), updates: 0 };
      this.arms.set(key, a);
    }
    return a;
  }

  private vector(context: PolicyContext): Float64Array {
    const raw = this.featurize(context);
    if (raw.length !== this.d) {
      throw new Error(`LinUcbPolicy: features returned ${raw.length} values, expected ${this.d}`);
    }
    const x = new Float64Array(this.d);
    for (let i = 0; i < this.d; i++) {
      const v = raw[i] as number;
      if (!Number.isFinite(v)) {
        throw new Error(`LinUcbPolicy: feature ${i} is not finite (${v})`);
      }
      x[i] = v;
    }
    return x;
  }

  /** u = A⁻¹x. O(d²), one allocation. */
  private solve(arm: Arm, x: Float64Array): Float64Array {
    const u = new Float64Array(this.d);
    for (let i = 0; i < this.d; i++) {
      let sum = 0;
      const row = i * this.d;
      for (let j = 0; j < this.d; j++) sum += (arm.aInv[row + j] as number) * (x[j] as number);
      u[i] = sum;
    }
    return u;
  }

  select(context: PolicyContext, actions: readonly A[]): PolicyChoice<A> {
    if (actions.length === 0) throw new Error("LinUcbPolicy: no actions to choose from");
    const x = this.vector(context);

    let best = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < actions.length; k++) {
      const arm = this.arm(armKey(actions[k]));
      const u = this.solve(arm, x);
      let mean = 0;
      let variance = 0;
      for (let i = 0; i < this.d; i++) {
        mean += (arm.b[i] as number) * (u[i] as number);
        variance += (x[i] as number) * (u[i] as number);
      }
      // Ties keep the caller's order, matching `ucb1` in @loom/reasoning.
      const score = mean + this.alpha * Math.sqrt(Math.max(0, variance));
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }

    const k = actions.length;
    if (this.epsilon === 0) {
      return { action: actions[best] as A, propensity: 1 };
    }
    // ε-greedy over the argmax: P(a) = ε/k + (1−ε)·1[a = argmax]. Reported exactly,
    // because a wrong propensity silently biases every later evaluation.
    const explore = this.rng() < this.epsilon;
    const index = explore ? Math.min(k - 1, Math.floor(this.rng() * k)) : best;
    const propensity = this.epsilon / k + (index === best ? 1 - this.epsilon : 0);
    return { action: actions[index] as A, propensity };
  }

  /** Fold one observed (context, action, reward) into the model. O(d²). */
  update(context: PolicyContext, action: A, reward: number): void {
    if (!Number.isFinite(reward)) {
      throw new Error(`LinUcbPolicy: reward must be finite, got ${reward}`);
    }
    const x = this.vector(context);
    const arm = this.arm(armKey(action));
    const u = this.solve(arm, x);

    let denom = 1;
    for (let i = 0; i < this.d; i++) denom += (x[i] as number) * (u[i] as number);
    // denom = 1 + xᵀA⁻¹x is ≥ 1 for a positive-definite A⁻¹, so this cannot divide
    // by zero; the guard is against drift from accumulated float error.
    if (!(denom > 0)) throw new Error("LinUcbPolicy: non-positive Sherman-Morrison denominator");

    for (let i = 0; i < this.d; i++) {
      const ui = u[i] as number;
      const row = i * this.d;
      for (let j = 0; j < this.d; j++) {
        arm.aInv[row + j] = (arm.aInv[row + j] as number) - (ui * (u[j] as number)) / denom;
      }
      arm.b[i] = (arm.b[i] as number) + reward * (x[i] as number);
    }
    arm.updates += 1;
  }

  /**
   * Train from trajectory steps mined out of a Loom log (`trajectories(events)`).
   * Steps without a context or a reward are skipped — they carry nothing to learn
   * from — and the count of applied steps is returned so a caller can tell the
   * difference between "trained on 40k steps" and "trained on 3".
   */
  fit(steps: readonly TrajectoryStep<A>[]): number {
    let applied = 0;
    for (const s of steps) {
      if (s.context === undefined || s.reward === undefined) continue;
      this.update(s.context, s.action, s.reward);
      applied += 1;
    }
    return applied;
  }

  /** How many updates each arm has absorbed — the evidence behind this snapshot. */
  evidence(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, arm] of this.arms) out[key] = arm.updates;
    return out;
  }

  snapshot(): LinUcbSnapshot {
    const arms: LinUcbSnapshot["arms"] = {};
    for (const [key, arm] of this.arms) {
      arms[key] = { aInv: [...arm.aInv], b: [...arm.b], updates: arm.updates };
    }
    return {
      id: this.id,
      version: this.version,
      dimension: this.d,
      alpha: this.alpha,
      epsilon: this.epsilon,
      arms,
    };
  }

  /**
   * Rebuild a trained policy from a snapshot. `version` is deliberately required
   * to be re-supplied when it differs: a promoted policy is identified by its
   * version, and silently reusing the old one makes an evaluation report point at
   * the wrong model.
   */
  static fromSnapshot<A = string>(
    snapshot: LinUcbSnapshot,
    opts: Pick<LinUcbOptions, "features"> & Partial<LinUcbOptions>
  ): LinUcbPolicy<A> {
    const policy = new LinUcbPolicy<A>({
      id: snapshot.id,
      version: opts.version ?? snapshot.version,
      dimension: snapshot.dimension,
      alpha: snapshot.alpha,
      epsilon: snapshot.epsilon,
      ...opts,
    });
    for (const [key, arm] of Object.entries(snapshot.arms)) {
      if (arm.aInv.length !== snapshot.dimension * snapshot.dimension) {
        throw new Error(`LinUcbPolicy.fromSnapshot: arm "${key}" has a malformed aInv`);
      }
      policy.arms.set(key, {
        aInv: Float64Array.from(arm.aInv),
        b: Float64Array.from(arm.b),
        updates: arm.updates,
      });
    }
    return policy;
  }
}

/**
 * The common featurizer: pull named numeric keys out of the context, with a
 * leading constant 1 so the model can fit an intercept. Missing or non-numeric
 * values become 0.
 */
export function numericFeatures(keys: readonly string[]): {
  features: (context: PolicyContext) => number[];
  dimension: number;
} {
  return {
    dimension: keys.length + 1,
    features: (context) => {
      const out = [1];
      for (const k of keys) {
        const v = context[k];
        out.push(typeof v === "number" && Number.isFinite(v) ? v : 0);
      }
      return out;
    },
  };
}

/**
 * One-hot featurizer for categorical observations, e.g. `oneHotFeatures("intent",
 * ["summarize", "code", "chat"])`. Unknown values encode as all-zero rather than
 * throwing, so a new category degrades to the intercept instead of breaking a run.
 */
export function oneHotFeatures(
  key: string,
  values: readonly string[]
): { features: (context: PolicyContext) => number[]; dimension: number } {
  const index = new Map(values.map((v, i) => [v, i]));
  return {
    dimension: values.length + 1,
    features: (context) => {
      const out = new Array<number>(values.length + 1).fill(0);
      out[0] = 1;
      const i = index.get(String(context[key]));
      if (i !== undefined) out[i + 1] = 1;
      return out;
    },
  };
}
