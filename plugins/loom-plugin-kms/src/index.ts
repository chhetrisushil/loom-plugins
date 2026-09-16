/**
 * `loom-plugin-kms` — a durable `KeyStore` for Loom's K10 crypto-shredding.
 *
 * Envelope encryption: one data key per subject, sealed by a KMS (or a master key you hold)
 * and stored as ciphertext. Erasure deletes the only copy of the sealed key — immediate, and
 * not at the mercy of a KMS deletion window.
 *
 * ```ts
 * import Database from "better-sqlite3";
 * import { KmsKeyStore, AwsKmsWrapper, SqliteWrappedKeyStore } from "loom-plugin-kms";
 * import { EncryptingEventStore } from "@loom/plugin-crypto";
 *
 * const keys = new KmsKeyStore({
 *   wrapper: new AwsKmsWrapper({ keyId: process.env.KMS_KEY_ARN!, region: "eu-west-1",
 *     credentials: { accessKeyId: …, secretAccessKey: … } }),
 *   store: new SqliteWrappedKeyStore(new Database("./keys.db")),
 * });
 *
 * defineConfig({
 *   storage: { kind: "custom",
 *     eventStore: new EncryptingEventStore(inner, keys, { sensitive: { … } }),
 *     snapshotStore },
 * });
 * ```
 */
export { KmsKeyStore, type KmsKeyStoreOptions } from "./KmsKeyStore";
export {
  AwsKmsWrapper,
  type AwsKmsOptions,
  LocalMasterKeyWrapper,
  type LocalMasterKeyOptions,
} from "./wrappers";
export { InMemoryWrappedKeyStore, SqliteWrappedKeyStore } from "./stores";
export type { KeyWrapper, WrappedKey, WrappedKeyStore } from "./types";
