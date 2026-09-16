import type { WrappedKey, WrappedKeyStore } from "./types";

/**
 * Wrapped keys in a Map. **For tests.**
 *
 * `durable: false` is the whole reason this class is safe to ship: wired into an app,
 * `loom doctor` fails it rather than letting a deployment encrypt against keys that vanish
 * at the next restart.
 */
export class InMemoryWrappedKeyStore implements WrappedKeyStore {
  readonly durable = false;
  private readonly rows = new Map<string, WrappedKey>();
  private readonly tombstones = new Set<string>();

  read(subjectId: string): Promise<WrappedKey | null> {
    return Promise.resolve(this.rows.get(subjectId) ?? null);
  }

  write(subjectId: string, key: WrappedKey): Promise<void> {
    this.rows.set(subjectId, key);
    return Promise.resolve();
  }

  destroy(subjectId: string): Promise<void> {
    this.rows.delete(subjectId);
    this.tombstones.add(subjectId);
    return Promise.resolve();
  }

  isDestroyed(subjectId: string): Promise<boolean> {
    return Promise.resolve(this.tombstones.has(subjectId));
  }
}

/** The subset of `better-sqlite3` this store uses — so the dependency stays the caller's. */
interface SqliteLike {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
  };
  exec(sql: string): unknown;
  close(): unknown;
}

/**
 * Wrapped keys in SQLite.
 *
 * Two tables, because the difference between them is the difference between "no key yet" and
 * "erased": deleting a row loses that distinction, and `getOrCreate` would happily mint a
 * fresh key for a subject someone shredded last month.
 *
 * Pass a `better-sqlite3` database (or anything with the same three methods), so this plugin
 * does not decide your SQLite dependency for you:
 *
 * ```ts
 * import Database from "better-sqlite3";
 * new SqliteWrappedKeyStore(new Database("./keys.db"));
 * ```
 *
 * Keep this file on a different volume from the event log if you can. Ciphertext and the
 * key that opens it sitting in one backup is most of the threat model gone.
 */
export class SqliteWrappedKeyStore implements WrappedKeyStore {
  readonly durable = true;
  private readonly db: SqliteLike;

  constructor(db: SqliteLike) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wrapped_keys (
        subject_id TEXT PRIMARY KEY,
        sealed     BLOB NOT NULL,
        key_id     TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shredded_subjects (
        subject_id   TEXT PRIMARY KEY,
        destroyed_at INTEGER NOT NULL
      );
    `);
  }

  read(subjectId: string): Promise<WrappedKey | null> {
    const row = this.db
      .prepare("SELECT sealed, key_id, created_at FROM wrapped_keys WHERE subject_id = ?")
      .get(subjectId) as
      | { sealed: Buffer | Uint8Array; key_id: string; created_at: number }
      | undefined;
    if (row === undefined) return Promise.resolve(null);
    return Promise.resolve({
      sealed: Buffer.isBuffer(row.sealed) ? row.sealed : Buffer.from(row.sealed),
      keyId: row.key_id,
      createdAt: row.created_at,
    });
  }

  write(subjectId: string, key: WrappedKey): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO wrapped_keys (subject_id, sealed, key_id, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(subject_id) DO UPDATE SET sealed = excluded.sealed, key_id = excluded.key_id`
      )
      .run(subjectId, key.sealed, key.keyId, key.createdAt);
    return Promise.resolve();
  }

  destroy(subjectId: string): Promise<void> {
    // Tombstone FIRST. If the process dies between the two statements, a subject marked
    // erased whose key still exists is recoverable by re-running destroy; a deleted key with
    // no tombstone lets getOrCreate mint a replacement and call it a new subject.
    this.db
      .prepare(
        "INSERT INTO shredded_subjects (subject_id, destroyed_at) VALUES (?, ?) ON CONFLICT DO NOTHING"
      )
      .run(subjectId, Date.now());
    this.db.prepare("DELETE FROM wrapped_keys WHERE subject_id = ?").run(subjectId);
    return Promise.resolve();
  }

  isDestroyed(subjectId: string): Promise<boolean> {
    const row = this.db
      .prepare("SELECT 1 AS found FROM shredded_subjects WHERE subject_id = ?")
      .get(subjectId);
    return Promise.resolve(row !== undefined);
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}
