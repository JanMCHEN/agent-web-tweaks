#!/usr/bin/env node
// 把本地桥暴露成 MCP server（stdio），任何支持 MCP 的 agent 都能直接用。
//
// Claude Code:  claude mcp add web-tweaks -- node /绝对路径/agent-web-tweaks/bridge/mcp.mjs
// Codex / 其它:  在 mcpServers 里配置同样的 command + args
//
// 不依赖 npm 包，只用 Node 18+ 内置能力。
import { TOOL_DEFS } from "../src/shared/tools.js";

const BRIDGE = String(process.env.AWT_BRIDGE || "http://127.0.0.1:8787").replace(/\/+$/, "");
const TOKEN = String(process.env.AWT_TOKEN || "");
const VERSION = "0.1.0";
const CALL_TIMEOUT_MS = Number(process.env.AWT_MCP_TIMEOUT || 180000);

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function failure(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function bridgeCall(tool, args) {
  const resp = await fetch(BRIDGE + "/call", {
    method: "POST",
    headers: { "content-type": "application/json", ...(TOKEN ? { "x-awt-token": TOKEN } : {}) },
    body: JSON.stringify({ tool, args: args || {}, timeoutMs: CALL_TIMEOUT_MS }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const data = await resp.json().catch(() => null);
  if (!data) throw new Error("本地桥返回了非 JSON 响应");
  if (!data.ok) throw new Error(data.error || "调用失败");
  return data.result;
}

function toContent(value) {
  if (value && typeof value === "object" && typeof value.dataUrl === "string" && value.dataUrl.startsWith("data:image/")) {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(value.dataUrl);
    if (match) {
      const { dataUrl, ...rest } = value;
      return [
        { type: "text", text: JSON.stringify(rest, null, 2) },
        { type: "image", data: match[2], mimeType: match[1] },
      ];
    }
  }
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    if (method === "initialize") {
      result(id, {
        protocolVersion: (params && params.protocolVersion) || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-web-tweaks", version: VERSION },
        instructions:
          "这些工具操作本机 Chrome 里的网页定制规则。写规则时用 CSS 或 JS（tweak SDK：tweak.$ / tweak.$$ / tweak.waitFor / tweak.observe / tweak.css / tweak.onCleanup / tweak.ready / tweak.onRoute / tweak.store / tweak.log），match 用 URL 通配符（如 https://example.com/*）。先 page.context 看页面，再 rules.save 并 apply。",
      });
      return;
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") return;
    if (method === "ping") {
      if (!isNotification) result(id, {});
      return;
    }
    if (method === "tools/list") {
      result(id, { tools: TOOL_DEFS });
      return;
    }
    if (method === "tools/call") {
      const name = String((params && params.name) || "");
      const args = (params && params.arguments) || {};
      if (!TOOL_DEFS.some((t) => t.name === name)) {
        failure(id, -32602, "未知工具：" + name);
        return;
      }
      try {
        const value = await bridgeCall(name, args);
        result(id, { content: toContent(value), isError: false });
      } catch (e) {
        result(id, { content: [{ type: "text", text: String(e.message || e) }], isError: true });
      }
      return;
    }
    if (method === "resources/list") {
      result(id, { resources: [] });
      return;
    }
    if (method === "prompts/list") {
      result(id, { prompts: [] });
      return;
    }
    if (!isNotification) failure(id, -32601, "不支持的方法：" + method);
  } catch (e) {
    if (!isNotification) failure(id, -32603, String((e && e.message) || e));
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));

process.on("unhandledRejection", (e) => {
  process.stderr.write("[web-tweaks-mcp] " + String((e && e.stack) || e) + "\n");
});

process.stderr.write("[web-tweaks-mcp] ready → " + BRIDGE + "\n");
