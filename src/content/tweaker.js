// Agent Web Tweaks —— 页面侧运行时（CSS 部分）。
//
// 规则里的 JS 由 background 用 chrome.userScripts 注入（不受页面 CSP 限制，
// 也不会踩到 MV3 内容脚本的 eval 禁令）；这里只负责：
//   1. document_start 直读 storage，尽早把 CSS 落下去
//   2. SPA 路由变化时增删样式
//   3. 把「实际应用了哪些规则 / 有没有报错」回报给后台
(() => {
  if (window.__awt) return;

  const RULES_KEY = "awt.rules.v1";
  const SETTINGS_KEY = "awt.settings.v1";
  const ERROR_PREFIX = "awt.error.";

  const state = {
    rules: [],
    settings: {},
    applied: new Map(), // id -> [cleanup]
    lastUrl: location.href,
  };

  // ---------- 匹配 ----------
  const regexCache = new Map();

  function normalizePattern(p) {
    const s = String(p || "").trim();
    if (!s) return "";
    if (/^[a-z*][a-z0-9+.-]*:\/\//i.test(s)) return s;
    if (/^(about|data|file|chrome|blob):/i.test(s)) return s;
    return "*://" + s.replace(/^\/+/, "");
  }

  function patternToSource(p) {
    const s = normalizePattern(p);
    if (!s) return null;
    let out = "";
    for (const ch of s) {
      if (ch === "*") out += ".*";
      else if (ch === "?") out += ".";
      else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return "^" + out + "$";
  }

  function matchesPattern(p, url) {
    const src = patternToSource(p);
    if (!src) return false;
    let re = regexCache.get(src);
    if (!re) {
      try { re = new RegExp(src, "i"); } catch { return false; }
      regexCache.set(src, re);
    }
    return re.test(String(url || ""));
  }

  function ruleMatches(rule, url) {
    const match = Array.isArray(rule.match) ? rule.match : [];
    if (!match.length) return false;
    if (!match.some((p) => matchesPattern(p, url))) return false;
    const exclude = Array.isArray(rule.exclude) ? rule.exclude : [];
    return !exclude.some((p) => matchesPattern(p, url));
  }

  const byOrder = (a, b) => (Number(a.order ?? 100) - Number(b.order ?? 100)) || String(a.id).localeCompare(String(b.id));

  // ---------- 回报 ----------
  function readRuleErrors(ids) {
    const errors = [];
    for (const id of ids) {
      try {
        const raw = localStorage.getItem(ERROR_PREFIX + id);
        if (!raw) continue;
        const item = JSON.parse(raw);
        if (item && item.message) errors.push({ id, message: String(item.message), at: item.at });
      } catch {}
    }
    return errors.slice(-10);
  }

  let reportTimer = null;
  let lastPayload = "";

  function report(now = false) {
    const send = () => {
      reportTimer = null;
      const ids = [...state.applied.keys()];
      const payload = {
        url: location.href,
        applied: ids,
        errors: readRuleErrors(ids),
        top: window.top === window,
        frame: window.frameElement ? "iframe" : "top",
      };
      const key = JSON.stringify(payload);
      if (key === lastPayload) return;
      lastPayload = key;
      try {
        chrome.runtime.sendMessage({ type: "awt:applied", payload }).catch(() => {});
      } catch {}
    };
    if (now) send();
    else if (!reportTimer) reportTimer = setTimeout(send, 120);
  }

  // ---------- 应用 CSS ----------
  function applyCss(rule) {
    if (state.applied.has(rule.id)) return;
    const cleanups = [];
    state.applied.set(rule.id, cleanups);
    if (!rule.css) return;
    try {
      const style = document.createElement("style");
      style.dataset.awt = rule.id;
      style.textContent = String(rule.css);
      (document.head || document.documentElement).appendChild(style);
      cleanups.push(() => style.remove());
    } catch (e) {
      try { console.warn("[awt:" + rule.id + "] 样式注入失败", e); } catch {}
    }
  }

  function removeRule(id) {
    const cleanups = state.applied.get(id);
    if (!cleanups) return false;
    state.applied.delete(id);
    while (cleanups.length) { try { cleanups.pop()(); } catch {} }
    return true;
  }

  function applyForUrl(url) {
    const desired = state.rules.filter((rule) => rule.enabled !== false && ruleMatches(rule, url));
    const keep = new Set(desired.map((r) => r.id));
    for (const id of [...state.applied.keys()]) if (!keep.has(id)) removeRule(id);
    for (const rule of desired) applyCss(rule);
    report();
  }

  // ---------- 跨域请求中转 ----------
  // 规则脚本（USER_SCRIPT / MAIN 世界）没有 chrome.*，dispatch 一个事件过来，
  // 这里转给 background 用扩展身份 fetch，再把结果 dispatch 回去。
  function installHttpBridge() {
    window.addEventListener("awt:http-request", (event) => {
      let req = null;
      try { req = JSON.parse(String(event.detail || "")); } catch { return; }
      if (!req || !req.id) return;
      const reply = (payload) => {
        try {
          window.dispatchEvent(new CustomEvent("awt:http-result", {
            detail: JSON.stringify({ id: req.id, ...payload }),
          }));
        } catch {}
      };
      try {
        chrome.runtime.sendMessage({ type: "awt:fetch", request: req }).then((resp) => {
          if (resp && resp.ok === false) reply({ error: resp.error || "请求失败" });
          else reply((resp && resp.result) || {});
        }).catch((e) => reply({ error: String((e && e.message) || e) }));
      } catch (e) {
        reply({ error: String((e && e.message) || e) });
      }
    });
  }

  // ---------- 生命周期 ----------
  async function reload() {
    let data;
    try {
      data = await chrome.storage.local.get([RULES_KEY, SETTINGS_KEY]);
    } catch {
      return;
    }
    const map = data[RULES_KEY] || {};
    state.rules = Object.values(map).filter((r) => r && r.id).sort(byOrder);
    state.settings = data[SETTINGS_KEY] || {};
    applyForUrl(location.href);
  }

  function onNavigate() {
    if (location.href === state.lastUrl) return;
    state.lastUrl = location.href;
    applyForUrl(location.href);
  }

  setInterval(onNavigate, 700);
  addEventListener("popstate", onNavigate);
  addEventListener("hashchange", onNavigate);

  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg.type !== "string") return;
      if (msg.type === "awt:page-state") {
        sendResponse({
          ok: true,
          result: {
            url: location.href,
            top: window.top === window,
            applied: [...state.applied.keys()],
            errors: readRuleErrors([...state.applied.keys()]),
          },
        });
        return true;
      }
      if (msg.type === "awt:page-apply") {
        const rules = Array.isArray(msg.rules) ? msg.rules : [];
        for (const rule of rules) {
          if (rule && rule.enabled !== false && ruleMatches(rule, location.href)) applyCss(rule);
        }
        report(true);
        sendResponse({ ok: true, result: { applied: [...state.applied.keys()] } });
        return true;
      }
      if (msg.type === "awt:page-remove") {
        if (msg.id) removeRule(msg.id);
        else for (const id of [...state.applied.keys()]) removeRule(id);
        report(true);
        sendResponse({ ok: true, result: { applied: [...state.applied.keys()] } });
        return true;
      }
      if (msg.type === "awt:page-refresh") {
        reload().then(() => sendResponse({ ok: true, result: { applied: [...state.applied.keys()] } }));
        return true;
      }
      return;
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[RULES_KEY] || changes[SETTINGS_KEY]) reload();
    });
  } catch {}

  window.__awt = {
    version: "0.1.0",
    list: () => ({ url: location.href, applied: [...state.applied.keys()], errors: readRuleErrors([...state.applied.keys()]) }),
    refresh: reload,
  };

  installHttpBridge();
  reload();
})();
