// 把 Tampermonkey / Violentmonkey 的 .user.js 解析成一条规则。
// 只做纯函数，方便在 Node 里单测。

const META_RE = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/;

export function parseUserScript(source) {
  const text = String(source || "").replace(/^\uFEFF/, "");
  const hit = META_RE.exec(text);
  if (!hit) throw new Error("没有找到 ==UserScript== 元数据块，这不是一个用户脚本");
  const meta = {};
  for (const line of hit[1].split(/\r?\n/)) {
    const m = /^\s*\/\/\s*@([A-Za-z0-9:_-]+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    (meta[key] ||= []).push(m[2].trim());
  }
  const body = text.slice(hit.index + hit[0].length).replace(/^\s*\r?\n/, "");
  return { meta, body, rawMeta: hit[0] };
}

function isRegexPattern(value) {
  return /^\/.*\/[a-z]*$/s.test(value);
}

function shortHash(input) {
  let h = 5381;
  for (const ch of String(input)) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
  return h.toString(36).slice(0, 5);
}

function slug(text) {
  const base = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 32);
  return base || "script";
}

/** 解析并转换成一条 Agent Web Tweaks 规则 */
export function userScriptToRule(source, options = {}) {
  const { filename = "" } = options;
  const { meta, body } = parseUserScript(source);
  const warnings = [];
  const first = (key) => (meta[key] && meta[key][0]) || "";
  const name = first("name") || filename.replace(/\.user\.js$/i, "") || "导入的脚本";

  const match = [];
  for (const value of [...(meta.match || []), ...(meta.include || [])]) {
    if (!value) continue;
    if (isRegexPattern(value)) {
      warnings.push("跳过正则形式的 @match/@include：" + value);
      continue;
    }
    match.push(value === "<all_urls>" ? "*://*/*" : value);
  }
  if (!match.length) throw new Error("脚本没有可用的 @match / @include（正则形式暂不支持）");

  const exclude = [];
  for (const value of meta.exclude || []) {
    if (!value) continue;
    if (isRegexPattern(value)) {
      warnings.push("跳过正则形式的 @exclude：" + value);
      continue;
    }
    exclude.push(value === "<all_urls>" ? "*://*/*" : value);
  }

  const grants = (meta.grant || []).filter(Boolean);
  const noGrant = !grants.length || grants.every((g) => g === "none");
  const world = noGrant ? "MAIN" : "ISOLATED";
  if (!noGrant) {
    warnings.push("脚本声明了 @grant " + grants.join(", ") + "：只提供 GM_addStyle / GM_getValue / GM_setValue / GM_deleteValue / GM_listValues / GM_log / GM_xmlhttpRequest 的兼容实现");
  }
  if ((meta.require || []).length) {
    warnings.push("@require 不会自动下载：" + meta.require.join(", "));
  }
  if ((meta.resource || []).length) {
    warnings.push("@resource 暂不支持");
  }
  if (meta.noframes) {
    warnings.push("原脚本有 @noframes：本扩展的规则会在所有 frame 里执行");
  }
  const runAt = first("run-at");
  if (runAt && runAt !== "document-start") {
    warnings.push("@run-at " + runAt + " 已忽略：规则统一在 document_start 执行，需要 DOM 时用 tweak.ready / tweak.waitFor");
  }

  const namespace = first("namespace");
  const description = [first("description"), namespace ? "@namespace " + namespace : ""].filter(Boolean).join("\n");
  const id = "us-" + slug(name) + "-" + shortHash(namespace + "|" + name + "|" + filename);

  return {
    rule: {
      id: id.slice(0, 64),
      name,
      desc: description || "从 .user.js 导入",
      match,
      exclude,
      css: "",
      js: body,
      world,
      order: 100,
      enabled: true,
      notes: [
        "来源：用户脚本" + (filename ? "（" + filename + "）" : ""),
        ...grants.map((g) => "@grant " + g),
        ...(meta.version || []).map((v) => "@version " + v),
      ].join("\n"),
    },
    meta,
    warnings,
  };
}

export function looksLikeUserScript(text) {
  return META_RE.test(String(text || ""));
}
