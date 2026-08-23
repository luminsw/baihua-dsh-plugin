/**
 * comfy.js — 绘图客户端（经百花算力池绘图网关）。
 *
 * 不再直连本机 ComfyUI：由目标百花机器的 Family 网关（/mg/pool/v1/draw/*）代调本地 ComfyUI，
 * 从而支持跨机互调（本机 DSH 默认走本机 family；配了 drawGatewayUrl 则调用对应百花节点）。
 * 支持文生图（txt2img）与文生视频（txt2video，LTX）。
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headersFor(token) {
  const h = { "Content-Type": "application/json" };
  if (token) h["X-Server-Token"] = token;
  return h;
}

export function createComfyClient(config) {
  // 支持传 config 对象或 getter（设置页表单改了即时生效）
  const cfg = () => (typeof config === "function" ? config() : config);
  const gatewayUrl = () => (cfg().drawGatewayUrl || cfg().familyUrl || "http://127.0.0.1:8788")
    .trim().replace(/\/+$/, "");
  const token = () => cfg().drawToken || "";
  const defaultModelType = () => normalizeModelType(cfg().comfyModelType || "z-image-turbo");

  /** 绘图能力查询（ComfyUI 在线 + 支持图像/视频）。返回的 detail 统一 camelCase 键。 */
  async function status(timeoutMs = 6000) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const res = await fetch(`${gatewayUrl()}/mg/pool/v1/draw/capabilities`, {
        signal: ac.signal,
        headers: token() ? { "X-Server-Token": token() } : {},
      });
      clearTimeout(timer);
      if (!res.ok) return { ok: false, detail: `绘图网关 HTTP ${res.status}` };
      const j = await res.json();
      // 后端序列化为 PascalCase，统一转 camelCase 再返回（避免消费方大小写踩坑）
      const cap = {};
      for (const [k, v] of Object.entries(j)) cap[k[0].toLowerCase() + k.slice(1)] = v;
      return { ok: true, detail: cap };
    } catch {
      return { ok: false, detail: "绘图网关不可达（检查 drawGatewayUrl 与目标百花是否在线）" };
    }
  }

  /** 文生图。经网关提交并等待完成，返回输出文件访问 URL。 */
  async function generate({
    prompt,
    negativePrompt = "",
    width,
    height,
    steps,
    seed,
    cfg,
    sampler,
    scheduler,
    checkpoint,
    unetName,
    clipName,
    vaeName,
    modelType,
    timeoutMs = 300000,
    gatewayBase,      // 跨机：指定目标节点网关（如 http://192.168.3.9:8788）
    gatewayToken,     // 跨机：目标节点网关 token
  }) {
    const mt = normalizeModelType(modelType || defaultModelType());
    const isTurbo = mt === "z-image-turbo";
    const w = clampInt(width || (isTurbo ? 1024 : 512), 256, 1024);
    const h = clampInt(height || (isTurbo ? 1024 : 512), 256, 1024);
    const st = clampInt(steps || (isTurbo ? 8 : 20), 1, 100);
    const body = {
      prompt,
      negativePrompt: negativePrompt || undefined,
      width: w,
      height: h,
      steps: st,
      modelType: mt,
      ...(seed != null ? { seed } : {}),
      ...(cfg != null ? { cfg } : {}),
      ...(sampler ? { sampler } : {}),
      ...(scheduler ? { scheduler } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      ...(unetName ? { unetName } : {}),
      ...(clipName ? { clipName } : {}),
      ...(vaeName ? { vaeName } : {}),
    };
    const r = await callGateway("/mg/pool/v1/draw/image", body, timeoutMs, { gatewayBase, gatewayToken });
    return r.ok ? { ...r, modelType: mt, width: w, height: h, steps: st } : r;
  }

  /** 文生视频（LTX）。经网关提交并等待完成，返回输出文件访问 URL。 */
  async function generateVideo({
    prompt,
    negativePrompt = "",
    width = 512,
    height = 512,
    length = 97,
    fps = 25,
    steps = 20,
    seed,
    cfg,
    sampler,
    scheduler,
    checkpoint,
    timeoutMs = 360000,
    gatewayBase,
    gatewayToken,
  }) {
    const body = {
      prompt,
      negativePrompt: negativePrompt || undefined,
      width: clampInt(width, 256, 768),
      height: clampInt(height, 256, 768),
      length: clampInt(length, 25, 121),
      fps: clampInt(fps, 1, 60),
      steps: clampInt(steps, 1, 100),
      ...(seed != null ? { seed } : {}),
      ...(cfg != null ? { cfg } : {}),
      ...(sampler ? { sampler } : {}),
      ...(scheduler ? { scheduler } : {}),
      ...(checkpoint ? { checkpoint } : {}),
    };
    return await callGateway("/mg/pool/v1/draw/video", body, timeoutMs, { gatewayBase, gatewayToken });
  }

  async function callGateway(path, body, timeoutMs, gw = {}) {
    let res;
    const base = (gw.gatewayBase || gatewayUrl()).replace(/\/+$/, "");
    const tok = gw.gatewayToken !== undefined ? gw.gatewayToken : token();
    try {
      res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: headersFor(tok),
        body: JSON.stringify(body),
      });
    } catch (e) {
      return { ok: false, error: "绘图网关不可达（检查 drawGatewayUrl 与目标百花是否在线）" };
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `绘图网关失败（HTTP ${res.status}）：${JSON.stringify(data).slice(0, 300)}` };
    if (!data.Success) return { ok: false, error: data.Error || "生成失败", elapsedMs: (data.ElapsedSeconds ?? 0) * 1000 };
    const url = data.FileUrl || `${base}/mg/pool/v1/draw/file?filename=${encodeURIComponent(data.FileName || "")}`;
    return {
      ok: true,
      // 输出文件统一叫 files（图片/视频通用，语义正确）
      files: [{ url, filename: data.FileName }],
      elapsedMs: (data.ElapsedSeconds ?? 0) * 1000,
      gatewayUrl: base,
    };
  }

  return { status, generate, generateVideo, gatewayUrl: gatewayUrl() };
}

function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeModelType(v) {
  const s = String(v || "").trim().toLowerCase();
  return ["z-image-turbo", "zimage-turbo", "z_image_turbo", "z-image", "zimage"].includes(s)
    ? "z-image-turbo"
    : "sd15";
}
