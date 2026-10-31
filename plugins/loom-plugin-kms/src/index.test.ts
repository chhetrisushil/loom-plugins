import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runKeyStoreConformance } from "@loom/conformance";
import { describe, expect, it } from "vitest";
import { KmsKeyStore } from "./KmsKeyStore";
import { InMemoryWrappedKeyStore, SqliteWrappedKeyStore } from "./stores";
import { AwsKmsWrapper, LocalMasterKeyWrapper } from "./wrappers";

const master = () => new LocalMasterKeyWrapper({ masterKey: randomBytes(32) });

// The published contract, run against the real composition. It covers the erasure invariant,
// which is the part a hand-written test skips.
runKeyStoreConformance(
  () => new KmsKeyStore({ wrapper: master(), store: new InMemoryWrappedKeyStore() }),
  "KmsKeyStore (local master key)"
);

// ...and against REAL SQLite, because the fake below only proves the fake agrees with my
// assumptions about SQL. `ON CONFLICT DO NOTHING`, BLOB round-tripping and the two-table
// tombstone are all things a stand-in cannot get wrong on my behalf.
runKeyStoreConformance(
  () => new KmsKeyStore({ wrapper: master(), store: new SqliteWrappedKeyStore(new Database(":memory:")) }),
  "KmsKeyStore (sqlite + local master key)"
);

describe("durability is inherited, never asserted", () => {
  it("reports false when the wrapped keys live in a Map", () => {
    const keys = new KmsKeyStore({ wrapper: master(), store: new InMemoryWrappedKeyStore() });
    // A real KMS wrapping keys that a Map then forgets is still a log that cannot be read
    // tomorrow. Hardcoding `true` here would make `loom doctor` pass and the data evaporate.
    expect(keys.durable).toBe(false);
  });

  it("reports true when they live in SQLite", () => {
    const keys = new KmsKeyStore({ wrapper: master(), store: new SqliteWrappedKeyStore(new Database(":memory:")) });
    expect(keys.durable).toBe(true);
  });
});

describe("getOrCreate is an atomic create-if-absent (loom ADR 0139 D22)", () => {
  const backings: Array<[string, () => InstanceType<typeof InMemoryWrappedKeyStore> | InstanceType<typeof SqliteWrappedKeyStore>]> = [
    ["in-memory", () => new InMemoryWrappedKeyStore()],
    ["sqlite", () => new SqliteWrappedKeyStore(new Database(":memory:"))],
  ];
  for (const [name, mk] of backings) {
    it(`concurrent callers on one instance resolve to ONE key (${name})`, async () => {
      const keys = new KmsKeyStore({ wrapper: master(), store: mk() });
      const got = await Promise.all(Array.from({ length: 16 }, () => keys.getOrCreate("s")));
      for (const k of got) expect(Buffer.compare(k, got[0] as Buffer)).toBe(0);
      expect(Buffer.compare((await keys.get("s")) as Buffer, got[0] as Buffer)).toBe(0);
    });

    it(`two nodes over one backing store resolve to ONE key (${name})`, async () => {
      const store = mk();
      const wrapper = master();
      const a = new KmsKeyStore({ wrapper, store });
      const b = new KmsKeyStore({ wrapper, store });
      const [ka, kb, kc] = await Promise.all([a.getOrCreate("s"), b.getOrCreate("s"), a.getOrCreate("s")]);
      expect(Buffer.compare(ka, kb)).toBe(0);
      expect(Buffer.compare(ka, kc)).toBe(0);
    });

    it(`a racing getOrCreate cannot resurrect a destroyed subject (${name})`, async () => {
      const keys = new KmsKeyStore({ wrapper: master(), store: mk() });
      await keys.getOrCreate("s");
      await keys.destroy("s");
      await expect(Promise.all([keys.getOrCreate("s"), keys.getOrCreate("s")])).rejects.toThrow(/destroyed/);
      expect(await keys.get("s")).toBeNull();
    });
  }

  it("two SQLite connections to one file converge on one key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kms-"));
    try {
      const file = join(dir, "keys.db");
      const wrapper = master();
      const a = new KmsKeyStore({ wrapper, store: new SqliteWrappedKeyStore(new Database(file)) });
      const b = new KmsKeyStore({ wrapper, store: new SqliteWrappedKeyStore(new Database(file)) });
      const [ka, kb] = await Promise.all([a.getOrCreate("s"), b.getOrCreate("s")]);
      expect(Buffer.compare(ka, kb)).toBe(0);
      await a.close();
      await b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("insertIfAbsent refuses an existing row and a tombstone, and never overwrites", async () => {
    for (const store of [new InMemoryWrappedKeyStore(), new SqliteWrappedKeyStore(new Database(":memory:"))]) {
      const row = (b: string) => ({ sealed: Buffer.from(b), keyId: "k", createdAt: 1 });
      expect(await store.insertIfAbsent("s", row("first"))).toBe(true);
      expect(await store.insertIfAbsent("s", row("second"))).toBe(false);
      expect(((await store.read("s")) as { sealed: Buffer }).sealed.toString()).toBe("first");
      await store.destroy("s");
      expect(await store.insertIfAbsent("s", row("third"))).toBe(false);
      expect(await store.read("s")).toBeNull();
    }
  });
});

describe("erasure", () => {
  it("survives a process restart — the whole reason this plugin exists", async () => {
    // One backing store, two KeyStore instances: the second models tomorrow's process.
    const store = new SqliteWrappedKeyStore(new Database(":memory:"));
    const wrapper = master();
    const today = new KmsKeyStore({ wrapper, store });
    const created = await today.getOrCreate("subject-1");

    const tomorrow = new KmsKeyStore({ wrapper, store });
    const recovered = await tomorrow.get("subject-1");
    expect(recovered).not.toBeNull();
    expect(Buffer.compare(recovered as Buffer, created)).toBe(0);
  });

  it("a shredded subject stays shredded across a restart", async () => {
    const store = new SqliteWrappedKeyStore(new Database(":memory:"));
    const wrapper = master();
    const today = new KmsKeyStore({ wrapper, store });
    await today.getOrCreate("subject-1");
    await today.destroy("subject-1");

    // The tombstone is the erasure. Without it, a fresh process would mint a new key for a
    // subject someone shredded, and the next write would be readable again.
    const tomorrow = new KmsKeyStore({ wrapper, store });
    expect(await tomorrow.get("subject-1")).toBeNull();
    await expect(tomorrow.getOrCreate("subject-1")).rejects.toThrow(/destroyed \(shredded\)/);
    expect(await tomorrow.get("subject-1")).toBeNull();
  });

  it("proves the destruction across a restart (wasDestroyed), and never for a live or unknown subject", async () => {
    // loom ADR 0130: an erasure retry that finds the key gone trusts it as destroyed only on
    // this proof — a node that merely never had the key must not answer true.
    const store = new SqliteWrappedKeyStore(new Database(":memory:"));
    const wrapper = master();
    const today = new KmsKeyStore({ wrapper, store });
    await today.getOrCreate("live");
    await today.getOrCreate("gone");
    await today.destroy("gone");

    const tomorrow = new KmsKeyStore({ wrapper, store });
    expect(await tomorrow.wasDestroyed("gone")).toBe(true);
    expect(await tomorrow.wasDestroyed("live")).toBe(false);
    expect(await tomorrow.wasDestroyed("never-minted")).toBe(false);
    // A different store (another node's empty key store) has no proof for the same subject.
    const elsewhere = new KmsKeyStore({ wrapper, store: new SqliteWrappedKeyStore(new Database(":memory:")) });
    expect(await elsewhere.wasDestroyed("gone")).toBe(false);
  });

  it("does not ask the KMS to delete anything", async () => {
    // Erasure must not depend on a KMS deletion window — and must not take out every other
    // subject wrapped under the same key.
    const calls: string[] = [];
    const wrapper = new AwsKmsWrapper({
      keyId: "arn:aws:kms:eu-west-1:1:key/abc",
      region: "eu-west-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      fetchImpl: fakeKms(calls),
    });
    const keys = new KmsKeyStore({ wrapper, store: new InMemoryWrappedKeyStore() });
    await keys.getOrCreate("s1");
    await keys.destroy("s1");
    expect(calls).toEqual(["TrentService.Encrypt"]); // no ScheduleKeyDeletion, no Decrypt
  });
});

describe("a failure to unwrap is not an erasure", () => {
  it("throws, naming both key ids, rather than reporting the subject as erased", async () => {
    const store = new InMemoryWrappedKeyStore();
    await new KmsKeyStore({
      wrapper: new LocalMasterKeyWrapper({ masterKey: randomBytes(32), keyId: "master-v1" }),
      store,
    }).getOrCreate("s1");

    // Rotated the master key and forgot to re-wrap. Returning null here would tell the caller
    // the subject was erased — a claim people make to regulators — when it is perfectly
    // readable by whoever still holds the old key.
    const wrongKey = new KmsKeyStore({
      wrapper: new LocalMasterKeyWrapper({ masterKey: randomBytes(32), keyId: "master-v2" }),
      store,
    });
    await expect(wrongKey.get("s1")).rejects.toThrow(/master-v1.*master-v2|master-v2/s);
  });
});

describe("AwsKmsWrapper signing", () => {
  it("signs the request the way KMS expects", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const wrapper = new AwsKmsWrapper({
      keyId: "alias/loom",
      region: "us-east-1",
      credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", sessionToken: "tok" },
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = { url, init };
        return new Response(JSON.stringify({ CiphertextBlob: Buffer.from("x").toString("base64") }));
      }) as unknown as typeof fetch,
    });
    await wrapper.wrap(randomBytes(32));

    const headers = seen?.init.headers as Record<string, string>;
    expect(seen?.url).toBe("https://kms.us-east-1.amazonaws.com");
    expect(headers["x-amz-target"]).toBe("TrentService.Encrypt");
    expect(headers["content-type"]).toBe("application/x-amz-json-1.1");
    // A session token must be SIGNED, not merely sent: AWS rejects a signature whose
    // SignedHeaders omits a header that is present.
    expect(headers.authorization).toContain("x-amz-security-token");
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-east-1\/kms\/aws4_request/);
  });

  it("surfaces the KMS error body, not just the status", async () => {
    const wrapper = new AwsKmsWrapper({
      keyId: "alias/loom",
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      fetchImpl: (async () =>
        new Response('{"__type":"KMSInvalidStateException"}', { status: 400 })) as typeof fetch,
    });
    // "400" tells an operator nothing; "the key is pending deletion" tells them everything.
    await expect(wrapper.wrap(randomBytes(32))).rejects.toThrow(/KMSInvalidStateException/);
  });
});

// ── helpers ─────────────────────────────────────────────────────────────────

/** A fake KMS that round-trips base64, so wrap/unwrap compose without a network. */
function fakeKms(calls: string[]): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const target = (init.headers as Record<string, string>)["x-amz-target"] as string;
    calls.push(target);
    const body = JSON.parse(init.body as string) as Record<string, string>;
    const payload =
      target === "TrentService.Encrypt"
        ? { CiphertextBlob: body.Plaintext }
        : { Plaintext: body.CiphertextBlob };
    return new Response(JSON.stringify(payload));
  }) as unknown as typeof fetch;
}
