/**
 * comfy.js — ComfyUI 出图客户端（最小可用版）。
 *
 * 提交 txt2img workflow 到本机 ComfyUI（默认 127.0.0.1:8188），轮询执行完成后
 * 返回输出图片的 view URL。ComfyUI 未运行或没有匹配的 checkpoint 时明确报错。
 */

const SAMPLER = "euler";
const SCHEDULER = "normal";

function buildWorkflow({ prompt, negativePrompt, width, height, steps, seed, checkpoint }) {
  return {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps,
        cfg: 7,
        sampler_name: SAMPLER,
        scheduler: SCHEDULER,
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } },
    "5": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: negativePrompt || "", clip: ["4", 1] } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "baihua-dsh" } },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createComfyClient(config) {
  const baseUrl = (config.comfyUrl || "http://127.0.0.1:8188").trim().replace(/\/+$/, "");
  const defaultCheckpoint = config.comfyCheckpoint || "model.safetensors";

  /** 健康检查：ComfyUI 是否在线。 */
  async function status(timeoutMs = 5000) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const res = await fetch(`${baseUrl}/system_stats`, { signal: ac.signal });
      clearTimeout(timer);
      return { ok: res.ok, detail: res.ok ? "comfy online" : `HTTP ${res.status}` };
    } catch {
      return { ok: false, detail: "ComfyUI 未运行或不可达" };
    }
  }

  /**
   * txt2img 出图。轮询等待完成（默认最长 300s），返回输出图片信息。
   * @returns {{ok:boolean, images?:Array<{url:string,filename:string}>, promptId?:string, elapsedMs?:number, error?:string}}
   */
  async function generate({ prompt, negativePrompt = "", width = 512, height = 512, steps = 20, checkpoint, timeoutMs = 300000 }) {
    const seed = Math.floor(Math.random() * 1_000_000_000);
    const workflow = buildWorkflow({
      prompt,
      negativePrompt,
      width: clampInt(width, 256, 2048),
      height: clampInt(height, 256, 2048),
      steps: clampInt(steps, 1, 100),
      seed,
      checkpoint: checkpoint || defaultCheckpoint,
    });

    let res;
    try {
      res = await fetch(`${baseUrl}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: workflow, client_id: `baihua-dsh-${Date.now()}` }),
      });
    } catch {
      return { ok: false, error: "ComfyUI 未运行或不可达（请先启动 ComfyUI）" };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `ComfyUI /prompt 失败（HTTP ${res.status}）：${body.slice(0, 300)}` };
    }
    const { prompt_id } = await res.json().catch(() => ({}));
    if (!prompt_id) return { ok: false, error: "ComfyUI 未返回 prompt_id" };

    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await sleep(2000);
      try {
        const hr = await (await fetch(`${baseUrl}/history/${prompt_id}`)).json();
        const entry = hr?.[prompt_id];
        if (entry?.outputs) {
          const images = [];
          for (const node of Object.values(entry.outputs)) {
            for (const img of node?.images ?? []) {
              const q = new URLSearchParams({
                filename: img.filename,
                subfolder: img.subfolder ?? "",
                type: img.type ?? "output",
              });
              images.push({ url: `${baseUrl}/view?${q.toString()}`, filename: img.filename });
            }
          }
          if (images.length > 0) {
            return { ok: true, images, promptId: prompt_id, elapsedMs: Date.now() - started };
          }
        }
        if (entry?.status?.status_str === "error") {
          return { ok: false, error: "ComfyUI 执行出错（workflow/checkpoint 可能不匹配）", promptId: prompt_id };
        }
      } catch {
        /* 轮询期短暂失败可容忍 */
      }
    }
    return { ok: false, error: "出图超时（请加大 timeoutMs 或检查 ComfyUI）", promptId: prompt_id };
  }

  return { status, generate };
}

function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}
