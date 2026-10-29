// 页面拾取器：点一下元素，把「够用来写规则」的信息回传给扩展。
// 由 background 用 chrome.scripting.executeScript 注入，所以必须是自包含脚本。
(() => {
  if (window.__awtPicker) {
    window.__awtPicker.stop("restart");
    return "restarted";
  }

  const OVERLAY = "awt-picker-overlay";
  const TIP = "awt-picker-tip";
  const ACCENT = "#4f46e5";

  const overlay = document.createElement("div");
  overlay.id = OVERLAY;
  overlay.style.cssText = [
    "position:fixed",
    "z-index:2147483646",
    "pointer-events:none",
    "border:2px solid " + ACCENT,
    "background:rgba(79,70,229,.12)",
    "border-radius:4px",
    "box-shadow:0 0 0 1px rgba(255,255,255,.6) inset",
    "transition:left .04s linear,top .04s linear,width .04s linear,height .04s linear",
    "display:none",
  ].join(";");

  const tip = document.createElement("div");
  tip.id = TIP;
  tip.innerHTML =
    '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#a5b4fc;margin-right:8px"></span>' +
    "点选要定制的元素 · Esc 取消";
  tip.style.cssText = [
    "position:fixed",
    "left:50%",
    "top:18px",
    "transform:translateX(-50%)",
    "z-index:2147483647",
    "pointer-events:none",
    "padding:8px 14px",
    "border-radius:999px",
    "background:rgba(15,23,42,.92)",
    "color:#fff",
    "font:12px/1.4 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif",
    "box-shadow:0 8px 24px rgba(15,23,42,.25)",
    "backdrop-filter:blur(6px)",
  ].join(";");

  const findRoot = () => document.body || document.documentElement;
  findRoot().append(overlay, tip);

  let current = null;

  const isPickerNode = (node) =>
    node === overlay || node === tip || (node.closest && node.closest("#" + OVERLAY + ",#" + TIP));

  const deepElementAt = (x, y) => {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };

  const uniq = (selector) => {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  };

  const cssEscape = (value) => (window.CSS && CSS.escape ? CSS.escape(String(value)) : String(value).replace(/["\\]/g, "\\$&"));

  const stableSelector = (el) => {
    if (el.id) {
      const candidate = "#" + cssEscape(el.id);
      if (uniq(candidate)) return candidate;
    }
    for (const attr of ["data-testid", "data-test", "data-qa", "name", "aria-label", "placeholder"]) {
      const value = el.getAttribute && el.getAttribute(attr);
      if (value && value.length < 60) {
        const candidate = el.tagName.toLowerCase() + "[" + attr + '="' + cssEscape(value) + '"]';
        if (uniq(candidate)) return candidate;
      }
    }
    if (el.classList && el.classList.length) {
      const classes = [...el.classList].filter((c) => c && c.length < 40 && !/^(is-|has-|js-)/.test(c)).slice(0, 3);
      for (let n = classes.length; n > 0; n -= 1) {
        const candidate = el.tagName.toLowerCase() + "." + classes.slice(0, n).map(cssEscape).join(".");
        if (uniq(candidate)) return candidate;
      }
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      if (node.id) {
        parts.unshift("#" + cssEscape(node.id));
        break;
      }
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const sameTag = [...parent.children].filter((child) => child.tagName === node.tagName);
      const index = sameTag.indexOf(node) + 1;
      parts.unshift(sameTag.length > 1 ? tag + ":nth-of-type(" + index + ")" : tag);
      node = parent;
    }
    return parts.join(" > ");
  };

  const classList = (el) => {
    const raw = el.getAttribute && el.getAttribute("class");
    return String(raw || "").split(/\s+/).filter(Boolean).slice(0, 12);
  };

  const referenceFor = (el) => {
    const rect = el.getBoundingClientRect();
    const attrs = {};
    let count = 0;
    for (const attr of el.attributes) {
      if (attr.name === "style") continue;
      attrs[attr.name] = String(attr.value).slice(0, 140);
      if (++count >= 16) break;
    }
    let style = {};
    try {
      const cs = getComputedStyle(el);
      style = {
        display: cs.display,
        position: cs.position,
        color: cs.color,
        background: cs.backgroundColor,
        fontSize: cs.fontSize,
        zIndex: cs.zIndex,
      };
    } catch {}
    return {
      selector: stableSelector(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || "",
      classes: classList(el),
      text: String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
      attributes: attrs,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      style,
      html: String(el.outerHTML || "").slice(0, 2000),
      url: location.href,
      title: document.title,
    };
  };

  const highlight = (el) => {
    if (!el) {
      overlay.style.display = "none";
      return;
    }
    const rect = el.getBoundingClientRect();
    overlay.style.display = "block";
    overlay.style.left = rect.left + "px";
    overlay.style.top = rect.top + "px";
    overlay.style.width = rect.width + "px";
    overlay.style.height = rect.height + "px";
  };

  const onMove = (event) => {
    const el = deepElementAt(event.clientX, event.clientY);
    if (!el || isPickerNode(el)) return;
    current = el;
    highlight(el);
  };

  function stop(reason) {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    tip.remove();
    window.__awtPicker = null;
    return reason;
  }

  function onClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const target = current;
    let reference = null;
    try {
      reference = target ? referenceFor(target) : null;
    } catch {}
    stop("picked");
    if (reference) {
      try {
        chrome.runtime.sendMessage({ type: "awt:picked", reference });
      } catch {}
    }
  }

  function onKey(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    stop("cancelled");
    try {
      chrome.runtime.sendMessage({ type: "awt:pick-cancelled" });
    } catch {}
  }

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  window.__awtPicker = { stop };
  return "ok";
})();
