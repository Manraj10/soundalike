# Soundalike

**Clone a voice on your own machine. No account, no cloud, no Python.**

<!-- DEMO.gif goes here, above everything. No badges above the fold. -->

Every good open-source voice model already exists. What doesn't exist is a way
for a normal person to use one. The popular options all end the same way:

```
git clone …
python -m venv .venv
pip install -r requirements.txt   # then fight CUDA for an hour
python server.py                  # then open localhost:7860 in a browser
```

Soundalike is a Windows app. You download it, double-click it, drop in ten
seconds of someone talking, and type. That's the whole thing.

---

## Speed

Measured on an RTX 4070 Laptop (8GB), 7 seconds of generated speech, steady
state after one warm-up pass. RTF is the multiple of realtime — lower is better,
1.0x means it generates speech as fast as you'd speak it.

| Checkpoint | Time for 7s of audio | RTF |
| ---------- | -------------------- | --- |
| turbo (default) | 9.5s | **1.19x** |
| base | 15.4s | 2.20x |

Longer inputs get closer to realtime, since a fixed per-call cost is amortised
over more audio. Reproduce it yourself with `python bench_turbo.py`.

## What it does

- **Clones a voice from a short sample** — 5 seconds minimum, 10–20 works best.
- **Near-realtime on a laptop GPU** — 1.19x realtime on a mobile 4070.
- **23 languages** — Arabic, Chinese, Danish, Dutch, English, Finnish, French,
  German, Greek, Hebrew, Hindi, Italian, Japanese, Korean, Malay, Norwegian,
  Polish, Portuguese, Russian, Spanish, Swahili, Swedish, Turkish.
- **Runs entirely offline.** Nothing you type or record leaves the machine.
- **Uses your GPU** when you have one, falls back to CPU when you don't.
- **No Python, no terminal, no localhost.** The model runs in a background
  process the app talks to over a pipe — there's no web server, so there's no
  port to conflict and no Windows Firewall prompt.

## What it doesn't do

Written here by me, before anyone else writes it for me:

- **Windows only** right now. macOS and Linux are not built yet.
- **First launch downloads ~3GB** — the Python runtime, PyTorch and the model
  weights, once. After that it works with the network off.
- **Needs an NVIDIA GPU to be fast.** It runs on CPU, just slowly.
- **Quality depends on your sample.** Ten seconds of clean, dry, single-speaker
  audio beats a minute of a noisy podcast clip. Background music ruins it.
- **It does not verify consent.** See below — this matters.

## Consent

Cloning a voice is not a neutral act. Don't clone someone who hasn't agreed to
it. Impersonation to commit fraud is a crime in most places, and "it was open
source" is not a defense. This tool exists for people making things with their
own voice, or with a voice they have explicit permission to use.

---

## Status

Working, not yet released. The engine is verified end to end and the Windows
installer builds (82MB), but the first-run provisioning has not been tested on
a clean machine yet, and the installer is unsigned. **Build from source for
now** — a signed release comes once first-run setup is proven on hardware that
isn't mine.

## Install

*(once released)* Download the latest `.exe` from [Releases](../../releases)
and run it.

The installer is 82MB. On first launch the app fetches its own private Python
runtime, PyTorch and the model weights (~3GB) behind a progress bar, then never
touches the network again. That lives in `%APPDATA%/soundalike/runtime`, so
uninstalling removes it and a broken environment can be fixed by deleting one
folder. Nothing is installed system-wide, and your system Python — if you even
have one — is not touched.

## Build from source

```bash
git clone https://github.com/Manraj10/soundalike
cd soundalike
npm install
python -m venv .venv
./.venv/Scripts/python.exe -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
./.venv/Scripts/python.exe -m pip install chatterbox-tts
npm start
```

Verify the engine on its own, without the UI:

```bash
npm run engine:test
```

## How it works

```
Electron UI  ──JSON over stdin/stdout──▶  Python engine  ──▶  Chatterbox (MIT)
```

One long-lived Python child process. Requests and replies are newline-delimited
JSON matched by id; progress events stream back while the model loads and
generates. Deliberately not an HTTP server — a pipe can't be reached from off
the machine, so "fully offline" is a property of the architecture rather than a
promise in a README.

## Credits

Speech synthesis by [Chatterbox](https://github.com/resemble-ai/chatterbox)
from Resemble AI (MIT). Soundalike is a desktop shell around it — the hard part
is theirs.

## License

MIT
