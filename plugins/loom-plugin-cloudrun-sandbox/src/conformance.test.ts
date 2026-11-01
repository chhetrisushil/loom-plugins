import { runSandboxBackendConformance } from "@loom/conformance";
import { afterAll, beforeAll, describe } from "vitest";
import { MEMORY_ENFORCED, findPython, startRunner, type LocalRunner } from "../test/util";
import { CloudRunSandboxBackend } from "./index";
import { PYTHON_FIXTURES } from "./fixtures";

// The SPI kit over the LOCAL runner. Locally there is no egress block and no instance recycling,
// so the honest declaration is network "open" and freshPerRun false (the defaults): the kit skips
// the no-network/no-escape and fresh-per-run cases, which only a deployed service can earn.
// macOS refuses RLIMIT_AS, so there `memory` is declared false (the kit then skips the allocation
// bomb instead of letting it eat the machine); on Linux the memory cap is exercised for real.
const python = findPython();
if (python === undefined) console.warn("SKIPPED conformance over the local runner: python3 >= 3.9 is not on PATH");

describe.skipIf(python === undefined)("local runner", () => {
  let runner: LocalRunner;
  beforeAll(async () => {
    runner = await startRunner();
  });
  afterAll(async () => {
    await runner.stop();
  });

  runSandboxBackendConformance(
    () => {
      const real = new CloudRunSandboxBackend({ url: runner.url });
      return {
        capabilities: { ...real.capabilities, memory: MEMORY_ENFORCED },
        evaluate: (request) => real.evaluate(request),
        close: () => real.close(),
      };
    },
    { fixtures: PYTHON_FIXTURES, label: "CloudRunSandboxBackend (local runner)" }
  );
});
