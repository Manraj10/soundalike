"use strict";

const $ = (id) => document.getElementById(id);
const el = {
  dot: $("statusDot"), device: $("device"), drop: $("drop"), voiceBtn: $("voiceBtn"),
  chosen: $("chosen"), fname: $("fname"), clearVoice: $("clearVoice"),
  text: $("text"), charCount: $("charCount"), go: $("go"), stage: $("stage"),
  result: $("result"), player: $("player"), meta: $("meta"), revealBtn: $("revealBtn"),
  error: $("error"), exaggeration: $("exaggeration"), exagOut: $("exagOut"),
  cfg: $("cfg"), cfgOut: $("cfgOut"),
};

let voicePath = null;
let lastOut = null;
let busy = false;

const STAGE_TEXT = {
  // The first load after setup downloads ~2GB of weights with no incremental
  // progress available from the library, so say that plainly. "Warming up" with
  // a silent multi-minute pause reads as a hang and people kill the app.
  loading_model: "first run: downloading ~2GB of voice model — several minutes, then cached forever",
  model_ready: "model ready",
  synthesizing: "generating…",
  gpu_failed: "GPU unavailable, falling back to CPU",
  done: "done",
};

function setBusy(on, label) {
  busy = on;
  el.go.disabled = on;
  el.dot.className = "dot " + (on ? "busy" : "ready");
  el.stage.textContent = label || "";
}

function showError(msg) {
  el.error.hidden = false;
  el.error.textContent = msg;
  el.dot.className = "dot err";
}

function clearError() {
  el.error.hidden = true;
  el.error.textContent = "";
}

// --- voice selection ------------------------------------------------------

function setVoice(p) {
  voicePath = p;
  if (p) {
    el.chosen.hidden = false;
    el.fname.textContent = p.split(/[\\/]/).pop();
  } else {
    el.chosen.hidden = true;
    el.fname.textContent = "";
  }
}

el.voiceBtn.addEventListener("click", async () => {
  const p = await window.vb.pickVoice();
  if (p) setVoice(p);
});

el.clearVoice.addEventListener("click", () => setVoice(null));

// Drag and drop. Electron exposes a real filesystem path on the File object.
["dragenter", "dragover"].forEach((ev) =>
  el.drop.addEventListener(ev, (e) => {
    e.preventDefault();
    el.drop.classList.add("over");
  })
);
["dragleave", "drop"].forEach((ev) =>
  el.drop.addEventListener(ev, (e) => {
    e.preventDefault();
    el.drop.classList.remove("over");
  })
);
el.drop.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files?.[0];
  if (!f) return;
  const p = window.vb.pathForFile ? window.vb.pathForFile(f) : f.path;
  if (p) setVoice(p);
});

// --- inputs ---------------------------------------------------------------

el.text.addEventListener("input", () => {
  el.charCount.textContent = el.text.value.length;
});

for (const [input, out] of [[el.exaggeration, el.exagOut], [el.cfg, el.cfgOut]]) {
  input.addEventListener("input", () => { out.textContent = input.value; });
}

// --- generate -------------------------------------------------------------

el.go.addEventListener("click", async () => {
  if (busy) return;
  const text = el.text.value.trim();
  if (!text) {
    showError("Type something for it to say.");
    el.text.focus();
    return;
  }
  clearError();
  el.result.hidden = true;
  setBusy(true, "starting…");

  const t0 = performance.now();
  try {
    const r = await window.vb.synth({
      text,
      voice: voicePath,
      exaggeration: parseFloat(el.exaggeration.value),
      cfg_weight: parseFloat(el.cfg.value),
    });
    const wall = (performance.now() - t0) / 1000;
    lastOut = r.path;
    // Cache-bust so replacing the file actually reloads the element.
    el.player.src = `file:///${r.path.replace(/\\/g, "/")}?t=${Date.now()}`;
    el.result.hidden = false;
    const rtf = wall / Math.max(r.seconds, 0.01);
    el.meta.textContent =
      `${r.seconds}s audio · ${wall.toFixed(1)}s to generate · ${rtf.toFixed(2)}x realtime` +
      (r.cloned ? " · cloned voice" : " · built-in voice");
    setBusy(false, "done");
  } catch (e) {
    setBusy(false, "");
    showError(String(e?.message || e));
  }
});

el.revealBtn.addEventListener("click", () => lastOut && window.vb.reveal(lastOut));

// Ctrl+Enter to generate.
el.text.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) el.go.click();
});

// --- engine events --------------------------------------------------------

window.vb.onEvent((msg) => {
  if (msg.event === "progress") {
    el.stage.textContent = STAGE_TEXT[msg.stage] || msg.stage;
  } else if (msg.event === "exited") {
    showError(`Engine stopped unexpectedly (code ${msg.code}). Reopen the app to retry.`);
    setBusy(false, "");
  }
});

// --- first-run setup ------------------------------------------------------

const setupEl = {
  wrap: $("setup"), fill: $("setupFill"), detail: $("setupDetail"),
  err: $("setupErr"), retry: $("setupRetry"),
};

window.vb.onSetupProgress((p) => {
  setupEl.fill.style.width = `${Math.round((p.pct || 0) * 100)}%`;
  setupEl.detail.textContent = p.detail || p.stage || "";
});

async function runSetup() {
  setupEl.err.hidden = true;
  setupEl.retry.hidden = true;
  setupEl.detail.textContent = "starting…";
  try {
    await window.vb.runSetup();
    setupEl.wrap.hidden = true;
    return true;
  } catch (e) {
    setupEl.err.hidden = false;
    setupEl.err.textContent = String(e?.message || e);
    setupEl.detail.textContent = "setup failed";
    setupEl.retry.hidden = false;
    return false;
  }
}

setupEl.retry.addEventListener("click", async () => {
  if (await runSetup()) boot();
});

// --- boot -----------------------------------------------------------------

async function boot() {
  try {
    if (await window.vb.setupNeeded()) {
      setupEl.wrap.hidden = false;
      if (!(await runSetup())) return;
    }
  } catch {
    // If the setup probe itself fails, fall through -- the status call below
    // will surface a concrete error rather than leaving a blank screen.
  }
  try {
    const s = await window.vb.status();
    const bits = [s.device === "cuda" ? (s.gpu || "GPU") : s.device.toUpperCase()];
    if (s.vram_total_gb) bits.push(`${s.vram_total_gb}GB VRAM`);
    if (s.torch) bits.push(`torch ${s.torch}`);
    el.device.textContent = bits.join("  ·  ");

    // Slider neutrals differ per checkpoint (turbo 0.0, base 0.5), so take them
    // from the engine rather than hardcoding a value the UI might not even be
    // able to reach.
    const d = s.defaults?.[s.model || "turbo"];
    if (d) {
      el.exaggeration.value = d.exaggeration;
      el.exagOut.textContent = d.exaggeration.toFixed(2);
      el.cfg.value = d.cfg_weight;
      el.cfgOut.textContent = d.cfg_weight.toFixed(2);
    }
  } catch (e) {
    el.device.textContent = "engine unavailable";
    showError("Could not start the voice engine.\n" + String(e?.message || e));
    return;
  }

  // Loading the model takes ~34s cold, which is far too long to make someone
  // wait after they hit Generate. Start it now, while they are still choosing a
  // voice and typing, so it is usually warm by the time they are ready.
  el.dot.className = "dot busy";
  // Shown before the engine emits its first progress event. On a first run this
  // period covers a ~2GB weight download and can last minutes, so do not call
  // it "warming up" -- that promises seconds and makes people force-quit.
  el.stage.textContent = "loading voice model — first run downloads ~2GB, this takes a few minutes";
  window.vb.load()
    .then(() => {
      el.dot.className = "dot ready";
      el.stage.textContent = "ready";
    })
    .catch((e) => {
      // Not fatal: Generate will retry the load and surface any real failure.
      el.dot.className = "dot ready";
      el.stage.textContent = "";
      console.warn("preload failed, will retry on demand:", e);
    });
}

boot();
