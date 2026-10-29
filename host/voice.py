# Voice for Albatross: speech to text (faster-whisper) and text to speech (Piper), on this PC.
# Started by voice.js; one JSON request per line on stdin, one JSON answer per line on stdout ({"id": ..., ...}).
#   {"op": "stt", "audio": base64 (webm/ogg/wav...), "lang": "de" or ""}  ->  {"text", "lang", "secs"}
#   {"op": "tts", "text": "...", "lang": "de"}                           ->  {"wav": base64}  (or {"none": true}: no voice for that language)
#   {"op": "status"}                                                     ->  {"stt": model or "", "device", "voices": [...]}
# Models are downloaded on first use: Whisper from Hugging Face (into its cache), Piper voices into <LocalAppData>\Albatross\voice.
import sys, os, json, base64, io, wave, time, tempfile, threading, urllib.request

DIR = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "Albatross", "voice")
VOICES = {  # language -> Piper voice (rhasspy/piper-voices)
    "de": "de/de_DE/thorsten/medium/de_DE-thorsten-medium",
    "en": "en/en_US/lessac/medium/en_US-lessac-medium",
    "fr": "fr/fr_FR/siwis/medium/fr_FR-siwis-medium",
    "es": "es/es_ES/davefx/medium/es_ES-davefx-medium",
    "it": "it/it_IT/paola/medium/it_IT-paola-medium",
}
HF = "https://huggingface.co/rhasspy/piper-voices/resolve/main/"
lock = threading.Lock()
whisper, device, voices = None, "", {}

def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n"); sys.stdout.flush()

WHISPER = {"large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo", "small": "Systran/faster-whisper-small"}
def model_dir(name):
    # fetched here, file by file: the huggingface_hub downloader fails on this Python ("unexpected keyword argument metadata_errors")
    d = os.path.join(DIR, "whisper-" + name); os.makedirs(d, exist_ok=True)
    for f in ("config.json", "preprocessor_config.json", "tokenizer.json", "vocabulary.json", "vocabulary.txt", "model.bin"):
        p = os.path.join(d, f)
        if os.path.exists(p): continue
        try:
            urllib.request.urlretrieve("https://huggingface.co/%s/resolve/main/%s" % (WHISPER[name], f), p + ".part"); os.replace(p + ".part", p)
        except Exception:
            if f in ("preprocessor_config.json", "vocabulary.json", "vocabulary.txt"): continue   # not every model has each of these
            raise
    return d

def cuda_dlls():
    # cuBLAS and cuDNN from the pip packages nvidia-cublas-cu12 / nvidia-cudnn-cu12, if installed
    import site
    for sp in site.getsitepackages():
        for pkg in ("cublas", "cudnn", "cuda_nvrtc"):
            d = os.path.join(sp, "nvidia", pkg, "bin")
            if os.path.isdir(d):
                os.add_dll_directory(d); os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")

def load_whisper():
    global whisper, device
    if whisper: return whisper
    try:  # the graphics card: the bigger, better model, and fast
        cuda_dlls()
        m = WhisperModel(model_dir("large-v3-turbo"), device="cuda", compute_type="float16")
        list(m.transcribe(silence(), language="en")[0])   # fails here if the card's libraries are missing
        whisper, device = m, "cuda"
    except Exception as e:
        sys.stderr.write("voice: no graphics card for Whisper (%s), using the processor\n" % e)
        whisper, device = WhisperModel(model_dir("small"), device="cpu", compute_type="int8"), "cpu"
    return whisper

def silence():
    b = io.BytesIO(); w = wave.open(b, "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\0\0" * 8000); w.close(); b.seek(0); return b

def stt(req):
    m = load_whisper()
    data = base64.b64decode(req["audio"])
    t0 = time.time()
    segs, info = m.transcribe(io.BytesIO(data), language=req.get("lang") or None, beam_size=5 if device == "cuda" else 1, vad_filter=True)
    text = " ".join(s.text.strip() for s in segs).strip()
    return {"text": text, "lang": info.language, "secs": round(time.time() - t0, 2)}

def voice_for(lang):
    lang = (lang or "en").split("-")[0].lower()
    if lang not in VOICES: return None
    if lang in voices: return voices[lang]
    name = VOICES[lang].split("/")[-1]
    onnx = os.path.join(DIR, name + ".onnx")
    if not os.path.exists(onnx) or not os.path.exists(onnx + ".json"):
        os.makedirs(DIR, exist_ok=True)
        for ext in (".onnx.json", ".onnx"):
            tmp = os.path.join(DIR, name + ext + ".part")
            urllib.request.urlretrieve(HF + VOICES[lang] + ext, tmp); os.replace(tmp, os.path.join(DIR, name + ext))
    voices[lang] = PiperVoice.load(onnx)
    return voices[lang]

def tts(req):
    v = voice_for(req.get("lang"))
    if not v: return {"none": True}
    b = io.BytesIO()
    with wave.open(b, "wb") as w: v.synthesize_wav(str(req.get("text", ""))[:4000], w)
    return {"wav": base64.b64encode(b.getvalue()).decode()}

def handle(line):
    try:
        req = json.loads(line); rid = req.get("id")
        with lock:
            op = req.get("op")
            res = stt(req) if op == "stt" else tts(req) if op == "tts" else {"stt": ("large-v3-turbo" if device == "cuda" else "small") if whisper else "", "device": device, "voices": sorted(VOICES)}
        res["id"] = rid; out(res)
    except Exception as e:
        out({"id": (locals().get("req") or {}).get("id"), "error": str(e)[:300]})

# imported here, in the main thread: importing them first inside a request thread hangs on this PC
from piper import PiperVoice
from faster_whisper import WhisperModel
out({"ready": True})
for line in sys.stdin:
    if line.strip(): threading.Thread(target=handle, args=(line,), daemon=True).start()
