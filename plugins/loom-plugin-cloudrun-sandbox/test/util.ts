import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

/** Poll `cond` until it holds. Never a fixed sleep before an assertion. */
export async function until(
  cond: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 15_000
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A real HTTP server on 127.0.0.1 (never a wildcard bind). */
export async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * The real interpreter path of `python3` >= 3.9, or undefined when absent. (The path, not the name: the
 * macOS `/usr/bin/python3` shim injects SDKROOT & co. into an empty environment, which a test of
 * "the child's environment is empty" must not see.)
 */
export function findPython(): string | undefined {
  const r = spawnSync(
    "python3",
    ["-c", "import sys; print(sys.executable if sys.version_info >= (3, 9) else '')"],
    { encoding: "utf8" }
  );
  const exe = r.stdout.trim();
  return r.status === 0 && exe !== "" ? exe : undefined;
}

/**
 * RLIMIT_AS is refused by macOS (`setrlimit` -> EINVAL), so the memory cap can only be exercised on
 * Linux. Elsewhere the runner is started with MEMORY_LIMIT=off and the backend declares memory: false.
 */
export const MEMORY_ENFORCED = process.platform === "linux";

export interface LocalRunner {
  url: string;
  pid: number;
  stop: () => Promise<void>;
  exited: Promise<number | null>;
}

const RUNNER = join(__dirname, "..", "runner", "server.py");

/** Start runner/server.py as a real process on 127.0.0.1 and an OS-chosen port. */
export async function startRunner(
  env: Record<string, string> = {}
): Promise<LocalRunner> {
  const child: ChildProcess = spawn("python3", [RUNNER], {
    env: {
      PATH: process.env.PATH ?? "",
      PORT: "0",
      BIND_HOST: "127.0.0.1",
      ...(MEMORY_ENFORCED ? {} : { MEMORY_LIMIT: "off" }),
      ...env,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = /listening [^\n]*:(\d+)\n/.exec(buf);
      if (m) resolve(Number(m[1]));
    });
    child.once("error", reject);
    exited.then(() => reject(new Error("runner exited before listening")));
  });
  let stopped = false;
  return {
    url: `http://127.0.0.1:${port}/`,
    pid: child.pid as number,
    exited,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      // Only the pid we spawned.
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
    },
  };
}
