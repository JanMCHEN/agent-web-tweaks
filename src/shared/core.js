// 规则模型：后台、弹窗、工作台、桥共用同一份定义。
// 这里只放纯函数，不碰 chrome.*，方便在 Node 里做单测。

export const RULES_KEY = "awt.rules.v1";
export const SETTINGS_KEY = "awt.settings.v1";
export const PICK_KEY = "awt.lastPick.v1";
export const STATUS_KEY = "awt.tabStatus.v1";
export const MAIN_WORLD_KEY = "awt.mainWorldActive";

export const DEFAULT_BRIDGE = "http://127.0.0.1:8787";

export const DEFAULT_SETTINGS = {
  bridgeUrl: DEFAULT_BRIDGE,
  bridgeToken: "",
  autoApply: true,
  openStudioOnInstall: true,
};

export const WORLDS = ["ISOLATED", "MAIN"];

export const TEMPLATES = [
  {
    id: "hide",
    name: "隐藏元素",
    desc: "用 CSS 把匹配到的元素藏起来（保留占位）",
    css: "/* 把下面的 SELECTOR 换成元素选择器 */\nSELECTOR {\n  display: none !important;\n}\n",
    js: "",
    world: "ISOLATED",
    match: ["https://example.com/*"],
  },
  {
    id: "remove",
    name: "删除元素",
    desc: "等元素出现后直接从 DOM 里删掉",
    css: "",
    js: "// 把 SELECTOR 换成元素选择器\ntweak.waitFor(\"SELECTOR\").then((el) => el.remove());\n",
    world: "ISOLATED",
    match: ["https://example.com/*"],
  },
  {
    id: "restyle",
    name: "改写样式",
    desc: "覆盖站点的颜色、字号、布局",
    css: ":root {\n  --awt-accent: #4f46e5;\n}\n\nbody {\n  letter-spacing: .01em;\n}\n",
    js: "",
    world: "ISOLATED",
    match: ["https://example.com/*"],
  },
  {
    id: "text",
    name: "改文案",
    desc: "替换页面上的一段文字",
    css: "",
    js: "const el = await tweak.waitFor(\"SELECTOR\");\nel.textContent = \"新的文字\";\n",
    world: "ISOLATED",
    match: ["https://example.com/*"],
  },
  {
    id: "autoclick",
    name: "自动点击",
    desc: "页面加载后自动点某个按钮 / 展开某个面板",
    css: "",
    js: "const btn = await tweak.waitFor(\"SELECTOR\");\nbtn.click();\n",
    world: "ISOLATED",
    match: ["https://example.com/*"],
  },
  {
    id: "cleanup",
    name: "清理页面",
    desc: "去广告、去浮层、去水印，可叠多条选择器",
    css: "/* 一行一个选择器 */\n.awt-ad,\n[class*=\"banner\"],\n[class*=\"watermark\"] {\n  display: none !important;\n}\n",
    js: "",
    world: "ISOLATED",
    match: ["*://*/*"],
  },
];

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidId(id) {
  return ID_RE.test(String(id || ""));
}

export function slugId(name) {
  const base = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 40);
  if (!base) return "rule-" + Math.random().toString(36).slice(2, 8);
  return isValidId(base) ? base : "rule-" + Math.random().toString(36).slice(2, 8);
}

function asStringArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/[\n,]/)
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

/** 补全协议：`example.com/*` → `*://example.com/*` */
export function normalizePattern(pattern) {
  const p = String(pattern || "").trim();
  if (!p) return "";
  if (/^[a-z*][a-z0-9+.-]*:\/\//i.test(p)) return p;
  if (/^(about|data|file|chrome|blob):/i.test(p)) return p;
  return "*://" + p.replace(/^\/+/, "");
}

const regexCache = new Map();

export function globToRegExpSource(pattern) {
  const p = normalizePattern(pattern);
  if (!p) return null;
  let out = "";
  for (const ch of p) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return "^" + out + "$";
}

export function matchesPattern(pattern, url) {
  const source = globToRegExpSource(pattern);
  if (!source) return false;
  let re = regexCache.get(source);
  if (!re) {
    try {
      re = new RegExp(source, "i");
    } catch {
      return false;
    }
    regexCache.set(source, re);
  }
  return re.test(String(url || ""));
}

export function ruleMatches(rule, url) {
  if (!rule) return false;
  const match = asStringArray(rule.match);
  if (!match.length) return false;
  const target = String(url || "");
  if (!match.some((p) => matchesPattern(p, target))) return false;
  const exclude = asStringArray(rule.exclude);
  if (exclude.some((p) => matchesPattern(p, target))) return false;
  return true;
}

export function normalizeRule(input = {}, prev = {}) {
  const now = Date.now();
  const name = String(input.name ?? prev.name ?? "").trim();
  const rawId = String(input.id ?? prev.id ?? "").trim();
  const id = isValidId(rawId) ? rawId : slugId(name);
  const match = input.match === undefined ? asStringArray(prev.match) : asStringArray(input.match);
  const exclude = input.exclude === undefined ? asStringArray(prev.exclude) : asStringArray(input.exclude);
  const world = String(input.world ?? prev.world ?? "ISOLATED").toUpperCase() === "MAIN" ? "MAIN" : "ISOLATED";
  return {
    id,
    name: name || id,
    desc: String(input.desc ?? prev.desc ?? ""),
    match: [...new Set(match.map(normalizePattern))],
    exclude: [...new Set(exclude.map(normalizePattern))],
    css: String(input.css ?? prev.css ?? ""),
    js: String(input.js ?? prev.js ?? ""),
    world,
    order: Number.isFinite(Number(input.order ?? prev.order)) ? Number(input.order ?? prev.order) : 100,
    enabled: input.enabled === undefined ? prev.enabled !== false : !!input.enabled,
    notes: String(input.notes ?? prev.notes ?? ""),
    createdAt: Number(prev.createdAt || now),
    updatedAt: now,
    source: String(input.source ?? prev.source ?? "local"),
  };
}

export function validateRule(rule) {
  const errors = [];
  if (!rule || !isValidId(rule.id)) {
    errors.push("id 需以字母或数字开头，只能包含字母、数字、. _ -，最长 64 位");
  }
  if (!rule.name) errors.push("name 不能为空");
  if (!Array.isArray(rule.match) || !rule.match.length) errors.push("match 至少需要一条 URL 通配符");
  for (const p of rule.match || []) {
    if (globToRegExpSource(p) == null) errors.push(`match 不合法：${p}`);
  }
  if (!rule.css && !rule.js) errors.push("css 与 js 至少要有一样");
  if (rule.world && !WORLDS.includes(rule.world)) errors.push("world 只能是 ISOLATED 或 MAIN");
  return errors;
}

export function sortRules(rules) {
  return [...rules].sort((a, b) => {
    const oa = Number(a.order ?? 100);
    const ob = Number(b.order ?? 100);
    if (oa !== ob) return oa - ob;
    return String(a.id).localeCompare(String(b.id));
  });
}

export function ruleSummary(rule, url) {
  return {
    id: rule.id,
    name: rule.name,
    desc: rule.desc || "",
    match: rule.match,
    exclude: rule.exclude || [],
    enabled: rule.enabled !== false,
    world: rule.world || "ISOLATED",
    order: rule.order ?? 100,
    has_css: !!rule.css,
    has_js: !!rule.js,
    css_size: (rule.css || "").length,
    js_size: (rule.js || "").length,
    updatedAt: rule.updatedAt || null,
    matched: url == null ? null : ruleMatches(rule, url),
  };
}

export function dedupeRules(list) {
  const map = new Map();
  for (const raw of list || []) {
    if (!raw || typeof raw !== "object") continue;
    const rule = normalizeRule(raw);
    if (!isValidId(rule.id)) continue;
    map.set(rule.id, rule);
  }
  return [...map.values()];
}
