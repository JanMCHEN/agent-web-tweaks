// Agent Web Tweaks —— service worker
// 职责：规则存储、注入、页面拾取、以及给任意 agent 用的本地桥（SSE + HTTP）。
import {
  RULES_KEY,
  SETTINGS_KEY,
  PICK_KEY,
  STATUS_KEY,
  DEFAULT_SETTINGS,
  DEFAULT_BRIDGE,
  normalizeRule,
  validateRule,
  ruleMatches,
  sortRules,
  ruleSummary,
  dedupeRules,
  isValidId,
  slugId,
} from "./shared/core.js";
import { buildRuleScript } from "./shared/runtime.js";
import { TOOL_DEFS } from "./shared/tools.js";

const VERSION = "0.1.0";
const MAIN_WORLD_KEY = "awt.mainWorldActive";
const MAIN_SCRIPT_ID = "awt-main";
const DEBUG = false;

const log = (...args) => { if (DEBUG) console.log("[awt:bg]", ...args); };

// ---------- 存储 ----------
let writeQueue = Promise.resolve();

function withLock(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.then(() => {}, () => {});
  return run;
}

async function getSettings() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY]);
  const value = stored[SETTINGS_KEY] || {};
  return { ...DEFAULT_SETTINGS, ...value, bridgeUrl: String(value.bridgeUrl ?? DEFAULT_SETTINGS.bridgeUrl).trim() || DEFAULT_BRIDGE };
}

async function setSettings(patch) {
  return await withLock(async () => {
    const current = await getSettings();
    const next = { ...current, ...patch };
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  });
}

async function getRules() {
  const stored = await chrome.storage.local.get([RULES_KEY]);
  const map = stored[RULES_KEY];
  const list = map && typeof map === "object" ? Object.values(map) : [];
  return list.filter((r) => r && isValidId(r.id));
}

async function saveRules(list) {
  return await withLock(async () => {
    const map = {};
    for (const rule of list) map[rule.id] = rule;
    await chrome.storage.local.set({ [RULES_KEY]: map });
    return Object.values(map);
  });
}

async function upsertRule(input) {
  const rules = await getRules();
  const prev = rules.find((r) => r.id === input.id) || {};
  const rule = normalizeRule(input, prev);
  const errors = validateRule(rule);
  if (errors.length) throw new Error(errors.join("；"));
  const next = rules.filter((r) => r.id !== rule.id);
  next.push(rule);
  await saveRules(next);
  await syncMainWorld();
  return rule;
}

async function deleteRule(id) {
  const rules = await getRules();
  const rule = rules.find((r) => r.id === id);
  if (!rule) throw new Error("规则不存在: " + id);
  await saveRules(rules.filter((r) => r.id !== id));
  await chrome.storage.local.remove(["awt.store." + id, "awt.error." + id]).catch(() => {});
  await syncMainWorld();
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (injectable(tab) && ruleMatches(rule, tab.url)) await removeFromTab(tab.id, id).catch(() => {});
  }
  return { deleted: id };
}

// ---------- MAIN world：注册成 userScripts ----------
async function userScriptsAvailable() {
  try {
    if (!chrome.userScripts || !chrome.userScripts.getScripts) return false;
    await chrome.userScripts.getScripts();
    return true;
  } catch {
    return false;
  }
}

let syncingScripts = null;

// 每条带 JS 的规则注册成一个 userScript（在 URL 匹配后才真正跑）。
// 用 userScripts 而不是内容脚本 eval：MV3 的内容脚本隔离世界禁止 eval，
// 而 userScripts 由浏览器注入，不受页面 CSP 影响。
async function syncUserScripts() {
  if (syncingScripts) return syncingScripts;
  syncingScripts = (async () => {
    const available = await userScriptsAvailable();
    const rules = await getRules();
    const settings = await getSettings();
    const jsRules = rules.filter((r) => r.enabled !== false && r.js);

    try {
      await chrome.userScripts.unregister();
    } catch {}

    const registered = [];
    const failed = [];
    if (available) {
      for (const rule of jsRules) {
        const world = rule.world === "MAIN" ? "MAIN" : "USER_SCRIPT";
        try {
          await chrome.userScripts.register([
            {
              id: "awt-" + rule.id,
              matches: ["<all_urls>"],
              runAt: "document_start",
              allFrames: true,
              world,
              js: [{ code: buildRuleScript(rule, settings.env || {}, world) }],
            },
          ]);
          registered.push(rule.id);
        } catch (e) {
          failed.push({ id: rule.id, error: String((e && e.message) || e) });
          console.error("[awt] 注册规则脚本失败", rule.id, e);
        }
      }
    }

    await chrome.storage.local.set({
      [MAIN_WORLD_KEY]: registered.length > 0,
      "awt.userScripts.v1": registered,
      "awt.userScriptsState.v1": { available, registered: registered.length, failed, at: Date.now() },
    });
    return { available, registered, failed, requested: jsRules.length };
  })().finally(() => {
    setTimeout(() => { syncingScripts = null; }, 300);
  });
  return syncingScripts;
}

// 兼容旧调用点
const syncMainWorld = syncUserScripts;

// ---------- 标签页 ----------
async function resolveTab(tabId) {
  if (tabId != null && Number.isFinite(Number(tabId))) {
    return await chrome.tabs.get(Number(tabId));
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("找不到活动标签页");
  return tab;
}

function injectable(tab) {
  return !!tab && /^https?:/i.test(tab.url || "");
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content/tweaker.js"] });
  } catch (e) {
    throw new Error("无法在该页面注入（可能是 chrome:// 或受保护页面）：" + (e.message || e));
  }
}

async function sendToPage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return null;
  }
}

async function pageState(tabId) {
  let state = await sendToPage(tabId, { type: "awt:page-state" });
  if (!state) {
    await ensureContentScript(tabId).catch(() => {});
    state = await sendToPage(tabId, { type: "awt:page-state" });
  }
  return state && state.result ? state.result : null;
}

function worldOf(rule) {
  return rule && rule.world === "MAIN" ? "MAIN" : "USER_SCRIPT";
}

async function runRuleInTab(tabId, rule) {
  if (!(await userScriptsAvailable())) {
    throw new Error("未开启「允许用户脚本」：规则 JS 无法执行（CSS 不受影响）");
  }
  const settings = await getSettings();
  const world = worldOf(rule);
  try {
    const results = await chrome.userScripts.execute({
      target: { tabId: Number(tabId), allFrames: true },
      world,
      injectImmediately: true,
      js: [{ code: buildRuleScript(rule, settings.env || {}, world) }],
    });
    const bad = (results || []).find((r) => r && r.error);
    if (bad) throw new Error(bad.error);
    return true;
  } catch (e) {
    throw new Error(String((e && e.message) || e));
  }
}

async function dropRuleInTab(tabId, id) {
  if (!(await userScriptsAvailable())) return;
  const code = `(() => {
  const reg = window.__awtRules;
  if (reg && reg[${JSON.stringify(String(id))}]) { try { reg[${JSON.stringify(String(id))}].remove(); } catch (e) {} }
})()`;
  await Promise.all(["USER_SCRIPT", "MAIN"].map((world) =>
    chrome.userScripts.execute({ target: { tabId: Number(tabId), allFrames: true }, world, js: [{ code }] }).catch(() => {})
  ));
}

async function applyToTab(tabId, ruleId) {
  // 工作台自己也是标签页：没指定或指到扩展页时，落到真正可定制的那个网页
  const tab = await findPickTab(tabId);
  if (!tab) throw new Error("当前窗口没有可定制的网页（chrome://、扩展页、PDF 都不行）。先打开一个普通网页。");
  const rules = sortRules((await getRules()).filter((r) => r.enabled !== false));
  const targets = rules.filter((r) => ruleMatches(r, tab.url) && (!ruleId || r.id === ruleId));
  if (!targets.length) {
    return { tabId: tab.id, url: tab.url, applied: [], errors: [], note: "没有匹配当前页面的规则" };
  }

  // 1) CSS 走内容脚本
  let resp = await sendToPage(tab.id, { type: "awt:page-apply", rules: targets });
  if (!resp) {
    await ensureContentScript(tab.id).catch(() => {});
    resp = await sendToPage(tab.id, { type: "awt:page-apply", rules: targets });
  }

  // 2) JS 走 userScripts（逐条，互不影响）
  const errors = [];
  const jsApplied = [];
  for (const rule of targets) {
    if (!rule.js) continue;
    try {
      await runRuleInTab(tab.id, rule);
      jsApplied.push(rule.id);
    } catch (e) {
      errors.push({ id: rule.id, message: String((e && e.message) || e) });
    }
  }

  const state = await pageState(tab.id);
  const cssApplied = (state && state.applied) || [];
  return {
    tabId: tab.id,
    url: tab.url,
    applied: [...new Set([...cssApplied, ...jsApplied])],
    errors: [...((state && state.errors) || []), ...errors],
  };
}

async function removeFromTab(tabId, id) {
  const tab = await findPickTab(tabId);
  if (!tab) return { tabId: null, applied: [], note: "当前窗口没有可定制的网页" };
  let resp = await sendToPage(tab.id, { type: "awt:page-remove", id: id || "" });
  if (!resp) {
    await ensureContentScript(tab.id).catch(() => {});
    resp = await sendToPage(tab.id, { type: "awt:page-remove", id: id || "" });
  }
  if (id) await dropRuleInTab(tab.id, id);
  else {
    const rules = await getRules();
    await Promise.all(rules.map((rule) => dropRuleInTab(tab.id, rule.id)));
  }
  return { tabId: tab.id, url: tab.url, applied: (resp && resp.result && resp.result.applied) || [] };
}


async function syncRuleToTabs(rule, { onlyIfApplied = false } = {}) {
  const tabs = await chrome.tabs.query({});
  const out = [];
  for (const tab of tabs) {
    if (!injectable(tab)) continue;
    if (!ruleMatches(rule, tab.url)) continue;
    if (onlyIfApplied && !(await pageState(tab.id).catch(() => null))) continue;
    try {
      if (rule.enabled === false) {
        await removeFromTab(tab.id, rule.id);
        out.push({ tabId: tab.id, url: tab.url, removed: true });
      } else {
        out.push(await applyToTab(tab.id, rule.id));
      }
    } catch (e) {
      out.push({ tabId: tab.id, url: tab.url, error: String((e && e.message) || e) });
    }
  }
  return out;
}

async function tabStatus(tabId) {
  const state = (await pageState(tabId)) || { applied: [], errors: [], url: "" };
  const registered = (await chrome.storage.local.get(["awt.userScripts.v1"]))["awt.userScripts.v1"] || [];
  return { ...state, registered_js: registered };
}

// ---------- 元素拾取 ----------
let pickWaiter = null;
let pickReturnTabId = null;
let pickOpenPopupAfter = false;

// 拾取结束后把界面拉回来：从工作台发起 → 切回工作台；从弹窗发起 → 重新把弹窗打开
async function restorePickSurface(sender) {
  if (pickReturnTabId != null) {
    await returnToPickOrigin();
    return;
  }
  if (!pickOpenPopupAfter) return;
  pickOpenPopupAfter = false;
  try {
    const windowId = sender && sender.tab ? sender.tab.windowId : undefined;
    await chrome.action.openPopup(windowId == null ? {} : { windowId });
  } catch {}
}

async function returnToPickOrigin() {
  const id = pickReturnTabId;
  pickReturnTabId = null;
  if (id == null) return;
  try {
    const tab = await chrome.tabs.get(id);
    await chrome.tabs.update(id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {}
}

// 拾取要落到一个普通网页上：工作台/设置页自己也是标签页，在它上面点「拾取」没意义。
// 优先显式 tabId，其次当前活动页，最后退回本窗口最近访问过的网页。
async function findPickTab(preferredId) {
  if (preferredId != null && Number.isFinite(Number(preferredId))) {
    try {
      const tab = await chrome.tabs.get(Number(preferredId));
      if (injectable(tab)) return tab;
    } catch {}
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && injectable(active)) return active;
  const tabs = (await chrome.tabs.query({ lastFocusedWindow: true })).filter(injectable);
  tabs.sort((a, b) => (Number(b.lastAccessed) || 0) - (Number(a.lastAccessed) || 0));
  return tabs[0] || null;
}

async function injectPicker(tabId) {
  // 每次重新发起拾取都先清掉上一轮的「结束后回到哪里」
  pickReturnTabId = null;
  pickOpenPopupAfter = false;
  const tab = await findPickTab(tabId);
  if (!tab) {
    throw new Error("当前窗口没有可定制的网页（chrome://、扩展页、PDF 都不行）。先打开一个普通网页再拾取。");
  }
  // 切到目标页，不然拾取器出现在看不见的标签页里
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {}
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/ui/picker.js"] });
  await chrome.storage.local.set({ "awt.pickState": { tabId: tab.id, at: Date.now() } });
  return { tabId: tab.id, url: tab.url, started: true };
}

function waitForPick(timeoutMs = 120000) {
  if (pickWaiter) {
    clearTimeout(pickWaiter.timer);
    pickWaiter.reject(new Error("上一次拾取被新的请求取代"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pickWaiter = null;
      reject(new Error("等待拾取超时"));
    }, Math.max(1000, Number(timeoutMs) || 120000));
    pickWaiter = { resolve, reject, timer };
  });
}

function settlePick(result, error) {
  if (!pickWaiter) return;
  const waiter = pickWaiter;
  pickWaiter = null;
  clearTimeout(waiter.timer);
  if (error) waiter.reject(error); else waiter.resolve(result);
}

// ---------- 在页面里执行代码 ----------
async function executePageCode(tabId, code, world = "ISOLATED") {
  if (!(await userScriptsAvailable())) {
    throw new Error("需要先开启「允许用户脚本」：chrome://extensions → 本扩展详情 → 允许用户脚本");
  }
  // 统一按 async 函数体执行：支持 await，用 return 返回值
  const wrapped = `(async () => {\n${code}\n})()`;
  const results = await chrome.userScripts.execute({
    target: { tabId: Number(tabId) },
    world: world === "MAIN" ? "MAIN" : "USER_SCRIPT",
    injectImmediately: true,
    js: [{ code: wrapped }],
  });
  const first = Array.isArray(results) ? results[0] : null;
  if (first && first.error) throw new Error(first.error);
  return { value: first ? first.result : undefined, via: "userScripts" };
}

async function evalInPage({ tabId, code, world = "ISOLATED" }) {
  const tab = await resolveTab(tabId);
  if (!injectable(tab)) throw new Error("该页面不支持执行脚本：" + (tab.url || ""));
  if (!code || typeof code !== "string") throw new Error("缺少 code");
  const out = await executePageCode(tab.id, code, world);
  return { tabId: tab.id, url: tab.url, world, via: out.via, result: out.value };
}

async function screenshot({ tabId } = {}) {
  const tab = await resolveTab(tabId);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  return { tabId: tab.id, url: tab.url, dataUrl };
}

async function pageContext({ tabId } = {}) {
  const tab = (await findPickTab(tabId)) || (await resolveTab(tabId));
  if (!injectable(tab)) {
    return { tabId: tab.id, url: tab.url, title: tab.title, injectable: false };
  }
  const state = (await pageState(tab.id)) || { applied: [], errors: [] };
  const rules = sortRules(await getRules()).filter((r) => ruleMatches(r, tab.url));
  let selection = "";
  let outline = null;
  try {
    const out = await executePageCode(
      tab.id,
      `return (() => {
        const sel = String(window.getSelection ? window.getSelection().toString() : "").slice(0, 500);
        const headings = [...document.querySelectorAll("h1,h2,h3")].slice(0, 12).map((h) => (h.tagName + ":" + (h.innerText || "").trim().slice(0, 80)));
        return { selection: sel, title: document.title, headings, elements: document.querySelectorAll("*").length };
      })();`,
      "ISOLATED"
    );
    outline = out.value || null;
    selection = (outline && outline.selection) || "";
  } catch {}
  const storedPick = ((await chrome.storage.local.get([PICK_KEY]))[PICK_KEY]) || null;
  return {
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
    injectable: true,
    applied: state.applied || [],
    errors: state.errors || [],
    matched_rules: rules.map((r) => ruleSummary(r, tab.url)),
    selection,
    outline,
    // 用户在弹窗/工作台里最后一次点选的元素：agent 可以直接拿它写规则，不用再让用户点一次
    last_pick: storedPick
      ? {
          selector: storedPick.selector || "",
          tag: storedPick.tag || "",
          text: storedPick.text || "",
          classes: storedPick.classes || [],
          attributes: storedPick.attributes || {},
          html: String(storedPick.html || "").slice(0, 2000),
          url: storedPick.url || "",
          title: storedPick.title || "",
          same_page: String(storedPick.url || "") === String(tab.url || ""),
          picked_at: storedPick.pickedAt || null,
        }
      : null,
  };
}

async function lastPick({ tabId } = {}) {
  const tab = (await findPickTab(tabId)) || (await resolveTab(tabId));
  const storedPick = ((await chrome.storage.local.get([PICK_KEY]))[PICK_KEY]) || null;
  if (!storedPick) return { pick: null };
  return { pick: { ...storedPick, same_page: String(storedPick.url || "") === String(tab.url || "") } };
}

async function pageHtml({ tabId, selector = "", maxChars = 20000 } = {}) {
  const tab = await resolveTab(tabId);
  const code = `return (() => {
    const el = ${JSON.stringify(String(selector || ""))} ? document.querySelector(${JSON.stringify(String(selector || ""))}) : document.documentElement;
    if (!el) return { found: false };
    return { found: true, html: (el.outerHTML || "").slice(0, ${Math.max(200, Number(maxChars) || 20000)}) };
  })();`;
  const out = await executePageCode(tab.id, code, "ISOLATED");
  return { tabId: tab.id, url: tab.url, ...(out.value || { found: false }) };
}

async function pageText({ tabId, selector = "", maxChars = 20000 } = {}) {
  const tab = await resolveTab(tabId);
  const sel = JSON.stringify(String(selector || ""));
  const code = `return (() => {
    const el = ${sel} ? document.querySelector(${sel}) : document.body;
    if (!el) return { found: false };
    const text = String(el.innerText || el.textContent || "");
    return { found: true, text: text.slice(0, ${Math.max(200, Number(maxChars) || 20000)}), length: text.length };
  })();`;
  const out = await executePageCode(tab.id, code, "ISOLATED");
  return { tabId: tab.id, url: tab.url, ...(out.value || { found: false }) };
}

// ---------- 页面交互（给 agent 自验证用） ----------
async function waitTabComplete(tabId, timeoutMs = 15000) {
  const started = Date.now();
  let tab = null;
  while (Date.now() - started < timeoutMs) {
    tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
    if (tab && tab.status === "complete") return tab;
    await new Promise((r) => setTimeout(r, 120));
  }
  return tab || (await chrome.tabs.get(Number(tabId)).catch(() => null));
}

// 动作之后回一份小状态：url/标题/已应用规则/报错，agent 一步就能判断有没有生效
async function pageSnapshot(tabId) {
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  const state = await pageState(tabId).catch(() => null);
  return {
    url: (tab && tab.url) || "",
    title: (tab && tab.title) || "",
    applied: (state && state.applied) || [],
    errors: (state && state.errors) || [],
  };
}

async function pageNavigate({ tabId, url, newTab = false } = {}) {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) throw new Error("navigate 只支持 http/https URL");
  if (newTab) {
    const tab = await chrome.tabs.create({ url: target, active: true });
    await waitTabComplete(tab.id);
    return { tabId: tab.id, action: "navigate", ...(await pageSnapshot(tab.id)) };
  }
  const tab = await findPickTab(tabId);
  if (!tab) throw new Error("当前窗口没有可用的标签页");
  await chrome.tabs.update(tab.id, { url: target });
  await waitTabComplete(tab.id);
  return { tabId: tab.id, action: "navigate", ...(await pageSnapshot(tab.id)) };
}

async function pageReload({ tabId, bypassCache = false } = {}) {
  const tab = await findPickTab(tabId);
  if (!tab) throw new Error("当前窗口没有可用的标签页");
  await chrome.tabs.reload(tab.id, { bypassCache: !!bypassCache });
  await waitTabComplete(tab.id);
  return { tabId: tab.id, action: "reload", ...(await pageSnapshot(tab.id)) };
}

async function pageClick({ tabId, selector, text, index = 0, settleMs = 300 } = {}) {
  const tab = await findPickTab(tabId);
  if (!tab) throw new Error("当前窗口没有可用的标签页");
  if (!selector && !text) throw new Error("click 需要 selector 或 text");
  const code = `return (() => {
  const sel = ${JSON.stringify(String(selector || ""))};
  const needle = ${JSON.stringify(String(text || ""))};
  const idx = ${Number(index) || 0};
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0;
  };
  let pool = sel ? Array.from(document.querySelectorAll(sel)) : [];
  if (!sel && needle) {
    pool = Array.from(document.querySelectorAll("a,button,[role=button],input[type=submit],label,li,span,div"))
      .filter((el) => (el.innerText || el.textContent || "").trim().includes(needle));
  }
  const targets = pool.filter(visible);
  const el = targets[idx];
  if (!el) return { ok: false, reason: "not_found", candidates: targets.length };
  el.scrollIntoView({ block: "center", inline: "center" });
  const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
  try { el.dispatchEvent(new PointerEvent("pointerdown", opts)); } catch (e) {}
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  try { el.dispatchEvent(new PointerEvent("pointerup", opts)); } catch (e) {}
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.click();
  return { ok: true, tag: el.tagName.toLowerCase(), text: String(el.innerText || el.textContent || "").trim().slice(0, 80), candidates: targets.length };
})();`;
  const out = await executePageCode(tab.id, code, "ISOLATED");
  await new Promise((r) => setTimeout(r, Math.max(0, Number(settleMs) || 0)));
  return { tabId: tab.id, action: "click", ...(out.value || {}), ...(await pageSnapshot(tab.id)) };
}

async function pageType({ tabId, selector, text = "", submit = false, clear = true, settleMs = 200 } = {}) {
  const tab = await findPickTab(tabId);
  if (!tab) throw new Error("当前窗口没有可用的标签页");
  if (!selector) throw new Error("type 需要 selector");
  const code = `return (() => {
  const el = document.querySelector(${JSON.stringify(String(selector))});
  if (!el) return { ok: false, reason: "not_found" };
  el.scrollIntoView({ block: "center" });
  el.focus();
  const value = ${JSON.stringify(String(text))};
  if (el.isContentEditable) {
    if (${clear ? "true" : "false"}) el.textContent = "";
    el.textContent = el.textContent + value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  } else {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
    const next = ${clear ? "value" : "String(el.value || \"\") + value"};
    if (setter) setter.call(el, next); else el.value = next;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  let submitted = false;
  if (${submit ? "true" : "false"}) {
    const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keypress", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
    const form = el.closest && el.closest("form");
    if (form && form.requestSubmit) { try { form.requestSubmit(); submitted = true; } catch (e) {} }
  }
  return { ok: true, tag: el.tagName.toLowerCase(), value: String(el.value != null ? el.value : el.textContent).slice(0, 120), submitted };
})();`;
  const out = await executePageCode(tab.id, code, "ISOLATED");
  await new Promise((r) => setTimeout(r, Math.max(0, Number(settleMs) || 0)));
  return { tabId: tab.id, action: "type", ...(out.value || {}), ...(await pageSnapshot(tab.id)) };
}

async function pagePress({ tabId, key, selector, settleMs = 200 } = {}) {
  const tab = await findPickTab(tabId);
  if (!tab) throw new Error("当前窗口没有可用的标签页");
  const name = String(key || "").trim();
  if (!name) throw new Error("press 需要 key（如 Enter / Escape / Tab）");
  const code = `return (() => {
  const el = ${selector ? `document.querySelector(${JSON.stringify(String(selector))}) || document.activeElement` : "document.activeElement || document.body"};
  if (!el) return { ok: false, reason: "no_target" };
  const key = ${JSON.stringify(name)};
  const opts = { key, code: key, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent("keydown", opts));
  el.dispatchEvent(new KeyboardEvent("keypress", opts));
  el.dispatchEvent(new KeyboardEvent("keyup", opts));
  return { ok: true, target: el.tagName.toLowerCase() };
})();`;
  const out = await executePageCode(tab.id, code, "ISOLATED");
  await new Promise((r) => setTimeout(r, Math.max(0, Number(settleMs) || 0)));
  return { tabId: tab.id, action: "press", key: name, ...(out.value || {}), ...(await pageSnapshot(tab.id)) };
}

async function pageScroll({ tabId, selector, direction = "down", amount = 600, settleMs = 200 } = {}) {
  const tab = await findPickTab(tabId);
  if (!tab) throw new Error("当前窗口没有可用的标签页");
  const code = `return (() => {
  const sel = ${JSON.stringify(String(selector || ""))};
  if (sel) {
    const el = document.querySelector(sel);
    if (!el) return { ok: false, reason: "not_found" };
    el.scrollIntoView({ block: "center", behavior: "auto" });
    return { ok: true, mode: "element", y: Math.round(window.scrollY) };
  }
  const dir = ${JSON.stringify(String(direction || "down"))};
  const amount = ${Number(amount) || 600};
  if (dir === "top") window.scrollTo({ top: 0, behavior: "auto" });
  else if (dir === "bottom") window.scrollTo({ top: document.body.scrollHeight, behavior: "auto" });
  else window.scrollBy({ top: dir === "up" ? -amount : amount, behavior: "auto" });
  return { ok: true, mode: dir, y: Math.round(window.scrollY), height: document.body.scrollHeight };
})();`;
  const out = await executePageCode(tab.id, code, "ISOLATED");
  await new Promise((r) => setTimeout(r, Math.max(0, Number(settleMs) || 0)));
  return { tabId: tab.id, action: "scroll", ...(out.value || {}), ...(await pageSnapshot(tab.id)) };
}

async function pageWaitFor({ tabId, selector, text, timeoutMs = 5000, intervalMs = 120, visible = true } = {}) {
  const tab = await findPickTab(tabId);
  if (!tab) throw new Error("当前窗口没有可用的标签页");
  if (!selector && !text) throw new Error("waitFor 需要 selector 或 text");
  const code = `const started = Date.now();
const timeout = ${Math.max(200, Number(timeoutMs) || 5000)};
const interval = ${Math.max(50, Number(intervalMs) || 120)};
const sel = ${JSON.stringify(String(selector || ""))};
const needle = ${JSON.stringify(String(text || ""))};
const needVisible = ${visible === false ? "false" : "true"};
const shown = (el) => {
  if (!el) return false;
  if (!needVisible) return true;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0;
};
while (Date.now() - started < timeout) {
  if (sel && shown(document.querySelector(sel))) return { ok: true, found: true, waitedMs: Date.now() - started, selector: sel };
  if (!sel && needle && document.body && (document.body.innerText || "").includes(needle)) return { ok: true, found: true, waitedMs: Date.now() - started, text: needle };
  await new Promise((r) => setTimeout(r, interval));
}
return { ok: true, found: false, waitedMs: Date.now() - started, selector: sel || null, text: needle || null };`;
  const out = await executePageCode(tab.id, code, "ISOLATED");
  return { tabId: tab.id, action: "waitFor", ...(out.value || {}), ...(await pageSnapshot(tab.id)) };
}

// ---------- 给 agent 的工具 ----------
async function toolMetaStatus() {
  const rules = await getRules();
  const stored = await chrome.storage.local.get([MAIN_WORLD_KEY, "awt.userScriptsState.v1"]);
  const tabs = await chrome.tabs.query({});
  const available = await userScriptsAvailable();
  return {
    version: VERSION,
    bridge: bridgeInfo(),
    userScripts: available,
    scriptState: stored["awt.userScriptsState.v1"] || null,
    mainWorld: !!stored[MAIN_WORLD_KEY],
    rules: rules.length,
    tabs: tabs.length,
    settings: await getSettings(),
  };
}

async function runTool(name, args = {}) {
  switch (name) {
    case "meta.status":
      return await toolMetaStatus();
    case "meta.tools":
      return { tools: TOOL_DEFS };
    case "rules.list": {
      const rules = sortRules(await getRules());
      const url = args.url ? String(args.url) : "";
      return {
        url,
        rules: rules.map((r) => ({
          ...ruleSummary(r, url || null),
          ...(args.full ? { css: r.css || "", js: r.js || "" } : {}),
        })),
      };
    }
    case "rules.get": {
      const rules = await getRules();
      const rule = rules.find((r) => r.id === String(args.id || ""));
      if (!rule) throw new Error("规则不存在: " + args.id);
      return { rule };
    }
    case "rules.save": {
      const rule = await upsertRule(args.rule || {});
      const applied = args.apply === false ? null : await syncRuleToTabs(rule);
      return { rule, applied };
    }
    case "rules.delete":
      await deleteRule(String(args.id || ""));
      return { deleted: String(args.id || "") };
    case "rules.toggle": {
      const rules = await getRules();
      const rule = rules.find((r) => r.id === String(args.id || ""));
      if (!rule) throw new Error("规则不存在: " + args.id);
      const next = await upsertRule({ ...rule, enabled: !!args.enabled });
      await syncRuleToTabs(next);
      return { rule: next };
    }
    case "rules.export":
      return { json: JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), rules: sortRules(await getRules()) }, null, 2) };
    case "rules.import": {
      const parsed = typeof args.data === "string" ? JSON.parse(args.data) : args.data;
      const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.rules) ? parsed.rules : null;
      if (!list) throw new Error("导入内容里没有 rules 数组");
      const incoming = dedupeRules(list);
      const mode = args.mode === "replace" ? "replace" : "merge";
      const existing = mode === "replace" ? [] : await getRules();
      const map = new Map(existing.map((r) => [r.id, r]));
      for (const rule of incoming) {
        const prev = map.get(rule.id) || {};
        map.set(rule.id, normalizeRule(rule, prev));
      }
      await saveRules([...map.values()]);
      await syncMainWorld();
      return { imported: incoming.length, total: map.size, mode };
    }
    case "tabs.list": {
      const tabs = await chrome.tabs.query(args.allWindows ? {} : { lastFocusedWindow: true });
      return {
        tabs: tabs.map((t) => ({ id: t.id, windowId: t.windowId, active: !!t.active, url: t.url, title: t.title, status: t.status })),
      };
    }
    case "page.context":
      return await pageContext(args);
    case "page.lastPick":
      return await lastPick(args);
    case "page.html":
      return await pageHtml(args);
    case "page.text":
      return await pageText(args);
    case "page.eval":
      return await evalInPage(args);
    case "page.screenshot":
      return await screenshot(args);
    case "page.navigate":
      return await pageNavigate(args);
    case "page.reload":
      return await pageReload(args);
    case "page.click":
      return await pageClick(args);
    case "page.type":
      return await pageType(args);
    case "page.press":
      return await pagePress(args);
    case "page.scroll":
      return await pageScroll(args);
    case "page.waitFor":
      return await pageWaitFor(args);
    case "page.pick": {
      const started = await injectPicker(args.tabId);
      const reference = await waitForPick(args.timeoutMs || 120000);
      return { ...started, reference };
    }
    case "page.apply":
      return await applyToTab(args.tabId, args.id ? String(args.id) : "");
    case "page.remove":
      return await removeFromTab(args.tabId, args.id ? String(args.id) : "");
    default:
      throw new Error("未知工具: " + name);
  }
}

// ---------- 本地桥：SSE 下行 + HTTP 上行 ----------
const bridge = {
  active: false,
  connected: false,
  url: "",
  error: "",
  since: 0,
  lastEventAt: 0,
  calls: 0,
  toolName: "",
};
let bridgeToken = 0;

function bridgeInfo() {
  return {
    active: bridge.active,
    connected: bridge.connected,
    url: bridge.url,
    error: bridge.error,
    since: bridge.since,
    lastEventAt: bridge.lastEventAt,
    calls: bridge.calls,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJson(url, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!resp.ok) throw new Error("HTTP " + resp.status + " " + (data && data.error ? data.error : ""));
  return data;
}

async function readSse(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = { event: "message", data: "", id: "" };
      for (const line of chunk.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "data") event.data = event.data ? event.data + "\n" + value : value;
        else if (field === "event") event.event = value;
        else if (field === "id") event.id = value;
      }
      if (event.data || event.event !== "message") {
        try { onEvent(event); } catch (e) { console.error("[awt] SSE 事件处理失败", e); }
      }
    }
  }
}

function ensureBridge(force = false) {
  if (force) bridgeToken += 1;
  else if (bridge.active) return;
  if (bridge.active && force) {
    try { bridgeAbort && bridgeAbort.abort(); } catch {}
  }
  const token = bridgeToken;
  bridge.active = true;
  (async () => {
    let attempt = 0;
    while (token === bridgeToken) {
      const settings = await getSettings();
      const base = String(settings.bridgeUrl || "").replace(/\/+$/, "");
      if (!base || settings.bridgeEnabled === false) {
        bridge.connected = false;
        bridge.error = base ? "桥已关闭" : "未配置桥地址";
        await sleep(4000);
        continue;
      }
      const controller = new AbortController();
      bridgeAbort = controller;
      try {
        const url = new URL(base + "/events");
        if (settings.bridgeToken) url.searchParams.set("token", String(settings.bridgeToken));
        const resp = await fetch(url.toString(), {
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
          cache: "no-store",
        });
        if (!resp.ok || !resp.body) throw new Error("HTTP " + resp.status);
        attempt = 0;
        bridge.connected = true;
        bridge.error = "";
        bridge.url = base;
        bridge.since = Date.now();
        bridge.lastEventAt = Date.now();
        broadcastUi({ type: "awt:bridge-state", bridge: bridgeInfo() });
        postJson(base + "/hello", {
          client: "agent-web-tweaks",
          version: VERSION,
          extensionId: chrome.runtime.id,
          tabs: (await chrome.tabs.query({})).length,
        }).catch(() => {});
        await readSse(resp.body, (event) => handleBridgeEvent(base, event));
      } catch (e) {
        if (token !== bridgeToken) return;
        const message = String((e && e.message) || e);
        bridge.error = /failed to fetch|networkerror|fetch failed|load failed/i.test(message)
          ? "本地桥未启动（node bridge/bridge.mjs）"
          : message;
      } finally {
        bridge.connected = false;
        broadcastUi({ type: "awt:bridge-state", bridge: bridgeInfo() });
      }
      if (token !== bridgeToken) return;
      attempt += 1;
      await sleep(Math.min(30000, 800 * Math.pow(1.7, Math.min(attempt, 8))));
    }
  })().finally(() => {
    if (token === bridgeToken) bridge.active = false;
  });
}

let bridgeAbort = null;

function handleBridgeEvent(base, event) {
  bridge.lastEventAt = Date.now();
  if (event.event === "ping" || !event.data) return;
  let payload;
  try {
    payload = JSON.parse(event.data);
  } catch {
    return;
  }
  if (payload && payload.ping) return;
  const id = payload && (payload.id || payload.call_id);
  const tool = payload && (payload.tool || payload.method);
  if (!id || !tool) return;
  const args = payload.args || payload.params || {};
  bridge.calls += 1;
  bridge.toolName = tool;
  runTool(String(tool), args)
    .then((result) => postJson(base + "/result", { id, ok: true, result }).catch(() => {}))
    .catch((error) => postJson(base + "/result", { id, ok: false, error: String((error && error.message) || error) }).catch(() => {}));
}

function broadcastUi(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {}
}

// ---------- 消息路由（弹窗 / 工作台 / 页面） ----------
async function uiState(options = {}) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const rules = sortRules(await getRules());
  const settings = await getSettings();
  const stored = await chrome.storage.local.get([PICK_KEY, "awt.pickState", MAIN_WORLD_KEY, "awt.userScriptsState.v1"]);
  const available = await userScriptsAvailable();
  const scriptState = stored["awt.userScriptsState.v1"] || null;
  // 用户刚在 chrome://extensions 打开了「允许用户脚本」：自动补一次注册
  if (available && (!scriptState || !scriptState.available)) syncUserScripts().catch(() => {});
  const activeInjectable = !!tab && injectable(tab);
  const pickTab = activeInjectable ? tab : await findPickTab(null);
  // page=active：只按当前活动页算命中/已应用（弹窗用），找不到就没有目标
  const strict = options.page === "active";
  const matchTab = activeInjectable ? tab : (strict ? null : pickTab);
  let status = null;
  if (matchTab && injectable(matchTab)) status = await tabStatus(matchTab.id).catch(() => null);
  return {
    version: VERSION,
    tab: tab ? { id: tab.id, url: tab.url || "", title: tab.title || "", windowId: tab.windowId } : null,
    injectable: activeInjectable,
    pickTab: pickTab ? { id: pickTab.id, url: pickTab.url || "", title: pickTab.title || "" } : null,
    rules: rules.map((rule) => ({
      ...ruleSummary(rule, matchTab ? matchTab.url : null),
      css: rule.css || "",
      js: rule.js || "",
      notes: rule.notes || "",
    })),
    settings,
    bridge: bridgeInfo(),
    status,
    lastPick: stored[PICK_KEY] || null,
    pickState: stored["awt.pickState"] || null,
    userScripts: available,
    scriptState,
    mainWorld: !!stored[MAIN_WORLD_KEY],
    extensionId: chrome.runtime.id,
  };
}

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case "awt:state":
      return await uiState({ page: msg.page });

    case "awt:save-rule": {
      const rule = await upsertRule(msg.rule || {});
      const applied = msg.apply ? await syncRuleToTabs(rule) : null;
      return { rule, applied };
    }

    case "awt:delete-rule": {
      await deleteRule(String(msg.id || ""));
      return { deleted: msg.id };
    }

    case "awt:toggle-rule": {
      const rules = await getRules();
      const rule = rules.find((r) => r.id === String(msg.id || ""));
      if (!rule) throw new Error("规则不存在");
      const next = await upsertRule({ ...rule, enabled: !!msg.enabled });
      await syncRuleToTabs(next);
      return { rule: next };
    }

    case "awt:batch": {
      const ids = (Array.isArray(msg.ids) ? msg.ids : []).map(String).filter(Boolean);
      if (!ids.length) throw new Error("没有选中规则");
      const action = String(msg.action || "");
      if (!["enable", "disable", "delete"].includes(action)) throw new Error("未知批量操作：" + action);
      const rules = await getRules();
      const targets = rules.filter((r) => ids.includes(r.id));
      if (!targets.length) return { updated: 0, deleted: 0 };

      if (action === "delete") {
        await saveRules(rules.filter((r) => !ids.includes(r.id)));
        await syncUserScripts();
        const tabs = await chrome.tabs.query({});
        for (const rule of targets) {
          await chrome.storage.local.remove(["awt.store." + rule.id, "awt.error." + rule.id]).catch(() => {});
          for (const tab of tabs) {
            if (injectable(tab) && ruleMatches(rule, tab.url)) await removeFromTab(tab.id, rule.id).catch(() => {});
          }
        }
        return { deleted: targets.length };
      }

      const enabled = action === "enable";
      const now = Date.now();
      const next = rules.map((rule) => (ids.includes(rule.id) ? { ...rule, enabled, updatedAt: now } : rule));
      await saveRules(next);
      await syncUserScripts();
      for (const rule of next.filter((r) => ids.includes(r.id))) {
        await syncRuleToTabs(rule).catch(() => {});
      }
      return { updated: targets.length, enabled };
    }

    case "awt:duplicate-rule": {
      const rules = await getRules();
      const source = rules.find((r) => r.id === String(msg.id || ""));
      if (!source) throw new Error("规则不存在");
      let id = slugId(source.id + "-copy");
      let n = 2;
      while (rules.some((r) => r.id === id)) id = slugId(source.id + "-copy-" + n++);
      const copy = await upsertRule({ ...source, id, name: source.name + " 副本" });
      return { rule: copy };
    }

    case "awt:reorder": {
      const ids = Array.isArray(msg.ids) ? msg.ids.map(String) : [];
      const rules = await getRules();
      const map = new Map(rules.map((r) => [r.id, r]));
      ids.forEach((id, index) => {
        const rule = map.get(id);
        if (rule) rule.order = (index + 1) * 10;
      });
      await saveRules([...map.values()]).catch(async () => {});
      return { ok: true };
    }

    case "awt:import": {
      return await runTool("rules.import", { data: msg.data, mode: msg.mode });
    }

    case "awt:export":
      return await runTool("rules.export", {});

    case "awt:apply": {
      const preferred = msg.tabId != null ? msg.tabId : (sender.tab && injectable(sender.tab) ? sender.tab.id : null);
      return await applyToTab(preferred, msg.id || "");
    }

    case "awt:remove":
      return await removeFromTab(msg.tabId, msg.id || "");

    case "awt:refresh-tab": {
      const tab = await findPickTab(msg.tabId);
      if (!tab) return { tabId: null, state: null };
      const state = await pageState(tab.id);
      return { tabId: tab.id, url: tab.url, state };
    }

    case "awt:pick-start": {
      const result = await injectPicker(msg.tabId);
      // 从工作台发起的拾取，点完自动切回去；从弹窗发起的，点完把弹窗重新打开
      pickReturnTabId = sender.tab && /^chrome-extension:/i.test(sender.tab.url || "") ? sender.tab.id : null;
      pickOpenPopupAfter = !sender.tab;
      return result;
    }

    case "awt:pick-cancel": {
      settlePick(null, new Error("用户取消拾取"));
      return { cancelled: true };
    }

    case "awt:picked": {
      const reference = msg.reference ? { ...msg.reference, pickedAt: Date.now() } : null;
      await chrome.storage.local.set({ [PICK_KEY]: reference, "awt.pickState": null });
      settlePick(reference);
      broadcastUi({ type: "awt:pick-result", reference });
      await restorePickSurface(sender);
      return { ok: true };
    }

    case "awt:pick-cancelled": {
      await chrome.storage.local.set({ "awt.pickState": null });
      settlePick(null, new Error("用户取消了拾取"));
      broadcastUi({ type: "awt:pick-cancelled" });
      pickOpenPopupAfter = false;
      await returnToPickOrigin();
      return { ok: true };
    }

    case "awt:applied": {
      const tabId = sender.tab && sender.tab.id;
      if (tabId != null) {
        const payload = msg.payload || {};
        const count = Array.isArray(payload.applied) ? payload.applied.length : 0;
        try {
          await chrome.action.setBadgeText({ tabId, text: count ? String(count) : "" });
          await chrome.action.setBadgeBackgroundColor({ tabId, color: "#4f46e5" });
        } catch {}
      }
      broadcastUi({ type: "awt:applied", payload: msg.payload, tabId });
      return { ok: true };
    }

    case "awt:screenshot":
      return await screenshot({ tabId: msg.tabId });

    case "awt:settings": {
      const next = await setSettings(msg.patch || {});
      if (msg.restartBridge !== false) ensureBridge(true);
      return { settings: next };
    }

    case "awt:bridge-restart": {
      ensureBridge(true);
      return { ok: true };
    }

    case "awt:open-studio": {
      await chrome.tabs.create({ url: chrome.runtime.getURL("src/ui/studio.html") });
      return { ok: true };
    }

    default:
      throw new Error("未知消息: " + msg.type);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("awt:")) return;
  Promise.resolve()
    .then(() => handleMessage(msg, sender))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
  return true;
});

// ---------- 生命周期 ----------
async function bootstrap() {
  const settings = await getSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  await syncMainWorld();
  ensureBridge(false);
}

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "awt-pick", title: "拾取元素并定制…", contexts: ["page", "selection"] });
    chrome.contextMenus.create({ id: "awt-apply", title: "应用 Web Tweaks 规则到此页", contexts: ["page"] });
    chrome.contextMenus.create({ id: "awt-studio", title: "打开 Agent Web Tweaks 工作台", contexts: ["page"] });
  });
  await bootstrap();
  if (details.reason === "install") {
    const settings = await getSettings();
    if (settings.openStudioOnInstall !== false) {
      chrome.tabs.create({ url: chrome.runtime.getURL("src/ui/studio.html") });
    }
  }
});

chrome.runtime.onStartup.addListener(() => { bootstrap(); });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "awt-bridge") ensureBridge(false);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === "awt-pick") await injectPicker(tab && tab.id);
    else if (info.menuItemId === "awt-apply") await applyToTab(tab && tab.id, "");
    else if (info.menuItemId === "awt-studio") await chrome.tabs.create({ url: chrome.runtime.getURL("src/ui/studio.html") });
  } catch (e) {
    console.error("[awt] 菜单操作失败", e);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "pick-element") return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && injectable(tab)) await injectPicker(tab.id);
  } catch (e) {
    console.error("[awt] 快捷键失败", e);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[RULES_KEY]) return;
  syncMainWorld();
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete" || !injectable(tab)) return;
  const rules = (await getRules()).filter((r) => r.enabled !== false && ruleMatches(r, tab.url));
  try {
    await chrome.action.setBadgeText({ tabId, text: rules.length ? String(rules.length) : "" });
  } catch {}
});

chrome.alarms.create("awt-bridge", { periodInMinutes: 0.5 });
bootstrap();
