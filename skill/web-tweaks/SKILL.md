---
name: web-tweaks
description: 在用户本机 Chrome 里定制网页——隐藏/删除元素、改文案、注入 CSS/JS、自动点击，或读取用户正在看的页面（DOM、文本、截图、选中文字）。当用户说「把这个页面的 X 去掉/改掉」「给这个站点打补丁」「帮我改一下浏览器里的页面」，或让你看/操作他当前打开的网页时使用；通过 Agent Web Tweaks 扩展的本地桥执行。
metadata:
  short-description: 用 CSS/JS 规则定制用户本机 Chrome 里的任意网页
---

# Web Tweaks

通过本机 Chrome 里的 **Agent Web Tweaks** 扩展改网页：一条规则 = URL 通配符 + 一段 CSS + 一段 JS，保存后立即生效，之后打开同类页面自动执行。

所有操作都走 `scripts/awt.mjs`（对着本地桥发 HTTP，不依赖 MCP）。

## 先确认状态

```bash
node scripts/awt.mjs status
```

- `bridge: "down"` → `node scripts/awt.mjs up`（后台起桥，pid 记在 `~/.agent-web-tweaks/`）
- `extension: "disconnected"` → 让用户先在 Chrome 里加载扩展（`chrome://extensions` → 加载已解压的扩展程序 → 选扩展目录）
- `userScripts: false` → CSS 能用、JS 不生效；让用户打开扩展详情页的「允许用户脚本」，别自己猜页面为什么没变

`call` 会自动确保桥在跑，但不会替你加载扩展。

## 标准流程

1. `node scripts/awt.mjs context` —— URL、标题、选中文字、已应用规则、规则报错
2. 找到目标元素：`node scripts/awt.mjs pick`（让用户点一下，拿到稳定选择器）或
   `node scripts/awt.mjs call page.html '{"selector":".promo"}'`。
   用户已经在弹窗/工作台里点过元素时，`context` 的 `last_pick`（或 `awt call page.lastPick`）
   里就是现成的选择器、文本和 HTML，别再让他点第二次
3. 写规则并应用：

```bash
node scripts/awt.mjs call rules.save '{"rule":{"id":"hide-promo","name":"去掉推广位","match":["https://example.com/*"],"css":".promo{display:none!important}"},"apply":true}'
```

4. 自验证：`awt call page.reload` → `awt call page.click '{"selector":".toc-toggle"}'` → `awt call page.waitFor '{"selector":".toc.open"}'` → `awt screenshot --out /tmp/awt.png`
5. 不满意就沿用同一个 `id` 再 save（= 更新）；只想临时撤掉用 `call page.remove`，真要删用 `call rules.delete '{"id":"..."}'`

## 写规则的要点

- `match` 是 URL 通配符（`*` 任意字符、`?` 单字符），省略协议自动补 `*://`
- 规则 JS 在 `document_start` 执行，此时 `document.body` 可能还不存在 —— 用 `tweak.ready(...)` 或 `await tweak.waitFor(...)`
- JS 里可用 `tweak.$ / $$ / waitFor / waitForText / observe / css / ready / onRoute / onCleanup / store / log`
- `world: "MAIN"` 才拿得到页面自己的全局变量、才能 hook `window.fetch`；默认用 `ISOLATED`
- 需要跨域请求用 `await tweak.fetch(url)`（走扩展身份，不受 CORS 限制）；目标域名要先在工作台 → 设置 → 跨域请求里授权
- 用户给的是 `.user.js` 时，工作台「导入」可直接转成规则（`@match`/`@grant` 自动映射，带 GM_* 兼容层）
- 字段与配方见 `references/rules.md`，工具参数见 `references/tools.md`

## 约束

- 改用户的浏览器之前先说清楚你要做什么，尤其是 `MAIN` 规则和会删内容的规则
- 不要把 `*://*/*` 加上「删东西」的规则；尽量具体到域名和路径
- 用户说「看看这个页面」时，先 `context`，再决定要不要 HTML/截图，别一上来就 dump 整页
- 只操作当前活动的普通网页（`http/https`）；`chrome://`、扩展页、PDF 阅读器都改不了

## 工具速查

| 命令 | 作用 |
| --- | --- |
| `awt status` / `awt up` | 桥与扩展状态 / 起桥 |
| `awt context` | 页面上下文（含已应用规则和报错） |
| `awt pick` | 用户点选元素，返回选择器与属性 |
| `awt screenshot --out f.png` | 可见区域截图落盘 |
| `awt save @rule.json` | 写入并应用规则 |
| `awt call <tool> [json]` | 其余工具：`rules.*`、`page.*`、`tabs.list`、`meta.status` |
