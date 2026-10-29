#!/usr/bin/env node
// 不想接 MCP 的 agent 可以直接用这个 CLI（或 curl）：
//   node bridge/cli.mjs tools
//   node bridge/cli.mjs call rules.list '{"url":"https://example.com"}'
//   node bridge/cli.mjs call rules.save @rule.json
import fs from "node:fs";

const BRIDGE = String(process.env.AWT_BRIDGE || "http://127.0.0.1:8787").replace(/\/+$/, "");
const TOKEN = String(process.env.AWT_TOKEN || "");

function parseArgs(raw) {
  if (!raw) return {};
  if (raw.startsWith("@")) return JSON.parse(fs.readFileSync(raw.slice(1), "utf8"));
  return JSON.parse(raw);
}

const [command, tool, argText] = process.argv.slice(2);

async function main() {
  if (!command || command === "help" || command === "--help") {
    console.log(`用法：
  node bridge/cli.mjs tools
  node bridge/cli.mjs health
  node bridge/cli.mjs call <tool> [jsonArgs]
  node bridge/cli.mjs call <tool> @args.json

常用：
  node bridge/cli.mjs call meta.status
  node bridge/cli.mjs call page.context
  node bridge/cli.mjs call rules.list '{"url":"https://example.com"}'
  node bridge/cli.mjs call rules.save '{"rule":{"id":"hide-nav","name":"隐藏导航","match":["https://example.com/*"],"css":".nav{display:none!important}"},"apply":true}'`);
    return;
  }

  const headers = { ...(TOKEN ? { "x-awt-token": TOKEN } : {}) };

  if (command === "health") {
    const resp = await fetch(BRIDGE + "/health", { headers });
    console.log(JSON.stringify(await resp.json(), null, 2));
    return;
  }

  if (command === "tools") {
    const resp = await fetch(BRIDGE + "/tools", { headers });
    console.log(JSON.stringify(await resp.json(), null, 2));
    return;
  }

  if (command === "call") {
    if (!tool) throw new Error("缺少工具名");
    const body = { tool, args: parseArgs(argText), timeoutMs: Number(process.env.AWT_TIMEOUT || 180000) };
    const resp = await fetch(BRIDGE + "/call", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    console.log(JSON.stringify(data, null, 2));
    if (!data.ok) process.exitCode = 1;
    return;
  }

  throw new Error("未知命令：" + command);
}

main().catch((e) => {
  console.error(String((e && e.stack) || e));
  process.exitCode = 1;
});
