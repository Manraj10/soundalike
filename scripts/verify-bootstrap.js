"use strict";

// Verifies first-run provisioning for real, without needing a human to watch a
// GUI. Runs under Electron because bootstrap.js needs app.getPath("userData").
//
//   npx electron scripts/verify-bootstrap.js            # provision + smoke test
//   npx electron scripts/verify-bootstrap.js --fresh     # wipe runtime first
//
// Exits non-zero on any failure so this can gate a release.

const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

// No app.setName() here on purpose. An earlier version set it locally to
// "Soundalike" so this script would not provision into %APPDATA%/Electron --
// but the packaged exe resolved to %APPDATA%/voicebox, so this script passed
// against a path the real app never used. Identity now lives in bootstrap.js
// and is inherited by requiring it, so the two entry points cannot diverge.
const bootstrap = require("../src/bootstrap");

const FRESH = process.argv.includes("--fresh");
const log = (...a) => { console.log(...a); };

function dirSizeMB(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch {} }
    }
  };
  walk(dir);
  return Math.round(total / 1e6);
}

/** Drive the provisioned interpreter through the real stdio protocol. */
function smokeTest(py) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, "..", "engine", "engine.py");
    const p = spawn(py, ["-u", script], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let stderrTail = "";
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error("smoke test timed out\n" + stderrTail.slice(-1500)));
    }, 15 * 60 * 1000);

    // stderr MUST be drained or the engine deadlocks on a full pipe buffer.
    p.stderr.on("data", (d) => { stderrTail = (stderrTail + d).slice(-4000); });

    const want = new Map();
    const send = (id, cmd, args = {}) => {
      want.set(id, cmd);
      p.stdin.write(JSON.stringify({ id, cmd, ...args }) + "\n");
    };

    const out = path.join(app.getPath("temp"), "soundalike-verify.wav");
    let t0 = 0;

    p.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }

        if (m.event === "ready") { send(1, "status"); continue; }
        if (m.event) { log(`     · ${m.stage || m.event} ${m.detail || ""}`); continue; }

        if (!m.ok) {
          clearTimeout(timer);
          p.kill();
          return reject(new Error(`${want.get(m.id)} failed: ${m.error}`));
        }

        if (m.id === 1) {
          log(`     device=${m.data.device} torch=${m.data.torch || "?"} gpu=${m.data.gpu || "n/a"}`);
          if (m.data.device !== "cuda") {
            log("     WARNING: CUDA not detected in the provisioned runtime");
          }
          t0 = Date.now();
          send(2, "synth", {
            text: "First run provisioning is verified and this audio proves it.",
            out,
          });
        } else if (m.id === 2) {
          const wall = (Date.now() - t0) / 1000;
          const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
          // Deliberately not reported as RTF: this span includes the ~35s cold
          // model load, so dividing by audio length gives a number 15x worse
          // than steady state. Use bench_turbo.py for real throughput.
          log(`     generated ${m.data.seconds}s of audio, ${size.toLocaleString()} bytes ` +
              `(${wall.toFixed(1)}s incl. cold model load -- not a throughput figure)`);
          clearTimeout(timer);
          send(3, "quit");
          if (size < 10000) return reject(new Error(`output too small: ${size} bytes`));
          resolve({ seconds: m.data.seconds, wall, size, device: "ok" });
        }
      }
    });

    p.on("error", reject);
  });
}

app.whenReady().then(async () => {
  const t0 = Date.now();
  let code = 0;
  try {
    const R = bootstrap.root();
    log(`app name:    ${app.getName()}`);
    log(`runtime dir: ${R}`);
    log(`userData:    ${app.getPath("userData")}`);

    // Hard gate. If the identity ever drifts again, this script must fail rather
    // than quietly verify a directory the shipped app does not use.
    if (app.getName() !== "soundalike") {
      throw new Error(`app name is "${app.getName()}", expected "soundalike" — ` +
                      `this run would verify the wrong userData path`);
    }
    const stale = ["voicebox", "Electron"].map((n) =>
      path.join(path.dirname(app.getPath("userData")), n, "runtime"));
    for (const s of stale) {
      if (fs.existsSync(s)) {
        log(`WARNING: stale runtime still present at ${s} — delete it so this ` +
            `test cannot accidentally rely on it`);
      }
    }

    if (FRESH && fs.existsSync(R)) {
      log("--fresh: removing existing runtime");
      fs.rmSync(R, { recursive: true, force: true });
    }
    log(`already provisioned: ${bootstrap.isReady()}`);

    log("\n1) provisioning");
    let last = -1;
    await bootstrap.provision((p) => {
      const pct = Math.round((p.pct || 0) * 100);
      if (pct !== last) { last = pct; log(`   [${String(pct).padStart(3)}%] ${p.stage}: ${p.detail}`); }
    });

    const py = bootstrap.pythonExe();
    if (!fs.existsSync(py)) throw new Error(`no interpreter at ${py}`);
    log(`\n   interpreter: ${py}`);
    log(`   runtime size: ${dirSizeMB(bootstrap.root()).toLocaleString()} MB`);
    log(`   provisioned in ${((Date.now() - t0) / 60000).toFixed(1)} min`);

    log("\n2) smoke test through the real stdio protocol");
    await smokeTest(py);

    log(`\nPASS - provisioning works end to end (${((Date.now() - t0) / 60000).toFixed(1)} min total)`);
  } catch (e) {
    console.error(`\nFAIL - ${e && e.message ? e.message : e}`);
    code = 1;
  }
  app.exit(code);
});
