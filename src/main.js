"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const bootstrap = require("./bootstrap");

// --- engine process -------------------------------------------------------
// One long-lived Python child. Requests are matched to replies by id; progress
// events are pushed to the renderer as they arrive. No sockets, no ports.

let engine = null;
let nextId = 1;
const pending = new Map();
let stdoutBuf = "";
let win = null;

function enginePaths() {
  const root = app.isPackaged ? process.resourcesPath : app.getAppPath();
  const script = path.join(root, "engine", "engine.py");
  // Prefer the project venv in dev; fall back to the runtime the first-run
  // bootstrap provisions into userData.
  const venvPy = path.join(app.getAppPath(), ".venv", "Scripts", "python.exe");
  const provisioned = bootstrap.pythonExe();
  let py = null;
  if (!app.isPackaged && fs.existsSync(venvPy)) py = venvPy;
  else if (fs.existsSync(provisioned)) py = provisioned;
  else if (fs.existsSync(venvPy)) py = venvPy;
  return { py, script };
}

/**
 * True when we can start the engine right now without provisioning.
 *
 * Checking only that python.exe exists is not enough. If a first run is
 * interrupted after CPython is extracted but before torch and chatterbox are
 * installed, the interpreter is present and useless. That made the app skip
 * setup and die on "ModuleNotFoundError: No module named 'chatterbox'" -- and
 * it stayed broken on every subsequent launch, because the half-built runtime
 * kept looking ready. A packaged build therefore requires the .provisioned
 * stamp, which is only written after imports are verified.
 */
function runtimeReady() {
  const venvPy = path.join(app.getAppPath(), ".venv", "Scripts", "python.exe");
  if (!app.isPackaged && fs.existsSync(venvPy)) return true;
  return bootstrap.isReady();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function startEngine() {
  if (engine) return { ok: true };
  const { py, script } = enginePaths();
  if (!py) return { ok: false, error: "No Python engine found. Run the installer or create .venv." };
  if (!fs.existsSync(script)) return { ok: false, error: `engine.py missing at ${script}` };

  engine = spawn(py, ["-u", script], { stdio: ["pipe", "pipe", "pipe"] });

  engine.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString("utf8");
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // stray non-protocol output; stderr is where logs belong
      }
      if (msg.event) {
        send("engine:event", msg);
        continue;
      }
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error || "engine error"));
      }
    }
  });

  // stderr is diagnostics only -- surface it without letting it break the UI.
  engine.stderr.on("data", (d) => send("engine:log", d.toString("utf8").slice(-4000)));

  engine.on("exit", (code) => {
    for (const [, p] of pending) p.reject(new Error(`engine exited (code ${code})`));
    pending.clear();
    engine = null;
    send("engine:event", { event: "exited", code });
  });

  return { ok: true };
}

function call(cmd, args = {}, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const started = startEngine();
    if (!started.ok) return reject(new Error(started.error));
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    engine.stdin.write(JSON.stringify({ id, cmd, ...args }) + "\n");
  });
}

// --- ipc ------------------------------------------------------------------

ipcMain.handle("setup:needed", () => !runtimeReady());

let provisioning = null;
ipcMain.handle("setup:run", () => {
  // Idempotent: a second call joins the in-flight run instead of starting a
  // parallel pip that would fight over the same directory.
  if (!provisioning) {
    provisioning = bootstrap
      .provision((p) => send("setup:progress", p))
      .then((r) => { provisioning = null; return r; })
      .catch((e) => { provisioning = null; throw e; });
  }
  return provisioning;
});

ipcMain.handle("engine:status", () => call("status", {}, 60000));
ipcMain.handle("engine:load", (_e, opts) => call("load", opts || {}));
ipcMain.handle("engine:languages", () => call("languages", {}, 60000));

ipcMain.handle("engine:synth", async (_e, opts) => {
  const outDir = path.join(app.getPath("documents"), "Soundalike");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.join(outDir, `soundalike-${stamp}.wav`);
  return call("synth", { ...opts, out });
});

ipcMain.handle("pick:voice", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Choose a voice sample (10-20 seconds of clean speech)",
    filters: [{ name: "Audio", extensions: ["wav", "mp3", "flac", "m4a", "ogg"] }],
    properties: ["openFile"],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle("reveal", (_e, p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); });

// --- window ---------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 940,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: "#0e0f13",
    show: false,
    // Packaged builds take the icon from the exe resources; this covers the
    // dev run and the taskbar grouping.
    icon: path.join(app.getAppPath(), "build", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();

  // Forward renderer console + uncaught errors to the main process stdout.
  // Without this a renderer exception is completely silent: the window stays on
  // whatever it last painted, the engine sits loaded and idle, and there is no
  // way to tell "still working" from "the UI died" from outside.
  win.webContents.on("console-message", (_e, level, message, line, source) => {
    const tag = ["log", "warn", "error"][level] || "log";
    console.log(`[renderer:${tag}] ${message}` + (source ? ` (${source}:${line})` : ""));
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    console.log(`[renderer] process gone: ${JSON.stringify(details)}`);
  });
  win.webContents.on("preload-error", (_e, p, err) => {
    console.log(`[preload-error] ${p}: ${err && err.message}`);
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => win.show());
}

// A second instance would fight the first over the same userData directory --
// that is what "Unable to move the cache: Access is denied" was -- and could
// run two provisioning passes into the same folder at once. Focus the existing
// window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(createWindow);
}

app.on("window-all-closed", () => {
  if (engine) { try { engine.stdin.write('{"cmd":"quit"}\n'); } catch {} engine.kill(); }
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
