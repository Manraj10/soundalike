"""Exercise the engine exactly the way Electron will: spawn it, talk JSON over stdio.

If this passes, the hard part works and the desktop shell is just a shell.
"""
import json
import os
import subprocess
import sys
import threading
import time
from collections import deque

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PY = os.path.join(ROOT, ".venv", "Scripts", "python.exe")
OUT_DIR = os.path.join(ROOT, "out")


class Engine:
    def __init__(self):
        self.p = subprocess.Popen(
            [PY, "-u", os.path.join(HERE, "engine.py")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", bufsize=1,
        )
        self._n = 0
        # The engine reroutes all library output to stderr to keep stdout as a
        # clean protocol stream. That means stderr MUST be drained continuously:
        # transformers writes progress bars there, and once the OS pipe buffer
        # (~4-8KB) fills, the engine blocks on write and the whole thing
        # deadlocks with the GPU sitting idle. Electron's main.js drains via a
        # 'data' listener; here we need a thread.
        self._err = deque(maxlen=400)
        self._drain = threading.Thread(target=self._drain_stderr, daemon=True)
        self._drain.start()

    def _drain_stderr(self):
        for line in self.p.stderr:
            self._err.append(line.rstrip())

    def stderr_tail(self, n=40):
        return "\n".join(list(self._err)[-n:])

    def _read_until_reply(self, rid, timeout=1800):
        """Consume progress events until the reply for `rid` arrives."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError(f"engine died.\n--- stderr ---\n{self.stderr_tail()}")
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                print(f"  [non-protocol stdout] {line[:120]}")
                continue
            if msg.get("event"):
                print(f"  · {msg['event']}: {msg.get('stage','')} {msg.get('detail','')}")
                continue
            if msg.get("id") == rid:
                return msg
        raise TimeoutError(f"no reply for id={rid}")

    def call(self, cmd, **kw):
        self._n += 1
        rid = self._n
        self.p.stdin.write(json.dumps({"id": rid, "cmd": cmd, **kw}) + "\n")
        self.p.stdin.flush()
        msg = self._read_until_reply(rid)
        if not msg.get("ok"):
            raise RuntimeError(f"{cmd} failed: {msg.get('error')}")
        return msg.get("data")

    def close(self):
        try:
            self.call("quit")
        except Exception:
            self.p.kill()


def main():
    if not os.path.isfile(PY):
        print(f"venv python missing at {PY}")
        return 1
    os.makedirs(OUT_DIR, exist_ok=True)

    e = Engine()
    # The startup {"event":"ready"} banner is consumed by the first call's
    # event loop, so there is nothing to drain here.

    print("1) status")
    st = e.call("status")
    for k, v in st.items():
        print(f"   {k}: {v}")

    print("\n2) load model (first run downloads weights)")
    t0 = time.time()
    info = e.call("load")
    print(f"   loaded in {time.time()-t0:.1f}s -> {info}")

    print("\n3) synth, built-in voice")
    t0 = time.time()
    out1 = os.path.join(OUT_DIR, "builtin.wav")
    # Long enough to reuse as a cloning prompt in step 4 -- turbo rejects
    # anything under 5 seconds.
    r1 = e.call("synth",
                text="If you can hear this, the whole pipeline works end to end. "
                     "This sentence is deliberately long so the resulting audio "
                     "runs past five seconds and can be reused as a voice prompt "
                     "for the cloning step that follows it.",
                out=out1)
    print(f"   {r1['seconds']}s of audio in {time.time()-t0:.1f}s -> {r1['path']}")
    rtf = (time.time() - t0) / max(r1["seconds"], 0.01)
    print(f"   realtime factor: {rtf:.2f}x  ({'faster' if rtf < 1 else 'slower'} than realtime)")

    print("\n4) synth, cloned from the audio we just made")
    t0 = time.time()
    out2 = os.path.join(OUT_DIR, "cloned.wav")
    r2 = e.call("synth",
                text="This sentence is spoken in a voice cloned from a ten second sample.",
                out=out2, voice=out1, exaggeration=0.6)
    print(f"   {r2['seconds']}s in {time.time()-t0:.1f}s -> {r2['path']} (cloned={r2['cloned']})")

    print("\n5) rejects a too-short voice sample with a readable message")
    short = os.path.join(OUT_DIR, "tooshort.wav")
    e.call("synth", text="Short.", out=short)
    try:
        e.call("synth", text="This should not run.", out=os.path.join(OUT_DIR, "nope.wav"),
               voice=short)
        print("   FAIL - short sample was accepted")
        return 1
    except RuntimeError as err:
        msg = str(err)
        ok = "at least" in msg and "AssertionError" not in msg
        print(f"   {'OK' if ok else 'FAIL'} - {msg.split('synth failed: ')[-1][:110]}")
        if not ok:
            return 1

    e.close()
    print("\nPASS - engine works over stdio.")
    for f in (out1, out2):
        print(f"  {os.path.getsize(f):>9,} bytes  {f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
