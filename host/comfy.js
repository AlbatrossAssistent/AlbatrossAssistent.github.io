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
const { spawn, execFile } = require("child_process");
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
  // Qwen-Image 2.1 (7B, 4-bit GGUF): makes pictures and edits them from reference pictures. Listed before OmniGen2,
  // so it's the one used for edits when both are installed. Needs the GGUF add-on to know "qwen_image21" (patched in loader.py).
  "qwen-image-2.1:comfyui": {
    files: { unet: ["unet", "qwen-image-2.1-Ultra.gguf"], clip: ["text_encoders", "qwen3vl_8b_int8_convrot.safetensors"], vae: ["vae", "qwen_image_2.1_vae_bf16.safetensors"] },
    details: { family: "qwen-image", parameter_size: "7B", format: "comfyui", edit: true },
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

let starting = null, child = null;
const alive = () => child && child.exitCode === null && !child.killed;
function ensureRunning(log, status = () => {}) {
  if (starting) return starting;
  starting = (async () => {
    if (await up()) return;
    // still starting from an earlier request (from a slow disk this takes minutes): wait for it, don't start a second one
    if (!alive()) {
      log("Starting ComfyUI for image generation…");
      const out = fs.openSync(path.join(__dirname, "comfyui.log"), "a");
      child = spawn(path.join(COMFY_DIR, "python_embeded", "python.exe"),
        ["-s", path.join("ComfyUI", "main.py"), "--windows-standalone-build", "--listen", "127.0.0.1", "--port", new URL(COMFY).port || "8188", "--disable-auto-launch",
         // keep the image model and its text encoder on the graphics card between pictures: the text encoder is stored
         // in 8-bit (half the memory, barely any quality difference) so both fit in 12 GB and nothing gets swapped out
         "--fp8_e4m3fn-text-enc", "--highvram",
         // pinning 6+ GB of RAM squeezes a 16 GB PC into swapping while a model loads
         // (don't add --disable-mmap: it reads whole model files into RAM first, which is far worse with 16 GB)
         "--disable-pinned-memory",
         // keep the loaded model between pictures: the default cache drops it whenever RAM runs low (always, with 16 GB),
         // and every picture then reloads ~10 GB from disk
         "--cache-classic"],
        { cwd: COMFY_DIR, detached: true, stdio: ["ignore", out, out], windowsHide: true });
      child.on("error", () => {});
      child.unref();
    }
    for (let i = 0; i < 600; i++) {
      if (await up()) { log("ComfyUI is running"); return; }
      if (i % 5 === 0) status(`Starting the picture engine… ${i ? i + " s" : ""}`.trim());
      if (child && !alive() && i > 5) throw new Error("ComfyUI stopped while starting (see host/comfyui.log)");
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("ComfyUI didn't start within 10 minutes (see host/comfyui.log)");
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

// Qwen-Image 2.1, as in ComfyUI's own template: its text encoder (Qwen3-VL-8B) also reads the reference pictures,
// and hands out the conditioning and, for edits, a latent the size of the first reference. 25 steps, CFG 1.
function qwenWorkflow({ prompt, width = 1024, height = 1024, steps = 25, seed, refs = [] }) {
  const F = MODELS["qwen-image-2.1:comfyui"].files;
  const w = {
    1: { class_type: "UnetLoaderGGUF", inputs: { unet_name: F.unet[1] } },
    2: { class_type: "CLIPLoader", inputs: { clip_name: F.clip[1], type: "qwen_image", device: "default" } },
    3: { class_type: "VAELoader", inputs: { vae_name: F.vae[1] } },
    4: { class_type: "TextEncodeQwenImage21", inputs: { clip: ["2", 0], prompt, negative_prompt: "", vae: ["3", 0], resolution: 1024 } },
    5: { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
  };
  refs.forEach((name, k) => { const id = String(20 + k); w[id] = { class_type: "LoadImage", inputs: { image: name } }; w[4].inputs[`images.image_${k + 1}`] = [id, 0]; });
  const sd = Number.isFinite(seed) ? seed : crypto.randomInt(2 ** 47);
  w[6] = { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["4", 0], negative: ["4", 1], latent_image: refs.length ? ["4", 2] : ["5", 0], seed: sd, steps, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } };
  w[7] = { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["3", 0] } };
  w[9] = { class_type: "PreviewImage", inputs: { images: ["7", 0] } };
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
  const t0 = Date.now();
  const status = (text) => emit({ model: name, status: text, done: false });
  await ensureRunning(log, status);
  const clamp = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Math.round(Number(v) || d)));
  const opts = {
    prompt: String(body.prompt || ""),
    width: clamp(body.width, 256, 2048, 1024) & ~15,
    height: clamp(body.height, 256, 2048, 1024) & ~15,
    steps: clamp(body.steps, 1, 50, name.startsWith("qwen-image") ? 25 : name.startsWith("omnigen2") ? 20 : 8),
    seed: body.seed === undefined ? undefined : Number(body.seed),
  };
  const clientId = crypto.randomUUID();
  const ws = new WebSocket(COMFY.replace(/^http/, "ws") + "/ws?clientId=" + clientId);
  await new Promise((ok, fail) => { ws.once("open", ok); ws.once("error", fail); });
  try {
    loaded = true; lastModel = name;
    const refs = MODELS[name].details.edit ? await uploadRefs(body.images) : [];
    if (refs.length) log(`${name.split(":")[0]}: editing with ${refs.length} reference picture${refs.length > 1 ? "s" : ""}`);
    const wf = name.startsWith("qwen-image") ? qwenWorkflow({ ...opts, refs }) : name.startsWith("omnigen2") ? omnigenWorkflow({ ...opts, refs }) : zimageWorkflow(opts);
    const r = await fetch(COMFY + "/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: wf, client_id: clientId }) });
    const j = await r.json();
    if (!r.ok || !j.prompt_id) throw new Error(j.error?.message || JSON.stringify(j.node_errors || j).slice(0, 300));
    const id = j.prompt_id;
    let drawing = false;
    const beat = setInterval(() => { if (!drawing) status(`Loading ${name.split(":")[0]} from disk… ${Math.round((Date.now() - t0) / 1000)} s`); }, 3000);
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
          if (m.type === "progress") drawing = true;
          if (m.type === "progress") emit({ model: name, completed: m.data.value, total: m.data.max, done: false });
          else if (m.type === "execution_error") fail(new Error(m.data.exception_message || "ComfyUI error"));
          else if (m.type === "execution_interrupted") fail(Object.assign(new Error("Stopped"), { name: "AbortError" }));
          else if (m.type === "executing" && m.data.node === null) ok();
          else if (m.type === "execution_success") ok();
        });
        ws.on("close", () => fail(new Error("Lost connection to ComfyUI")));
        signal?.addEventListener("abort", () => fail(Object.assign(new Error("Stopped"), { name: "AbortError" })));
      });
    } finally { signal?.removeEventListener("abort", onAbort); clearInterval(beat); }
    // ComfyUI says "finished" a moment before it files the result in its history: ask again for a few seconds
    let img = null;
    for (let i = 0; i < 40 && !img; i++) {
      const hist = (await (await fetch(COMFY + "/history/" + id)).json())[id];
      img = Object.values(hist?.outputs || {}).flatMap((o) => o.images || [])[0];
      if (!img) await new Promise((r) => setTimeout(r, 250));
    }
    if (!img) throw new Error("ComfyUI didn't return an image");
    const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || "", type: img.type || "temp" });
    const png = Buffer.from(await (await fetch(COMFY + "/view?" + q)).arrayBuffer());
    emit({ model: name, image: png.toString("base64"), done: true });
  } finally { ws.close(); }
}

// A ComfyUI started with older settings (by an earlier version of the host) is stopped while it's idle,
// so the next picture starts it with the current ones.
const FLAGS = ["--disable-pinned-memory", "--cache-classic"], NOT = ["--disable-mmap"];
const ps = (cmd) => new Promise((res) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd],
  { windowsHide: true, timeout: 15000 }, (e, out) => res(String(out || "").trim())));
const COMFY_PROC = "Get-CimInstance Win32_Process -Filter \"name='python.exe'\" | Where-Object { $_.CommandLine -like '*ComfyUI*main.py*' }";

// Newest change to an add-on's own code (custom_nodes/<add-on>/*.py), so a patched add-on gets picked up.
function addonsChanged() {
  let newest = 0;
  const dir = path.join(COMFY_DIR, "ComfyUI", "custom_nodes");
  try {
    for (const a of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!a.isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(dir, a.name))) if (f.endsWith(".py")) newest = Math.max(newest, fs.statSync(path.join(dir, a.name, f)).mtimeMs);
    }
  } catch {}
  return newest;
}

async function retireOutdated(log) {
  if (process.platform !== "win32" || !(await up())) return;
  try {
    const argv = (await (await fetch(COMFY + "/system_stats")).json()).system?.argv || [];
    const flagsOk = FLAGS.every((f) => argv.includes(f)) && !NOT.some((f) => argv.includes(f));
    const started = Date.parse(await ps(`(${COMFY_PROC} | Select-Object -First 1).CreationDate.ToString('o')`));
    const addonsOk = !Number.isFinite(started) || addonsChanged() < started;
    if (flagsOk && addonsOk) return;
    const q = await (await fetch(COMFY + "/queue")).json();
    if (q.queue_running?.length || q.queue_pending?.length) return;
    await ps(`${COMFY_PROC} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);
    log(flagsOk ? "Restarted ComfyUI so it picks up its updated add-ons (it starts again with the next picture)"
      : "Restarted ComfyUI with faster loading settings (it starts again with the next picture)");
  } catch {}
}

// Loads a model ahead of time (the website asks when you pick a picture model): a tiny 1-step picture
// pulls everything from disk onto the graphics card, so the real one starts drawing right away.
let warmingUp = null;
function warm(model, log) {
  if (warmingUp || (loaded && lastModel === model)) return;
  log(`Getting ${model} ready`);
  warmingUp = generate({ model, prompt: "a plain grey background", width: 256, height: 256, steps: 1 }, () => {}, null, log)
    .then(() => log(`${model} is ready`), (e) => log(`Couldn't get ${model} ready: ${e.message}`))
    .finally(() => { warmingUp = null; });
}

// Frees ComfyUI's GPU memory (used by the "Free GPU memory" buttons). Does nothing if it isn't running.
// Returns true if it had made an image since the last free (so there's something worth reporting).
let loaded = false, lastModel = "";
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

module.exports = { MODEL, isComfy, models, generate, free, installed, bytes, warm, retireOutdated };
