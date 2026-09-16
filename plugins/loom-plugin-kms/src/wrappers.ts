import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import type { KeyWrapper } from "./types";

// ── Local master key ─────────────────────────────────────────────────────────

export interface LocalMasterKeyOptions {
  /** 32 bytes. Read it from a secret manager or an env var — never from source. */
  masterKey: Buffer;
  /** Recorded beside every wrapped key. Change it when you rotate. */
  keyId?: string;
}

/**
 * Wraps data keys with AES-256-GCM under a master key you hold.
 *
 * A real option, not only a test double: if your secrets already live in a secret manager
 * and you do not want a KMS round trip on every key read, this is the same envelope scheme
 * with the wrapping key in your process instead of theirs.
 *
 * Know what you are choosing. The master key is in memory, so anyone who can read process
 * memory or your secret store can open every subject's data — where a KMS can refuse, log,
 * and be revoked centrally. Rotating means re-wrapping every row; the `keyId` on each row is
 * how you find the ones still on the old key.
 */
export class LocalMasterKeyWrapper implements KeyWrapper {
  readonly keyId: string;
  private readonly masterKey: Buffer;

  constructor(options: LocalMasterKeyOptions) {
    if (options.masterKey.length !== 32) {
      throw new Error(
        `LocalMasterKeyWrapper: masterKey must be 32 bytes (AES-256), got ${options.masterKey.length}`
      );
    }
    this.masterKey = options.masterKey;
    this.keyId = options.keyId ?? "local-master";
  }

  /** `iv(12) ‖ tag(16) ‖ ciphertext` — self-describing, so unwrap needs no side table. */
  wrap(dataKey: Buffer): Promise<Buffer> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey, iv);
    const sealed = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return Promise.resolve(Buffer.concat([iv, cipher.getAuthTag(), sealed]));
  }

  unwrap(sealed: Buffer): Promise<Buffer> {
    if (sealed.length < 12 + 16 + 1) {
      throw new Error("LocalMasterKeyWrapper: sealed key is too short to be well-formed");
    }
    const iv = sealed.subarray(0, 12);
    const tag = sealed.subarray(12, 28);
    const decipher = createDecipheriv("aes-256-gcm", this.masterKey, iv);
    decipher.setAuthTag(tag);
    // GCM authenticates: a wrong master key or a tampered row throws here rather than
    // returning plausible garbage that would then "decrypt" the log into nonsense.
    return Promise.resolve(Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]));
  }
}

// ── AWS KMS ──────────────────────────────────────────────────────────────────

export interface AwsKmsOptions {
  /** Key ARN, key id, or alias — whatever `Encrypt` accepts. */
  keyId: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  /** Override for a VPC endpoint, or for a fake in tests. */
  endpoint?: string;
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Extra context bound into the ciphertext; must match on decrypt. */
  encryptionContext?: Record<string, string>;
}

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

const sha256Hex = (data: string): string =>
  createHash("sha256").update(data, "utf8").digest("hex");

/**
 * Wraps data keys with AWS KMS `Encrypt` / `Decrypt`, over the HTTP API with SigV4.
 *
 * No AWS SDK: the wire call is one signed POST, and a plugin that drags in a vendor SDK to
 * make two requests taxes every install. `fetchImpl` is injectable so the signing and the
 * request shape are testable without a network or an account.
 *
 * **This never asks KMS to delete anything.** Erasure is the wrapped-key row going away —
 * see `KmsKeyStore`. Scheduling a KMS key for deletion would also erase every OTHER subject
 * wrapped under it, days later, which is not what `destroy(subjectId)` promises.
 */
export class AwsKmsWrapper implements KeyWrapper {
  readonly keyId: string;
  private readonly region: string;
  private readonly creds: AwsKmsOptions["credentials"];
  private readonly endpoint: string;
  private readonly doFetch: typeof fetch;
  private readonly context: Record<string, string> | undefined;

  constructor(options: AwsKmsOptions) {
    this.keyId = options.keyId;
    this.region = options.region;
    this.creds = options.credentials;
    this.endpoint = options.endpoint ?? `https://kms.${options.region}.amazonaws.com`;
    this.doFetch = options.fetchImpl ?? fetch;
    this.context = options.encryptionContext;
  }

  async wrap(dataKey: Buffer): Promise<Buffer> {
    const body = await this.call("TrentService.Encrypt", {
      KeyId: this.keyId,
      Plaintext: dataKey.toString("base64"),
      ...(this.context !== undefined && { EncryptionContext: this.context }),
    });
    const blob = (body as { CiphertextBlob?: string }).CiphertextBlob;
    if (typeof blob !== "string") throw new Error("AWS KMS Encrypt returned no CiphertextBlob");
    return Buffer.from(blob, "base64");
  }

  async unwrap(sealed: Buffer): Promise<Buffer> {
    const body = await this.call("TrentService.Decrypt", {
      CiphertextBlob: sealed.toString("base64"),
      ...(this.context !== undefined && { EncryptionContext: this.context }),
    });
    const plain = (body as { Plaintext?: string }).Plaintext;
    if (typeof plain !== "string") throw new Error("AWS KMS Decrypt returned no Plaintext");
    return Buffer.from(plain, "base64");
  }

  private async call(target: string, payload: unknown): Promise<unknown> {
    const body = JSON.stringify(payload);
    const now = new Date();
    const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15)}Z`;
    const dateStamp = amzDate.slice(0, 8);
    const host = new URL(this.endpoint).host;

    const headers: Record<string, string> = {
      "content-type": "application/x-amz-json-1.1",
      host,
      "x-amz-date": amzDate,
      "x-amz-target": target,
      ...(this.creds.sessionToken !== undefined && {
        "x-amz-security-token": this.creds.sessionToken,
      }),
    };

    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = `${Object.keys(headers)
      .sort()
      .map((h) => `${h}:${headers[h]}`)
      .join("\n")}\n`;
    const canonicalRequest = [
      "POST",
      "/",
      "",
      canonicalHeaders,
      signedHeaders,
      sha256Hex(body),
    ].join("\n");

    const scope = `${dateStamp}/${this.region}/kms/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      sha256Hex(canonicalRequest),
    ].join("\n");

    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.creds.secretAccessKey}`, dateStamp), this.region), "kms"),
      "aws4_request"
    );
    const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

    const response = await this.doFetch(this.endpoint, {
      method: "POST",
      headers: {
        ...headers,
        authorization: `AWS4-HMAC-SHA256 Credential=${this.creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      body,
    });

    if (!response.ok) {
      // KMS puts the useful part in the body — an `AccessDeniedException` or a
      // `KMSInvalidStateException` (the key is pending deletion) reads very differently from
      // "503", and both are things an operator can act on.
      throw new Error(
        `AWS KMS ${target.split(".")[1]} failed: ${response.status} ${await response.text()}`
      );
    }
    return await response.json();
  }
}
