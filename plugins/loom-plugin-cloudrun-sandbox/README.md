# loom-plugin-cloudrun-sandbox

A third-party Loom **sandbox backend** (`SandboxBackend`, [ADR 0144](https://github.com/chhetrisushil/loom/blob/main/docs/adr/0144-sandbox-backend-spi.md))
that runs **model-written Python** on **Google Cloud Run**. It has two halves:

- `CloudRunSandboxBackend`, a TypeScript client. `SandboxEffect` (`@loom/sandbox`) owns the input and
  output ceilings, the content-address check, the `scriptError` / `limitExceeded` / `shapeMismatch`
  channels, bounded error text, cancellation and the replay form of the result; this client only
  POSTs one request and maps the answer to a `SandboxOutcome`.
- [`runner/`](runner), the service that goes on Cloud Run: a **standard-library-only** Python HTTP server
  (3.9+; the image uses 3.12) that runs each script in a fresh child process. [`deploy.md`](deploy.md) is
  the `gcloud` recipe for the ADR's remote-backend checklist.

This repo's other plugins implement a seam inside your process. This one executes code somewhere else,
so most of what matters is the deployment, and most of this README is about what the plugin can and cannot
promise about it.

## Install

```sh
pnpm add loom-plugin-cloudrun-sandbox @loom/sandbox
```

Node 20.3 or newer (it uses `AbortSignal.any`). The only runtime dependency is `@loom/sandbox`, a peer, so
there is one copy of the SPI. It does **not** depend on `google-auth-library`: authentication is a
function you pass in (below).

## Wire it

The sandbox is consumed from flow code, like a `Policy`, not from `defineConfig`.

```ts
import { registerSandboxBackend } from "@loom/sandbox";
import { CloudRunSandboxBackend } from "loom-plugin-cloudrun-sandbox";

const backend = new CloudRunSandboxBackend({
  url: "https://loom-sandbox-abc123-ew.a.run.app/",
  getAuthHeaders: async () => ({ Authorization: `Bearer ${await idToken()}` }),
  // What your DEPLOYMENT guarantees: see "Capabilities are earned". Omit it and you claim nothing.
  deployment: { egress: "blocked", freshInstancePerRun: true },
});

const effect = registerSandboxBackend(effects, scripts, backend, {
  limits: { wallClockMs: 5_000, memoryBytes: 128 * 1024 * 1024 },
  backendGraceMs: 90_000, // cold start + the kill; the default is 60 s
  // Needed exactly when the declaration is weaker than "none" / fresh:
  //   allowNetwork: true,            // egress: "open"
  //   allowReusedEnvironment: true,  // freshInstancePerRun: false
});
await effect.warm();  // optional
await effect.close(); // shutdown: aborts requests still in flight
```

### The script convention

The script is **Python**. The global `input` is `json.loads(inputJson)`; the result is the value of the
global `result` (absent means `null`), which must be JSON-serialisable (no `NaN`). An exception is a
`scriptError` (class name and message, no traceback); `print` output is discarded.

```python
result = {"total": sum(row["amount"] for row in input["rows"])}
```

### Getting an ID token

The service is deployed with `--no-allow-unauthenticated`, so each call needs a Google ID token whose
audience is the service URL. On Google Cloud, ask the metadata server (no library):

```ts
async function idToken(): Promise<string> {
  const audience = encodeURIComponent("https://loom-sandbox-abc123-ew.a.run.app");
  const res = await fetch(
    `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${audience}`,
    { headers: { "Metadata-Flavor": "Google" } }
  );
  if (!res.ok) throw new Error(`metadata server answered ${res.status}`);
  return res.text();
}
```

Cache the token until shortly before it expires (about an hour) rather than fetching per call. Off Google
Cloud, mint one with your own auth client or `gcloud auth print-identity-token --audiences=<url>`. The
client never follows redirects, so the `Authorization` header cannot be forwarded elsewhere.

## Capabilities are earned

A backend's `capabilities` are what the effect uses to decide what to refuse and whether the step is
`idempotent`. **For this plugin they describe the deployment, not the code**, and the client cannot
verify either claim. So you declare them, and the defaults are the weakest:

| Capability | Value | Why |
|---|---|---|
| `language` | `"python"` | the runner only runs Python |
| `wallClock` | `"hard"` | the runner kills the child at `wallClockMs` |
| `memory` | `true` | `RLIMIT_AS` on the child (Linux; see Limitations) |
| `cpu` | `true` | `RLIMIT_CPU` on the child |
| `network` | `"open"`, or `"none"` when `deployment.egress === "blocked"` | only the VPC can make this true |
| `freshPerRun` | `false`, or `true` when `deployment.freshInstancePerRun` | only one request per instance can make this true |

`egress: "blocked"` is true only if the service runs with all traffic into a subnet that has no way out
(no Cloud NAT, deny-all egress firewall). `freshInstancePerRun: true` is true only if the runner runs with
`EXIT_AFTER_EACH_REQUEST=1` under `--concurrency 1`, so Cloud Run replaces the instance and its in-memory
filesystem after every run. Without the exit, `/tmp` and every other file outside the child's own directory
survive to the next run, which may belong to another tenant, so `freshPerRun` is **false**. (Each run's
child process is always new; the instance around it is what is or is not reused.)

**Do not make a stronger claim because the deploy recipe says it should hold. Earn it:** run the
conformance kit against the DEPLOYED url with the claim, and keep it only if it passes.

```sh
LOOM_CLOUDRUN_SANDBOX_URL=https://… LOOM_CLOUDRUN_SANDBOX_TOKEN=… \
LOOM_CLOUDRUN_SANDBOX_EGRESS=blocked LOOM_CLOUDRUN_SANDBOX_FRESH=1 \
  pnpm --filter loom-plugin-cloudrun-sandbox exec vitest run src/live.test.ts
```

The kit passes the effect `allowNetwork` / `allowReusedEnvironment` exactly when the declaration needs
them, and runs the extra cases the claim unlocks. Rerun it whenever the network, the service account, the
image or the flags change. `PYTHON_FIXTURES` (exported) is the kit's fixture set for this runner's script
convention; use it for your own deployment tests:

```ts
import { runSandboxBackendConformance } from "@loom/conformance";
import { CloudRunSandboxBackend, PYTHON_FIXTURES } from "loom-plugin-cloudrun-sandbox";

runSandboxBackendConformance(() => new CloudRunSandboxBackend({ url, deployment }), {
  fixtures: PYTHON_FIXTURES,
  timeoutMs: 300_000, // cold starts
});
```

The network probe does not look up names or check that `socket` imports: it opens TCP connections to public
addresses with a 3 s timeout, which is the thing a deployed egress block has to stop.

## Local versus deployed

What this repository's own tests prove, and what only a deployed service can.

| | Local runner (`vitest`, 127.0.0.1) | Deployed per `deploy.md` |
|---|---|---|
| echo, throw, syntax error, rich value, oversized `threw` | yes | yes |
| runaway loop (`cpu` or `wallClock`) | yes | yes |
| allocation bomb → `memory` | **Linux only**; macOS refuses `RLIMIT_AS` | yes |
| abort mid-run stops the work | yes (the runner kills the child when the client hangs up) | yes |
| no network, no escape | skipped (`network: "open"`) | runs when you claim `egress: "blocked"` |
| fresh per run | skipped (`freshPerRun: false`) | runs when you claim `freshInstancePerRun` |
| declared capabilities | `network: "open"`, `freshPerRun: false` | what you earned |
| contacts a real cloud service | never | the live test only, opt-in |

## The runner

`runner/server.py` listens on `$PORT` (bind address `BIND_HOST`, default `0.0.0.0`). Per request it
validates the body (size, field types, no NUL in the script, positive limits), then starts a **new**
`python3 -I -S` child that, before it touches the script, lowers `RLIMIT_AS` (`memoryBytes` plus
`MEMORY_OVERHEAD_BYTES`, because the interpreter's mappings count) and `RLIMIT_CPU` (the wall clock
rounded up to whole seconds) on itself; it runs in a private temporary directory with an empty
environment and with its stdout and stderr on `/dev/null`. The parent reads the child's result over a
separate descriptor, capped at `MAX_RESULT_BYTES`, kills the child's process group at the wall clock, and
kills it when the client hangs up. Exit mapping: wall clock → `limit/wallClock`; `MemoryError` →
`limit/memory`; `SIGXCPU` → `limit/cpu`; an exception → `threw`; a result over the cap →
`threw` named `ResultTooLarge`; anything unexplained → `infrastructure` with a fixed message.

All settings are environment variables, documented at the top of the file. The ones that matter:
`EXIT_AFTER_EACH_REQUEST`, `MAX_WALL_CLOCK_MS` (a request above it is clamped, not refused),
`MAX_MEMORY_BYTES`, `MAX_BODY_BYTES`, `MAX_RESULT_BYTES`. `MEMORY_LIMIT=off` runs without a memory cap, for
local development on macOS only; the default fails closed where `RLIMIT_AS` cannot be applied, and
`/healthz` reports which mode is running.

### Client behaviour

`evaluate` POSTs `{ script, inputJson, limits }` as JSON to the url, passes the effect's signal to `fetch`,
and reads the response as a stream, stopping past `maxResponseBytes` (default 2 MiB + 64 KiB). It validates
the answer against the closed vocabulary. Any HTTP status other than 200, bad JSON, a wrong shape, an
oversized body, a redirect or a network error becomes `{ ok: false, kind: "infrastructure", message }` with a
short message written by this plugin, never a piece of the response, which is untyped and retryable in the
effect. The runner's own `infrastructure` text is replaced for the same reason.

## Limitations

- **The runner is not a boundary on its own.** The child runs as the same unprivileged user in the same
  container as the runner. What isolates it from you is the deployment (the execution environment, no
  roles, no secrets, no egress), and nothing in this repository can check that. A script can fork, read
  `/proc`, and use any file the user can; `RLIMIT_NPROC` is not set.
- **The metadata server** is reachable from a Cloud Run container whatever the VPC says (verify for your
  project), so a script can fetch the token of the service account. The account must hold no roles; that
  is the defence. The escape probe therefore does not treat the metadata server as an escape.
- **Memory.** `RLIMIT_AS` limits virtual address space, which over-counts what the script actually holds.
  macOS refuses `setrlimit(RLIMIT_AS)` (EINVAL), so the memory cap and the `limit/memory` mapping under a
  real allocation bomb were **not exercised by this repository's tests**; only the `MemoryError` mapping is.
  Run the live test, or the local suite on Linux, before trusting `memory: true`. A process that dies from
  an allocation failure the interpreter cannot recover from is reported as `infrastructure`, not `memory`.
- **One request per instance costs a cold start per run** (seconds). `backendGraceMs` must cover it. Without
  `EXIT_AFTER_EACH_REQUEST` you save that and lose `freshPerRun`.
- **Results.** Python integers are arbitrary precision but cross into JavaScript as doubles, so integers past
  2^53 lose precision in the loom value. `NaN` and `Infinity` are refused. A result over the runner's cap is
  a `scriptError`, not `limitExceeded output`, because the value never reaches loom to be measured.
- **Wall clock** starts when the child is spawned, so interpreter start-up counts, and a request above
  `MAX_WALL_CLOCK_MS` is clamped to it.
- Python only, one script per request: no packages, files or multi-file projects. The standard library is
  available to the script, including `socket`, so network isolation is entirely the deployment's job.
- The client sends the whole script and input in one JSON body (Cloud Run's HTTP/1 request limit is 32 MiB).

## Contract

- Implements the sandbox backend SPI (`SANDBOX_BACKEND_SPI_VERSION 1.0.0`); `loom plugin check` passes.
- Tests: `pnpm test` (client against a local fake server; the runner as a real process; the conformance kit
  over the local runner; Python 3.9+ on `PATH`, otherwise those suites report as skipped). The live suite is
  skipped unless `LOOM_CLOUDRUN_SANDBOX_URL` is set.
- Third-party: you own the supply-chain trust. Apache-2.0 (see the repository `LICENSE` and `NOTICE`).
