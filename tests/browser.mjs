// 真浏览器冒烟测试（需要 Chrome for Testing / Chromium 支持 --load-extension）。
//   CHROME=/path/to/Chrome node tests/browser.mjs
import puppeteer from "puppeteer-core";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME || "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const PORT = 8899;
const BRIDGE_PORT = 8798;
const BRIDGE = `http://127.0.0.1:${BRIDGE_PORT}`;
let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass += 1;
  else { fail += 1; console.log(`  ✗ ${name}\n    实际: ${JSON.stringify(actual)}\n    期望: ${JSON.stringify(expected)}`); }
}
const ok = (name, cond) => check(name, !!cond, true);

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    // 故意上严格 CSP，验证隔离世界不受影响
    "content-security-policy": "default-src 'self'; script-src 'self' 'nonce-testnonce'",
  });
  res.end(`<!doctype html><html><head><title>awt test</title></head>
  <body>
    <h1 id="headline">原始标题</h1>
    <p class="promo">推广内容</p>
    <button id="btn">按钮</button>
    <script nonce="testnonce">window.__pageMarker = "page-var";</script>
  </body></html>`);
}).listen(PORT);

const bridge = spawn(process.execPath, [path.join(root, "bridge/bridge.mjs"), "--port", String(BRIDGE_PORT), "--quiet"], { stdio: ["ignore", "ignore", "inherit"] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(tool, args = {}) {
  const resp = await fetch(BRIDGE + "/call", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, args, timeoutMs: 30000 }),
  });
  return await resp.json();
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: [
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  let swTarget = browser.targets().find((t) => t.type() === "service_worker");
  if (!swTarget) {
    swTarget = await browser.waitForTarget((t) => t.type() === "service_worker", { timeout: 15000 });
  }
  const worker = await swTarget.worker();
  const workerUrl = swTarget.url();
  const extensionId = new URL(workerUrl).host;
  console.log("扩展 id:", extensionId);

  // 打开「允许用户脚本」，等价于用户在 chrome://extensions 里手动打开
  const extPage = await browser.newPage();
  await extPage.goto("chrome://extensions/", { waitUntil: "domcontentloaded" });
  await extPage.evaluate(async (id) => {
    await chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, userScriptsAccess: true });
  }, extensionId);
  await extPage.close();
  await sleep(600);
  ok("userScripts 可用", await worker.evaluate(() => !!(chrome.userScripts && chrome.userScripts.execute)));

  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });

  await worker.evaluate(async ({ bridgeUrl }) => {
    await chrome.storage.local.set({
      "awt.settings.v1": { bridgeUrl, bridgeToken: "", bridgeEnabled: true, autoApply: true },
    });
  }, { bridgeUrl: BRIDGE });

  for (let i = 0; i < 60; i += 1) {
    const health = await (await fetch(BRIDGE + "/health")).json();
    if (health.clients > 0) break;
    await sleep(250);
  }
  const health = await (await fetch(BRIDGE + "/health")).json();
  ok("扩展连上本地桥", health.clients > 0);

  const status = await call("meta.status", {});
  if (!status.ok) console.log("  meta.status 错误:", status.error);
  ok("meta.status 可用", status.ok);
  check("工具清单可读", (await call("meta.tools")).result.tools.length, 18);

  const rule = {
    id: "test-hide-title",
    name: "测试：隐藏标题并改属性",
    match: [`http://127.0.0.1:${PORT}/*`],
    css: "#headline { display: none !important; }",
    js: "tweak.ready(() => { document.body.setAttribute('data-awt-test', '1'); tweak.log('ran'); });",
    enabled: true,
    world: "ISOLATED",
  };
  const saved = await call("rules.save", { rule, apply: true });
  if (!saved.ok) console.log("  rules.save 错误:", saved.error);
  else if (saved.result && saved.result.applied) console.log("  applied:", JSON.stringify(saved.result.applied));
  ok("保存规则", saved.ok);

  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(600);
  const applied = await page.evaluate(() => ({
    hidden: getComputedStyle(document.getElementById("headline")).display,
    flag: document.body.getAttribute("data-awt-test"),
  }));
  check("CSS 生效", applied.hidden, "none");
  check("JS 生效", applied.flag, "1");

  const ctx = await call("page.context", {});
  ok("page.context 返回已应用规则", (ctx.result.applied || []).includes("test-hide-title"));

  // 模拟用户在弹窗/工作台里拾取过一个元素：agent 从 context / lastPick 就能直接拿到
  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      "awt.lastPick.v1": {
        selector: ".promo",
        tag: "p",
        text: "推广内容",
        classes: ["promo"],
        html: '<p class="promo">推广内容</p>',
        url: "http://127.0.0.1:8899/",
        title: "awt test",
        pickedAt: Date.now(),
      },
    });
  });
  const ctx2 = await call("page.context", {});
  check("context 带 last_pick", ctx2.result.last_pick && ctx2.result.last_pick.selector, ".promo");
  check("last_pick 标记同页", ctx2.result.last_pick.same_page, true);
  const last = await call("page.lastPick", {});
  check("page.lastPick", last.result.pick.selector, ".promo");

  const evaluated = await call("page.eval", { code: "return document.title" });
  const asyncEval = await call("page.eval", { code: "await new Promise((r) => setTimeout(r, 120)); return 1 + 1;" });
  check("page.eval 支持 await", asyncEval.result.result, 2);
  check("page.eval", evaluated.result.result, "awt test");

  const shot = await call("page.screenshot", {});
  ok("page.screenshot", String(shot.result.dataUrl || "").startsWith("data:image/png"));

  // MAIN world：拿页面自己的变量
  const mainRule = {
    id: "test-main-world",
    name: "测试：MAIN world",
    match: [`http://127.0.0.1:${PORT}/*`],
    css: "",
    js: "tweak.ready(() => document.documentElement.setAttribute('data-main-marker', String(window.__pageMarker)));",
    world: "MAIN",
    enabled: true,
  };
  ok("保存 MAIN 规则", (await call("rules.save", { rule: mainRule, apply: true })).ok);
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(600);
  check("MAIN world 拿到页面变量", await page.evaluate(() => document.documentElement.getAttribute("data-main-marker")), "page-var");

  // SPA 路由：pushState 后新规则自动生效
  const spaRule = {
    id: "test-spa-route",
    name: "测试：SPA 路由",
    match: [`http://127.0.0.1:${PORT}/spa`],
    css: "#headline { font-size: 40px !important; }",
    js: "tweak.onRoute(() => {});",
    enabled: true,
  };
  ok("保存 SPA 规则", (await call("rules.save", { rule: spaRule, apply: true })).ok);
  await page.evaluate(() => history.pushState({}, "", "/spa"));
  await sleep(1200);
  check("SPA 路由后 CSS 生效", await page.evaluate(() => getComputedStyle(document.getElementById("headline")).fontSize), "40px");

  const removed = await call("page.remove", { id: "test-hide-title" });
  ok("page.remove", removed.ok);
  await sleep(300);
  const afterRemove = await page.evaluate(() => getComputedStyle(document.getElementById("headline")).display);
  check("撤销后恢复", afterRemove !== "none", true);

  // UI 冒烟
  const studio = await browser.newPage();
  const studioErrors = [];
  studio.on("pageerror", (e) => studioErrors.push(String(e)));
  studio.on("console", (m) => { if (m.type() === "error") studioErrors.push("console: " + m.text()); });
  await studio.goto(`chrome-extension://${extensionId}/src/ui/studio.html`, { waitUntil: "domcontentloaded" });
  await sleep(800);
  const studioState = await studio.evaluate(() => ({
    listItems: document.querySelectorAll(".rule-item").length,
    hasEditor: !document.getElementById("editor").hidden,
    bridgeText: document.getElementById("bridgeSub").textContent,
  }));
  ok("工作台渲染规则列表", studioState.listItems >= 1);
  ok("工作台打开编辑器", studioState.hasEditor);
  check("工作台 UI 无报错", studioErrors, []);

  const popup = await browser.newPage();
  const popupErrors = [];
  popup.on("pageerror", (e) => popupErrors.push(String(e)));
  await popup.goto(`chrome-extension://${extensionId}/src/ui/popup.html`, { waitUntil: "domcontentloaded" });
  await sleep(600);
  const popupState = await popup.evaluate(() => ({
    count: document.getElementById("ruleCount").textContent,
    title: document.getElementById("tabTitle").textContent,
  }));
  ok("弹窗读到规则数", Number(popupState.count) >= 0);
  check("弹窗 UI 无报错", popupErrors, []);

  check("页面无 JS 报错", pageErrors, []);
  await browser.close();
}

main()
  .catch((e) => { console.error("测试异常:", e); process.exitCode = 1; })
  .finally(() => {
    bridge.kill();
    server.close();
    console.log(`\n${pass} 通过，${fail} 失败`);
    process.exit(fail ? 1 : 0);
  });
