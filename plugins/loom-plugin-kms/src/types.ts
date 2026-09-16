/**
 * The two seams this plugin composes, kept apart on purpose.
 *
 * `KeyWrapper` is where a KMS lives. `WrappedKeyStore` is where the wrapped bytes live. The
 * split is what makes `destroy` immediate: a KMS that schedules key deletion 7–30 days out
 * cannot give you erasure on request, but deleting the only copy of a wrapped data key can —
 * the KMS protects the wrapping key, and you own the moment of erasure.
 */

/**
 * Seals and opens a data key. Implemented by AWS KMS, GCP KMS, Vault, or a master key you
 * hold yourself.
 *
 * Neither method is ever called with a key belonging to another subject: one data key per
 * subject is generated, wrapped once, and unwrapped on read.
 */
export interface KeyWrapper {
  /** Seal a freshly generated data key. The result is what gets stored. */
  wrap(dataKey: Buffer): Promise<Buffer>;
  /** Open a sealed data key. Throws if the wrapping key is gone or the bytes were tampered. */
  unwrap(sealed: Buffer): Promise<Buffer>;
  /**
   * What did the sealing — an ARN, a key name, `"local-master"`. Recorded beside each wrapped
   * key so a rotation can tell which rows still need re-wrapping, and so an operator can see
   * what an unwrap failure is actually asking for.
   */
  readonly keyId: string;
}

/** A sealed data key plus the provenance needed to open it later. */
export interface WrappedKey {
  /** The sealed bytes — never the data key itself. */
  sealed: Buffer;
  /** The `KeyWrapper.keyId` that sealed it. */
  keyId: string;
  createdAt: number;
}

/**
 * Where wrapped keys and erasure tombstones live.
 *
 * A tombstone is not bookkeeping — it IS the erasure. `getOrCreate` on a destroyed subject
 * must not mint a fresh key, or crypto-shredding would be undone by the next write that
 * touches the subject.
 */
export interface WrappedKeyStore {
  read(subjectId: string): Promise<WrappedKey | null>;
  write(subjectId: string, key: WrappedKey): Promise<void>;
  /** Delete the wrapped key AND record that this subject was erased. Idempotent. */
  destroy(subjectId: string): Promise<void>;
  /** Was this subject erased? Distinguishes "never existed" from "shredded". */
  isDestroyed(subjectId: string): Promise<boolean>;
  close?(): Promise<void>;
  /**
   * Does this store survive a restart?
   *
   * `KmsKeyStore` reports the value from here rather than claiming `true` for itself: a
   * KeyStore backed by a Map is not durable no matter what wraps its keys, and `loom doctor`
   * fails on exactly that claim. Declaring it here keeps the honest answer in the one place
   * that knows it.
   */
  readonly durable: boolean;
}
