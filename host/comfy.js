// Image generation through ComfyUI, for PCs where Ollama can't make images (Windows/Linux for now).
// The host lists the installed ComfyUI models (e.g. "z-image-turbo:comfyui", "omnigen2:comfyui") next to the
// Ollama models and answers /api/generate for them in Ollama's format, so the website works unchanged
// (and stays end-to-end encrypted). OmniGen2 can also take reference pictures and edit them.
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
const M = (...p) => path.join(COMFY_DIR, "ComfyUI", "models", ...p);
// The models Albatross knows how to run. Each is offered only if all its files are there.
const MODELS = {
  "z-image-turbo:comfyui": {
    files: { unet: ["diffusion_models", "z_image_turbo_nvfp4.safetensors"], clip: ["text_encoders", "qwen_3_4b_fp8_mixed.safetensors"], vae: ["vae", "ae.safetensors"] },
    details: { family: "z-image", parameter_size: "6B", format: "comfyui" },
  },
  "omnigen2:comfyui": {
    files: { unet: ["unet", "omnigen2-fp32-q8_0.gguf"], clip: ["text_encoders", "qwen_2.5_vl_fp16.safetensors"], vae: ["vae", "ae.safetensors"] },
    details: { family: "omnigen2", parameter_size: "4B", format: "comfyui", edit: true },   // edit: takes reference pictures
  },
};
const MODEL = "z-image-turbo:comfyui";
const hasPython = () => fs.existsSync(path.join(COMFY_DIR, "python_embeded", "python.exe"));
const hasFiles = (name) => Object.values(MODELS[name].files).every(([dir, f]) => fs.existsSync(M(dir, f)));
const installed = () => hasPython() && Object.keys(MODELS).some(hasFiles);
const isComfy = (model) => Object.prototype.hasOwnProperty.call(MODELS, model);
const up = () => fetch(COMFY + "/system_stats", { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);

// Shown in the model list like Ollama models; the ":comfyui" names make the website treat them as image models.
function models() {
  if (!hasPython()) return [];
  return Object.keys(MODELS).filter(hasFiles).map((name) => ({ name, model: name, size: 0, details: MODELS[name].details }));
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
function zimageWorkflow({ prompt, width = 1024, height = 1024, steps = 8, seed }) {
  const F = MODELS["z-image-turbo:comfyui"].files;
  return {
    1: { class_type: "UNETLoader", inputs: { unet_name: F.unet[1], weight_dtype: "default" } },
    2: { class_type: "CLIPLoader", inputs: { clip_name: F.clip[1], type: "lumina2", device: "default" } },
    3: { class_type: "VAELoader", inputs: { vae_name: F.vae[1] } },
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

// OmniGen2: text-to-image, or editing/combining up to 3 reference pictures (uploaded to ComfyUI first).
// With references it uses two guidance scales: one for the instruction, one for staying close to the pictures.
function omnigenWorkflow({ prompt, width = 1024, height = 1024, steps = 20, seed, refs = [] }) {
  const F = MODELS["omnigen2:comfyui"].files;
  const w = {
    1: { class_type: "UnetLoaderGGUF", inputs: { unet_name: F.unet[1] } },
    2: { class_type: "CLIPLoader", inputs: { clip_name: F.clip[1], type: "omnigen2", device: "default" } },
    3: { class_type: "VAELoader", inputs: { vae_name: F.vae[1] } },
    4: { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["2", 0] } },
    5: { class_type: "CLIPTextEncode", inputs: { text: "blurry, low quality, distorted, deformed, watermark, text artifacts", clip: ["2", 0] } },
    6: { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: 1 } },
  };
  const sd = Number.isFinite(seed) ? seed : crypto.randomInt(2 ** 47);
  if (!refs.length) {
    w[7] = { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0], seed: sd, steps, cfg: 5, sampler_name: "euler", scheduler: "simple", denoise: 1 } };
    w[8] = { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } };
  } else {
    let pos = ["4", 0], neg = ["5", 0], id = 20;
    for (const name of refs) {
      const load = String(id++), scale = String(id++), enc = String(id++), rp = String(id++), rn = String(id++);
      w[load] = { class_type: "LoadImage", inputs: { image: name } };
      w[scale] = { class_type: "ImageScaleToTotalPixels", inputs: { image: [load, 0], upscale_method: "lanczos", megapixels: 1, resolution_steps: 16 } };
      w[enc] = { class_type: "VAEEncode", inputs: { pixels: [scale, 0], vae: ["3", 0] } };
      w[rp] = { class_type: "ReferenceLatent", inputs: { conditioning: pos, latent: [enc, 0] } };
      w[rn] = { class_type: "ReferenceLatent", inputs: { conditioning: neg, latent: [enc, 0] } };
      pos = [rp, 0]; neg = [rn, 0];
    }
    w[10] = { class_type: "DualCFGGuider", inputs: { model: ["1", 0], cond1: pos, cond2: neg, negative: ["5", 0], cfg_conds: 5, cfg_cond2_negative: 2, style: "regular" } };
    w[11] = { class_type: "RandomNoise", inputs: { noise_seed: sd } };
    w[12] = { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } };
    w[13] = { class_type: "BasicScheduler", inputs: { model: ["1", 0], scheduler: "simple", steps, denoise: 1 } };
    w[14] = { class_type: "SamplerCustomAdvanced", inputs: { noise: ["11", 0], guider: ["10", 0], sampler: ["12", 0], sigmas: ["13", 0], latent_image: ["6", 0] } };
    w[8] = { class_type: "VAEDecode", inputs: { samples: ["14", 0], vae: ["3", 0] } };
  }
  w[9] = { class_type: "PreviewImage", inputs: { images: ["8", 0] } };
  return w;
}

// Reference pictures from the website (base64) go to ComfyUI's input folder; returns their names there.
async function uploadRefs(images) {
  const names = [];
  for (const b64 of (images || []).slice(0, 3)) {
    const buf = Buffer.from(String(b64).replace(/^data:[^,]+,/, ""), "base64");
    if (!buf.length || buf.length > 25e6) continue;
    const fd = new FormData();
    fd.append("image", new Blob([buf], { type: "image/png" }), "albatross-" + crypto.randomUUID() + ".png");
    fd.append("overwrite", "true");
    const r = await fetch(COMFY + "/upload/image", { method: "POST", body: fd });
    if (!r.ok) throw new Error("Couldn't hand the picture to ComfyUI (" + r.status + ")");
    names.push((await r.json()).name);
  }
  return names;
}

// Runs one image and reports progress like Ollama does: {completed,total} lines, then {image, done:true}.
async function generate(body, emit, signal, log) {
  const name = isComfy(body.model) ? body.model : MODEL;
  if (!hasPython() || !hasFiles(name)) throw new Error(`${name} isn't fully installed on this PC`);
  await ensureRunning(log);
  const clamp = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Math.round(Number(v) || d)));
  const opts = {
    prompt: String(body.prompt || ""),
    width: clamp(body.width, 256, 2048, 1024) & ~15,
    height: clamp(body.height, 256, 2048, 1024) & ~15,
    steps: clamp(body.steps, 1, 50, name.startsWith("omnigen2") ? 20 : 8),
    seed: body.seed === undefined ? undefined : Number(body.seed),
  };
  const clientId = crypto.randomUUID();
  const ws = new WebSocket(COMFY.replace(/^http/, "ws") + "/ws?clientId=" + clientId);
  await new Promise((ok, fail) => { ws.once("open", ok); ws.once("error", fail); });
  try {
    loaded = true;
    const refs = name.startsWith("omnigen2") ? await uploadRefs(body.images) : [];
    if (refs.length) log(`OmniGen2: editing with ${refs.length} reference picture${refs.length > 1 ? "s" : ""}`);
    const wf = name.startsWith("omnigen2") ? omnigenWorkflow({ ...opts, refs }) : zimageWorkflow(opts);
    const r = await fetch(COMFY + "/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: wf, client_id: clientId }) });
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
          if (m.type === "progress") emit({ model: name, completed: m.data.value, total: m.data.max, done: false });
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
    emit({ model: name, image: png.toString("base64"), done: true });
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
function bytes(model) {
  const m = MODELS[model] || MODELS[MODEL];
  let t = 0;
  for (const [dir, f] of Object.values(m.files)) { try { t += fs.statSync(M(dir, f)).size; } catch {} }
  return t;
}

module.exports = { MODEL, isComfy, models, generate, free, installed, bytes };
