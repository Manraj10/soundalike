"""Voice engine: newline-delimited JSON over stdin/stdout.

Deliberately not an HTTP server. Every comparable project binds a localhost
port, which costs the user a Windows Firewall prompt, a possible port clash,
and a browser tab. A stdio pipe has none of those failure modes and cannot be
reached from off-machine, so "fully offline" is structural rather than a promise.

Protocol -- one JSON object per line, both directions.
  in : {"id": 1, "cmd": "status"}
       {"id": 2, "cmd": "load"}
       {"id": 3, "cmd": "synth", "text": "...", "out": "C:/path.wav",
                 "voice": "C:/sample.wav" | null,
                 "exaggeration": 0.5, "cfg_weight": 0.5}
       {"id": 4, "cmd": "quit"}
  out: {"id": 1, "ok": true, "data": {...}}
       {"id": 1, "ok": false, "error": "..."}
       {"event": "progress", "stage": "loading_model", "detail": "..."}

stdout carries protocol only. Anything a library prints is rerouted to stderr
so a stray print() from a dependency cannot corrupt the stream.
"""
import contextlib
import io
import json
import os
import sys
import traceback

# Force classic HTTP downloads from the HuggingFace hub.
#
# chatterbox pulls in hf-xet, HuggingFace's Xet storage backend. On some
# networks it stalls at zero bytes forever rather than erroring or falling back,
# which presents as the app "not starting" -- the window opens, the engine is
# healthy, and the weight download simply never advances. Observed here as three
# .incomplete files sitting at 0 MB across a 20 minute run.
#
# Must be set before huggingface_hub is imported anywhere.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "0")

_MODEL = None
_DEVICE = None
_KIND = None

# Measured on an RTX 4070 Laptop, 7s of audio, steady state after a warm-up pass:
#   base  -> RTF 2.20x slower than realtime
#   turbo -> RTF 1.19x  (1.85x faster than base)
# Turbo is the default because near-realtime is the difference between a tool
# people use and a tool people try once. The two checkpoints also want different
# defaults: base is tuned around 0.5/0.5, turbo around 0.0/0.0.
DEFAULTS = {
    "turbo": {"exaggeration": 0.0, "cfg_weight": 0.0},
    "base": {"exaggeration": 0.5, "cfg_weight": 0.5},
    "multilingual": {"exaggeration": 0.5, "cfg_weight": 0.5},
}

# Only the multilingual checkpoint accepts a language_id; passing one to turbo
# or base is a TypeError, so the engine gates it rather than trusting callers.
MULTILINGUAL_ONLY = {"multilingual"}

# Turbo asserts internally on voice prompts shorter than this.
MIN_VOICE_SECONDS = 5.0


def _audio_duration(path):
    """Duration in seconds, or None if it can't be determined without failing."""
    try:
        import soundfile as sf
        info = sf.info(path)
        return info.frames / float(info.samplerate) if info.samplerate else None
    except Exception:
        return None


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def progress(stage, detail=""):
    emit({"event": "progress", "stage": stage, "detail": detail})


def pick_device():
    """CUDA if usable, else CPU. Never raise -- CPU is always a valid answer."""
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def cmd_status(_req):
    global _DEVICE
    if _DEVICE is None:
        _DEVICE = pick_device()
    info = {"device": _DEVICE, "model_loaded": _MODEL is not None,
            "model": _KIND, "defaults": DEFAULTS,
            "python": sys.version.split()[0]}
    try:
        import torch
        info["torch"] = torch.__version__
        if _DEVICE == "cuda":
            info["gpu"] = torch.cuda.get_device_name(0)
            free, total = torch.cuda.mem_get_info()
            info["vram_free_gb"] = round(free / 1e9, 1)
            info["vram_total_gb"] = round(total / 1e9, 1)
    except Exception as e:
        info["torch_error"] = str(e)
    return info


def _model_class(kind):
    if kind == "turbo":
        from chatterbox.tts_turbo import ChatterboxTurboTTS
        return ChatterboxTurboTTS
    if kind == "multilingual":
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS
        return ChatterboxMultilingualTTS
    from chatterbox.tts import ChatterboxTTS
    return ChatterboxTTS


def cmd_languages(_req):
    """The multilingual checkpoint's language codes, straight from the package."""
    try:
        from chatterbox import SUPPORTED_LANGUAGES
        return {"languages": SUPPORTED_LANGUAGES}
    except Exception as e:
        return {"languages": {"en": "English"}, "error": str(e)}


def cmd_load(req):
    """Load the model. First call downloads weights; later calls are cached."""
    global _MODEL, _DEVICE, _KIND
    kind = (req or {}).get("model") or "turbo"
    if kind not in DEFAULTS:
        raise ValueError(f"unknown model '{kind}'; expected turbo or base")
    if _MODEL is not None and _KIND == kind:
        return {"already_loaded": True, "device": _DEVICE, "model": _KIND,
                "sample_rate": _MODEL.sr}

    _DEVICE = _DEVICE or pick_device()
    progress("loading_model", f"{kind} on {_DEVICE}; first run downloads ~2GB of weights")

    cls = _model_class(kind)
    # Library chatter goes to stderr; stdout is protocol-only.
    with contextlib.redirect_stdout(sys.stderr):
        try:
            _MODEL = cls.from_pretrained(device=_DEVICE)
        except Exception:
            if _DEVICE == "cpu":
                raise
            progress("gpu_failed", "falling back to CPU")
            _DEVICE = "cpu"
            _MODEL = cls.from_pretrained(device=_DEVICE)

    _KIND = kind
    progress("model_ready", f"{kind} on {_DEVICE}")
    return {"loaded": True, "device": _DEVICE, "model": _KIND,
            "sample_rate": _MODEL.sr}


def cmd_synth(req):
    global _MODEL
    text = (req.get("text") or "").strip()
    if not text:
        raise ValueError("text is empty")
    if len(text) > 5000:
        raise ValueError(f"text is {len(text)} chars; cap is 5000 per request")

    out_path = req.get("out")
    if not out_path:
        raise ValueError("missing 'out' path")
    out_dir = os.path.dirname(os.path.abspath(out_path))
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    voice = req.get("voice") or None
    if voice:
        if not os.path.isfile(voice):
            raise FileNotFoundError(f"voice sample not found: {voice}")
        # The turbo checkpoint asserts on prompts under 5s deep inside the
        # model, which surfaces as a bare AssertionError. Check it here so the
        # user gets a sentence they can act on instead of a stack trace.
        dur = _audio_duration(voice)
        if dur is not None and dur < MIN_VOICE_SECONDS:
            raise ValueError(
                f"Voice sample is {dur:.1f}s. Needs to be at least "
                f"{MIN_VOICE_SECONDS:.0f}s — 10 to 20 seconds of clean speech "
                f"works best."
            )

    if _MODEL is None:
        cmd_load({"model": req.get("model")})

    kw = {}
    if voice:
        kw["audio_prompt_path"] = voice
    # Fall back to the loaded checkpoint's own tuning rather than a shared
    # constant -- base and turbo disagree on what neutral means.
    tuned = DEFAULTS.get(_KIND, DEFAULTS["turbo"])
    for k in ("exaggeration", "cfg_weight"):
        kw[k] = float(req[k]) if req.get(k) is not None else tuned[k]
    if req.get("temperature") is not None:
        kw["temperature"] = float(req["temperature"])
    lang = req.get("language")
    if lang and _KIND in MULTILINGUAL_ONLY:
        kw["language_id"] = lang
    elif lang and lang != "en":
        raise ValueError(
            f"Language '{lang}' needs the multilingual model. "
            f"Load it with model='multilingual' first."
        )

    progress("synthesizing", f"{len(text)} chars")
    with contextlib.redirect_stdout(sys.stderr):
        wav = _MODEL.generate(text, **kw)

    import torch
    import torchaudio
    # torchaudio defaults to float32 WAV (format tag 3), which many players and
    # the stdlib `wave` module refuse to open. Write 16-bit PCM instead so the
    # output works in an <audio> element and in every editor.
    audio = wav.cpu()
    if audio.dim() == 1:
        audio = audio.unsqueeze(0)
    audio = torch.clamp(audio, -1.0, 1.0)
    torchaudio.save(out_path, audio, _MODEL.sr,
                    encoding="PCM_S", bits_per_sample=16)
    size = os.path.getsize(out_path)
    dur = round(wav.shape[-1] / _MODEL.sr, 2)
    progress("done", out_path)
    return {"path": out_path, "bytes": size, "seconds": dur,
            "sample_rate": _MODEL.sr, "cloned": bool(voice)}


HANDLERS = {"status": cmd_status, "load": cmd_load, "synth": cmd_synth,
            "languages": cmd_languages}


def main():
    # Keep dependency logging off stdout no matter what any library does.
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    emit({"event": "ready", "pid": os.getpid()})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            emit({"ok": False, "error": f"bad json: {e}"})
            continue

        rid = req.get("id")
        cmd = req.get("cmd")
        if cmd == "quit":
            emit({"id": rid, "ok": True, "data": {"bye": True}})
            return
        fn = HANDLERS.get(cmd)
        if fn is None:
            emit({"id": rid, "ok": False, "error": f"unknown cmd: {cmd}"})
            continue
        try:
            emit({"id": rid, "ok": True, "data": fn(req)})
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            emit({"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
