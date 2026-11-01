import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEMORY_ENFORCED, findPython, startRunner, until, type LocalRunner } from "../test/util";
import { ESCAPE_PROBE_TARGETS, NETWORK_PROBE_TARGETS, PYTHON_FIXTURES } from "./fixtures";

const python = findPython();
if (python === undefined) {
  console.warn("SKIPPED runner tests: python3 >= 3.9 is not on PATH");
}

type Outcome = { ok: boolean; kind?: string; limit?: string; name?: string; message?: string; value?: unknown };

describe.skipIf(python === undefined)("runner (real process, 127.0.0.1)", () => {
  let runner: LocalRunner;
  beforeAll(async () => {
    runner = await startRunner();
  });
  afterAll(async () => {
    await runner.stop();
  });

  const post = async (
    script: string,
    input: unknown = null,
    limits: { wallClockMs: number; memoryBytes: number } = { wallClockMs: 3000, memoryBytes: 32 << 20 },
    base = runner.url
  ): Promise<Outcome> => {
    const res = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ script, inputJson: JSON.stringify(input), limits }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Outcome;
  };

  it("returns the script's result, and `input` is the parsed inputJson", async () => {
    const input = { a: [1, 2, { b: "é\u4e16" }], n: null };
    expect(await post("result = {'got': input, 'sum': sum(input['a'][:2])}", input)).toEqual({
      ok: true,
      value: { got: input, sum: 3 },
    });
  });

  it("a script that sets no result returns null", async () => {
    expect(await post("x = 1")).toEqual({ ok: true, value: null });
  });

  it("carries the rich value across the boundary exactly", async () => {
    const out = await post(PYTHON_FIXTURES.richValueScript);
    expect(out).toEqual({ ok: true, value: PYTHON_FIXTURES.richValue });
  });

  it("an exception is `threw` with name and message, and no traceback", async () => {
    const out = await post("def f():\n    raise ValueError('boom')\nf()");
    expect(out).toEqual({ ok: false, kind: "threw", name: "ValueError", message: "boom" });
    expect(JSON.stringify(out)).not.toMatch(/Traceback|File "/);
  });

  it("a syntax error is `threw` SyntaxError", async () => {
    expect(await post("def (")).toMatchObject({ ok: false, kind: "threw", name: "SyntaxError" });
  });

  it("a result that is not JSON is `threw`, not a crash", async () => {
    expect(await post("result = float('nan')")).toMatchObject({ ok: false, kind: "threw", name: "ValueError" });
    expect(await post("result = object()")).toMatchObject({ ok: false, kind: "threw", name: "TypeError" });
  });

  it("a thrown message is bounded by the runner", async () => {
    const out = await post(PYTHON_FIXTURES.hugeThrow);
    expect(out.kind).toBe("threw");
    expect((out.message ?? "").length).toBeLessThanOrEqual(8192);
  });

  it("MemoryError maps to limit/memory (the mapping, on every platform)", async () => {
    expect(await post("raise MemoryError()")).toEqual({ ok: false, kind: "limit", limit: "memory" });
  });

  it("an infinite loop is killed: wallClock when the clock is shorter than a CPU second", async () => {
    const out = await post("while True:\n    pass", null, { wallClockMs: 300, memoryBytes: 32 << 20 });
    expect(out).toEqual({ ok: false, kind: "limit", limit: "wallClock" });
  });

  it("a CPU-bound script is killed by RLIMIT_CPU: limit/cpu", async () => {
    // wallClock 1000 ms -> a 1 s CPU budget. cpu or wallClock may win the race to 1 s.
    const out = await post("while True:\n    pass", null, { wallClockMs: 1000, memoryBytes: 32 << 20 });
    expect(out.kind).toBe("limit");
    expect(["cpu", "wallClock"]).toContain(out.limit);
  });

  it("a sleeping script is killed at the wall clock", async () => {
    const out = await post("import time\ntime.sleep(60)", null, { wallClockMs: 300, memoryBytes: 32 << 20 });
    expect(out).toEqual({ ok: false, kind: "limit", limit: "wallClock" });
  });

  it.skipIf(!MEMORY_ENFORCED)("an allocation bomb is limit/memory (RLIMIT_AS, Linux only)", async () => {
    const out = await post(PYTHON_FIXTURES.allocationBomb, null, { wallClockMs: 20_000, memoryBytes: 32 << 20 });
    expect(out).toEqual({ ok: false, kind: "limit", limit: "memory" });
  });

  it.skipIf(MEMORY_ENFORCED)("RLIMIT_AS is refused by this platform: the default runner fails closed", async () => {
    // macOS: setrlimit(RLIMIT_AS) -> EINVAL, so a runner that enforces memory cannot start a child.
    const strict = await startRunner({ MEMORY_LIMIT: "enforce" });
    try {
      const out = await post("result = 1", null, undefined, strict.url);
      expect(out).toMatchObject({ ok: false, kind: "infrastructure" });
      const health = (await (await fetch(`${strict.url}healthz`)).json()) as { memoryEnforced: boolean };
      expect(health.memoryEnforced).toBe(true);
    } finally {
      await strict.stop();
    }
  });

  it("a flood on the script's stdout is discarded; the result is unaffected", async () => {
    const out = await post("import sys\nfor _ in range(2000):\n    print('x' * 100000)\n    sys.stderr.write('e' * 100000)\nresult = 'done'", null, {
      wallClockMs: 20_000,
      memoryBytes: 64 << 20,
    });
    expect(out).toEqual({ ok: true, value: "done" });
  });

  it("a huge result channel is capped: the child is killed and the answer is bounded", async () => {
    const small = await startRunner({ MAX_RESULT_BYTES: "100000" });
    try {
      const viaValue = await post("result = 'x' * 500000", null, undefined, small.url);
      expect(viaValue).toMatchObject({ ok: false, kind: "threw", name: "ResultTooLarge" });
      // Writing straight onto the result descriptor floods the pipe; the read stops at the cap.
      const viaFd = await post("import os\nwhile True:\n    os.write(3, b'x' * 65536)", null, { wallClockMs: 10_000, memoryBytes: 32 << 20 }, small.url);
      expect(viaFd).toMatchObject({ ok: false, kind: "threw", name: "ResultTooLarge" });
      expect(JSON.stringify(viaFd).length).toBeLessThan(500);
    } finally {
      await small.stop();
    }
  });

  it("the child has an empty environment and a private cwd that is removed afterwards", async () => {
    const out = await post("import os\nresult = {'cwd': os.getcwd(), 'env': sorted(os.environ)}");
    const value = (out as { value: { cwd: string; env: string[] } }).value;
    expect(value.env.filter((k) => !["LC_CTYPE", "__CF_USER_TEXT_ENCODING"].includes(k))).toEqual([]);
    expect(value.cwd).toMatch(/loom-sbx-/);
    await until(() => !existsSync(value.cwd), "the private directory to be removed");
  });

  it("each run is a fresh process (no module or global state carries over)", async () => {
    await post("import builtins\nbuiltins.leak = 1\nresult = 1");
    expect(await post("import builtins\nresult = hasattr(builtins, 'leak')")).toEqual({ ok: true, value: false });
  });

  describe("without EXIT_AFTER_EACH_REQUEST, state outside the child survives (freshPerRun is false)", () => {
    const stateFile = "/tmp/loom-conformance-state";
    beforeAll(() => rmSync(stateFile, { force: true }));
    afterAll(() => rmSync(stateFile, { force: true }));
    it("the stateful probe counts up", async () => {
      expect(await post(PYTHON_FIXTURES.statefulProbe)).toEqual({ ok: true, value: 1 });
      expect(await post(PYTHON_FIXTURES.statefulProbe)).toEqual({ ok: true, value: 2 });
    });
  });

  it("a client that hangs up mid-run gets its child killed", async () => {
    const controller = new AbortController();
    const pending = fetch(runner.url, {
      method: "POST",
      body: JSON.stringify({
        script: "while True:\n    pass",
        inputJson: "null",
        limits: { wallClockMs: 120_000, memoryBytes: 32 << 20 },
      }),
      signal: controller.signal,
    }).catch(() => undefined);
    const active = async () => ((await (await fetch(`${runner.url}healthz`)).json()) as { active: number }).active;
    await until(async () => (await active()) >= 1, "the run to start");
    controller.abort();
    await pending;
    await until(async () => (await active()) === 0, "the runner to stop the abandoned run");
  });

  describe("a hostile request", () => {
    let small: LocalRunner;
    beforeAll(async () => {
      small = await startRunner({ MAX_BODY_BYTES: "5000", MAX_WALL_CLOCK_MS: "2000" });
    });
    afterAll(async () => {
      await small.stop();
    });
    const raw = (body: string | undefined, headers: Record<string, string> = {}, path = "/") =>
      fetch(`${small.url.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      });
    const good = { script: "result = 1", inputJson: "1", limits: { wallClockMs: 1000, memoryBytes: 32 << 20 } };

    it("a body over the cap is 413", async () => {
      const res = await raw(JSON.stringify({ ...good, script: `result = '${"x".repeat(6000)}'` }));
      expect(res.status).toBe(413);
    });

    it("a chunked body without Content-Length is refused (411)", async () => {
      const port = Number(new URL(small.url).port);
      const status = await new Promise<string>((resolve, reject) => {
        const s = createConnection({ port, host: "127.0.0.1" }, () => {
          s.write("POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n");
        });
        let buf = "";
        s.on("data", (d) => {
          buf += d.toString();
        });
        s.on("end", () => resolve(buf.split("\r\n")[0] ?? ""));
        s.on("error", reject);
      });
      expect(status).toContain("411");
    });

    for (const [name, body] of [
      ["not JSON", "{nope"],
      ["not an object", "[1]"],
      ["no script", JSON.stringify({ ...good, script: undefined })],
      ["empty script", JSON.stringify({ ...good, script: "" })],
      ["NUL in script", JSON.stringify({ ...good, script: "result = 1\u0000" })],
      ["inputJson not a string", JSON.stringify({ ...good, inputJson: 1 })],
      ["no limits", JSON.stringify({ ...good, limits: undefined })],
      ["wallClockMs not a number", JSON.stringify({ ...good, limits: { wallClockMs: "1", memoryBytes: 1 << 25 } })],
      ["negative wallClockMs", JSON.stringify({ ...good, limits: { wallClockMs: -1, memoryBytes: 1 << 25 } })],
      ["memoryBytes below 1 MiB", JSON.stringify({ ...good, limits: { wallClockMs: 100, memoryBytes: 10 } })],
    ] as const) {
      it(`400: ${name}`, async () => {
        expect((await raw(body)).status).toBe(400);
      });
    }

    it("404 for an unknown path and for GET /", async () => {
      expect((await raw(JSON.stringify(good), {}, "/nope")).status).toBe(404);
      expect((await fetch(small.url)).status).toBe(404);
    });

    it("a wall clock above the operator's ceiling is clamped to it", async () => {
      const res = await raw(
        JSON.stringify({ script: "import time\ntime.sleep(60)", inputJson: "null", limits: { wallClockMs: 600_000, memoryBytes: 32 << 20 } })
      );
      expect(await res.json()).toEqual({ ok: false, kind: "limit", limit: "wallClock" });
    });

    it("the runner is still serving afterwards", async () => {
      const res = await raw(JSON.stringify(good));
      expect(await res.json()).toEqual({ ok: true, value: 1 });
    });
  });

  it("EXIT_AFTER_EACH_REQUEST=1: the process answers once and exits", async () => {
    const once = await startRunner({ EXIT_AFTER_EACH_REQUEST: "1" });
    const out = await post("result = 41 + 1", null, undefined, once.url);
    expect(out).toEqual({ ok: true, value: 42 });
    expect(await once.exited).toBe(0);
  });
});

describe.skipIf(python === undefined)("the Python fixtures", () => {
  const run = (script: string): { status: number | null; stdout: string } => {
    const r = spawnSync(python as string, ["-I", "-S", "-c", script], { encoding: "utf8", env: {} });
    return { status: r.status, stdout: r.stdout };
  };

  it("every fixture script parses as Python", () => {
    const { throwsMessage: _m, richValue: _v, ...scripts } = PYTHON_FIXTURES;
    for (const [name, script] of Object.entries(scripts)) {
      if (name === "syntaxError") continue;
      const r = spawnSync(python as string, ["-I", "-S", "-c", "import ast,sys; ast.parse(sys.stdin.read())"], {
        input: script as string,
        encoding: "utf8",
      });
      expect(r.status, `${name} must parse`).toBe(0);
    }
    const bad = spawnSync(python as string, ["-I", "-S", "-c", "import ast,sys; ast.parse(sys.stdin.read())"], {
      input: PYTHON_FIXTURES.syntaxError,
    });
    expect(bad.status).not.toBe(0);
  });

  // The probes must CONNECT. Without touching a real network, replace the connect call and watch what the probe does with it.
  const withConnect = (impl: string, probe: string) =>
    `import socket\nattempts = []\n${impl}\nsocket.create_connection = _connect\n${probe}\nimport json\nprint(json.dumps({'result': result, 'attempts': attempts}))`;

  const refuse = "def _connect(addr, timeout=None):\n    attempts.append([addr[0], addr[1], timeout])\n    raise OSError('refused')";
  const accept = "class _S:\n    def close(self): pass\ndef _connect(addr, timeout=None):\n    attempts.append([addr[0], addr[1], timeout])\n    return _S()";

  it("networkProbe tries to connect to public IPs with a short timeout; reached only if one connects", () => {
    const blocked = JSON.parse(run(withConnect(refuse, PYTHON_FIXTURES.networkProbe)).stdout);
    expect(blocked.result).toEqual({ reached: false });
    expect(blocked.attempts.map((a: unknown[]) => [a[0], a[1]])).toEqual(NETWORK_PROBE_TARGETS.map(([h, p]) => [h, p]));
    for (const a of blocked.attempts) {
      expect(a[2]).toBeLessThanOrEqual(5);
      expect(a[0]).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    }
    const open = JSON.parse(run(withConnect(accept, PYTHON_FIXTURES.networkProbe)).stdout);
    expect(open.result).toEqual({ reached: true });
  });

  it("escapeProbe connects out by other routes too, and reports reached only if something connects", () => {
    const blocked = JSON.parse(run(withConnect(refuse, PYTHON_FIXTURES.escapeProbe)).stdout);
    expect(blocked.result).toEqual({ reached: false });
    expect(blocked.attempts.map((a: unknown[]) => [a[0], a[1]])).toEqual(ESCAPE_PROBE_TARGETS.map(([h, p]) => [h, p]));
    expect(JSON.parse(run(withConnect(accept, PYTHON_FIXTURES.escapeProbe)).stdout).result).toEqual({ reached: true });
  });
});
