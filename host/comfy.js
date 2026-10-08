// Image generation through ComfyUI, for PCs where Ollama can't make images (Windows/Linux for now).
// The host lists "z-image-turbo:comfyui" next to the Ollama models and answers /api/generate for it
// in Ollama's format, so the website's Image mode works unchanged (and stays end-to-end encrypted).
// ComfyUI is started on the first image request and runs only on this PC (127.0.0.1).
//
// Env: COMFY_DIR (default: a ComfyUI folder next to the Burrow folder, e.g. D:\Burrow\ComfyUI\ComfyUI_windows_portable),
//      COMFY_URL (default http://127.0.0.1:8188)

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const COMFY_DIR = process.env.COMFY_DIR || [
  path.join(__dirname, "..", "..", "ComfyUI", "ComfyUI_windows_portable"), // D:\Burrow\app\host -> D:\Burrow\ComfyUI
  "D:\\ComfyUI\\ComfyUI_windows_portable",
].find((d) => fs.existsSync(d)) || "D:\\ComfyUI\\ComfyUI_windows_portable";
const COMFY = (process.env.COMFY_URL || "http://127.0.0.1:8188").replace(/\/+$/, "");
const MODEL = "z-image-turbo:comfyui";
const FILES = { unet: "z_image_turbo_nvfp4.safetensors", clip: "qwen_3_4b_fp8_mixed.safetensors", vae: "ae.safetensors" };

const installed = () => fs.existsSync(path.join(COMFY_DIR, "python_embeded", "python.exe"))
  && fs.existsSync(path.join(COMFY_DIR, "ComfyUI", "models", "diffusion_models", FILES.unet));
const isComfy = (model) => model === MODEL;
const up = () => fetch(COMFY + "/system_stats", { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);

// Shown in the model list like an Ollama model; the name makes the website treat it as an image model.
function models() {
  if (!installed()) return [];
  return [{ name: MODEL, model: MODEL, size: 0, details: { family: "z-image", parameter_size: "6B", format: "comfyui" } }];
}

let starting = null;
function ensureRunning(log) {
  if (starting) return starting;
  starting = (async () => {
    if (await up()) return;
    log("Starting ComfyUI for image generation…");
    const out = fs.openSync(path.join(__dirname, "comfyui.log"), "a");
    const child = spawn(path.join(COMFY_DIR, "python_embeded", "python.exe"),
      ["-s", path.join("ComfyUI", "main.py"), "--windows-standalone-build", "--listen", "127.0.0.1", "--port", new URL(COMFY).port || "8188", "--disable-auto-launch"],
      { cwd: COMFY_DIR, detached: true, stdio: ["ignore", out, out], windowsHide: true });
    child.on("error", () => {});
    child.unref();
    for (let i = 0; i < 180; i++) {
      if (await up()) { log("ComfyUI is running"); return; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("ComfyUI didn't start within 3 minutes (see host/comfyui.log)");
  })().finally(() => { starting = null; });
  return starting;
}

// ComfyUI's API format: Z-Image Turbo text-to-image, 8 steps, no negative prompt.
function workflow({ prompt, width = 1024, height = 1024, steps = 8, seed }) {
  return {
    1: { class_type: "UNETLoader", inputs: { unet_name: FILES.unet, weight_dtype: "default" } },
    2: { class_type: "CLIPLoader", inputs: { clip_name: FILES.clip, type: "lumina2", device: "default" } },
    3: { class_type: "VAELoader", inputs: { vae_name: FILES.vae } },
    4: { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["2", 0] } },
    5: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
    6: { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: 1 } },
    7: { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3 } },
    8: { class_type: "KSampler", inputs: {
      model: ["7", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0],
      seed: Number.isFinite(seed) ? seed : crypto.randomInt(2 ** 47), steps, cfg: 1,
      sampler_name: "res_multistep", scheduler: "simple", denoise: 1,
    } },
    9: { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    10: { class_type: "PreviewImage", inputs: { images: ["9", 0] } },
  };
}

// Runs one image and reports progress like Ollama does: {completed,total} lines, then {image, done:true}.
async function generate(body, emit, signal, log) {
  if (!installed()) throw new Error("ComfyUI isn't installed on this PC");
  await ensureRunning(log);
  const clamp = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Math.round(Number(v) || d)));
  const opts = {
    prompt: String(body.prompt || ""),
    width: clamp(body.width, 256, 2048, 1024) & ~15,
    height: clamp(body.height, 256, 2048, 1024) & ~15,
    steps: clamp(body.steps, 1, 50, 8),
    seed: body.seed === undefined ? undefined : Number(body.seed),
  };
  const clientId = crypto.randomUUID();
  const ws = new WebSocket(COMFY.replace(/^http/, "ws") + "/ws?clientId=" + clientId);
  await new Promise((ok, fail) => { ws.once("open", ok); ws.once("error", fail); });
  try {
    loaded = true;
    const r = await fetch(COMFY + "/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: workflow(opts), client_id: clientId }) });
    const j = await r.json();
    if (!r.ok || !j.prompt_id) throw new Error(j.error?.message || JSON.stringify(j.node_errors || j).slice(0, 300));
    const id = j.prompt_id;
    const onAbort = () => {
      fetch(COMFY + "/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [id] }) }).catch(() => {});
      fetch(COMFY + "/interrupt", { method: "POST" }).catch(() => {});
    };
    signal?.addEventListener("abort", onAbort);
    try {
      await new Promise((ok, fail) => {
        ws.on("message", (raw, isBinary) => {
          if (isBinary) return; // live preview frames
          let m; try { m = JSON.parse(raw); } catch { return; }
          if (m.data?.prompt_id && m.data.prompt_id !== id) return;
          if (m.type === "progress") emit({ model: MODEL, completed: m.data.value, total: m.data.max, done: false });
          else if (m.type === "execution_error") fail(new Error(m.data.exception_message || "ComfyUI error"));
          else if (m.type === "execution_interrupted") fail(Object.assign(new Error("Stopped"), { name: "AbortError" }));
          else if (m.type === "executing" && m.data.node === null) ok();
          else if (m.type === "execution_success") ok();
        });
        ws.on("close", () => fail(new Error("Lost connection to ComfyUI")));
        signal?.addEventListener("abort", () => fail(Object.assign(new Error("Stopped"), { name: "AbortError" })));
      });
    } finally { signal?.removeEventListener("abort", onAbort); }
    const hist = (await (await fetch(COMFY + "/history/" + id)).json())[id];
    const img = Object.values(hist?.outputs || {}).flatMap((o) => o.images || [])[0];
    if (!img) throw new Error("ComfyUI didn't return an image");
    const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || "", type: img.type || "temp" });
    const png = Buffer.from(await (await fetch(COMFY + "/view?" + q)).arrayBuffer());
    emit({ model: MODEL, image: png.toString("base64"), done: true });
  } finally { ws.close(); }
}

// Frees ComfyUI's GPU memory (used by the "Free GPU memory" buttons). Does nothing if it isn't running.
// Returns true if it had made an image since the last free (so there's something worth reporting).
let loaded = false;
async function free() {
  if (!(await up())) return false;
  await fetch(COMFY + "/free", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }) }).catch(() => {});
  const was = loaded;
  loaded = false;
  return was;
}

// Size of the model files ComfyUI loads, for the loading percentage.
function bytes() {
  let t = 0;
  for (const [dir, f] of [["diffusion_models", FILES.unet], ["text_encoders", FILES.clip], ["vae", FILES.vae]]) {
    try { t += fs.statSync(path.join(COMFY_DIR, "ComfyUI", "models", dir, f)).size; } catch {}
  }
  return t;
}

module.exports = { MODEL, isComfy, models, generate, free, installed, bytes };
