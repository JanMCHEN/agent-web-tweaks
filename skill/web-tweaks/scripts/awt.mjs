#!/usr/bin/env node
// Agent Web Tweaks 的命令行入口（skill 用，不需要 MCP）。
//
//   awt status                     桥 + 扩展连接 + 扩展状态
//   awt up / down                  起 / 停本地桥（后台进程）
//   awt tools                      列出工具
//   awt call <tool> [json|@file]   调任意工具
//   awt context [tabId]            当前页面上下文
//   awt pick                       让用户在页面上点一个元素
//   awt screenshot [--out file]    截当前可见区域并落盘
//   awt save @rule.json            写入并应用一条规则
//   awt rules [url]                列规则（给 url 时标出命中）
//
// 地址优先级：AWT_BRIDGE > awt.config.json 的 bridge > http://127.0.0.1:8787
// 仓库位置：AWT_HOME > awt.config.json 的 home > 相对本文件向上两级
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, "..");
const STATE_DIR = path.join(os.homedir(), ".agent-web-tweaks");
const PID_FILE = path.join(STATE_DIR, "bridge.pid");
const LOG_FILE = path.join(STATE_DIR, "bridge.log");

function readConfig() {
  const candidates = [
    process.env.AWT_CONFIG,
    path.join(SKILL_DIR, "awt.config.json"),
    path.join(STATE_DIR, "config.json"),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {}
  }
  return {};
}

const CONFIG = readConfig();
const HOME = process.env.AWT_HOME || CONFIG.home || path.resolve(SKILL_DIR, "../..");
const BRIDGE = String(process.env.AWT_BRIDGE || CONFIG.bridge || "http://127.0.0.1:8787").replace(/\/+$/, "");
const TOKEN = String(process.env.AWT_TOKEN || CONFIG.token || "");
const TIMEOUT = Number(process.env.AWT_TIMEOUT || 180000);

const HELP = `用法：
  awt status                     桥 + 扩展连接 + 扩展状态
  awt up / down                  起 / 停本地桥（后台进程）
  awt tools                      列出工具
  awt call <tool> [json|@file]   调任意工具（会自动确保桥在跑）
  awt context [tabId]            当前页面上下文
  awt pick                       让用户在页面上点一个元素
  awt screenshot [--out file]    截当前可见区域并落盘
  awt save @rule.json            写入并应用一条规则
  awt rules [url]                列规则（给 url 时标出命中）

环境变量：
  AWT_HOME     agent-web-tweaks 仓库路径
  AWT_BRIDGE   桥地址（默认 http://127.0.0.1:8787）
  AWT_TOKEN    与桥一致的 token（如果设置了）
  AWT_TIMEOUT  单次调用超时 ms（默认 180000）`;

const args = process.argv.slice(2);
const command = args[0] || "help";
const flags = new Set(args.filter((a) => a.startsWith("--")));
const rest = args.slice(1).filter((a) => !a.startsWith("--"));
const flagValue = (name, fallback = "") => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

async function http(pathname, options = {}) {
  const url = BRIDGE + pathname;
  let resp;
  try {
    resp = await fetch(url, {
      method: options.method || "GET",
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(TOKEN ? { "x-awt-token": TOKEN } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeout || 15000),
    });
  } catch (e) {
    const err = new Error(`连不上本地桥 ${BRIDGE}（${e.message}）`);
    err.code = "NO_BRIDGE";
    throw err;
  }
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: resp.status, data };
}

async function health() {
  try {
    const { data } = await http("/health", { timeout: 2500 });
    return data && data.ok ? data : null;
  } catch {
    return null;
  }
}

async function ensureBridge() {
  const now = await health();
  if (now) return now;
  const bridgeFile = path.join(HOME, "bridge/bridge.mjs");
  if (!fs.existsSync(bridgeFile)) {
    die(`找不到 ${bridgeFile}。请设置 AWT_HOME 指向 agent-web-tweaks 仓库，或在 awt.config.json 里写 "home"。`);
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const out = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [bridgeFile, "--quiet"], {
    cwd: HOME,
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 120));
    const h = await health();
    if (h) return h;
  }
  die(`本地桥启动超时，日志：${LOG_FILE}`);
}

async function call(tool, toolArgs = {}, { autoUp = true, timeout = TIMEOUT } = {}) {
  if (autoUp) await ensureBridge();
  const { data } = await http("/call", { method: "POST", body: { tool, args: toolArgs, timeoutMs: timeout }, timeout: timeout + 5000 });
  if (!data) die("本地桥返回了空响应");
  if (!data.ok) {
    const hint = /没有扩展连接/.test(String(data.error))
      ? "\n提示：先在 Chrome 里加载 agent-web-tweaks 扩展（chrome://extensions → 加载已解压的扩展程序），并打开「允许用户脚本」。"
      : "";
    die(`工具 ${tool} 失败：${data.error}${hint}`);
  }
  return data.result;
}

function print(value) {
  if (value === undefined) return console.log("ok");
  if (typeof value === "string") return console.log(value);
  console.log(JSON.stringify(value, null, 2));
}

function parseArgs(raw) {
  if (!raw) return {};
  if (raw.startsWith("@")) {
    const file = raw.slice(1);
    if (!fs.existsSync(file)) die(`参数文件不存在：${file}`);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  try {
    return JSON.parse(raw);
  } catch {
    die(`参数不是合法 JSON：${raw}`);
  }
}

async function cmdStatus() {
  const h = await health();
  if (!h) {
    console.log(JSON.stringify({ bridge: "down", url: BRIDGE, log: LOG_FILE }, null, 2));
    console.log("\n桥没起来，运行：node scripts/awt.mjs up");
    process.exitCode = 2;
    return;
  }
  const summary = { bridge: "up", url: BRIDGE, clients: h.clients, pending: h.pending };
  if (!h.clients) {
    summary.extension = "disconnected";
    summary.hint = "扩展没连上：在 Chrome 里加载 agent-web-tweaks，并打开「允许用户脚本」";
  } else {
    summary.extension = "connected";
    try {
      const meta = await call("meta.status", {}, { autoUp: false, timeout: 8000 });
      summary.version = meta.version;
      summary.userScripts = meta.userScripts;
      summary.rules = meta.rules;
      summary.tabs = meta.tabs;
      if (!meta.userScripts) summary.hint = "JS 规则未生效：chrome://extensions → 扩展详情 → 允许用户脚本";
    } catch (e) {
      summary.metaError = e.message;
    }
  }
  console.log(JSON.stringify(summary, null, 2));
}

async function cmdUp() {
  await ensureBridge();
  // 扩展会自己连过来，给它一点时间，别立刻报「没连上」
  let h = await health();
  for (let i = 0; i < 12 && h && !h.clients; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    h = (await health()) || h;
  }
  console.log(`本地桥已就绪：${BRIDGE}（clients=${h ? h.clients : 0}）`);
  if (!h || !h.clients) console.log("扩展还没连上：在 Chrome 里加载 agent-web-tweaks 扩展并打开「允许用户脚本」。");
}

function cmdDown() {
  let pid = 0;
  try { pid = Number(fs.readFileSync(PID_FILE, "utf8")); } catch {}
  if (!pid) {
    console.log("没有记录到桥进程（可能不是本脚本启动的）");
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    fs.unlinkSync(PID_FILE);
    console.log(`已停止桥进程 ${pid}`);
  } catch (e) {
    console.log(`停止失败：${e.message}`);
  }
}

async function cmdTools() {
  const h = await ensureBridge();
  if (!h.clients) die("扩展未连接，先加载扩展。");
  const out = await call("meta.tools", {}, { autoUp: false });
  for (const t of out.tools || []) console.log(`${t.name.padEnd(16)} ${t.description}`);
}

async function cmdContext() {
  const tabId = rest[0] ? Number(rest[0]) : undefined;
  print(await call("page.context", tabId == null ? {} : { tabId }));
}

async function cmdRules() {
  const url = rest[0] || flagValue("url", "");
  print(await call("rules.list", url ? { url } : {}));
}

async function cmdPick() {
  console.error("请在页面上点选要定制的元素（Esc 取消）…");
  print(await call("page.pick", {}, { timeout: 180000 }));
}

async function cmdScreenshot() {
  const out = flagValue("out") || path.join(process.cwd(), `awt-shot-${Date.now()}.png`);
  const result = await call("page.screenshot", rest[0] ? { tabId: Number(rest[0]) } : {});
  const match = /^data:image\/([a-z0-9.+-]+);base64,(.*)$/is.exec(String(result.dataUrl || ""));
  if (!match) die("截图结果不是 data URL");
  fs.writeFileSync(out, Buffer.from(match[2], "base64"));
  console.log(JSON.stringify({ file: path.resolve(out), bytes: fs.statSync(out).size, url: result.url }, null, 2));
}

async function cmdSave() {
  const raw = rest[0];
  if (!raw) die("用法：awt save @rule.json 或 awt save '{\"rule\":{...}}'");
  const parsed = parseArgs(raw);
  const body = parsed && parsed.rule ? parsed : { rule: parsed, apply: !flags.has("--no-apply") };
  print(await call("rules.save", body));
}

async function main() {
  switch (command) {
    case "status": return await cmdStatus();
    case "up": return await cmdUp();
    case "down": return cmdDown();
    case "tools": return await cmdTools();
    case "call": {
      if (!rest[0]) die("用法：awt call <tool> [json|@file]");
      return print(await call(rest[0], parseArgs(rest[1]), { autoUp: !flags.has("--no-auto-up") }));
    }
    case "context": return await cmdContext();
    case "rules": return await cmdRules();
    case "pick": return await cmdPick();
    case "screenshot": return await cmdScreenshot();
    case "save": return await cmdSave();
    case "help":
    case "--help":
    case "-h":
      return console.log(HELP);
    default:
      die(`未知命令：${command}\n运行 awt help 看用法`);
  }
}

main().catch((e) => {
  if (e && e.code === "NO_BRIDGE") die(e.message + "\n先运行：node scripts/awt.mjs up");
  die(String((e && e.message) || e));
});
