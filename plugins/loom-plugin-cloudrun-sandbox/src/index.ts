import type {
  SandboxBackend,
  SandboxBackendCapabilities,
  SandboxOutcome,
  SandboxRequest,
} from "@loom/sandbox";

export { PYTHON_FIXTURES, NETWORK_PROBE_TARGETS, ESCAPE_PROBE_TARGETS } from "./fixtures";
export type { PythonSandboxFixtures } from "./fixtures";

/**
 * What the DEPLOYMENT guarantees. The client cannot see it, so you declare it, and every stronger
 * claim has to be earned by running the conformance kit against the deployed service (README).
 */
export interface CloudRunDeployment {
  /**
   * `"blocked"`: the network layer refuses all egress from the service (no Cloud NAT, deny-all egress
   * firewall). `"open"` (default): it does not, or you have not proven it does.
   */
  egress: "blocked" | "open";
  /**
   * `true` only when each run gets a brand-new instance: the runner started with
   * `EXIT_AFTER_EACH_REQUEST=1` under `--concurrency 1`. Default `false`.
   */
  freshInstancePerRun: boolean;
}

export interface CloudRunSandboxBackendOptions {
  /** The service URL (`https://<service>-<hash>.<region>.run.app/`). The request is POSTed to it as given. */
  url: string;
  /**
   * Headers to send on every request, typically `{ Authorization: "Bearer <ID token>" }`. This plugin
   * does not depend on google-auth-library: fetch the token from the metadata server (README) or use
   * your own auth client, and cache it for its lifetime. Called per request.
   */
  getAuthHeaders?: () => Promise<Record<string, string>>;
  /** What the deployment guarantees. Defaults to the weakest claims: egress open, instances reused. */
  deployment?: Partial<CloudRunDeployment>;
  /** Largest response body read, in bytes. Default 2 MiB + 64 KiB (a 1 MiB result, escaped, plus the envelope). */
  maxResponseBytes?: number;
  /** For tests, or to route through a proxy. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** 2 x the effect's default 1 MiB output ceiling (JSON escaping can double a string), plus the envelope. */
export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024 + 64 * 1024;

const infra = (message: string): SandboxOutcome => ({ ok: false, kind: "infrastructure", message });

/**
 * A `SandboxBackend` that runs model-written PYTHON on a Cloud Run service running this package's
 * `runner/`. Register it from flow code with `registerSandboxBackend`.
 *
 * Capabilities are a property of the DEPLOYMENT, not of this code: see {@link CloudRunDeployment}.
 * Fixed by the runner: `language: "python"`, `wallClock: "hard"` (the runner kills the child),
 * `memory: true` and `cpu: true` (RLIMIT_AS / RLIMIT_CPU, applied in the child).
 */
export class CloudRunSandboxBackend implements SandboxBackend {
  readonly capabilities: SandboxBackendCapabilities;
  private readonly url: string;
  private readonly getAuthHeaders: (() => Promise<Record<string, string>>) | undefined;
  private readonly maxResponseBytes: number;
  private readonly doFetch: typeof fetch;
  private readonly inflight = new Set<AbortController>();

  constructor(options: CloudRunSandboxBackendOptions) {
    let parsed: URL;
    try {
      parsed = new URL(options.url);
    } catch {
      throw new Error("CloudRunSandboxBackend: `url` is not a valid URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("CloudRunSandboxBackend: `url` must be http(s)");
    }
    if (parsed.username !== "" || parsed.password !== "") {
      throw new Error("CloudRunSandboxBackend: `url` must not carry credentials");
    }
    const egress = options.deployment?.egress ?? "open";
    const fresh = options.deployment?.freshInstancePerRun ?? false;
    if (egress !== "blocked" && egress !== "open") {
      throw new Error('CloudRunSandboxBackend: `deployment.egress` must be "blocked" or "open"');
    }
    if (typeof fresh !== "boolean") {
      throw new Error("CloudRunSandboxBackend: `deployment.freshInstancePerRun` must be a boolean");
    }
    const max = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isInteger(max) || max < 1024) {
      throw new Error("CloudRunSandboxBackend: `maxResponseBytes` must be an integer >= 1024");
    }
    this.url = parsed.toString();
    this.getAuthHeaders = options.getAuthHeaders;
    this.maxResponseBytes = max;
    this.doFetch = options.fetch ?? fetch;
    this.capabilities = Object.freeze({
      language: "python",
      network: egress === "blocked" ? "none" : "open",
      wallClock: "hard",
      memory: true,
      cpu: true,
      freshPerRun: fresh,
    });
  }

  async evaluate(request: SandboxRequest): Promise<SandboxOutcome> {
    const own = new AbortController();
    this.inflight.add(own);
    const signal =
      request.signal === undefined ? own.signal : AbortSignal.any([request.signal, own.signal]);
    try {
      let auth: Record<string, string> = {};
      if (this.getAuthHeaders !== undefined) {
        try {
          auth = await this.getAuthHeaders();
        } catch {
          return infra("sandbox: could not obtain auth headers for the Cloud Run service");
        }
      }
      let res: Response;
      try {
        res = await this.doFetch(this.url, {
          method: "POST",
          headers: withFixedHeaders(auth),
          body: JSON.stringify({
            script: request.script,
            inputJson: request.inputJson,
            limits: request.limits,
          }),
          signal,
          // A redirect would carry the Authorization header to wherever it points.
          redirect: "error",
        });
      } catch {
        return infra(
          signal.aborted ? "sandbox: request aborted" : "sandbox: could not reach the Cloud Run service"
        );
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        return infra(`sandbox: the Cloud Run service answered HTTP ${res.status}`);
      }
      const text = await this.readCapped(res, signal);
      if (text === undefined) return infra("sandbox: the service response was too large or unreadable");
      return parseOutcome(text);
    } finally {
      this.inflight.delete(own);
    }
  }

  /** Abort requests still in flight. */
  async close(): Promise<void> {
    for (const c of this.inflight) c.abort(new Error("backend closed"));
    this.inflight.clear();
  }

  /** Stream the body and stop reading as soon as it passes the cap. `undefined` on any failure. */
  private async readCapped(res: Response, signal: AbortSignal): Promise<string | undefined> {
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > this.maxResponseBytes) {
      await res.body?.cancel().catch(() => {});
      return undefined;
    }
    if (res.body === null) return undefined;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        if (signal.aborted) throw new Error("aborted");
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.maxResponseBytes) {
          await reader.cancel().catch(() => {});
          return undefined;
        }
        chunks.push(value);
      }
      const all = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        all.set(c, at);
        at += c.byteLength;
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(all);
    } catch {
      await reader.cancel().catch(() => {});
      return undefined;
    }
  }
}

/** The fixed headers win over anything the auth provider returned for the same name, in any letter case. */
function withFixedHeaders(auth: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(auth)) {
    const lower = k.toLowerCase();
    if (lower !== "content-type" && lower !== "accept" && lower !== "content-length") out[k] = v;
  }
  out["content-type"] = "application/json";
  out.accept = "application/json";
  return out;
}

/** Validate the runner's JSON against the closed vocabulary. Anything else is infrastructure. */
function parseOutcome(text: string): SandboxOutcome {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return infra("sandbox: the service response is not JSON");
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return infra("sandbox: the service response has an unexpected shape");
  }
  const o = doc as Record<string, unknown>;
  if (o.ok === true) {
    return "value" in o
      ? { ok: true, value: o.value }
      : infra("sandbox: the service response has an unexpected shape");
  }
  if (o.ok !== false) return infra("sandbox: the service response has an unexpected shape");
  switch (o.kind) {
    case "limit":
      return o.limit === "cpu" || o.limit === "memory" || o.limit === "wallClock"
        ? { ok: false, kind: "limit", limit: o.limit }
        : infra("sandbox: the service response has an unexpected shape");
    case "threw":
      if (typeof o.message !== "string" || (o.name !== undefined && typeof o.name !== "string")) {
        return infra("sandbox: the service response has an unexpected shape");
      }
      return o.name === undefined
        ? { ok: false, kind: "threw", message: o.message }
        : { ok: false, kind: "threw", name: o.name, message: o.message };
    case "inputTooLarge":
      return { ok: false, kind: "inputTooLarge" };
    case "infrastructure":
      // The runner's own text is not forwarded: loom authors every infrastructure message.
      return infra("sandbox: the Cloud Run runner reported an infrastructure failure");
    default:
      return infra("sandbox: the service response has an unexpected shape");
  }
}
