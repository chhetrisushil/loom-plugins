import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { CloudRunSandboxBackend, DEFAULT_MAX_RESPONSE_BYTES } from "./index";
import { listen, readBody, until } from "../test/util";

const REQUEST = {
  script: "result = input",
  inputJson: '{"a":1}',
  limits: { wallClockMs: 1000, memoryBytes: 32 * 1024 * 1024 },
};

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function backendFor(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  options: Partial<ConstructorParameters<typeof CloudRunSandboxBackend>[0]> = {}
) {
  const srv = await listen(handler);
  const backend = new CloudRunSandboxBackend({ url: srv.url, ...options });
  return { srv, backend };
}

describe("capabilities are the deployment's declaration", () => {
  const url = "https://svc.example.run.app/";

  it("defaults to the weakest claims", () => {
    expect(new CloudRunSandboxBackend({ url }).capabilities).toEqual({
      language: "python",
      network: "open",
      wallClock: "hard",
      memory: true,
      cpu: true,
      freshPerRun: false,
    });
  });

  it("follows the declaration, and is frozen", () => {
    const b = new CloudRunSandboxBackend({
      url,
      deployment: { egress: "blocked", freshInstancePerRun: true },
    });
    expect(b.capabilities).toMatchObject({ network: "none", freshPerRun: true });
    expect(Object.isFrozen(b.capabilities)).toBe(true);
    const half = new CloudRunSandboxBackend({ url, deployment: { egress: "blocked" } });
    expect(half.capabilities).toMatchObject({ network: "none", freshPerRun: false });
  });

  it("refuses a bad url, bad declaration or bad cap at construction", () => {
    expect(() => new CloudRunSandboxBackend({ url: "not a url" })).toThrow(/valid URL/);
    expect(() => new CloudRunSandboxBackend({ url: "ftp://x/" })).toThrow(/http/);
    expect(() => new CloudRunSandboxBackend({ url: "https://u:p@x/" })).toThrow(/credentials/);
    expect(
      () => new CloudRunSandboxBackend({ url, deployment: { egress: "none" as never } })
    ).toThrow(/egress/);
    expect(
      () => new CloudRunSandboxBackend({ url, deployment: { freshInstancePerRun: "yes" as never } })
    ).toThrow(/freshInstancePerRun/);
    expect(() => new CloudRunSandboxBackend({ url, maxResponseBytes: 10 })).toThrow(/maxResponseBytes/);
  });
});

describe("evaluate: the request", () => {
  it("POSTs script, inputJson and limits as JSON, with the auth headers", async () => {
    let seen: { method?: string; headers: IncomingMessage["headers"]; body: string } | undefined;
    const { srv, backend } = await backendFor(
      async (req, res) => {
        seen = { method: req.method, headers: req.headers, body: await readBody(req) };
        json(res, { ok: true, value: 7 });
      },
      {
        getAuthHeaders: async () => ({ Authorization: "Bearer tok", "Content-Type": "text/plain" }),
      }
    );
    try {
      expect(await backend.evaluate(REQUEST)).toEqual({ ok: true, value: 7 });
      expect(seen?.method).toBe("POST");
      expect(seen?.headers.authorization).toBe("Bearer tok");
      expect(seen?.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(seen?.body ?? "")).toEqual(REQUEST);
    } finally {
      await srv.close();
    }
  });

  it("uses an injected fetch", async () => {
    const calls: string[] = [];
    const backend = new CloudRunSandboxBackend({
      url: "https://svc.example.run.app/",
      fetch: (async (url: string) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ ok: true, value: "x" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await backend.evaluate(REQUEST)).toEqual({ ok: true, value: "x" });
    expect(calls).toEqual(["https://svc.example.run.app/"]);
  });

  it("a failing auth provider is infrastructure and sends nothing", async () => {
    let hits = 0;
    const { srv, backend } = await backendFor(
      (_req, res) => {
        hits++;
        json(res, { ok: true, value: 1 });
      },
      {
        getAuthHeaders: async () => {
          throw new Error("metadata server exploded: secret-detail");
        },
      }
    );
    try {
      const out = await backend.evaluate(REQUEST);
      expect(out).toMatchObject({ ok: false, kind: "infrastructure" });
      expect(JSON.stringify(out)).not.toContain("secret-detail");
      expect(hits).toBe(0);
    } finally {
      await srv.close();
    }
  });
});

describe("evaluate: every outcome kind", () => {
  const cases: Array<[string, unknown, unknown]> = [
    ["ok", { ok: true, value: { a: [1, null] } }, { ok: true, value: { a: [1, null] } }],
    ["ok with a null value", { ok: true, value: null }, { ok: true, value: null }],
    ["limit cpu", { ok: false, kind: "limit", limit: "cpu" }, { ok: false, kind: "limit", limit: "cpu" }],
    ["limit memory", { ok: false, kind: "limit", limit: "memory" }, { ok: false, kind: "limit", limit: "memory" }],
    ["limit wallClock", { ok: false, kind: "limit", limit: "wallClock" }, { ok: false, kind: "limit", limit: "wallClock" }],
    [
      "threw with a name",
      { ok: false, kind: "threw", name: "ValueError", message: "boom" },
      { ok: false, kind: "threw", name: "ValueError", message: "boom" },
    ],
    [
      "threw without a name",
      { ok: false, kind: "threw", message: "boom" },
      { ok: false, kind: "threw", message: "boom" },
    ],
    ["inputTooLarge", { ok: false, kind: "inputTooLarge" }, { ok: false, kind: "inputTooLarge" }],
  ];
  for (const [name, wire, expected] of cases) {
    it(name, async () => {
      const { srv, backend } = await backendFor((_req, res) => json(res, wire));
      try {
        expect(await backend.evaluate(REQUEST)).toEqual(expected);
      } finally {
        await srv.close();
      }
    });
  }

  it("the runner's own infrastructure text is replaced, not forwarded", async () => {
    const { srv, backend } = await backendFor((_req, res) =>
      json(res, { ok: false, kind: "infrastructure", message: "LEAK /etc/passwd" })
    );
    try {
      const out = await backend.evaluate(REQUEST);
      expect(out).toMatchObject({ ok: false, kind: "infrastructure" });
      expect(JSON.stringify(out)).not.toContain("LEAK");
    } finally {
      await srv.close();
    }
  });
});

describe("evaluate: anything unexpected is infrastructure, never the body", () => {
  const SECRET = "TOP-SECRET-BODY";
  const bad: Array<[string, (res: ServerResponse) => void]> = [
    ["HTTP 500", (res) => json(res, { error: SECRET }, 500)],
    ["HTTP 403", (res) => json(res, { error: SECRET }, 403)],
    ["HTTP 204", (res) => res.writeHead(204).end()],
    ["not JSON", (res) => res.writeHead(200).end(`<html>${SECRET}`)],
    ["JSON null", (res) => json(res, null)],
    ["JSON array", (res) => json(res, [SECRET])],
    ["ok not boolean", (res) => json(res, { ok: "true", value: SECRET })],
    ["ok without value", (res) => json(res, { ok: true })],
    ["unknown kind", (res) => json(res, { ok: false, kind: SECRET })],
    ["limit not in vocabulary", (res) => json(res, { ok: false, kind: "limit", limit: SECRET })],
    ["threw without message", (res) => json(res, { ok: false, kind: "threw", name: SECRET })],
    ["threw with non-string name", (res) => json(res, { ok: false, kind: "threw", name: 5, message: SECRET })],
    ["invalid UTF-8", (res) => res.writeHead(200).end(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))],
  ];
  for (const [name, respond] of bad) {
    it(name, async () => {
      const { srv, backend } = await backendFor((_req, res) => respond(res));
      try {
        const out = await backend.evaluate(REQUEST);
        expect(out).toMatchObject({ ok: false, kind: "infrastructure" });
        expect(JSON.stringify(out)).not.toContain(SECRET);
        expect((out as { message: string }).message.length).toBeLessThan(120);
      } finally {
        await srv.close();
      }
    });
  }

  it("a body past the cap, declared by Content-Length, is refused without reading it", async () => {
    const { srv, backend } = await backendFor((_req, res) => {
      res.writeHead(200, { "content-length": String(DEFAULT_MAX_RESPONSE_BYTES + 1) });
      res.write("{");
    });
    try {
      expect(await backend.evaluate(REQUEST)).toMatchObject({ ok: false, kind: "infrastructure" });
    } finally {
      await srv.close();
    }
  });

  it("a streamed body past the cap stops the read: the server sees the connection close", async () => {
    let closed = false;
    let written = 0;
    const { srv, backend } = await backendFor(
      (req, res) => {
        res.on("close", () => {
          closed = true;
        });
        res.writeHead(200);
        res.write('{"ok":true,"value":"');
        const pump = () => {
          if (closed || res.destroyed) return;
          const chunk = "x".repeat(16 * 1024);
          written += chunk.length;
          if (res.write(chunk)) setImmediate(pump);
          else res.once("drain", pump);
        };
        pump();
        void req;
      },
      { maxResponseBytes: 64 * 1024 }
    );
    try {
      expect(await backend.evaluate(REQUEST)).toMatchObject({ ok: false, kind: "infrastructure" });
      await until(() => closed, "the server to see the client hang up");
      expect(written).toBeLessThan(64 * 1024 * 64); // stopped long before an unbounded stream would
    } finally {
      await srv.close();
    }
  });

  it("a body exactly at the cap is read", async () => {
    const value = "y".repeat(2000);
    const text = JSON.stringify({ ok: true, value });
    const { srv, backend } = await backendFor((_req, res) => res.writeHead(200).end(text), {
      maxResponseBytes: Buffer.byteLength(text),
    });
    try {
      expect(await backend.evaluate(REQUEST)).toEqual({ ok: true, value });
    } finally {
      await srv.close();
    }
  });

  it("a network error (nothing listening) is infrastructure", async () => {
    const srv = await listen(() => {});
    const url = srv.url;
    await srv.close();
    const out = await new CloudRunSandboxBackend({ url }).evaluate(REQUEST);
    expect(out).toMatchObject({ ok: false, kind: "infrastructure" });
  });

  it("a redirect is refused and not followed", async () => {
    let targetHits = 0;
    const target = await listen((_req, res) => {
      targetHits++;
      json(res, { ok: true, value: "followed" });
    });
    const { srv, backend } = await backendFor(
      (_req, res) => res.writeHead(302, { location: target.url }).end(),
      { getAuthHeaders: async () => ({ Authorization: "Bearer tok" }) }
    );
    try {
      expect(await backend.evaluate(REQUEST)).toMatchObject({ ok: false, kind: "infrastructure" });
      expect(targetHits).toBe(0);
    } finally {
      await srv.close();
      await target.close();
    }
  });
});

describe("evaluate: cancellation", () => {
  it("an abort mid-request cancels the fetch (the server sees the hang-up) and settles", async () => {
    let arrived = false;
    let closed = false;
    const { srv, backend } = await backendFor((req) => {
      arrived = true;
      req.on("close", () => {
        closed = true;
      });
      // never answers
    });
    try {
      const controller = new AbortController();
      const pending = backend.evaluate({ ...REQUEST, signal: controller.signal });
      await until(() => arrived, "the request to reach the server");
      controller.abort(new Error("stop"));
      expect(await pending).toMatchObject({ ok: false, kind: "infrastructure" });
      await until(() => closed, "the server to see the connection close");
    } finally {
      await srv.close();
    }
  });

  it("an already-aborted signal never reaches the server", async () => {
    let hits = 0;
    const { srv, backend } = await backendFor((_req, res) => {
      hits++;
      json(res, { ok: true, value: 1 });
    });
    try {
      const out = await backend.evaluate({ ...REQUEST, signal: AbortSignal.abort(new Error("no")) });
      expect(out).toMatchObject({ ok: false, kind: "infrastructure" });
      expect(hits).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it("close() aborts requests still in flight", async () => {
    let arrived = false;
    const { srv, backend } = await backendFor(() => {
      arrived = true;
    });
    try {
      const pending = backend.evaluate(REQUEST);
      await until(() => arrived, "the request to reach the server");
      await backend.close();
      expect(await pending).toMatchObject({ ok: false, kind: "infrastructure" });
    } finally {
      await srv.close();
    }
  });
});
