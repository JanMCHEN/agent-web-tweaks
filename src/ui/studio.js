import { TEMPLATES, slugId, isValidId, ruleMatches } from "../shared/core.js";

const $ = (id) => document.getElementById(id);

const app = {
  rules: [],
  settings: {},
  bridge: {},
  tab: null,
  status: null,
  lastPick: null,
  userScripts: null,
  mainWorld: false,
};

let draft = null;
let dirty = false;
let saveTimer = null;
let activeTab = "css";
let selectedId = null;

async function send(type, payload = {}) {
  const resp = await chrome.runtime.sendMessage({ type, ...payload });
  if (!resp) throw new Error("扩展后台没有响应");
  if (resp.ok === false) throw new Error(resp.error || "操作失败");
  return resp.result;
}

function toast(text, bad = false) {
  const el = $("toast");
  el.textContent = text;
  el.classList.toggle("bad", bad);
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 2400);
}

function flashSaved() {
  const el = $("savedHint");
  el.textContent = "已保存";
  el.classList.add("show");
  clearTimeout(flashSaved.timer);
  flashSaved.timer = setTimeout(() => el.classList.remove("show"), 1200);
}

function splitLines(value) {
  return String(value || "")
    .split("\n")
    .map((v) => v.trim())
    .filter(Boolean);
}

function isExtensionUrl(url) {
  return /^chrome-extension:/i.test(String(url || ""));
}

function pickTarget() {
  if (app.pickTab) return app.pickTab;
  if (app.tab && !isExtensionUrl(app.tab.url)) return app.tab;
  return null;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url || "-";
  }
}

function currentPattern() {
  try {
    const target = pickTarget();
    const u = new URL((target && target.url) || "");
    return [u.origin + (u.pathname === "/" ? "/*" : u.pathname + "*")];
  } catch {
    return ["https://example.com/*"];
  }
}

// ---------- 渲染 ----------
const collapsedGroups = new Set();
let selectMode = false;
const selected = new Set();

function groupKeyOf(rule) {
  const pattern = (rule.match || [])[0] || "";
  if (!pattern) return "未设置 URL";
  try {
    const url = new URL(pattern.replace(/^\*:\/\//, "https://"));
    const host = decodeURIComponent(url.host || "");
    if (!host || host === "*") return "所有站点";
    return host;
  } catch {
    return pattern;
  }
}

function renderList() {
  const keyword = $("searchInput").value.trim().toLowerCase();
  const list = $("ruleList");
  list.innerHTML = "";
  const rules = [...app.rules].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
  const filtered = rules.filter((rule) => {
    if (!keyword) return true;
    return rule.id.toLowerCase().includes(keyword)
      || (rule.name || "").toLowerCase().includes(keyword)
      || (rule.match || []).join(" ").toLowerCase().includes(keyword)
      || (rule.desc || "").toLowerCase().includes(keyword);
  });
  $("ruleTotal").textContent = rules.length + " 条";
  $("batchBar").hidden = !selectMode;
  $("selectAll").checked = filtered.length > 0 && filtered.every((r) => selected.has(r.id));
  $("selCount").textContent = "已选 " + selected.size;

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.style.padding = "12px 8px";
    empty.textContent = rules.length ? "没有匹配的规则" : "还没有规则，点「新建」开始";
    list.appendChild(empty);
    return;
  }

  const groups = new Map();
  for (const rule of filtered) {
    const key = groupKeyOf(rule);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rule);
  }
  const order = [...groups.keys()].sort((a, b) => {
    if (a === "所有站点") return 1;
    if (b === "所有站点") return -1;
    return a.localeCompare(b);
  });

  for (const key of order) {
    const items = groups.get(key);
    const group = document.createElement("div");
    group.className = "group" + (collapsedGroups.has(key) ? " collapsed" : "");

    const head = document.createElement("div");
    head.className = "group-head";

    if (selectMode) {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = items.every((r) => selected.has(r.id));
      box.addEventListener("click", (event) => event.stopPropagation());
      box.addEventListener("change", () => {
        if (box.checked) items.forEach((r) => selected.add(r.id));
        else items.forEach((r) => selected.delete(r.id));
        renderList();
      });
      head.appendChild(box);
    }

    const caret = document.createElement("button");
    caret.className = "caret";
    caret.textContent = collapsedGroups.has(key) ? "▸" : "▾";
    const name = document.createElement("span");
    name.className = "group-name";
    name.textContent = key;
    name.title = key;
    const count = document.createElement("span");
    count.className = "group-count";
    count.textContent = String(items.length);

    head.append(caret, name, count);
    head.addEventListener("click", () => {
      if (collapsedGroups.has(key)) collapsedGroups.delete(key);
      else collapsedGroups.add(key);
      renderList();
    });
    group.appendChild(head);

    const body = document.createElement("div");
    body.className = "group-body";
    for (const rule of items) body.appendChild(renderRuleItem(rule));
    group.appendChild(body);
    list.appendChild(group);
  }
}

function renderRuleItem(rule) {
  const item = document.createElement("div");
  item.className = "rule-item" + (rule.id === selectedId ? " active" : "") + (rule.enabled ? "" : " off");
  item.dataset.id = rule.id;

  if (selectMode) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "sel";
    box.checked = selected.has(rule.id);
    box.addEventListener("click", (event) => event.stopPropagation());
    box.addEventListener("change", () => {
      if (box.checked) selected.add(rule.id);
      else selected.delete(rule.id);
      renderList();
    });
    item.appendChild(box);
  }

  const state = document.createElement("span");
  state.className = "state" + ((app.status && (app.status.applied || []).includes(rule.id)) ? " on" : "");
  state.title = state.className.includes("on") ? "已应用到当前页面" : "";

  const body = document.createElement("div");
  body.className = "body";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = rule.name || rule.id;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = (rule.match || []).join("  ·  ") || "未设置匹配";
  body.appendChild(name);
  body.appendChild(meta);

  const tags = document.createElement("div");
  tags.style.display = "flex";
  tags.style.gap = "4px";
  tags.style.alignItems = "center";
  if (rule.matched) {
    const hit = document.createElement("span");
    hit.className = "hit";
    hit.textContent = "命中";
    tags.appendChild(hit);
  }
  if (rule.world === "MAIN") {
    const tag = document.createElement("span");
    tag.className = "main-tag";
    tag.textContent = "MAIN";
    tags.appendChild(tag);
  }

  const mini = document.createElement("label");
  mini.className = "mini-switch";
  // 开关自己处理点击：不然冒泡到整行会触发 selectRule → 重渲染，label 的切换动作被打断
  mini.addEventListener("click", (event) => event.stopPropagation());
  mini.title = rule.enabled ? "停用" : "启用";
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = rule.enabled;
  toggle.addEventListener("click", (event) => event.stopPropagation());
  toggle.addEventListener("change", async () => {
    try {
      await send("awt:toggle-rule", { id: rule.id, enabled: toggle.checked });
      await load();
    } catch (e) {
      toggle.checked = !toggle.checked;
      toast(e.message, true);
    }
  });
  mini.append(toggle, document.createElement("span"));

  item.append(state, body, tags, mini);
  item.addEventListener("click", () => {
    // 批量模式下点整行 = 勾选，不进编辑器
    if (selectMode) {
      if (selected.has(rule.id)) selected.delete(rule.id);
      else selected.add(rule.id);
      renderList();
      return;
    }
    selectRule(rule.id);
  });
  return item;
}

function renderRail() {
  const target = pickTarget();
  const showTarget = !app.tab || isExtensionUrl(app.tab.url);
  $("railTitle").textContent = showTarget
    ? (target ? target.title || "可定制的页面" : "没有可定制的网页")
    : (app.tab && app.tab.title) || "当前标签页";
  $("railUrl").textContent = showTarget ? (target ? shortUrl(target.url) : "-") : shortUrl(app.tab && app.tab.url);
  $("railHead").textContent = showTarget ? "可定制的页面" : "当前标签页";
  const btn = $("pickBtn");
  btn.disabled = !target;
  btn.title = target ? "在 " + shortUrl(target.url) + " 上拾取" : "先打开一个普通网页";

  const errors = $("errorList");
  errors.innerHTML = "";
  const errorList = (app.status && app.status.errors) || [];
  for (const err of errorList) {
    const line = document.createElement("div");
    line.className = "error-line";
    line.textContent = err.id + " · " + err.message;
    errors.appendChild(line);
  }
  $("errorCard").hidden = !errorList.length;

  if (app.lastPick) {
    $("pickCard").hidden = false;
    $("pickSelector").textContent = app.lastPick.selector || "(无选择器)";
    $("pickMeta").textContent = [app.lastPick.tag, app.lastPick.text ? "「" + app.lastPick.text.slice(0, 90) + "」" : ""].filter(Boolean).join(" · ");
  } else {
    $("pickCard").hidden = true;
  }

  $("usCard").hidden = app.userScripts !== false;
  const sub = $("bridgeSub");
  sub.classList.remove("on", "off");
  if (app.bridge && app.bridge.connected) {
    sub.classList.add("on");
    sub.textContent = "本地桥已连接 · " + (app.bridge.url || "");
  } else if (app.bridge && app.bridge.active) {
    sub.classList.add("off");
    sub.textContent = "本地桥未连接" + (app.bridge.error ? " · " + app.bridge.error : "");
  } else {
    sub.textContent = "本地桥未启动";
  }
}

function renderWelcomeTarget() {
  const target = pickTarget();
  $("welcomeUrl").textContent = target ? shortUrl(target.url) : "当前没有可定制的网页（先打开一个普通页面）";
  const btn = $("welcomePick");
  btn.disabled = !target;
  btn.title = target ? "在 " + shortUrl(target.url) + " 上拾取" : "先打开一个普通网页";
}

function renderEditor() {
  const editorVisible = !!draft;
  $("editor").hidden = !editorVisible;
  $("welcome").hidden = editorVisible;
  if (!draft) {
    renderWelcomeTarget();
    return;
  }

  $("nameInput").value = draft.name || "";
  $("idText").textContent = draft.id;
  $("enabledInput").checked = draft.enabled !== false;
  $("matchInput").value = (draft.match || []).join("\n");
  $("excludeInput").value = (draft.exclude || []).join("\n");
  $("worldSelect").value = draft.world === "MAIN" ? "MAIN" : "ISOLATED";
  $("orderInput").value = String(draft.order ?? 100);
  $("descInput").value = draft.desc || "";

  showTab(activeTab);
  updateGutter();
  updateSizeHint();
  runMatchTest();
}

function showTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".tab").forEach((el) => el.classList.toggle("active", el.dataset.tab === tab));
  const code = $("codeInput");
  const notes = $("notesInput");
  if (tab === "notes") {
    code.hidden = true;
    $("gutter").hidden = true;
    notes.hidden = false;
    notes.value = (draft && draft.notes) || "";
    notes.focus();
  } else {
    notes.hidden = true;
    code.hidden = false;
    $("gutter").hidden = false;
    code.value = tab === "css" ? (draft && draft.css) || "" : (draft && draft.js) || "";
    code.placeholder = tab === "css" ? "/* 例：\n.banner { display: none !important; }\n*/" : "// tweak.waitFor(\".banner\").then((el) => el.remove());";
    code.focus();
    updateGutter();
  }
}

function updateGutter() {
  const code = $("codeInput");
  if (code.hidden) return;
  const lines = Math.max(1, code.value.split("\n").length);
  const numbers = [];
  for (let i = 1; i <= lines; i += 1) numbers.push(i);
  $("gutter").textContent = numbers.join("\n");
  $("gutter").scrollTop = code.scrollTop;
}

function updateSizeHint() {
  if (!draft) return;
  $("sizeHint").textContent = `CSS ${(draft.css || "").length} · JS ${(draft.js || "").length} 字符`;
}

function runMatchTest() {
  const typed = $("testInput").value.trim();
  const tabUrl = app.tab && app.tab.url && !/^chrome-extension:/i.test(app.tab.url) ? app.tab.url : "";
  const url = typed || tabUrl;
  const el = $("testResult");
  if (!draft || !url) {
    el.className = "badge";
    el.textContent = "—";
    return;
  }
  const rule = draftForSave(false);
  const hit = ruleMatches(rule, url);
  el.className = "badge " + (hit ? "yes" : "no");
  el.textContent = hit ? "命中" : "不命中";
}

// ---------- 草稿 ----------
function draftFrom(rule) {
  return {
    id: rule.id,
    name: rule.name || rule.id,
    desc: rule.desc || "",
    match: [...(rule.match || [])],
    exclude: [...(rule.exclude || [])],
    css: rule.css || "",
    js: rule.js || "",
    world: rule.world === "MAIN" ? "MAIN" : "ISOLATED",
    order: rule.order ?? 100,
    enabled: rule.enabled !== false,
    notes: rule.notes || "",
  };
}

function draftForSave(validate = true) {
  const base = draft || {};
  const next = {
    ...base,
    name: $("nameInput").value.trim(),
    id: base.id,
    desc: $("descInput").value.trim(),
    match: splitLines($("matchInput").value),
    exclude: splitLines($("excludeInput").value),
    world: $("worldSelect").value,
    order: Number($("orderInput").value || 100),
    enabled: $("enabledInput").checked,
  };
  if (activeTab === "css") next.css = $("codeInput").value;
  else if (activeTab === "js") next.js = $("codeInput").value;
  else next.notes = $("notesInput").value;
  if (validate && !next.name) next.name = next.id;
  return next;
}

function syncDraftFromInputs() {
  if (!draft) return;
  const next = draftForSave(false);
  draft = { ...draft, ...next };
}

function scheduleSave() {
  dirty = true;
  syncDraftFromInputs();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { save().catch((e) => toast(e.message, true)); }, 900);
}

async function save({ silent = false, apply = app.settings.autoApply !== false } = {}) {
  clearTimeout(saveTimer);
  if (!draft) return null;
  syncDraftFromInputs();
  if (!draft.match.length) {
    toast("至少需要一条匹配 URL", true);
    return null;
  }
  if (!draft.css && !draft.js) {
    toast("CSS 与 JS 至少写一样", true);
    return null;
  }
  const payload = { ...draft };
  try {
    const result = await send("awt:save-rule", { rule: payload, apply });
    draft = draftFrom(result.rule);
    dirty = false;
    const index = app.rules.findIndex((r) => r.id === result.rule.id);
    const matchTarget = pickTarget();
    if (index >= 0) app.rules[index] = { ...result.rule, matched: ruleMatches(result.rule, (matchTarget && matchTarget.url) || "") };
    else app.rules.push({ ...result.rule, matched: ruleMatches(result.rule, (matchTarget && matchTarget.url) || "") });
    selectedId = result.rule.id;
    $("idText").textContent = draft.id;
    renderList();
    updateSizeHint();
    flashSaved();
    if (!silent) refreshStatus();
    return result;
  } catch (e) {
    toast(e.message, true);
    return null;
  }
}

async function selectRule(id) {
  if (dirty) await save({ silent: true });
  const rule = app.rules.find((r) => r.id === id);
  if (!rule) return;
  selectedId = id;
  draft = draftFrom(rule);
  dirty = false;
  $("testInput").value = "";
  renderList();
  renderEditor();
}

function newRule(template) {
  const id = slugId((template.id || "rule") + "-" + Date.now().toString(36).slice(-5));
  const rule = {
    id,
    name: template.name || "新规则",
    desc: template.desc || "",
    match: currentPattern(),
    exclude: [],
    css: template.css || "",
    js: template.js || "",
    world: template.world || "ISOLATED",
    order: 100,
    enabled: true,
    notes: "",
  };
  selectedId = id;
  draft = rule;
  activeTab = rule.css ? "css" : "js";
  app.rules.push({ ...rule, matched: ruleMatches(rule, (app.tab && app.tab.url) || "") });
  renderList();
  renderEditor();
  save({ silent: true }).then(() => toast("已创建：" + rule.name));
}

// ---------- 弹层 ----------
function openModal(title, bodyHtml) {
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = bodyHtml;
  $("modal").hidden = false;
}

function closeModal() {
  $("modal").hidden = true;
  $("modalBody").innerHTML = "";
}

function templateModal() {
  const cards = TEMPLATES.map((tpl) => `
    <button class="tpl" data-tpl="${tpl.id}">
      <b>${escapeHtml(tpl.name)}</b>
      <span>${escapeHtml(tpl.desc)}</span>
    </button>`).join("");
  openModal("从模板新建", `<div class="tpl-grid">${cards}</div>`);
  $("modalBody").querySelectorAll(".tpl").forEach((el) => {
    el.addEventListener("click", () => {
      const tpl = TEMPLATES.find((t) => t.id === el.dataset.tpl);
      closeModal();
      if (tpl) newRule(tpl);
    });
  });
}

function settingsModal() {
  const settings = app.settings || {};
  const help = [
    "{",
    '  "mcpServers": {',
    '    "web-tweaks": {',
    '      "command": "node",',
    '      "args": ["<仓库路径>/bridge/mcp.mjs"]',
    "    }",
    "  }",
    "}",
    "",
    "# 或直接用 curl",
    'curl -s http://127.0.0.1:8787/call \\',
    '  -H "content-type: application/json" \\',
    `  -d '{"tool":"rules.list","args":{}}'`,
  ].join("\n");

  openModal("连接与设置", `
    <div class="field-row">
      <label class="field grow"><span>本地桥地址</span><input id="setBridgeUrl" value="${escapeHtml(settings.bridgeUrl || "http://127.0.0.1:8787")}" /></label>
      <label class="field narrow"><span>Token（可选）</span><input id="setBridgeToken" value="${escapeHtml(settings.bridgeToken || "")}" /></label>
    </div>
    <div class="row">
      <label class="switch"><input type="checkbox" id="setBridgeEnabled" ${settings.bridgeEnabled === false ? "" : "checked"} /><span></span></label>
      <span>启用本地桥（agent 通过它调用扩展）</span>
    </div>
    <div class="row">
      <label class="switch"><input type="checkbox" id="setAutoApply" ${settings.autoApply === false ? "" : "checked"} /><span></span></label>
      <span>保存后立即应用到已打开的匹配页面</span>
    </div>
    <div class="row">
      <label class="switch"><input type="checkbox" id="setOpenStudio" ${settings.openStudioOnInstall === false ? "" : "checked"} /><span></span></label>
      <span>安装后自动打开工作台</span>
    </div>
    <div class="row" style="gap:8px">
      <button class="primary" id="setSaveBtn">保存并重连</button>
      <button class="ghost" id="setRestartBtn">重启桥连接</button>
      <span class="muted" id="setBridgeState">${app.bridge && app.bridge.connected ? "已连接" : "未连接"}</span>
    </div>
    <div class="field"><span>任意 agent 的接入方式</span><pre class="snippet">${escapeHtml(help)}</pre></div>
  `);

  $("setSaveBtn").addEventListener("click", async () => {
    try {
      const result = await send("awt:settings", {
        patch: {
          bridgeUrl: $("setBridgeUrl").value.trim(),
          bridgeToken: $("setBridgeToken").value.trim(),
          bridgeEnabled: $("setBridgeEnabled").checked,
          autoApply: $("setAutoApply").checked,
          openStudioOnInstall: $("setOpenStudio").checked,
        },
      });
      app.settings = result.settings;
      toast("已保存");
      setTimeout(load, 600);
    } catch (e) {
      toast(e.message, true);
    }
  });

  $("setRestartBtn").addEventListener("click", async () => {
    await send("awt:bridge-restart");
    toast("已请求重连");
    setTimeout(load, 900);
  });
}

function shortSelector(selector, max = 36) {
  const s = String(selector || "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function agentSnippet(pick) {
  const details = [
    "- 页面：" + (pick.url || ""),
    "- 选择器：" + (pick.selector || pick.tag || ""),
    pick.tag ? "- 标签：" + pick.tag : "",
    pick.text ? "- 文本：" + pick.text : "",
    pick.classes && pick.classes.length ? "- class：" + pick.classes.join(" ") : "",
    pick.html ? "- HTML：" + String(pick.html).replace(/\s+/g, " ").slice(0, 400) : "",
  ].filter(Boolean);
  return [
    "用 web-tweaks 定制这个页面：",
    "",
    ...details,
    "",
    "要做的事：<写你的需求，比如「隐藏它」「把文案改成 xxx」「加载后自动点一下」>",
    "",
    "（装了 web-tweaks skill 或 MCP 的话可以直接 rules.save 应用；否则把规则代码贴回来我自己加。）",
  ].join("\n");
}

function escapeHtml(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------- 动作 ----------
async function refreshStatus() {
  try {
    const out = await send("awt:refresh-tab", {});
    app.status = out.state;
    renderRail();
  } catch {}
}

async function applyCurrent() {
  if (!draft) return;
  if (dirty) await save({ silent: true });
  try {
    const out = await send("awt:apply", {});
    const n = ((out && out.applied) || []).length;
    if (!n) toast("这个页面没有命中的规则");
    else toast("已应用到 " + shortUrl((out && out.url) || "") + "：" + n + " 条规则");
    await refreshStatus();
  } catch (e) {
    toast(e.message, true);
  }
}

async function deleteCurrent() {
  if (!draft) return;
  if (!confirm("删除规则「" + draft.name + "」？此操作不可撤销。")) return;
  try {
    await send("awt:delete-rule", { id: draft.id });
    app.rules = app.rules.filter((r) => r.id !== draft.id);
    draft = null;
    dirty = false;
    selectedId = null;
    renderList();
    renderEditor();
    $("editor").hidden = true;
    toast("已删除");
  } catch (e) {
    toast(e.message, true);
  }
}

async function duplicateCurrent() {
  if (!draft) return;
  if (dirty) await save({ silent: true });
  try {
    const out = await send("awt:duplicate-rule", { id: draft.id });
    await load();
    await selectRule(out.rule.id);
    toast("已复制");
  } catch (e) {
    toast(e.message, true);
  }
}


async function exportRules() {
  const out = await send("awt:export");
  const blob = new Blob([out.json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "agent-web-tweaks-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast("已导出 " + JSON.parse(out.json).rules.length + " 条规则");
}

function importRules() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const text = await file.text();
    try {
      const out = await send("awt:import", { data: text, mode: "merge" });
      toast("已导入 " + out.imported + " 条");
      await load();
    } catch (e) {
      toast("导入失败：" + e.message, true);
    }
  });
  input.click();
}

async function quickRule(kind) {
  const pick = app.lastPick;
  if (!pick) return;
  const selector = pick.selector || pick.tag;
  const jsSel = JSON.stringify(selector);
  const pattern = (() => {
    try {
      const u = new URL(pick.url || (app.tab && app.tab.url) || "");
      return [u.origin + (u.pathname === "/" ? "/*" : u.pathname + "*")];
    } catch {
      return ["*://*/*"];
    }
  })();
  const stamp = Date.now().toString(36).slice(-4);
  let rule = null;

  if (kind === "hide") {
    rule = { id: "hide-" + pick.tag + "-" + stamp, name: "隐藏 " + (pick.text ? pick.text.slice(0, 16) : shortSelector(selector)), match: pattern, css: selector + " {\n  display: none !important;\n}\n", js: "" };
  } else if (kind === "remove") {
    rule = { id: "remove-" + pick.tag + "-" + stamp, name: "删除 " + (pick.text ? pick.text.slice(0, 16) : shortSelector(selector)), match: pattern, css: "", js: "tweak.waitFor(" + jsSel + ").then((el) => el && el.remove());\n" };
  } else if (kind === "text") {
    const text = prompt("新的文字", pick.text || "");
    if (text == null) return;
    rule = { id: "text-" + pick.tag + "-" + stamp, name: "改文案 " + (pick.text ? pick.text.slice(0, 12) : shortSelector(selector)), match: pattern, css: "", js: "const el = await tweak.waitFor(" + jsSel + ");\nif (el) el.textContent = " + JSON.stringify(text) + ";\n" };
  } else if (kind === "copy") {
    await navigator.clipboard.writeText(selector);
    toast("选择器已复制");
    return;
  } else if (kind === "agent") {
    await navigator.clipboard.writeText(agentSnippet(pick));
    toast("已复制给 agent 的描述，粘贴到对话里即可");
    return;
  }
  if (!rule) return;
  const out = await send("awt:save-rule", { rule, apply: true });
  toast("已保存并应用：" + out.rule.name);
  await load();
  await selectRule(out.rule.id);
}

// ---------- 事件 ----------
$("searchInput").addEventListener("input", renderList);

$("selectToggle").addEventListener("click", () => {
  selectMode = !selectMode;
  selected.clear();
  $("selectToggle").textContent = selectMode ? "取消" : "批量";
  renderList();
});

$("selectAll").addEventListener("change", () => {
  const keyword = $("searchInput").value.trim().toLowerCase();
  const visible = app.rules.filter((rule) => {
    if (!keyword) return true;
    return rule.id.toLowerCase().includes(keyword)
      || (rule.name || "").toLowerCase().includes(keyword)
      || (rule.match || []).join(" ").toLowerCase().includes(keyword)
      || (rule.desc || "").toLowerCase().includes(keyword);
  });
  if ($("selectAll").checked) visible.forEach((r) => selected.add(r.id));
  else visible.forEach((r) => selected.delete(r.id));
  renderList();
});

$("batchBar").addEventListener("click", async (event) => {
  const btn = event.target.closest("[data-batch]");
  if (!btn) return;
  const ids = [...selected];
  if (!ids.length) return toast("先在左边勾选规则", true);
  const action = btn.dataset.batch;
  if (action === "delete" && !confirm("删除选中的 " + ids.length + " 条规则？删除后不可恢复。")) return;
  btn.disabled = true;
  try {
    const out = await send("awt:batch", { ids, action });
    const n = out.deleted || out.updated || ids.length;
    toast(
      action === "delete" ? "已删除 " + n + " 条规则"
        : action === "enable" ? "已启用 " + n + " 条规则"
        : "已停用 " + n + " 条规则"
    );
    selected.clear();
    await load();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
});
$("newBtn").addEventListener("click", templateModal);
$("settingsBtn").addEventListener("click", settingsModal);
$("importBtn").addEventListener("click", importRules);
$("exportBtn").addEventListener("click", () => exportRules().catch((e) => toast(e.message, true)));

for (const id of ["nameInput", "descInput", "matchInput", "excludeInput", "orderInput"]) {
  $(id).addEventListener("input", () => { scheduleSave(); runMatchTest(); });
}
$("worldSelect").addEventListener("change", () => scheduleSave());
$("enabledInput").addEventListener("change", () => scheduleSave());
$("codeInput").addEventListener("input", () => {
  scheduleSave();
  updateGutter();
  updateSizeHint();
});
$("codeInput").addEventListener("scroll", () => { $("gutter").scrollTop = $("codeInput").scrollTop; });
$("notesInput").addEventListener("input", () => scheduleSave());
$("testInput").addEventListener("input", runMatchTest);
$("saveBtn").addEventListener("click", async () => {
  const result = await save({ apply: true });
  if (!result) return;
  const tabs = (result.applied || []).filter((item) => Array.isArray(item.applied) && item.applied.length).length;
  toast(tabs ? "已保存并应用到 " + tabs + " 个页面" : "已保存（当前没有命中的页面）");
});
$("idText").addEventListener("click", async () => {
  if (!draft) return;
  try {
    await navigator.clipboard.writeText(draft.id);
    toast("已复制规则 id：" + draft.id);
  } catch {
    toast("复制失败，请手动选中", true);
  }
});
$("reloadBtn").addEventListener("click", refreshStatus);
$("pickBtn").addEventListener("click", async () => {
  try {
    await send("awt:pick-start", {});
    toast("在页面上点击要定制的元素…");
  } catch (e) {
    toast(e.message, true);
  }
});
document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => quickRule(chip.dataset.act).catch((e) => toast(e.message, true)));
});
$("pickUseBtn").addEventListener("click", () => {
  if (!draft || !app.lastPick) return;
  const selector = app.lastPick.selector || app.lastPick.tag;
  if (activeTab === "js") {
    const code = $("codeInput");
    const insert = "const el = await tweak.waitFor(" + JSON.stringify(selector) + ");\n";
    code.value = code.value + (code.value.endsWith("\n") ? "" : "\n") + insert;
    code.focus();
  } else if (activeTab === "css") {
    const code = $("codeInput");
    code.value = code.value + (code.value.endsWith("\n") ? "" : "\n") + selector + " {\n  \n}\n";
    code.focus();
  }
  scheduleSave();
  updateGutter();
});
$("copyAgentBtn").addEventListener("click", async () => {
  const item = AGENT_SNIPPETS[agentTab] || AGENT_SNIPPETS.mcp;
  await navigator.clipboard.writeText(item.text);
  toast(item.label.replace(/^复制/, "已复制"));
});

$("agentTabs").addEventListener("click", (event) => {
  const btn = event.target.closest("[data-agent]");
  if (!btn) return;
  agentTab = btn.dataset.agent;
  renderAgentSnippet();
});
$("moreBtn").addEventListener("click", () => {
  openModal("更多操作", `
    <div class="row" style="gap:8px;flex-wrap:wrap">
      <button class="ghost" id="moreReinject">重新注入到当前页</button>
      <button class="ghost" id="moreDup">复制规则</button>
      <button class="ghost" id="moreExport">导出单条 JSON</button>
      <button class="ghost" id="moreDelete" style="color:#dc2626;border-color:#fecaca">删除规则</button>
    </div>
    <div class="field"><span>规则内容</span><pre class="snippet" style="max-height:240px;overflow:auto">${escapeHtml(JSON.stringify(draft, null, 2))}</pre></div>
  `);
  $("moreReinject").addEventListener("click", () => { closeModal(); applyCurrent(); });
  $("moreDup").addEventListener("click", () => { closeModal(); duplicateCurrent(); });
  $("moreDelete").addEventListener("click", () => { closeModal(); deleteCurrent(); });
  $("moreExport").addEventListener("click", async () => {
    await navigator.clipboard.writeText(JSON.stringify(draft, null, 2));
    toast("规则 JSON 已复制到剪贴板");
  });
});
$("usOpenBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/?id=" + (app.extensionId || chrome.runtime.id) });
});
$("usRecheckBtn").addEventListener("click", async () => {
  await load();
  toast(app.userScripts ? "已检测到用户脚本权限" : "仍未开启「允许用户脚本」", !app.userScripts);
});
$("welcomeNew").addEventListener("click", templateModal);
$("welcomePick").addEventListener("click", async () => {
  try {
    await send("awt:pick-start", {});
    toast("在页面上点击要定制的元素…");
  } catch (e) {
    toast(e.message, true);
  }
});
$("modalClose").addEventListener("click", closeModal);
$("modal").addEventListener("click", (event) => { if (event.target === $("modal")) closeModal(); });
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    syncDraftFromInputs();
    showTab(tab.dataset.tab);
  });
});

document.addEventListener("keydown", (event) => {
  const meta = event.metaKey || event.ctrlKey;
  if (meta && event.key.toLowerCase() === "s") {
    event.preventDefault();
    save({ apply: true }).then((r) => r && toast("已保存并应用"));
  }
  if (meta && event.key === "Enter") {
    event.preventDefault();
    applyCurrent();
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === "awt:pick-result") {
    app.lastPick = msg.reference;
    renderRail();
    toast("已拾取：" + (msg.reference && msg.reference.selector));
  }
  if (msg.type === "awt:bridge-state") {
    app.bridge = msg.bridge;
    renderRail();
  }
});

const AGENT_SNIPPETS = {
  mcp: {
    label: "复制 MCP 配置",
    text: JSON.stringify(
      {
        mcpServers: {
          "web-tweaks": {
            command: "node",
            args: ["<仓库路径>/bridge/mcp.mjs"],
          },
        },
      },
      null,
      2
    ),
  },
  skill: {
    label: "复制安装命令",
    text: [
      "# 装到 ~/.codex/skills 和 ~/.claude/skills",
      "node skill/install.mjs",
      "",
      "# 之后 agent 直接用 awt",
      "node ~/.codex/skills/web-tweaks/scripts/awt.mjs status",
      "node ~/.codex/skills/web-tweaks/scripts/awt.mjs pick",
    ].join("\n"),
  },
  cli: {
    label: "复制 CLI 示例",
    text: [
      "# 起本地桥（扩展会自动连上来）",
      "node bridge/bridge.mjs",
      "",
      "# 任何能跑命令的 agent 都能调",
      'curl -s http://127.0.0.1:8787/call \\',
      '  -H "content-type: application/json" \\',
      `  -d '{"tool":"rules.list","args":{}}'`,
    ].join("\n"),
  },
};
let agentTab = "mcp";

function renderAgentSnippet() {
  const item = AGENT_SNIPPETS[agentTab] || AGENT_SNIPPETS.mcp;
  $("agentSnippet").textContent = item.text;
  $("copyAgentBtn").textContent = item.label;
  document.querySelectorAll(".agent-tab").forEach((el) => {
    el.classList.toggle("active", el.dataset.agent === agentTab);
  });
}

// ---------- 启动 ----------
async function load() {
  const state = await send("awt:state");
  app.rules = state.rules;
  for (const id of [...selected]) {
    if (!state.rules.some((r) => r.id === id)) selected.delete(id);
  }
  app.settings = state.settings;
  app.bridge = state.bridge;
  app.tab = state.tab;
  app.pickTab = state.pickTab;
  app.status = state.status;
  app.lastPick = state.lastPick;
  app.userScripts = state.userScripts;
  app.mainWorld = state.mainWorld;
  app.extensionId = state.extensionId;
  app.scriptState = state.scriptState;
  renderList();
  renderRail();
  if (draft && !dirty) {
    const fresh = app.rules.find((r) => r.id === draft.id);
    if (fresh) draft = draftFrom(fresh);
  }
  renderEditor();
}

function pickInitial() {
  const hash = location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  const ruleId = params.get("rule");
  if (ruleId && app.rules.some((r) => r.id === ruleId)) return ruleId;
  const first = app.rules.find((r) => r.matched) || app.rules[0];
  return first ? first.id : null;
}

async function init() {
  renderAgentSnippet();
  await load();
  const id = pickInitial();
  if (id) await selectRule(id);
  else {
    $("editor").hidden = true;
    $("welcome").hidden = false;
    renderWelcomeTarget();
  }
  setInterval(() => { send("awt:state").then((state) => {
    app.bridge = state.bridge;
    app.status = state.status;
    app.tab = state.tab;
    app.pickTab = state.pickTab;
    renderRail();
    if (!draft) { $("editor").hidden = true; }
  }).catch(() => {}); }, 8000);
}

init().catch((e) => toast(e.message, true));
