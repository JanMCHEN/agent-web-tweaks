# 规则

## 字段

```json
{
  "id": "kebab-case-id",
  "name": "人类可读的名字",
  "desc": "为什么需要这条规则",
  "match": ["https://example.com/*"],
  "exclude": ["https://example.com/admin/*"],
  "world": "ISOLATED",
  "order": 100,
  "enabled": true,
  "css": ".selector { display: none !important; }",
  "js": ""
}
```

| 字段 | 说明 |
| --- | --- |
| `id` | 字母/数字开头，只能含字母数字 `.` `_` `-`，最长 64；更新规则时沿用 |
| `match` | URL 通配符数组，`*` 任意字符、`?` 单字符；没写协议补 `*://`；匹配的是完整 URL（含 hash） |
| `exclude` | 命中这些就不执行 |
| `world` | `ISOLATED`（默认，跑在 USER_SCRIPT 世界）/ `MAIN`（页面主世界） |
| `order` | 小的先执行 |
| `css` / `js` | 至少一个 |

CSS 在 `document_start` 就注入，基本不闪。JS 也在 `document_start` 执行。

## tweak SDK

| API | 说明 |
| --- | --- |
| `tweak.$(sel, root?)` / `tweak.$$(sel, root?)` | 查询元素 |
| `tweak.waitFor(sel, { timeout, root })` | 等元素出现，超时返回 `null` |
| `tweak.waitForText(text, { timeout })` | 等某段文字出现 |
| `tweak.observe(cb, { selector, throttleMs, immediate, target })` | 监听 DOM 变化（自带节流；回调过密会被熔断） |
| `tweak.css(text)` | 运行时插样式 |
| `tweak.ready(fn)` | DOM 就绪后执行 |
| `tweak.onRoute(fn)` | SPA 路由变化（`{ from, to }`） |
| `tweak.onCleanup(fn)` | 规则被停用/删除/不再匹配时执行 |
| `tweak.store.get/set(key)` | 每条规则一份持久小存储（页面 origin 的 localStorage） |
| `tweak.log(...)` | 带规则 id 的日志 |
| `tweak.env` | 扩展里配置的环境变量（`awt.settings.v1.env`） |

规则 JS 是脚本语义，可以直接 `await`。

## 配方

**隐藏广告 / 浮层**

```json
{ "css": "[class*=\"ad-\"], .sponsor, #cookie-banner { display: none !important; }" }
```

**删掉整个区块**

```js
const el = await tweak.waitFor(".annoying-panel");
if (el) el.remove();
```

**改文案**

```js
const el = await tweak.waitFor(".title");
if (el) el.textContent = "新的标题";
```

**自动点开 / 自动提交**

```js
const btn = await tweak.waitFor("button.load-more");
if (btn) btn.click();
```

**只展开一次（用 store 记状态）**

```js
if (!tweak.store.get("expanded")) {
  const btn = await tweak.waitFor(".collapse-toggle");
  if (btn) btn.click();
  tweak.store.set("expanded", true);
}
```

**懒加载图片补 src**

```js
tweak.observe(() => {
  for (const img of tweak.$$("img[data-src]")) {
    if (img.src !== img.dataset.src) img.src = img.dataset.src;
  }
}, { immediate: true, throttleMs: 120 });
```

**MAIN world：hook fetch**

```js
const original = window.fetch;
window.fetch = (...args) => {
  tweak.log("fetch", String(args[0]));
  return original.apply(window, args);
};
tweak.onCleanup(() => { window.fetch = original; });
```

## 排错

- 规则 JS 的报错写进 `localStorage["awt.error.<id>"]`，`awt context` 的 `errors` 里能看到
- 页面控制台里搜 `[awt:<id>]`
- 改完没效果：确认 `awt status` 里 `userScripts: true`，且 URL 真的命中 `match`
- `document.body` 为 `null`：这是 `document_start` 的正常时序，改用 `tweak.ready`
