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

// Single source of truth for the app identity, set here rather than in each
// entry point.
//
// Electron derives userData from app.getName(), which defaults to package.json
// "name". That used to be "voicebox" (the pre-rename folder), so the packaged
// app provisioned into %APPDATA%/voicebox while a verifier script that called
// app.setName("Soundalike") provisioned into %APPDATA%/Soundalike -- and
// reported PASS for a path the shipped app never touched. Any per-entry-point
// override can drift like that again, so the name is pinned once, in the module
// that owns the path, and every caller inherits it.
//
// Must run before anything reads app.getPath("userData"), which is why it sits
// at module load and not inside provision().
app.setName("soundalike");

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

/**
 * Run a child process, failing if it goes silent.
 *
 * `idleMs` is the important part. A hung pip never exits, so an exit-code retry
 * never fires -- observed in practice: pip sat at 0 bytes for 20 minutes with
 * the CPU spinning inside its own retry loop, and --timeout did not save it.
 * Treating "no output for N minutes" as a failure turns an infinite hang into a
 * normal retryable error.
 */
function run(exe, args, { onLine, cwd, idleMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    let settled = false;
    let watchdog = null;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      fn(arg);
    };

    const bumpWatchdog = () => {
      if (!idleMs) return;
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        try { p.kill(); } catch {}
        finish(reject, new Error(
          `${path.basename(exe)} produced no output for ${Math.round(idleMs / 1000)}s ` +
          `(stalled)\n${tail.slice(-2000)}`
        ));
      }, idleMs);
    };

    const feed = (buf) => {
      const s = buf.toString("utf8");
      tail = (tail + s).slice(-4000);
      bumpWatchdog();
      if (onLine) s.split(/\r?\n/).filter(Boolean).forEach(onLine);
    };

    // Both streams must be drained; pip writes progress to stderr and a full
    // pipe buffer would deadlock the child.
    p.stdout.on("data", feed);
    p.stderr.on("data", feed);
    p.on("error", (e) => finish(reject, e));
    p.on("close", (code) =>
      code === 0
        ? finish(resolve)
        : finish(reject, new Error(`${path.basename(exe)} exited ${code}\n${tail}`))
    );
    bumpWatchdog();
  });
}

/**
 * pip, with the flags and retries a 2.5GB download over a real connection needs.
 *
 * Observed failures on a cold run: pip's own resume gave up after repeated
 * "Connection interrupted", and then died with WinError 32 -- antivirus holding
 * the partially downloaded wheel open while pip tried to move it. Both are
 * transient, so retry the whole command; pip's HTTP cache means an attempt
 * resumes rather than restarting from zero.
 *
 * The cache is pinned inside our own runtime directory so partial downloads
 * survive between attempts and get removed with the app on uninstall.
 */
async function pipInstall(py, args, { report, stage, base, span, attempts = 4 } = {}) {
  const cacheDir = path.join(root(), "pip-cache");
  const full = [
    "-m", "pip", "install",
    "--cache-dir", cacheDir,
    "--retries", "10",
    // The one that actually matters for a 2.5GB wheel. pip only caches
    // COMPLETED downloads and discards the partial on failure, so relaunching
    // pip restarts from zero -- on a connection that drops every few hundred MB
    // it can never finish, which is exactly what was observed (pip-cache stuck
    // at 1MB across retries). --resume-retries makes pip resume in-process from
    // the bytes it already has. Requires pip >= 25.1; the runtime ships 26.x.
    "--resume-retries", "20",
    "--timeout", "60",
    "--no-warn-script-location",
    ...args,
  ];

  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await run(py, full, {
        // pip prints a progress bar continuously while downloading, so five
        // minutes of total silence means it is wedged, not working.
        idleMs: 5 * 60 * 1000,
        onLine: (l) => {
          const m = l.match(/(\d+)\s*%/);
          if (m && report && span) {
            report({ stage, pct: base + (parseInt(m[1], 10) / 100) * span,
                     detail: attempt > 1 ? `retrying (${attempt}/${attempts})` : undefined });
          }
        },
      });
      return;
    } catch (e) {
      lastErr = e;
      const transient = /WinError 32|Connection interrupted|Read timed out|IncompleteRead|ConnectionReset|Temporary failure|stalled/i
        .test(e.message);
      if (attempt === attempts || !transient) break;
      if (report) {
        report({ stage, pct: base,
                 detail: `download interrupted, retrying (${attempt + 1}/${attempts})` });
      }
      // A pip killed mid-write leaves a corrupt HTTP cache, and pip will then
      // spin on it forever instead of re-downloading. Purge it so the retry is
      // actually a fresh attempt rather than a replay of the broken state.
      fs.rmSync(cacheDir, { recursive: true, force: true });
      // Give a virus scanner time to release the file it is holding open.
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  throw lastErr;
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
  // setuptools is NOT optional here. python-build-standalone's install_only
  // build ships without it, and chatterbox's watermarker dependency (perth)
  // still imports pkg_resources at module load. perth swallows that ImportError
  // and sets PerthImplicitWatermarker to None, so the failure surfaces much
  // later as "TypeError: 'NoneType' object is not callable" the first time
  // someone generates audio. Every dev venv has setuptools, so this breaks only
  // in the packaged build -- it works on the author's machine and fails for
  // everyone who downloads the installer.
  // The pin matters as much as the package: setuptools 81 dropped
  // pkg_resources, so installing the current release (83 at time of writing)
  // leaves perth just as broken as having no setuptools at all. This is a
  // borrowed-time workaround -- the real fix is upstream in perth, which should
  // use importlib.resources.
  await pipInstall(py, ["--upgrade", "pip", "wheel", "setuptools<81"]);

  // Torch first, from the CUDA index. Biggest single step by far.
  report({ stage: "torch", pct: 0.15, detail: "downloading PyTorch (~2.5GB, one time)" });
  await pipInstall(py, ["torch", "torchaudio", "--index-url", TORCH_INDEX], {
    report, stage: "torch", base: 0.15, span: 0.55,
  });

  report({ stage: "deps", pct: 0.72, detail: "installing speech model" });
  await pipInstall(py, ["chatterbox-tts"], {
    report, stage: "deps", base: 0.72, span: 0.2,
  });

  // Prove it imports before claiming success -- a half-installed env that only
  // fails at generate time is far worse than failing loudly here.
  report({ stage: "verify", pct: 0.95, detail: "verifying" });
  // Importing is not enough. perth catches its own ImportError and leaves
  // PerthImplicitWatermarker as None, so `import chatterbox.tts_turbo` succeeded
  // against a runtime that could not generate a single sample. Assert on the
  // symbols that are actually called, and on a real torch op, so a broken
  // environment fails here instead of on the user's first click.
  await run(py, ["-c", [
    "import torch, torchaudio, soundfile, pkg_resources",
    "import perth",
    "assert perth.PerthImplicitWatermarker is not None, 'perth watermarker unavailable (missing setuptools/pkg_resources)'",
    "perth.PerthImplicitWatermarker()",
    "from chatterbox.tts_turbo import ChatterboxTurboTTS",
    "torch.zeros(4).sum()",
    "print('verified cuda=%s' % torch.cuda.is_available())",
  ].join("; ")]);

  // Only now that everything imports: drop the wheel cache. It is ~2.5GB and is
  // dead weight once installed. Kept until this point so retries could resume.
  fs.rmSync(path.join(root(), "pip-cache"), { recursive: true, force: true });

  fs.writeFileSync(stampFile(), new Date().toISOString());
  report({ stage: "done", pct: 1, detail: "ready" });
  return { python: py };
}

module.exports = { isReady, provision, pythonExe, root };
