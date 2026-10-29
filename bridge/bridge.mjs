#!/usr/bin/env node
// Agent Web Tweaks 本地桥。
//
// 方向：扩展主动连过来（SSE 长连接），agent 通过 HTTP 调用。
//   GET  /events   扩展订阅命令（text/event-stream）
//   POST /result   扩展回传执行结果
//   POST /call     agent 调用一个工具（同步等结果）
//   GET  /tools    工具清单
//   GET  /health   健康检查
//
// 不依赖任何 npm 包，Node 18+ 直接跑：
//   node bridge/bridge.mjs
import http from "node:http";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const HOST = argOf("host", process.env.AWT_HOST || "127.0.0.1");
const PORT = Number(argOf("port", process.env.AWT_PORT || 8787));
const TOKEN = String(argOf("token", process.env.AWT_TOKEN || "")).trim();
const DEFAULT_TIMEOUT = Number(argOf("timeout", process.env.AWT_TIMEOUT || 120000));
const QUIET = args.includes("--quiet");

const clients = new Set();
const pending = new Map();
let seq = 0;
let startedAt = Date.now();

const log = (...parts) => {
  if (QUIET) return;
  const stamp = new Date().toISOString().slice(11, 19);
  console.error(`[${stamp}]`, ...parts);
};

function cors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type,x-awt-token");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
}

function json(res, status, body) {
  cors(res);
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function authorized(req, url) {
  if (!TOKEN) return true;
  const header = String(req.headers["x-awt-token"] || "");
  const query = String(url.searchParams.get("token") || "");
  return header === TOKEN || query === TOKEN;
}

async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text);
}

function activeClient() {
  let best = null;
  for (const client of clients) {
    if (!best || client.connectedAt > best.connectedAt) best = client;
  }
  return best;
}

/** 给扩展发一条命令，等它回 /result */
function callExtension(tool, toolArgs = {}, timeoutMs = DEFAULT_TIMEOUT) {
  const client = activeClient();
  if (!client) {
    throw new Error("没有扩展连接。请打开 Chrome，加载 agent-web-tweaks 扩展，并在工作台确认「本地桥已连接」。");
  }
  const id = "c" + (++seq) + "-" + randomUUID().slice(0, 6);
  const payload = JSON.stringify({ id, tool, args: toolArgs });
  try {
    client.res.write(`event: call\ndata: ${payload}\n\n`);
  } catch (e) {
    clients.delete(client);
    throw new Error("扩展连接已断开：" + e.message);
  }
  log(`→ ${tool} ${JSON.stringify(toolArgs).slice(0, 180)}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`工具 ${tool} 超时（${Math.round(timeoutMs / 1000)}s）`));
    }, Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT));
    pending.set(id, { resolve, reject, timer, tool, clientId: client.id });
  });
}

function handleEvents(req, res, url) {
  if (!authorized(req, url)) return json(res, 401, { ok: false, error: "token 不正确" });
  cors(res);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ server: "agent-web-tweaks-bridge", version: "0.1.0", pid: process.pid })}\n\n`);

  const client = { id: randomUUID().slice(0, 8), res, connectedAt: Date.now(), info: {} };
  clients.add(client);
  log(`扩展已连接 (${client.id})，当前 ${clients.size} 个连接`);

  const keepalive = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
  }, 15000);

  const cleanup = () => {
    clearInterval(keepalive);
    clients.delete(client);
    for (const [id, item] of [...pending.entries()]) {
      if (item.clientId !== client.id) continue;
      clearTimeout(item.timer);
      pending.delete(id);
      item.reject(new Error("扩展连接已断开"));
    }
    log(`扩展断开 (${client.id})，剩 ${clients.size} 个连接`);
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
  res.on("error", cleanup);
}

async function handleResult(req, res, url) {
  if (!authorized(req, url)) return json(res, 401, { ok: false, error: "token 不正确" });
  const body = await readBody(req);
  const item = pending.get(String(body.id || ""));
  if (!item) return json(res, 200, { ok: true, ignored: true });
  pending.delete(String(body.id || ""));
  clearTimeout(item.timer);
  if (body.ok === false) item.reject(new Error(String(body.error || "执行失败")));
  else item.resolve(body.result);
  json(res, 200, { ok: true });
}

async function handleCall(req, res, url) {
  if (!authorized(req, url)) return json(res, 401, { ok: false, error: "token 不正确" });
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { ok: false, error: "请求体不是合法 JSON：" + e.message });
  }
  const tool = String(body.tool || body.method || "");
  if (!tool) return json(res, 400, { ok: false, error: "缺少 tool" });
  const toolArgs = body.args || body.params || {};
  try {
    const result = await callExtension(tool, toolArgs, body.timeoutMs);
    json(res, 200, { ok: true, tool, result });
  } catch (e) {
    json(res, 200, { ok: false, tool, error: String(e.message || e) });
  }
}

async function handleTools(req, res) {
  try {
    const result = await callExtension("meta.tools", {}, 4000);
    json(res, 200, { ok: true, tools: result.tools || [] });
  } catch (e) {
    json(res, 200, { ok: false, error: String(e.message || e), tools: [] });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    return res.end();
  }
  try {
    if (url.pathname === "/events" && req.method === "GET") return handleEvents(req, res, url);
    if (url.pathname === "/result" && req.method === "POST") return await handleResult(req, res, url);
    if (url.pathname === "/call" && req.method === "POST") return await handleCall(req, res, url);
    if (url.pathname === "/tools" && req.method === "GET") return await handleTools(req, res);
    if (url.pathname === "/hello" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      const client = activeClient();
      if (client) client.info = body;
      log("扩展信息", JSON.stringify(body));
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/health" && req.method === "GET") {
      return json(res, 200, {
        ok: true,
        server: "agent-web-tweaks-bridge",
        version: "0.1.0",
        uptimeMs: Date.now() - startedAt,
        clients: clients.size,
        pending: pending.size,
        client: activeClient() ? activeClient().info : null,
      });
    }
    if (url.pathname === "/" && req.method === "GET") {
      return json(res, 200, {
        ok: true,
        name: "Agent Web Tweaks bridge",
        endpoints: ["GET /events (extension)", "POST /result (extension)", "POST /call (agent)", "GET /tools", "GET /health"],
      });
    }
    json(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

server.requestTimeout = 0;
server.headersTimeout = 0;

server.listen(PORT, HOST, () => {
  log(`Agent Web Tweaks bridge 已启动：http://${HOST}:${PORT}`);
  log(`扩展会自动连过来；agent 用 POST /call 或 bridge/mcp.mjs 调用。`);
  if (TOKEN) log("已启用 token 校验");
});

process.on("SIGINT", () => {
  log("收到 SIGINT，退出");
  for (const client of clients) {
    try { client.res.end(); } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
});

export { callExtension };
