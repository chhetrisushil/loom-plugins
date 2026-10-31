# loom-plugin-kms

A durable `KeyStore` for Loom's K10 crypto-shredding, built on **envelope encryption**.

Loom encrypts sensitive payload fields at rest and satisfies erasure by destroying the key —
so the key *is* the erasure boundary. Losing one is indistinguishable from shredding the
subject: the writes succeed, the log survives, and every field encrypted under it is
unreadable from the next boot. `@loom/plugin-crypto` ships only `InMemoryKeyStore`, which
declares `durable: false` and which `loom doctor` refuses in an app.

This is the store that makes that check pass.

```bash
pnpm add loom-plugin-kms better-sqlite3
```

```ts
import Database from "better-sqlite3";
import { EncryptingArchiveStore, EncryptingEventStore } from "@loom/plugin-crypto";
import { SqliteArchiveStore } from "@loom/plugin-sqlite";
import { AwsKmsWrapper, KmsKeyStore, SqliteWrappedKeyStore } from "loom-plugin-kms";

const keys = new KmsKeyStore({
  wrapper: new AwsKmsWrapper({
    keyId: process.env.KMS_KEY_ARN!,
    region: "eu-west-1",
    credentials: { accessKeyId: …, secretAccessKey: … },
  }),
  store: new SqliteWrappedKeyStore(new Database("./keys.db")),
});

defineConfig({
  storage: {
    kind: "custom",
    eventStore: new EncryptingEventStore(inner, keys, {
      sensitive: { STEP_COMPLETED: ["output.ssn"] },
    }),
    snapshotStore,
    // Compaction archives what it removes (loom ADR 0138). Seal the archive with the
    // SAME KeyStore so crypto-shredding a subject also erases its archived history.
    archiveStore: new EncryptingArchiveStore(new SqliteArchiveStore("./archive.db"), keys),
  },
});
```

```
$ loom doctor --config ./dist/app.js
  ✓ encryption keys (will the log still be readable?)
      eventStore encrypts with a durable KeyStore
```

## How erasure works here, and why

One data key per subject, sealed by the KMS, stored as ciphertext. `destroy(subjectId)`
deletes the only copy of the sealed key and writes a tombstone.

**It never asks the KMS to delete anything**, and that is deliberate. Most KMS services do
not delete on request — AWS *schedules* key deletion 7–30 days out, GCP enforces a 24-hour
minimum. Loom's contract is that `get` returns `null` once `destroy` resolves, and callers
read that as *erased*; a pending-deletion window breaks that quietly, in the direction that
matters legally. Scheduling deletion would also erase every **other** subject wrapped under
that key, days later, which is not what `destroy(subjectId)` promises.

Deleting a row is immediate, verifiable, and cannot be undone by a KMS outage. The KMS
protects the wrapping key; this store owns the moment of erasure.

The tombstone is not bookkeeping — it *is* the erasure. Without it, `getOrCreate` on a
shredded subject would mint a fresh key and the next write would be readable again.

## What's in the box

| | |
|---|---|
| `KmsKeyStore` | the `KeyStore`: envelope encryption over a wrapper + a row store |
| `AwsKmsWrapper` | AWS KMS `Encrypt`/`Decrypt` over the HTTP API with SigV4 — **no AWS SDK** |
| `LocalMasterKeyWrapper` | AES-256-GCM under a master key you hold yourself |
| `SqliteWrappedKeyStore` | wrapped keys + tombstones in SQLite (`durable: true`) |
| `InMemoryWrappedKeyStore` | for tests (`durable: false`) |

`durable` is **inherited from the row store, never asserted**. A real KMS wrapping keys that
a `Map` then forgets is still a log nobody can read tomorrow, and hardcoding `true` would
make `loom doctor` pass while the data evaporates.

## Bring your own KMS

`KeyWrapper` is three members. GCP KMS, Vault, or an HSM is a small class:

```ts
class MyWrapper implements KeyWrapper {
  readonly keyId = "projects/p/locations/l/keyRings/r/cryptoKeys/k";
  async wrap(dataKey: Buffer): Promise<Buffer> { /* encrypt */ }
  async unwrap(sealed: Buffer): Promise<Buffer> { /* decrypt */ }
}
```

Same for storage: `WrappedKeyStore` is four methods plus a `durable` declaration, so Postgres
or DynamoDB is a short class too.

## Operating it

- **Keep this database off the volume that holds your event log.** Ciphertext and the key
  that opens it in one backup is most of the threat model gone.
- **Rotation** means re-wrapping rows: every wrapped key records the `keyId` that sealed it,
  so you can find the ones still on the old wrapping key. Rotating the wrapper without
  re-wrapping makes `get` throw — it does *not* silently report the subject as erased, which
  would be a false erasure claim.
- **An unwrap failure is not an erasure.** If credentials are wrong or a key was rotated,
  `get` throws and names both key ids. Only a tombstone means erased.

## Conformance

```ts
import { runKeyStoreConformance } from "@loom/conformance";
runKeyStoreConformance(() => new KmsKeyStore({ wrapper, store }));
```

This package runs that kit against both backends, and the SQLite one runs against **real
SQLite** rather than a stand-in — a fake only proves the fake agrees with your assumptions
about SQL.
