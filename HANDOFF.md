# Handoff prompt

Copy everything below the line into Codex (or any coding agent with local shell
access on this Windows machine).

---

You are finishing a working open-source project. It is already built and pushed;
your job is to verify the one unproven path, then release it.

## The project

**Soundalike** — a Windows desktop app for local voice cloning. Repo:
`https://github.com/Manraj10/soundalike`, checked out at
`C:\Users\manra\Documents\voicebox` (the folder name predates the rename; the
product is Soundalike).

Architecture: an Electron UI talks to a Python engine over **newline-delimited
JSON on stdin/stdout** — deliberately not a localhost HTTP server, so there is
no port to collide, no firewall prompt, and no browser tab. Speech comes from
Chatterbox (Resemble AI, MIT). The default checkpoint is `turbo`.

Layout:
- `engine/engine.py` — the Python engine. Commands: `status`, `load`, `synth`,
  `languages`, `quit`.
- `engine/test_engine.py` — drives the engine over stdio exactly as Electron does.
- `src/main.js` — Electron main; engine lifecycle, id-matched request/reply.
- `src/bootstrap.js` — **first-run provisioning. This is what you must verify.**
- `src/preload.js`, `src/renderer/` — the UI.
- `npm run engine:test` — engine test. `npm run dist` — build the installer.

## Already verified — do not redo

On an RTX 4070 Laptop (8.6GB VRAM), Python 3.11, torch 2.6.0+cu124:
- Engine passes end to end: model loads in ~34s, generates real audio, clones
  from a sample, rejects too-short samples with a readable message.
- Performance, 7s of audio, steady state after a warm-up pass:
  **turbo RTF 1.19x, base RTF 2.20x.** Turbo is default. Do not re-benchmark on
  short strings — under ~3s the fixed per-call cost dominates and you will
  measure 4.5x and wrongly conclude it is slow.
- 23 languages resolve via the `languages` command.
- Installer builds: `dist/Soundalike Setup 0.1.0.exe`, 82MB, with
  `resources/engine/engine.py` bundled.
- `src/bootstrap.js` correctly resolves the newest CPython 3.11 Windows asset
  from the python-build-standalone GitHub API (853 assets, matches
  `cpython-3.11.15+...-x86_64-pc-windows-msvc-install_only.tar.gz`).

## Task 1 — verify first-run provisioning (the actual gate)

`src/bootstrap.js` downloads a standalone CPython, extracts it with Windows'
`tar.exe`, pip-installs torch + chatterbox-tts into
`%APPDATA%/soundalike/runtime`, and verifies the imports before writing a
`.provisioned` stamp. **Only the asset-resolution step has ever been run.** The
full ~3GB path has never executed.

Verify it on a state that has no pre-existing environment:

1. Ensure `%APPDATA%/soundalike/runtime` does not exist.
2. Install from `dist/Soundalike Setup 0.1.0.exe`, or run
   `dist/win-unpacked/Soundalike.exe` directly. Either way the packaged app must
   NOT see the dev `.venv` — confirm `enginePaths()` in `src/main.js` resolves to
   the provisioned interpreter, not the project venv.
3. Watch the setup screen run to completion. Then generate speech.

It must end with: a real `.wav` in `Documents/Soundalike/`, the GPU actually
used, and no terminal ever shown to the user.

Report the wall-clock time and peak disk usage of provisioning, and put the real
number in the README (it currently says "~3GB").

If it fails, fix it. Likely failure points, in order: the `tar.exe` extraction
producing an unexpected directory layout; pip needing `--no-warn-script-location`
in a path with spaces; and the progress regex in `bootstrap.js` not matching
current pip output, which shows a frozen bar rather than erroring.

## Task 2 — record the demo GIF

The README expects a demo at the very top, above everything. Record the real app
(use ffmpeg `gdigrab` or any screen recorder), ~15 seconds, one take, no music,
no zoom effects, no cuts:

- **0–3s** App open. Drop in a ~15s voice sample. Deliberately unremarkable.
- **3–6s** Type a sentence. The hardware badge is visible in the header.
- **6–10s** Click Generate. Audio appears with `1.19x realtime` in the metadata.
- **10–15s** Play it. Cut on the cloned voice speaking.

The beat that sells it is **the speed readout sitting next to the audio** — no
competitor can show that, because they all cost you a venv and a browser tab
first. Keep it under 5MB so GitHub renders it inline. Commit as `docs/demo.gif`
and reference it at the top of the README.

## Task 3 — sign and release, but only after Task 1 passes

Code signing is currently disabled: `"signAndEditExecutable": false` in
`package.json`. It is off because electron-builder's `winCodeSign` cache contains
**macOS symlinks** that Windows refuses to extract without Developer Mode. That
is a workaround, not a fix — it also means the exe has no icon or version
metadata.

If a signing certificate is available, re-enable signing and use it. If not,
publish anyway but say plainly in the release notes that the binary is unsigned
and SmartScreen will warn. Then cut a GitHub release with the installer attached
and remove the "Status: working, not yet released" section from the README.

**Do not publish a release binary if Task 1 did not pass.** An installer that
fails on first launch is worse than no installer.

## Traps already hit — do not reintroduce these

1. **stderr must be drained continuously.** The engine routes library output to
   stderr to keep stdout a clean protocol stream. transformers writes progress
   bars there. If a consumer does not drain stderr, the ~4-8KB pipe buffer fills,
   the engine blocks on write, and everything hangs **with the GPU at 0% while
   merely looking slow**. This cost hours. Electron's `data` listener is correct;
   any new Python-side harness needs a dedicated reader thread.
2. **WAV must be 16-bit PCM.** `torchaudio.save` defaults to IEEE float32, which
   the Python stdlib `wave` module refuses and HTML5 `<audio>` handles
   inconsistently. Pass `encoding="PCM_S", bits_per_sample=16` and clamp to
   [-1, 1].
3. **Voice samples under 5s** make the turbo checkpoint raise a bare
   `AssertionError` from deep inside the model. The engine pre-checks duration
   and raises a readable message; there is a regression test asserting the
   message stays human-readable. Keep it.
4. **`File.path` does not exist in Electron 32+.** Drag-and-drop needs
   `webUtils.getPathForFile`, called from the preload.
5. **Turbo and base disagree on neutral** (0.0/0.0 vs 0.5/0.5 for
   exaggeration/cfg_weight). The engine reports `defaults` in `status` and the UI
   reads them. Do not hardcode slider values — an earlier version had
   `min="0.25"` and literally could not reach turbo's own default.
6. **`npm install` silently blocks Electron's postinstall** under npm's
   allow-scripts policy, so `node_modules/electron/dist/electron.exe` never
   downloads. Run `node install.js` inside `node_modules/electron` rather than
   loosening the global npm policy.
7. **`du` on `.venv` while pip is writing to it hangs.** Do not poll it.

## Constraints

- **Do not change system or security settings** — no enabling Developer Mode, no
  creating user accounts, no touching Defender or AppLocker. Work around, or
  report that a step needs the owner.
- **Do not commit** `.venv/`, `node_modules/`, `dist/`, `out/`, or generated
  `.wav` files. `.gitignore` covers these; keep it that way.
- **Do not weaken the Electron security posture**: `contextIsolation: true`,
  `sandbox: true`, `nodeIntegration: false`, and the renderer CSP stay as they
  are. The preload surface is intentionally narrow.
- **Report measured numbers, not estimates.** If you claim it works, say what you
  ran and paste the output. If a step fails, say so plainly rather than
  describing what should have happened.
- Keep the README's **Consent** section. Voice cloning needs it and it is not
  decoration.
