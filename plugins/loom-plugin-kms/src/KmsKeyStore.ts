import { randomBytes } from "node:crypto";
import type { KeyStore } from "@loom/plugin-crypto";
import type { KeyWrapper, WrappedKeyStore } from "./types";

/** AES-256: the key size `@loom/plugin-crypto` encrypts payload fields with. */
const DATA_KEY_BYTES = 32;

export interface KmsKeyStoreOptions {
  /** Where the KMS lives. */
  wrapper: KeyWrapper;
  /** Where wrapped keys and tombstones live. */
  store: WrappedKeyStore;
}

/**
 * A durable {@link KeyStore} built from envelope encryption.
 *
 * Per subject: generate a 32-byte data key, seal it with the KMS, store the sealed bytes.
 * Reading unwraps; erasing deletes the only copy of the sealed key and leaves a tombstone.
 *
 * **Why not just use a KMS key per subject.** Most KMS services do not delete on request —
 * AWS schedules key deletion 7–30 days out, GCP enforces a 24-hour minimum. Loom's contract
 * is that `get` returns `null` once `destroy` resolves, and callers read that as *erased*. A
 * pending-deletion window silently breaks it in the direction that matters legally. Deleting
 * a row is immediate and verifiable, so that is what erasure is here; the KMS protects the
 * wrapping key, and a KMS outage cannot resurrect what it never held.
 *
 * ```ts
 * const keys = new KmsKeyStore({
 *   wrapper: new AwsKmsWrapper({ keyId: "arn:aws:kms:…", region: "eu-west-1" }),
 *   store: new SqliteWrappedKeyStore("./keys.db"),
 * });
 * const eventStore = new EncryptingEventStore(inner, keys, { sensitive: { … } });
 * ```
 */
export class KmsKeyStore implements KeyStore {
  private readonly wrapper: KeyWrapper;
  private readonly store: WrappedKeyStore;

  constructor(options: KmsKeyStoreOptions) {
    this.wrapper = options.wrapper;
    this.store = options.store;
  }

  /**
   * Inherited from the backing store, never asserted.
   *
   * A wrapped key sealed by a real KMS and kept in a Map is still gone at the next boot, and
   * the whole point of this property is that `loom doctor` can refuse that combination. It
   * would be the easiest thing in the world to hardcode `true` here and make the check pass
   * while the data still evaporates.
   */
  get durable(): boolean {
    return this.store.durable;
  }

  async getOrCreate(subjectId: string): Promise<Buffer> {
    const existing = await this.get(subjectId);
    if (existing !== null) return existing;

    // The erasure invariant: a shredded subject must never get a fresh key, or the next write
    // touching it quietly undoes the shredding. Refusing loudly beats returning something the
    // caller would then encrypt new data under.
    if (await this.store.isDestroyed(subjectId)) {
      throw new Error(
        `key for subject "${subjectId}" was destroyed (shredded); cannot recreate — ` +
          "everything encrypted under it is unreadable by design"
      );
    }

    const dataKey = randomBytes(DATA_KEY_BYTES);
    const sealed = await this.wrapper.wrap(dataKey);
    await this.store.write(subjectId, {
      sealed,
      keyId: this.wrapper.keyId,
      createdAt: Date.now(),
    });
    return dataKey;
  }

  async get(subjectId: string): Promise<Buffer | null> {
    const row = await this.store.read(subjectId);
    if (row === null) return null;
    try {
      return await this.wrapper.unwrap(row.sealed);
    } catch (err) {
      // An unwrap failure is NOT "no key". The ciphertext is still readable by whoever can
      // open this wrap, so reporting null would tell the caller the subject was erased when
      // it was not — and erasure is a claim people make to regulators. Name the wrapping key
      // instead, because the fix is almost always credentials or a rotated key.
      throw new Error(
        `unwrapping the data key for subject "${subjectId}" failed (sealed by "${row.keyId}", ` +
          `wrapper is "${this.wrapper.keyId}"): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** Irreversible. Deletes the only copy of the sealed key and tombstones the subject. */
  async destroy(subjectId: string): Promise<void> {
    await this.store.destroy(subjectId);
  }

  /**
   * Proof of destruction (loom ADR 0130): true only once THIS store's tombstone records the
   * subject. An erasure retry that finds the key gone accepts it as destroyed only on `true`.
   */
  async wasDestroyed(subjectId: string): Promise<boolean> {
    return this.store.isDestroyed(subjectId);
  }

  async close(): Promise<void> {
    await this.store.close?.();
  }
}
