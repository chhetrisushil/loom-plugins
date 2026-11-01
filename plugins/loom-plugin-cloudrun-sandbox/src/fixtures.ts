/**
 * Conformance fixtures for a PYTHON sandbox backend (`runSandboxBackendConformance(factory, { fixtures })`).
 *
 * The script convention is this plugin's runner: the global `input` is the parsed input and the
 * result is the value of the global `result`. The shape is structurally identical to `SandboxFixtures`
 * in `@loom/conformance`; it is declared here so a consumer's runtime does not need the kit.
 */
export interface PythonSandboxFixtures {
  echo: string;
  throws: string;
  throwsMessage: string;
  syntaxError: string;
  runaway: string;
  allocationBomb: string;
  networkProbe: string;
  escapeProbe: string;
  statefulProbe: string;
  hugeThrow: string;
  richValueScript: string;
  richValue: unknown;
}

/** Unicode (BMP, astral), escapes, integers past 2^31, nesting: what a boundary that mangles values gets wrong. */
const RICH_VALUE = {
  s: 'héllo 世界 😀 "q" \\ \n\t',
  big: 9007199254740991,
  neg: -4294967297,
  f: 1.5e-7,
  deep: [[{ a: [1, [2, { b: null }]] }]],
  empty: { o: {}, a: [] },
  t: true,
};

/**
 * Public addresses the network probe tries to CONNECT to. A name lookup or an `import socket` proves
 * nothing: the claim a deployment makes is that the packets do not leave, so the probe sends a SYN.
 * Three destinations on different ranges and ports, so one filtered port or one dead host cannot
 * make an open network look closed.
 */
export const NETWORK_PROBE_TARGETS: ReadonlyArray<readonly [string, number]> = [
  ["1.1.1.1", 53],
  ["8.8.8.8", 53],
  ["93.184.216.34", 80],
];

const networkProbe = `import socket
reached = False
for host, port in ${JSON.stringify(NETWORK_PROBE_TARGETS.map(([h, p]) => [h, p]))}:
    try:
        socket.create_connection((host, port), timeout=3).close()
        reached = True
        break
    except Exception:
        pass
result = {"reached": reached}
`;

/** A second set of destinations for the escape probe: other ranges, TCP/443, so it is not the network probe again. */
export const ESCAPE_PROBE_TARGETS: ReadonlyArray<readonly [string, number]> = [
  ["9.9.9.9", 443],
  ["208.67.222.222", 443],
];

/**
 * Host capabilities a script must not have: a non-empty environment (the runner starts the child with
 * none; the two keys are what the interpreter and macOS add themselves) and an outbound connection by
 * another route than the network probe's. It deliberately does NOT probe the cloud metadata server: on
 * Cloud Run it stays reachable whatever the VPC rules say (deploy.md), which is why the service account
 * holds no roles, so a "reached" there would make `network: "none"` unearnable for a reason that is not egress.
 */
const escapeProbe = `import os, socket
reached = False
if any(k not in ("LC_CTYPE", "__CF_USER_TEXT_ENCODING") for k in os.environ):
    reached = True
for host, port in ${JSON.stringify(ESCAPE_PROBE_TARGETS.map(([h, p]) => [h, p]))}:
    try:
        socket.create_connection((host, port), timeout=3).close()
        reached = True
    except Exception:
        pass
result = {"reached": reached}
`;

/**
 * Counts the runs this ENVIRONMENT has seen, through a file in /tmp: 1 on a fresh instance, 2 and up on
 * one that is reused. A read-only filesystem leaves nothing behind, which is also "fresh".
 */
const statefulProbe = `import os
path = "/tmp/loom-conformance-state"
try:
    with open(path, "a") as f:
        f.write("x")
    with open(path) as f:
        n = len(f.read())
except OSError:
    n = 1
result = n
`;

export const PYTHON_FIXTURES: PythonSandboxFixtures = {
  echo: "result = input\n",
  throws: 'raise Exception("loom-conformance-boom")\n',
  throwsMessage: "loom-conformance-boom",
  syntaxError: "def (\n",
  runaway: "while True:\n    pass\n",
  // Capped at ~2 GB so a host that does NOT enforce the limit fails the kit rather than being exhausted by it.
  allocationBomb:
    'chunks = []\nfor _ in range(200):\n    chunks.append(" " * 10_000_000)\nresult = len(chunks)\n',
  networkProbe,
  escapeProbe,
  statefulProbe,
  hugeThrow: 'raise Exception("x" * 100000)\n',
  richValueScript: `import json\nresult = json.loads(${JSON.stringify(JSON.stringify(RICH_VALUE))})\n`,
  richValue: RICH_VALUE,
};
