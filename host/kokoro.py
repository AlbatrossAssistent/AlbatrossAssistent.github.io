# The natural voice for Albatross: Kokoro (hexgrad/Kokoro-82M, Apache-2.0) through kokoro-onnx (MIT), on this PC's processor.
# Started by host/kokoro.js with the Python of its own folder (<LocalAppData>\Albatross\kokoro\venv); one JSON request per line on
# stdin, one JSON answer per line on stdout:
#   {"id", "op": "tts", "text", "lang": "en", "voice": "af_heart", "speed": 1.0}  ->  {"id", "wav": base64 (16-bit mono)}
#   {"id", "op": "voices"}                                                       ->  {"id", "voices": [...]}
import sys, os, json, base64, io, wave, threading

DIR = os.path.dirname(os.path.abspath(sys.argv[1])) if len(sys.argv) > 1 else os.getcwd()
MODEL, VOICES = os.path.join(DIR, "kokoro-v1.0.onnx"), os.path.join(DIR, "voices-v1.0.bin")
# Kokoro's languages, and the voice used for each when the chosen voice belongs to another language
LANGS = {"en": ("en-us", "af_heart"), "es": ("es", "ef_dora"), "fr": ("fr-fr", "ff_siwis"), "it": ("it", "if_sara"),
         "pt": ("pt-br", "pf_dora"), "hi": ("hi", "hf_alpha"), "ja": ("ja", "jf_alpha"), "zh": ("cmn", "zf_xiaoxiao")}
PREFIX = {"en": "ab", "es": "e", "fr": "f", "it": "i", "pt": "p", "hi": "h", "ja": "j", "zh": "z"}
kokoro, lock = None, threading.Lock()

def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n"); sys.stdout.flush()

def load():
    global kokoro
    if kokoro is None:
        from kokoro_onnx import Kokoro
        kokoro = Kokoro(MODEL, VOICES)
    return kokoro

def tts(req):
    lang = (req.get("lang") or "en").split("-")[0].lower()
    if lang not in LANGS: return {"none": True}
    code, default = LANGS[lang]
    voice = str(req.get("voice") or "")
    if not voice or voice[0] not in PREFIX[lang]: voice = default
    if lang == "en" and voice[0] == "b": code = "en-gb"            # British voices speak British English
    k = load()
    if voice not in k.get_voices(): voice = default
    import numpy as np
    samples, rate = k.create(str(req.get("text") or "")[:4000], voice=voice, speed=float(req.get("speed") or 1.0), lang=code)
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    b = io.BytesIO(); w = wave.open(b, "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(pcm); w.close()
    return {"wav": base64.b64encode(b.getvalue()).decode("ascii"), "voice": voice, "engine": "kokoro"}

for line in sys.stdin:
    try: req = json.loads(line)
    except Exception: continue
    rid = req.get("id")
    try:
        with lock:
            if req.get("op") == "tts": res = tts(req)
            elif req.get("op") == "voices": res = {"voices": load().get_voices()}
            else: res = {"error": "unknown op"}
    except Exception as e:
        res = {"error": "%s: %s" % (type(e).__name__, e)}
    res["id"] = rid; out(res)
