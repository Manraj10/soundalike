"use strict";

// First-run provisioning.
//
// The installer stays small (~90MB) and the ~3GB of Python + PyTorch is fetched
// once, on first launch, behind a progress bar. Shipping 3GB in an NSIS payload
// would mean a 20-minute download before the app even opens, and would rebuild
// the whole installer on every UI tweak.
//
// Everything lands in userData, so uninstalling actually removes it and a
// corrupted env can be fixed by deleting one folder. Nothing is written next to
// the .exe (Program Files is not writable without elevation).
//
// Uses Windows' built-in tar.exe and the bundled Node -- no extra npm deps.

const { app } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");

const PY_VERSION = "3.11";
const TORCH_INDEX = "https://download.pytorch.org/whl/cu124";
const PBS_API =
  "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest";

function root() {
  return path.join(app.getPath("userData"), "runtime");
}
function pythonExe() {
  return path.join(root(), "python", "python.exe");
}
function stampFile() {
  return path.join(root(), ".provisioned");
}

/** Provisioned means the interpreter exists AND the deps import cleanly. */
function isReady() {
  return fs.existsSync(stampFile()) && fs.existsSync(pythonExe());
}

function get(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "soundalike-bootstrap", ...(opts.headers || {}) } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return get(res.headers.location, opts).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        resolve(res);
      }
    );
    req.on("error", reject);
    req.setTimeout(120000, () => req.destroy(new Error("request timed out")));
  });
}

async function fetchJson(url) {
  const res = await get(url);
  let body = "";
  for await (const chunk of res) body += chunk;
  return JSON.parse(body);
}

/** Download to disk, reporting bytes as they land. */
async function download(url, dest, onProgress) {
  const res = await get(url);
  const total = parseInt(res.headers["content-length"] || "0", 10);
  let seen = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    res.on("data", (c) => {
      seen += c.length;
      if (total) onProgress(seen / total, seen, total);
    });
    res.pipe(out);
    out.on("finish", resolve);
    out.on("error", reject);
    res.on("error", reject);
  });
  return dest;
}

function run(exe, args, { onLine, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const feed = (buf) => {
      const s = buf.toString("utf8");
      tail = (tail + s).slice(-4000);
      if (onLine) s.split(/\r?\n/).filter(Boolean).forEach(onLine);
    };
    // Both streams must be drained; pip writes progress to stderr and a full
    // pipe buffer would deadlock the child.
    p.stdout.on("data", feed);
    p.stderr.on("data", feed);
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${path.basename(exe)} exited ${code}\n${tail}`))
    );
  });
}

/** Pick the Windows x86_64 "install_only" tarball from the latest PBS release. */
function pickAsset(release) {
  const want = (a) =>
    a.name.includes("x86_64-pc-windows-msvc") &&
    a.name.includes("install_only") &&
    !a.name.endsWith(".sha256") &&
    a.name.includes(`cpython-${PY_VERSION}.`);
  const hit = (release.assets || []).find(want);
  if (!hit) throw new Error(`no CPython ${PY_VERSION} Windows asset in ${release.tag_name}`);
  return hit;
}

/**
 * Provision the runtime. `report({stage, pct, detail})` drives the setup UI.
 * Safe to call repeatedly: it resumes rather than restarting from scratch.
 */
async function provision(report) {
  const R = root();
  fs.mkdirSync(R, { recursive: true });

  if (!fs.existsSync(pythonExe())) {
    report({ stage: "python", pct: 0, detail: "finding a Python runtime" });
    const asset = pickAsset(await fetchJson(PBS_API));
    const tgz = path.join(R, asset.name);

    if (!fs.existsSync(tgz)) {
      const partial = tgz + ".part";
      await download(asset.browser_download_url, partial, (frac, seen, total) =>
        report({
          stage: "python",
          pct: frac * 0.1,
          detail: `downloading Python ${(seen / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} MB`,
        })
      );
      fs.renameSync(partial, tgz); // rename last so a killed download never looks complete
    }

    report({ stage: "python", pct: 0.1, detail: "extracting Python" });
    // Use the bsdtar that ships in System32 by absolute path. Resolving "tar.exe"
    // through PATH can find GNU tar (Git for Windows puts one there), which reads
    // "C:\..." as a remote host spec and dies with "Cannot connect to C:".
    // Passing a relative filename with cwd keeps a colon out of the args entirely.
    const sysTar = path.join(
      process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"
    );
    const tarExe = fs.existsSync(sysTar) ? sysTar : "tar.exe";
    await run(tarExe, ["-xzf", path.basename(tgz)], { cwd: R });
    if (!fs.existsSync(pythonExe())) throw new Error("extraction did not produce python.exe");
    fs.rmSync(tgz, { force: true });
  }

  // Drop any leftover download. The extraction branch above only runs when the
  // interpreter is missing, so without this a stale 48MB archive can sit in
  // userData indefinitely.
  for (const f of fs.readdirSync(R)) {
    if (f.startsWith("cpython-") && (f.endsWith(".tar.gz") || f.endsWith(".part"))) {
      fs.rmSync(path.join(R, f), { force: true });
    }
  }

  const py = pythonExe();
  report({ stage: "pip", pct: 0.12, detail: "preparing installer" });
  await run(py, ["-m", "pip", "install", "--upgrade", "pip", "--no-warn-script-location"]);

  // Torch first, from the CUDA index. Biggest single step by far.
  report({ stage: "torch", pct: 0.15, detail: "downloading PyTorch (~2.5GB, one time)" });
  await run(
    py,
    ["-m", "pip", "install", "torch", "torchaudio", "--index-url", TORCH_INDEX,
     "--no-warn-script-location"],
    {
      onLine: (l) => {
        const m = l.match(/(\d+)\s*%/);
        if (m) {
          report({ stage: "torch", pct: 0.15 + (parseInt(m[1], 10) / 100) * 0.55,
                   detail: "installing PyTorch" });
        }
      },
    }
  );

  report({ stage: "deps", pct: 0.72, detail: "installing speech model" });
  await run(py, ["-m", "pip", "install", "chatterbox-tts", "--no-warn-script-location"], {
    onLine: (l) => {
      const m = l.match(/(\d+)\s*%/);
      if (m) {
        report({ stage: "deps", pct: 0.72 + (parseInt(m[1], 10) / 100) * 0.2,
                 detail: "installing speech model" });
      }
    },
  });

  // Prove it imports before claiming success -- a half-installed env that only
  // fails at generate time is far worse than failing loudly here.
  report({ stage: "verify", pct: 0.95, detail: "verifying" });
  await run(py, ["-c",
    "import torch, chatterbox.tts_turbo; print('cuda', torch.cuda.is_available())"]);

  fs.writeFileSync(stampFile(), new Date().toISOString());
  report({ stage: "done", pct: 1, detail: "ready" });
  return { python: py };
}

module.exports = { isReady, provision, pythonExe, root };
