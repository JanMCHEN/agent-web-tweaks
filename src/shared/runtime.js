// 规则运行时：一条规则 = 一个 userScript（USER_SCRIPT 或 MAIN 世界）。
//
// 为什么不用 eval：MV3 内容脚本的隔离世界受扩展 CSP 限制，`new Function` 会直接抛
// EvalError；而 chrome.userScripts 执行的是浏览器注入的脚本，不受页面 CSP 影响。
// 所以规则 JS 一律走 userScripts，代码在构建字符串时就拼好（运行期不需要编译字符串）。
//
// 每条规则独立注册：一条规则写坏不会影响别的规则。

export function buildRuleScript(rule, env, world = "USER_SCRIPT") {
  const meta = JSON.stringify({
    id: rule.id,
    name: rule.name || rule.id,
    match: rule.match || [],
    exclude: rule.exclude || [],
    updatedAt: rule.updatedAt || 0,
  });
  const envJson = JSON.stringify(env && typeof env === "object" ? env : {});
  const body = String(rule.js || "");

  return `(() => {
  const META = ${meta};
  const ENV = ${envJson};
  const WORLD = ${JSON.stringify(world)};
  const ERROR_KEY = "awt.error." + META.id;
  const STORE_KEY = "awt.store." + META.id;

  const toSource = (p) => {
    let s = String(p || "").trim();
    if (!s) return null;
    if (!/^[a-z*][a-z0-9+.-]*:\\/\\//i.test(s)) s = "*://" + s.replace(/^\\/+/, "");
    let out = "";
    for (const ch of s) {
      if (ch === "*") out += ".*";
      else if (ch === "?") out += ".";
      else out += ch.replace(/[.+^\${}()|[\\]\\\\]/g, "\\\\$&");
    }
    return "^" + out + "$";
  };

  const cache = new Map();
  const matchOne = (p, url) => {
    const src = toSource(p);
    if (!src) return false;
    let re = cache.get(src);
    if (!re) { try { re = new RegExp(src, "i"); } catch (e) { return false; } cache.set(src, re); }
    return re.test(url);
  };
  const matches = (url) => {
    if (!META.match.length || !META.match.some((p) => matchOne(p, url))) return false;
    return !META.exclude.some((p) => matchOne(p, url));
  };

  const cleanups = [];
  const add = (fn) => { if (typeof fn === "function") cleanups.push(fn); return () => { const i = cleanups.indexOf(fn); if (i >= 0) cleanups.splice(i, 1); }; };

  const note = (err) => {
    const message = String((err && err.message) || err || "未知错误");
    try { localStorage.setItem(ERROR_KEY, JSON.stringify({ message: message, at: Date.now() })); } catch (e) {}
    try { console.error("[awt:" + META.id + "] " + message, err); } catch (e) {}
  };
  const clearNote = () => { try { localStorage.removeItem(ERROR_KEY); } catch (e) {} };

  const routeHooks = new Set();

  const tweak = {
    id: META.id,
    name: META.name,
    url: location.href,
    world: WORLD === "MAIN" ? "MAIN" : "ISOLATED",
    isTop: window.top === window,
    env: ENV,
    $: (sel, root) => { try { return (root || document).querySelector(sel); } catch (e) { return null; } },
    $$: (sel, root) => { try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); } catch (e) { return []; } },
    css(text) {
      if (!text) return () => {};
      const style = document.createElement("style");
      style.dataset.awt = META.id + ":inline";
      style.textContent = String(text);
      (document.head || document.documentElement).appendChild(style);
      return add(() => style.remove());
    },
    onCleanup: add,
    ready(fn) {
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, { once: true });
      else { try { fn(); } catch (e) { note(e); } }
    },
    waitFor(selector, options) {
      options = options || {};
      const timeout = Number(options.timeout || 15000);
      const root = options.root || document;
      return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (done) return; done = true; try { obs.disconnect(); } catch (e) {} clearTimeout(timer); resolve(v); };
        let obs;
        try {
          obs = new MutationObserver(() => { const el = root.querySelector(selector); if (el) finish(el); });
          obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
        } catch (e) { return resolve(root.querySelector(selector) || null); }
        const timer = setTimeout(() => finish(null), timeout);
        add(() => { if (!done) { done = true; try { obs.disconnect(); } catch (e) {} clearTimeout(timer); } });
        const found = root.querySelector(selector);
        if (found) finish(found);
      });
    },
    waitForText(text, options) {
      options = options || {};
      const timeout = Number(options.timeout || 15000);
      const needle = String(text);
      const hit = () => {
        const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) if (node.nodeValue && node.nodeValue.includes(needle)) return node.parentElement;
        return null;
      };
      return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (done) return; done = true; try { obs.disconnect(); } catch (e) {} clearTimeout(timer); resolve(v); };
        const obs = new MutationObserver(() => { const el = hit(); if (el) finish(el); });
        obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
        const timer = setTimeout(() => finish(null), timeout);
        add(() => { if (!done) { done = true; try { obs.disconnect(); } catch (e) {} clearTimeout(timer); } });
        const found = hit();
        if (found) finish(found);
      });
    },
    observe(callback, options) {
      options = options || {};
      const target = options.target || document.documentElement;
      let timer = null;
      const run = () => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          try { callback(options.selector ? document.querySelector(options.selector) : null); } catch (e) { note(e); }
        }, Number(options.throttleMs || 80));
      };
      const obs = new MutationObserver(run);
      obs.observe(target, {
        attributes: options.attributes !== false,
        childList: options.childList !== false,
        characterData: !!options.characterData,
        subtree: options.subtree !== false,
      });
      add(() => { try { obs.disconnect(); } catch (e) {} });
      if (options.immediate) run();
      return () => { try { obs.disconnect(); } catch (e) {} };
    },
    onRoute(fn) {
      if (typeof fn !== "function") return () => {};
      routeHooks.add(fn);
      return add(() => routeHooks.delete(fn));
    },
    log: (...args) => { try { console.log("[awt:" + META.id + "]", ...args); } catch (e) {} },
    store: {
      get(key, fallback) {
        try {
          const all = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
          return key == null ? all : (all[key] === undefined ? fallback : all[key]);
        } catch (e) { return fallback; }
      },
      set(key, value) {
        try {
          const all = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
          all[key] = value;
          localStorage.setItem(STORE_KEY, JSON.stringify(all));
          return true;
        } catch (e) { return false; }
      },
    },
  };

  let appliedUrl = "";

  const remove = () => {
    while (cleanups.length) { try { cleanups.pop()(); } catch (e) {} }
    appliedUrl = "";
    try { delete window.__awtRules[META.id]; } catch (e) {}
  };

  async function run(tweakApi, env) {
${body}
  }

  const apply = () => {
    const NativeMO = window.MutationObserver;
    let restore = null;
    try {
      if (typeof NativeMO === "function") {
        window.MutationObserver = class extends NativeMO {
          constructor(callback) {
            let windowStart = performance.now();
            let count = 0;
            let tripped = false;
            super(function (records, observer) {
              const now = performance.now();
              if (now - windowStart > 1000) { windowStart = now; count = 0; }
              count += 1;
              if (count > 3000) {
                if (!tripped) { tripped = true; try { observer.disconnect(); } catch (e) {} note("MutationObserver 回调异常频繁，已自动断开"); }
                return;
              }
              try { return callback(records, observer); } catch (e) { note(e); }
            });
          }
        };
        restore = () => { window.MutationObserver = NativeMO; };
      }
    } catch (e) {}
    const task = run(tweak, ENV);
    Promise.resolve(task).then(clearNote, note);
    if (restore) { try { restore(); } catch (e) {} }
    appliedUrl = location.href;
  };

  const tick = () => {
    if (!matches(location.href)) { if (appliedUrl) remove(); return; }
    if (appliedUrl && appliedUrl !== location.href) {
      routeHooks.forEach((fn) => { try { fn({ from: appliedUrl, to: location.href }); } catch (e) { note(e); } });
      appliedUrl = location.href;
    }
    if (!appliedUrl) apply();
  };

  window.__awtRules = window.__awtRules || {};
  const previous = window.__awtRules[META.id];
  if (previous && typeof previous.remove === "function") { try { previous.remove(); } catch (e) {} }
  window.__awtRules[META.id] = { remove: remove, apply: apply, meta: META, world: WORLD };

  if (matches(location.href)) apply();
  addEventListener("popstate", tick);
  addEventListener("hashchange", tick);
  setInterval(tick, 700);
})();`;
}
