// 自测：纯函数 + 本地桥 + MCP 协议。跑法：node tests/run.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeRule, validateRule, ruleMatches, sortRules, globToRegExpSource, dedupeRules,
} from "../src/shared/core.js";
import { buildRuleScript } from "../src/shared/runtime.js";
import { TOOL_DEFS } from "../src/shared/tools.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    console.log(`  ✗ ${name}\n    实际: ${JSON.stringify(actual)}\n    期望: ${JSON.stringify(expected)}`);
  }
}

function ok(name, condition) {
  check(name, !!condition, true);
}

console.log("· 规则模型");
check("glob 补协议", globToRegExpSource("example.com/*"), "^.*://example\\.com/.*$");
ok("命中", ruleMatches({ match: ["https://example.com/*"] }, "https://example.com/a/b"));
ok("不命中", !ruleMatches({ match: ["https://example.com/*"] }, "https://other.com/a"));
ok("排除生效", !ruleMatches({ match: ["*://*.example.com/*"], exclude: ["*://admin.example.com/*"] }, "https://admin.example.com/x"));
check("normalize 补协议", normalizeRule({ id: "r1", name: "r", match: ["example.com/*"], css: "a{}" }).match, ["*://example.com/*"]);
check("校验通过", validateRule(normalizeRule({ id: "r1", name: "r", match: ["a.com"], css: "a{}" })), []);
ok("空内容校验失败", validateRule(normalizeRule({ id: "r1", name: "r", match: ["a.com"] })).length > 0);
check("排序", sortRules([{ id: "b", order: 20 }, { id: "a", order: 10 }, { id: "c", order: 10 }]).map((x) => x.id), ["a", "c", "b"]);
check("去重", dedupeRules([{ id: "x", name: "a", match: ["a.com"], css: "a{}" }, { id: "x", name: "b", match: ["a.com"], css: "a{}" }]).length, 1);
ok("中文名有唯一 id", normalizeRule({ name: "中文" }).id.startsWith("rule-"));
ok("规则脚本可编译", (() => { new Function(buildRuleScript({ id: "m", match: ["*://*/*"], js: "tweak.log(1)", enabled: true }, {}, "USER_SCRIPT")); return true; })());
ok("MAIN 脚本可编译", (() => { new Function(buildRuleScript({ id: "m2", match: ["*://*/*"], js: "await tweak.waitFor('.x');" }, {}, "MAIN")); return true; })());
ok("脚本带世界标记", buildRuleScript({ id: "m3", match: [], js: "" }, {}, "MAIN").includes('const WORLD = "MAIN"'));
check("工具数量", TOOL_DEFS.length, 18);

// ---------- 本地桥 ----------
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const bridge = spawn(process.execPath, [path.join(root, "bridge/bridge.mjs"), "--port", String(PORT), "--quiet"], { stdio: ["ignore", "ignore", "pipe"] });
bridge.stderr.on("data", (d) => process.env.AWT_VERBOSE && process.stderr.write(d));

async function waitHealth() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const r = await fetch(BASE + "/health");
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("桥没有启动");
}

function parseSse(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  (async () => {
    try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const evt = { event: "message", data: "" };
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) evt.event = line.slice(6).trim();
          else if (line.startsWith("data:")) evt.data += line.slice(5).trim();
        }
        if (evt.data) onEvent(evt);
      }
    }
    } catch {}
  })();
}

let extensionConnected = false;
const seen = [];

async function run() {
  console.log("· 本地桥");
  const health = await waitHealth();
  check("健康检查", health.ok, true);

  const ac = new AbortController();
  const resp = await fetch(BASE + "/events", { signal: ac.signal, headers: { accept: "text/event-stream" } });
  ok("SSE 建立", resp.ok && resp.body);
  parseSse(resp.body, async (evt) => {
    if (evt.event === "hello") extensionConnected = true;
    if (evt.event === "call") {
      const msg = JSON.parse(evt.data);
      seen.push(msg.tool);
      const result = msg.tool === "meta.tools" ? { tools: TOOL_DEFS } : { echo: msg.args, tool: msg.tool };
      const bad = msg.tool === "boom";
      await fetch(BASE + "/result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bad ? { id: msg.id, ok: false, error: "故意失败" } : { id: msg.id, ok: true, result }),
      });
    }
  });

  for (let i = 0; i < 30 && !extensionConnected; i += 1) await new Promise((r) => setTimeout(r, 50));
  ok("扩展连上", extensionConnected);

  const call1 = await (await fetch(BASE + "/call", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "rules.list", args: { url: "https://a.com" } }),
  })).json();
  check("调用结果", call1.result, { echo: { url: "https://a.com" }, tool: "rules.list" });

  const call2 = await (await fetch(BASE + "/call", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "boom", args: {} }),
  })).json();
  check("错误透传", call2.ok, false);
  check("错误信息", call2.error, "故意失败");

  const tools = await (await fetch(BASE + "/tools")).json();
  check("工具清单", tools.tools.length, TOOL_DEFS.length);

  // ---------- MCP ----------
  console.log("· MCP");
  const mcp = spawn(process.execPath, [path.join(root, "bridge/mcp.mjs")], {
    env: { ...process.env, AWT_BRIDGE: BASE },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const waiters = new Map();
  let mcpBuf = "";
  mcp.stdout.setEncoding("utf8");
  mcp.stdout.on("data", (chunk) => {
    mcpBuf += chunk;
    let i;
    while ((i = mcpBuf.indexOf("\n")) >= 0) {
      const line = mcpBuf.slice(0, i).trim();
      mcpBuf = mcpBuf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    }
  });
  const rpc = (id, method, params) => new Promise((resolve) => {
    waiters.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

  const init = await rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  check("MCP serverInfo", init.result.serverInfo.name, "agent-web-tweaks");
  const list = await rpc(2, "tools/list", {});
  check("MCP 工具数", list.result.tools.length, TOOL_DEFS.length);
  const called = await rpc(3, "tools/call", { name: "rules.list", arguments: { url: "https://a.com" } });
  check("MCP 调用", called.result.isError, false);
  ok("MCP 有内容", called.result.content[0].type === "text");
  const unknown = await rpc(4, "tools/call", { name: "nope", arguments: {} });
  ok("MCP 未知工具报错", unknown.error && unknown.error.code === -32602);
  mcp.kill();

  ac.abort();
  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
}

run()
  .catch((e) => {
    console.error("测试异常:", e);
    process.exitCode = 1;
  })
  .finally(() => {
    bridge.kill();
  });
