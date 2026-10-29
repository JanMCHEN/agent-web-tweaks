# 给 agent 的说明

这份文档可以直接贴给 agent，或作为 MCP server 的说明补充。

## 能做什么

你可以通过 `web-tweaks` 这组工具，在本机 Chrome 里：

- 读页面（DOM / 文本 / 截图 / 选中文字）
- 让用户在页面上点一个元素，拿到稳定选择器
- 写一条「URL 匹配 + CSS + JS」的规则，立即生效并持久保留
- 之后用户再打开同类页面，规则自动执行

## 标准流程

1. `page.context` —— 看当前标签页：URL、标题、已应用规则、错误
2. `page.html { selector }` 或 `page.pick` —— 找到要改的元素；
   如果用户已经在弹窗/工作台里点过元素，`page.context` 的 `last_pick` 或 `page.lastPick` 里就有现成的选择器
3. `rules.save { rule, apply: true }` —— 写规则并立即应用
4. `page.screenshot` —— 确认效果
5. 需要微调就再 `rules.save`（同一个 id 就是更新）

## 规则格式

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

- `match`：URL 通配符，`*` 任意字符，`?` 单字符；省略协议会自动补 `*://`
- `world`：`ISOLATED`（默认，推荐）/ `MAIN`（需要页面自己的全局变量或改 `window.fetch` 这类）
- CSS 与 JS 至少有一个

## 写 JS 规则

脚本在 `document_start` 执行，可用 `tweak` SDK：

```js
// 等元素出现再操作
const el = await tweak.waitFor(".promo", { timeout: 8000 });
if (el) el.remove();

// 监听后续渲染（自带节流，回调过密会自动断开）
tweak.observe(() => {
  for (const img of tweak.$$("img[data-src]")) img.src = img.dataset.src;
}, { throttleMs: 120 });

// 路由变化（SPA）
tweak.onRoute(({ from, to }) => tweak.log("route", to));

// 清理
tweak.onCleanup(() => console.log("bye"));
```

注意：

- `document.body` 在 `document_start` 可能还不存在 —— 用 `tweak.ready` 或 `tweak.waitFor`
- `tweak.store.get/set` 存在页面 origin 的 localStorage（键名 `awt.store.<rule-id>`）
- 规则报错会写到 `localStorage["awt.error.<rule-id>"]`，`page.context` 里能看到

## 常用配方

**隐藏广告 / 浮层**

```json
{ "css": "[class*=\"ad-\"], .sponsor, #cookie-banner { display: none !important; }" }
```

**删掉某个区块**

```js
const el = await tweak.waitFor(".annoying-panel");
if (el) el.remove();
```

**替换文案**

```js
const el = await tweak.waitFor(".title");
if (el) el.textContent = "新的标题";
```

**自动点开 / 自动提交**

```js
const btn = await tweak.waitFor("button.load-more");
if (btn) btn.click();
```

**MAIN world：改页面的 fetch**

```js
const original = window.fetch;
window.fetch = (...args) => {
  tweak.log("fetch", String(args[0]));
  return original.apply(window, args);
};
tweak.onCleanup(() => { window.fetch = original; });
```

## 注意事项

- 改动用户的浏览器前先说明你要做什么，尤其是 `MAIN world` 规则
- 不要写死宽泛的 `*://*/*` 规则去改所有站点；尽量用具体域名 + 路径
- 规则 id 用稳定的 kebab-case；更新同一条规则时沿用原 id
- `page.remove` 只撤销当前标签页；规则本身还在，刷新后会重新生效
- 用 `rules.delete` 才是真正删除
