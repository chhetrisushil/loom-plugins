#!/usr/bin/env python3
"""Loom Cloud Run sandbox runner (loom ADR 0144). Python standard library only.

    POST /            {"script": str, "inputJson": str, "limits": {"wallClockMs": int, "memoryBytes": int}}
      -> 200          a SandboxOutcome as JSON:
                        {"ok": true, "value": ...}
                        {"ok": false, "kind": "limit", "limit": "cpu"|"memory"|"wallClock"}
                        {"ok": false, "kind": "threw", "name": str, "message": str}
                        {"ok": false, "kind": "inputTooLarge"}
                        {"ok": false, "kind": "infrastructure", "message": str}
      -> 4xx/5xx      a malformed or refused request (the client maps these to `infrastructure`)
    GET  /healthz     {"ok": true, "active": <runs in flight>}

Every request runs its script in a FRESH child process (`python -I -S`): the global `input` is
`json.loads(inputJson)`, the result is the value of the global `result` (absent means null).
The child lowers RLIMIT_AS / RLIMIT_CPU on itself before it touches the script, runs with an empty
environment in a private temporary directory, and is killed by this process at the wall clock.

What this process does NOT do: it is not an isolation boundary by itself. The child runs as the
same user in the same container, so the deployment (gVisor, no service account, no secrets,
egress denied, one request per instance) is what makes it one. See deploy.md.

Environment:
    PORT                       listen port (default 8080)
    BIND_HOST                  bind address (default 0.0.0.0; tests use 127.0.0.1)
    EXIT_AFTER_EACH_REQUEST    "1": exit after responding (with `--concurrency 1`, Cloud Run then
                               replaces the instance and its in-memory filesystem)
    MAX_BODY_BYTES             request body ceiling (default 41943040)
    MAX_RESULT_BYTES           child result ceiling (default 4194304)
    MAX_WALL_CLOCK_MS          ceiling a request's wallClockMs is clamped to (default 300000)
    MAX_MEMORY_BYTES           ceiling a request's memoryBytes is clamped to (default 1073741824)
    MEMORY_OVERHEAD_BYTES      added to memoryBytes for RLIMIT_AS, because the interpreter's own
                               mappings count against the address space (default 100663296)
    MEMORY_LIMIT               "enforce" (default: refuse to run where RLIMIT_AS cannot be applied) or
                               "off" (no memory cap; local development on macOS ONLY)
    MAX_CONCURRENT             runs in flight before answering 503 (default 4)
"""
import json
import os
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _env_int(name, default):
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    value = int(raw)
    if value <= 0:
        raise ValueError(name + " must be a positive integer")
    return value


MAX_BODY_BYTES = _env_int("MAX_BODY_BYTES", 40 * 1024 * 1024)
MAX_RESULT_BYTES = _env_int("MAX_RESULT_BYTES", 4 * 1024 * 1024)
MAX_WALL_CLOCK_MS = _env_int("MAX_WALL_CLOCK_MS", 300_000)
MAX_MEMORY_BYTES = _env_int("MAX_MEMORY_BYTES", 1024 * 1024 * 1024)
MEMORY_OVERHEAD_BYTES = _env_int("MEMORY_OVERHEAD_BYTES", 96 * 1024 * 1024)
MAX_CONCURRENT = _env_int("MAX_CONCURRENT", 4)
# "enforce" (default) fails closed where RLIMIT_AS cannot be applied (macOS refuses it). "off" runs
# WITHOUT a memory cap, for local development only; /healthz reports it and a deployment must not use it.
MEMORY_LIMIT_ENFORCED = os.environ.get("MEMORY_LIMIT", "enforce") != "off"
THREW_TEXT_LIMIT = 8192  # the effect bounds again; this keeps the wire small
REQUEST_READ_TIMEOUT_S = 30

# ── the child: runs under `python -I -S -c _CHILD_BOOTSTRAP <memLimit> <cpuSeconds> <payloadBytes>` ──
# Order matters: limits first, then everything the script could influence. The result goes to a
# duplicate of the original stdout; the script's own stdout/stderr are /dev/null.
_CHILD_BOOTSTRAP = r"""
import sys, os, json

def _main():
    mem, cpu, n = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
    import resource
    limits = [(resource.RLIMIT_CPU, cpu, cpu + 1)]
    if mem > 0:  # 0: MEMORY_LIMIT=off (a platform without RLIMIT_AS, local development only)
        limits.insert(0, (resource.RLIMIT_AS, mem, mem))
    for which, soft, hard in limits:
        try:
            resource.setrlimit(which, (soft, hard))
        except (ValueError, OSError):
            os._exit(70)  # fail closed: a limit that cannot be applied is not a limit
    out = os.dup(1)
    null = os.open(os.devnull, os.O_RDWR)
    os.dup2(null, 1)
    os.dup2(null, 2)

    def emit(obj):
        data = json.dumps(obj, ensure_ascii=True, allow_nan=False).encode("ascii")
        view = memoryview(data)
        while view:
            view = view[os.write(out, view):]

    def threw(e):
        msg = str(e)
        emit({"ok": False, "kind": "threw", "name": type(e).__name__[:128], "message": msg[:8192]})

    try:
        buf = bytearray(n)
        view, got = memoryview(buf), 0
        while got < n:
            k = os.readv(0, [view[got:]])
            if k == 0:
                os._exit(71)
            got += k
        sep = buf.index(0)
        script = bytes(buf[:sep]).decode("utf-8")
        input_json = bytes(buf[sep + 1:]).decode("utf-8")
        del buf, view
        parsed = json.loads(input_json)
        del input_json
    except MemoryError:
        emit({"ok": False, "kind": "inputTooLarge"})
        return
    except Exception:
        os._exit(72)  # input that is not JSON text: the client never sends this

    g = {"__name__": "__main__", "input": parsed}
    try:
        code = compile(script, "<script>", "exec")
        del script
        exec(code, g)
        value = g.get("result")
        text = json.dumps(value, ensure_ascii=True, allow_nan=False)
    except MemoryError:
        g.clear()  # free what the script hoarded, or even this small reply cannot be allocated
        emit({"ok": False, "kind": "limit", "limit": "memory"})
        return
    except BaseException as e:
        try:
            threw(e)
        except MemoryError:
            g.clear()
            emit({"ok": False, "kind": "limit", "limit": "memory"})
        return
    emit_raw = ('{"ok": true, "value": ' + text + '}').encode("ascii")
    view = memoryview(emit_raw)
    while view:
        view = view[os.write(out, view):]

_main()
"""


def _text(value):
    return value[:THREW_TEXT_LIMIT]


class _Request(Exception):
    def __init__(self, status, message):
        Exception.__init__(self, message)
        self.status = status
        self.message = message


def validate(body):
    """Parse and validate the request body. Returns (script, input_json, wall_clock_ms, memory_bytes)."""
    try:
        doc = json.loads(body)
    except (ValueError, RecursionError):
        raise _Request(400, "body is not JSON")
    if not isinstance(doc, dict):
        raise _Request(400, "body must be an object")
    script, input_json, limits = doc.get("script"), doc.get("inputJson"), doc.get("limits")
    if not isinstance(script, str) or script == "" or "\x00" in script:
        raise _Request(400, "script must be a non-empty string without NUL")
    if not isinstance(input_json, str):
        raise _Request(400, "inputJson must be a string")
    if not isinstance(limits, dict):
        raise _Request(400, "limits must be an object")
    wall, mem = limits.get("wallClockMs"), limits.get("memoryBytes")
    for name, v in (("wallClockMs", wall), ("memoryBytes", mem)):
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v <= 0 or v == float("inf"):
            raise _Request(400, "limits." + name + " must be a positive number")
    wall = min(int(wall), MAX_WALL_CLOCK_MS)
    mem = min(int(mem), MAX_MEMORY_BYTES)
    if wall < 1 or mem < 1024 * 1024:
        raise _Request(400, "limits are below the minimum (1 ms, 1 MiB)")
    return script, input_json, wall, mem


def _kill_group(proc):
    """Kill the child's own process group (it is a session leader we created). Never pid <= 1."""
    pid = proc.pid
    if pid is None or pid <= 1:
        return
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        proc.kill()
    except OSError:
        pass


def _client_gone(conn):
    try:
        r, _, _ = select.select([conn], [], [], 0)
        if not r:
            return False
        return conn.recv(1, socket.MSG_PEEK) == b""
    except (OSError, ValueError):
        return True


def _outcome_from_child(raw):
    """Whitelist what the child wrote: it is script-influenced, so rebuild the outcome from known fields."""
    try:
        doc = json.loads(raw.decode("ascii"))
    except (ValueError, RecursionError, UnicodeDecodeError):
        return None
    if not isinstance(doc, dict):
        return None
    if doc.get("ok") is True and "value" in doc:
        return {"ok": True, "value": doc["value"]}
    if doc.get("ok") is not False:
        return None
    kind = doc.get("kind")
    if kind == "limit" and doc.get("limit") in ("cpu", "memory", "wallClock"):
        return {"ok": False, "kind": "limit", "limit": doc["limit"]}
    if kind == "threw" and isinstance(doc.get("message"), str):
        name = doc.get("name")
        res = {"ok": False, "kind": "threw", "message": _text(doc["message"])}
        if isinstance(name, str):
            res["name"] = name[:128]
        return res
    if kind == "inputTooLarge":
        return {"ok": False, "kind": "inputTooLarge"}
    return None


def run_script(script, input_json, wall_ms, mem_bytes, conn=None):
    """Run one script in a fresh child and return a SandboxOutcome dict."""
    cpu_s = max(1, -(-wall_ms // 1000))  # ceil(wall clock) whole CPU seconds
    payload = script.encode("utf-8") + b"\x00" + input_json.encode("utf-8")
    workdir = tempfile.mkdtemp(prefix="loom-sbx-")
    proc = None
    try:
        proc = subprocess.Popen(
            [sys.executable, "-I", "-S", "-c", _CHILD_BOOTSTRAP,
             str(mem_bytes + MEMORY_OVERHEAD_BYTES if MEMORY_LIMIT_ENFORCED else 0), str(cpu_s), str(len(payload))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            cwd=workdir, env={}, close_fds=True, start_new_session=True,
        )
        deadline = time.monotonic() + wall_ms / 1000.0
        # Feed the payload; the child reads it before anything else, so this is short.
        try:
            proc.stdin.write(payload)
            proc.stdin.close()
        except (BrokenPipeError, OSError):
            pass
        del payload
        out_fd = proc.stdout.fileno()
        chunks, size, eof, too_big, timed_out, gone = [], 0, False, False, False, False
        while not eof:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            watch = [out_fd] + ([conn] if conn is not None else [])
            ready, _, _ = select.select(watch, [], [], min(remaining, 0.25))
            if conn is not None and _client_gone(conn):
                gone = True
                break
            if out_fd in ready:
                data = os.read(out_fd, 65536)
                if not data:
                    eof = True
                else:
                    size += len(data)
                    if size > MAX_RESULT_BYTES:
                        too_big = True
                        break
                    chunks.append(data)
        if gone:
            _kill_group(proc)
            return {"ok": False, "kind": "infrastructure", "message": "client disconnected"}
        if too_big:
            _kill_group(proc)
            return {"ok": False, "kind": "threw", "name": "ResultTooLarge",
                    "message": "the script's result exceeds the runner's %d byte ceiling" % MAX_RESULT_BYTES}
        if timed_out:
            _kill_group(proc)
            return {"ok": False, "kind": "limit", "limit": "wallClock"}
        # EOF: the child closed its result pipe. Give it the rest of the clock to exit.
        try:
            code = proc.wait(timeout=max(0.01, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            _kill_group(proc)
            return {"ok": False, "kind": "limit", "limit": "wallClock"}
        outcome = _outcome_from_child(b"".join(chunks))
        if outcome is not None:
            return outcome
        if code == -signal.SIGXCPU:
            return {"ok": False, "kind": "limit", "limit": "cpu"}
        if code == 70:
            return {"ok": False, "kind": "infrastructure", "message": "the runner could not apply its resource limits"}
        if code < 0:
            return {"ok": False, "kind": "infrastructure",
                    "message": "the sandbox child was killed by signal %d" % -code}
        return {"ok": False, "kind": "infrastructure", "message": "the sandbox child exited with code %d" % code}
    except OSError:
        return {"ok": False, "kind": "infrastructure", "message": "the runner could not start the sandbox child"}
    finally:
        if proc is not None:
            _kill_group(proc)  # also reaps grandchildren the script started
            try:
                proc.wait(timeout=5)
            except Exception:
                pass
            for f in (proc.stdout, proc.stdin):
                try:
                    if f is not None:
                        f.close()
                except OSError:
                    pass
        shutil.rmtree(workdir, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"  # one request per connection; the body ends at close
    timeout = REQUEST_READ_TIMEOUT_S
    server_version = "loom-sandbox-runner"
    sys_version = ""

    def log_message(self, fmt, *args):  # no request data in logs
        pass

    def _send(self, status, doc):
        body = json.dumps(doc, ensure_ascii=True, allow_nan=False).encode("ascii")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def do_GET(self):
        if self.path == "/healthz":
            self._send(200, {"ok": True, "active": self.server.active, "memoryEnforced": MEMORY_LIMIT_ENFORCED})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path not in ("/", "/evaluate"):
            self._send(404, {"error": "not found"})
            return
        if self.headers.get("Transfer-Encoding") is not None:
            self._send(411, {"error": "Content-Length required"})
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self._send(411, {"error": "Content-Length required"})
            return
        if length < 0 or length > MAX_BODY_BYTES:
            self._send(413, {"error": "body too large"})
            return
        try:
            body = self.rfile.read(length)
        except (OSError, socket.timeout):
            return
        if len(body) != length:
            return
        try:
            script, input_json, wall, mem = validate(body)
        except _Request as e:
            self._send(e.status, {"error": e.message})
            return
        del body
        if not self.server.slots.acquire(False):
            self._send(503, {"error": "busy"})
            return
        with self.server.lock:
            self.server.active += 1
        try:
            outcome = run_script(script, input_json, wall, mem, self.connection)
        finally:
            with self.server.lock:
                self.server.active -= 1
            self.server.slots.release()
        try:
            self._send(200, outcome)
        except OSError:
            pass
        if self.server.exit_after_each:
            self.server.request_exit()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    exit_after_each = False

    def __init__(self, addr):
        ThreadingHTTPServer.__init__(self, addr, Handler)
        self.slots = threading.BoundedSemaphore(MAX_CONCURRENT)
        self.lock = threading.Lock()
        self.active = 0

    def request_exit(self):
        threading.Thread(target=self.shutdown, daemon=True).start()


def main():
    host = os.environ.get("BIND_HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8080"))
    server = Server((host, port))
    server.exit_after_each = os.environ.get("EXIT_AFTER_EACH_REQUEST") == "1"
    # Announce the bound port (tests bind PORT=0) on stdout, one line.
    sys.stdout.write("listening %s:%d\n" % server.server_address[:2])
    sys.stdout.flush()
    try:
        server.serve_forever(poll_interval=0.1)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
