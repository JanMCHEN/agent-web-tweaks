const $ = (id) => document.getElementById(id);

let state = null;

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
  toast.timer = setTimeout(() => { el.hidden = true; }, 2200);
}

function originPattern(url) {
  try {
    const u = new URL(url);
    return u.origin + (u.pathname === "/" ? "/*" : u.pathname + "*");
  } catch {
    return "*://*/*";
  }
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url || "-";
  }
}

function renderBridge(info) {
  const dot = $("bridgeDot");
  dot.classList.remove("on", "off");
  if (info && info.connected) {
    dot.classList.add("on");
    $("bridgeSub").textContent = "本地桥已连接 · " + (info.url || "");
  } else if (info && info.active) {
    dot.classList.add("off");
    $("bridgeSub").textContent = "本地桥未连接" + (info.error ? " · " + info.error : " · 先启动 node bridge/bridge.mjs");
  } else {
    dot.classList.add("off");
    $("bridgeSub").textContent = "本地桥未启动 · node bridge/bridge.mjs";
  }
}

function renderRules() {
  const list = $("ruleList");
  const canTweak = state.injectable !== false;
  const pickBtn = $("pickBtn");
  pickBtn.disabled = !canTweak;
  pickBtn.title = canTweak ? "在页面上点选要定制的元素" : "先切到一个普通网页";

  const rules = canTweak ? (state.rules || []).filter((r) => r.matched !== false) : [];
  const applied = new Set((state.status && state.status.applied) || []);
  $("ruleCount").textContent = String(rules.length);
  list.innerHTML = "";

  if (!canTweak) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const title = document.createElement("div");
    title.textContent = "此页不能定制规则";
    const hint = document.createElement("div");
    hint.className = "empty-hint";
    hint.textContent = "chrome:// 和扩展页面都改不了。切到要修改的网页，再点扩展图标";
    empty.append(title, hint);
    list.appendChild(empty);
    return;
  }

  if (!rules.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const title = document.createElement("div");
    title.textContent = "这个页面还没有规则";
    const hint = document.createElement("div");
    hint.className = "empty-hint";
    hint.textContent = "点下面的「拾取元素」，在页面上选一个，就能生成一条只作用于这个页面的规则";
    empty.append(title, hint);
    list.appendChild(empty);
    return;
  }
  for (const rule of rules) {
    const row = document.createElement("div");
    row.className = "rule" + (rule.enabled ? "" : " off");

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = rule.name || rule.id;
    name.title = rule.id;

    if (rule.world === "MAIN") {
      const tag = document.createElement("span");
      tag.className = "tag main";
      tag.textContent = "MAIN";
      row.appendChild(tag);
    }
    if (applied.has(rule.id)) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "已应用";
      row.appendChild(tag);
    }

    const label = document.createElement("label");
    label.className = "switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = rule.enabled;
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("change", async () => {
      try {
        await send("awt:toggle-rule", { id: rule.id, enabled: input.checked });
        toast(input.checked ? "已启用 " + rule.name : "已停用 " + rule.name);
        await load();
      } catch (e) {
        input.checked = !input.checked;
        toast(e.message, true);
      }
    });
    label.appendChild(input);
    label.appendChild(document.createElement("span"));

    const edit = document.createElement("button");
    edit.className = "edit";
    edit.textContent = "✎";
    edit.title = "在工作台里编辑这条规则";
    edit.addEventListener("click", (event) => {
      event.stopPropagation();
      chrome.tabs.create({ url: chrome.runtime.getURL("src/ui/studio.html") + "#rule=" + encodeURIComponent(rule.id) });
    });

    row.appendChild(name);
    row.appendChild(edit);
    row.appendChild(label);
    list.appendChild(row);
  }
}

function renderPick() {
  const pick = state.lastPick;
  const card = $("pickCard");
  if (!pick) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $("pickSelector").textContent = pick.selector || "(无选择器)";
  $("pickText").textContent = pick.text ? "「" + pick.text.slice(0, 120) + "」" : pick.tag;
  // 刚拾取完自动弹开的这一次：滚到卡片并闪一下，告诉用户接下来点哪个
  if (pick && pick.pickedAt && Date.now() - Number(pick.pickedAt) < 60000 && card.dataset.flashed !== String(pick.pickedAt)) {
    card.dataset.flashed = String(pick.pickedAt);
    card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    card.classList.add("flash");
    setTimeout(() => card.classList.remove("flash"), 1800);
  }
}

function renderPage() {
  const tab = state.tab;
  const canTweak = state.injectable !== false;
  $("tabTitle").textContent = (tab && tab.title) || "当前标签页";
  $("tabUrl").textContent = shortUrl(tab && tab.url);
  $("tabUrl").title = (tab && tab.url) || "";
  const meta = [];
  if (!canTweak) meta.push("此页不能定制（chrome:// 页面）");
  if (state.userScripts === false) meta.push("JS 未启用（点此开启）");
  else if (canTweak && state.mainWorld) meta.push("MAIN world 已启用");
  if (state.status && state.status.errors && state.status.errors.length) meta.push("有 " + state.status.errors.length + " 条执行错误");
  $("pageMeta").textContent = meta.join(" · ");
  $("pageMeta").style.color = (!canTweak || state.userScripts === false) ? "#b45309" : "";
  $("pageMeta").style.cursor = state.userScripts === false ? "pointer" : "default";
  $("pageMeta").onclick = state.userScripts === false
    ? () => chrome.tabs.create({ url: "chrome://extensions/?id=" + (state.extensionId || chrome.runtime.id) })
    : null;
}

async function load() {
  state = await send("awt:state", { page: "active" });
  renderBridge(state.bridge);
  renderPage();
  renderRules();
  renderPick();
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

async function makeQuickRule(kind) {
  const pick = state.lastPick;
  if (!pick) return;
  const selector = pick.selector || pick.tag;
  const jsSel = JSON.stringify(selector);
  const pattern = originPattern(pick.url || (state.tab && state.tab.url) || "");
  const stamp = Date.now().toString(36).slice(-4);
  let rule;

  if (kind === "hide") {
    rule = {
      id: "hide-" + pick.tag + "-" + stamp,
      name: "隐藏 " + (pick.text ? pick.text.slice(0, 16) : shortSelector(selector)),
      match: [pattern],
      desc: "隐藏 " + selector,
      css: selector + " {\n  display: none !important;\n}\n",
      js: "",
    };
  } else if (kind === "remove") {
    rule = {
      id: "remove-" + pick.tag + "-" + stamp,
      name: "删除 " + (pick.text ? pick.text.slice(0, 16) : shortSelector(selector)),
      match: [pattern],
      desc: "从 DOM 删除 " + selector,
      css: "",
      js: "tweak.waitFor(" + jsSel + ").then((el) => el && el.remove());\n",
    };
  } else if (kind === "text") {
    const text = window.prompt("新的文字", pick.text || "");
    if (text == null) return;
    rule = {
      id: "text-" + pick.tag + "-" + stamp,
      name: "改文案 " + (pick.text ? pick.text.slice(0, 12) : shortSelector(selector)),
      match: [pattern],
      desc: "替换 " + selector + " 的文字",
      css: "",
      js: "const el = await tweak.waitFor(" + jsSel + ");\nif (el) el.textContent = " + JSON.stringify(text) + ";\n",
    };
  } else {
    return;
  }

  await send("awt:save-rule", { rule, apply: true });
  toast("已保存并应用：" + rule.name);
  await load();
}

$("removeAllBtn").addEventListener("click", async () => {
  try {
    await send("awt:remove", {});
    toast("已在本页临时撤销，规则本身还在");
    await load();
  } catch (e) {
    toast(e.message, true);
  }
});

$("pickBtn").addEventListener("click", async () => {
  try {
    await send("awt:pick-start", { tabId: state.tab && state.tab.id });
    window.close();
  } catch (e) {
    toast(e.message, true);
  }
});

$("pickClear").addEventListener("click", async () => {
  await chrome.storage.local.remove("awt.lastPick.v1");
  await load();
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", async () => {
    const act = chip.dataset.act;
    try {
      if (act === "css") {
        await navigator.clipboard.writeText(state.lastPick ? state.lastPick.selector : "");
        toast("选择器已复制");
        return;
      }
      if (act === "agent") {
        if (!state.lastPick) return;
        await navigator.clipboard.writeText(agentSnippet(state.lastPick));
        toast("已复制，粘贴到 agent 对话里即可");
        return;
      }
      await makeQuickRule(act);
    } catch (e) {
      toast(e.message, true);
    }
  });
});

$("studioBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/ui/studio.html") });
});

$("refreshBtn").addEventListener("click", () => load().catch((e) => toast(e.message, true)));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "awt:pick-result") {
    load().catch(() => {});
  }
});

load().catch((e) => toast(e.message, true));
