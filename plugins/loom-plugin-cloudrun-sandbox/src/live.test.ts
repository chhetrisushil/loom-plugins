import { runSandboxBackendConformance } from "@loom/conformance";
import { describe } from "vitest";
import { CloudRunSandboxBackend } from "./index";
import { PYTHON_FIXTURES } from "./fixtures";

// LIVE: the kit against a DEPLOYED service, with the capabilities the deployment CLAIMS. This is how a
// stronger claim is earned (README). Skipped unless LOOM_CLOUDRUN_SANDBOX_URL is set; it contacts
// a real service and needs deploy.md's recipe done first.
//
//   LOOM_CLOUDRUN_SANDBOX_URL     the service URL
//   LOOM_CLOUDRUN_SANDBOX_TOKEN   optional: a Cloud Run ID token (gcloud auth print-identity-token --audiences=<url>)
//   LOOM_CLOUDRUN_SANDBOX_EGRESS  "blocked" to claim network "none" (default "open")
//   LOOM_CLOUDRUN_SANDBOX_FRESH   "1" to claim freshPerRun (EXIT_AFTER_EACH_REQUEST=1 + --concurrency 1)
const url = process.env.LOOM_CLOUDRUN_SANDBOX_URL;
const token = process.env.LOOM_CLOUDRUN_SANDBOX_TOKEN;

describe.skipIf(url === undefined || url === "")("live Cloud Run service", () => {
  runSandboxBackendConformance(
    () =>
      new CloudRunSandboxBackend({
        url: url as string,
        ...(token ? { getAuthHeaders: async () => ({ Authorization: `Bearer ${token}` }) } : {}),
        deployment: {
          egress: process.env.LOOM_CLOUDRUN_SANDBOX_EGRESS === "blocked" ? "blocked" : "open",
          freshInstancePerRun: process.env.LOOM_CLOUDRUN_SANDBOX_FRESH === "1",
        },
      }),
    // Cold starts: a fresh instance per run makes the 16 + 8 sequential/concurrent runs slow.
    { fixtures: PYTHON_FIXTURES, label: "CloudRunSandboxBackend (live)", timeoutMs: 300_000 }
  );
});
