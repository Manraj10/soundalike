"""Base vs Turbo on this GPU. 4.5x-slower-than-realtime is a product problem;
this decides whether Turbo fixes it before we wire either one in."""
import time, torch, torchaudio, sys

TEXT = ("Soundalike clones a voice on your own machine, with no account and no cloud. "
        "This sentence is long enough to make the timing meaningful.")

def run(label, model, **kw):
    # warm-up pass so we time steady state, not first-call graph/kernel init
    model.generate("Warm up.", **kw)
    if torch.cuda.is_available():
        torch.cuda.synchronize()
    t0 = time.time()
    wav = model.generate(TEXT, **kw)
    if torch.cuda.is_available():
        torch.cuda.synchronize()
    wall = time.time() - t0
    secs = wav.shape[-1] / model.sr
    print(f"{label:<8} {secs:5.2f}s audio in {wall:6.2f}s  ->  RTF {wall/secs:5.2f}x", flush=True)
    a = wav.cpu()
    if a.dim() == 1:
        a = a.unsqueeze(0)
    torchaudio.save(f"bench_{label.lower()}.wav", torch.clamp(a, -1, 1), model.sr,
                    encoding="PCM_S", bits_per_sample=16)
    return wall / secs

dev = "cuda" if torch.cuda.is_available() else "cpu"
print(f"device={dev}\n", flush=True)

from chatterbox.tts import ChatterboxTTS
print("loading base...", flush=True)
t = time.time(); base = ChatterboxTTS.from_pretrained(device=dev)
print(f"  base loaded in {time.time()-t:.1f}s", flush=True)
rtf_base = run("BASE", base, exaggeration=0.5, cfg_weight=0.5)
del base; torch.cuda.empty_cache()

from chatterbox.tts_turbo import ChatterboxTurboTTS
print("\nloading turbo...", flush=True)
t = time.time(); turbo = ChatterboxTurboTTS.from_pretrained(device=dev)
print(f"  turbo loaded in {time.time()-t:.1f}s", flush=True)
rtf_turbo = run("TURBO", turbo, exaggeration=0.0, cfg_weight=0.0)

print(f"\nturbo is {rtf_base/rtf_turbo:.2f}x faster than base")
print("VERDICT:", "ship turbo as default" if rtf_turbo < rtf_base * 0.75 else "keep base")
