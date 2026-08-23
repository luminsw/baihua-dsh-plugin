/**
 * smoke.test.mjs — baihua-dsh-plugin 冒烟测试（node:test，无需 DSH 环境）。
 * 覆盖：
 *  - ops.detectRepoRoot / startGitCommitPush 快速失败路径（不执行真实 git 变更）
 *  - comfy.js 高级参数透传与 files 字段语义（mock 网关）
 *  - comfy.js capabilities camelCase 归一化
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createBhOps, detectRepoRoot } from "../src/ops.js";
import { createComfyClient } from "../src/comfy.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("detectRepoRoot 在任意输入下不抛异常", () => {
  let r;
  assert.doesNotThrow(() => {
    r = detectRepoRoot({ bhCommand: "bh", gitRepo: "" });
  });
  assert.ok(r === null || typeof r === "string");
});

test("gitRepo 无效/不存在时 startGitCommitPush 快速失败", () => {
  const ops = createBhOps({ bhCommand: "bh", gitRepo: "C:/definitely/not/a/repo" });
  const r = ops.startGitCommitPush("smoke");
  assert.equal(r.ok, false);
  assert.match(r.error, /不是有效 git 仓库/);
});

test("gitRepo 是子目录而非仓库根时快速失败", () => {
  // 用本仓库的 src 子目录：是 git 仓库内但非根
  const ops = createBhOps({ bhCommand: "bh", gitRepo: join(repoRoot, "src") });
  const r = ops.startGitCommitPush("smoke");
  assert.equal(r.ok, false);
  assert.match(r.error, /不是仓库根/);
});

test("comfy.generate 高级参数透传 + files 字段语义", async () => {
  let received = null;
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ Success: true, FileName: "out.png", ElapsedSeconds: 1.5, FileUrl: "http://x/out.png" }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const comfy = createComfyClient({ drawGatewayUrl: `http://127.0.0.1:${port}` });
  try {
    const r = await comfy.generate({
      prompt: "cat", seed: 42, cfg: 3.5, sampler: "dpmpp_2m", scheduler: "karras",
      unetName: "u.safetensors", clipName: "c.safetensors", vaeName: "v.safetensors",
      modelType: "z-image-turbo",
    });
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.files) && r.files.length === 1 && r.files[0].url === "http://x/out.png");
    assert.equal(received.seed, 42);
    assert.equal(received.cfg, 3.5);
    assert.equal(received.sampler, "dpmpp_2m");
    assert.equal(received.scheduler, "karras");
    assert.equal(received.unetName, "u.safetensors");
    assert.equal(received.clipName, "c.safetensors");
    assert.equal(received.vaeName, "v.safetensors");

    // 不传高级参数：body 不应出现这些字段
    await comfy.generate({ prompt: "dog" });
    for (const k of ["seed", "cfg", "sampler", "scheduler", "unetName"]) assert.ok(!(k in received), `未传参数不应出现 ${k}`);
  } finally {
    srv.close();
  }
});

test("comfy.generateVideo 高级参数透传 + files 字段", async () => {
  let received = null;
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ Success: true, FileName: "out.mp4", ElapsedSeconds: 2, FileUrl: "http://x/out.mp4" }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const comfy = createComfyClient({ drawGatewayUrl: `http://127.0.0.1:${port}` });
  try {
    const r = await comfy.generateVideo({ prompt: "cat", seed: 7, cfg: 4.5, sampler: "euler_ancestral", scheduler: "normal" });
    assert.equal(r.ok, true);
    assert.equal(r.files[0].url, "http://x/out.mp4");
    assert.equal(received.seed, 7);
    assert.equal(received.cfg, 4.5);
    assert.equal(received.sampler, "euler_ancestral");
  } finally {
    srv.close();
  }
});

test("comfy.status 将后端 PascalCase 归一化为 camelCase", async () => {
  const srv = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ComfyOnline: true, Image: true, Video: true, UnetModels: ["z_image_turbo_bf16.safetensors"], ClipModels: [], VaeModels: [] }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const comfy = createComfyClient({ drawGatewayUrl: `http://127.0.0.1:${port}` });
  try {
    const s = await comfy.status(3000);
    assert.equal(s.ok, true);
    assert.equal(s.detail.comfyOnline, true);
    assert.deepEqual(s.detail.unetModels, ["z_image_turbo_bf16.safetensors"]);
  } finally {
    srv.close();
  }
});
