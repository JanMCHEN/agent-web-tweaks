// 工具清单：扩展（background）与本地桥（bridge/mcp.mjs）共用同一份定义。
export const TOOL_DEFS = [
  {
    name: "meta.status",
    description: "扩展版本、桥连接状态、userScripts(MAIN world) 是否可用、规则数量。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "rules.list",
    description: "列出规则；给 url 时附带 matched 标记。",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, full: { type: "boolean", description: "带上完整 css/js 源码" } },
    },
  },
  {
    name: "rules.get",
    description: "读取一条规则的完整内容。",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "rules.save",
    description:
      "新建或更新规则。规则字段：id,name,match[](URL 通配符，如 https://example.com/*),exclude[],css,js,world(ISOLATED|MAIN),order,enabled,desc。js 里可用 tweak SDK：tweak.$(sel)/tweak.$$(sel)/tweak.waitFor(sel)/tweak.observe(fn)/tweak.css(text)/tweak.onCleanup(fn)/tweak.ready(fn)/tweak.onRoute(fn)/tweak.store.get/set/tweak.log。",
    inputSchema: {
      type: "object",
      properties: {
        rule: { type: "object" },
        apply: { type: "boolean", description: "保存后立刻应用到匹配的已打开标签页" },
      },
      required: ["rule"],
    },
  },
  {
    name: "rules.delete",
    description: "删除规则。",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "rules.toggle",
    description: "启用/停用规则。",
    inputSchema: { type: "object", properties: { id: { type: "string" }, enabled: { type: "boolean" } }, required: ["id", "enabled"] },
  },
  {
    name: "rules.export",
    description: "导出全部规则（JSON 字符串）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "rules.import",
    description: "导入规则；mode=merge 合并，replace 覆盖。",
    inputSchema: {
      type: "object",
      properties: { data: { type: "string" }, mode: { type: "string", enum: ["merge", "replace"] } },
      required: ["data"],
    },
  },
  {
    name: "tabs.list",
    description: "列出当前窗口的标签页。",
    inputSchema: { type: "object", properties: { allWindows: { type: "boolean" } } },
  },
  {
    name: "page.context",
    description: "读取页面上下文：URL/标题/选中文字/标题结构/已应用规则/错误，以及用户最后一次拾取的元素（last_pick）。",
    inputSchema: { type: "object", properties: { tabId: { type: "number" } } },
  },
  {
    name: "page.html",
    description: "读取页面或某个元素的 outerHTML。",
    inputSchema: { type: "object", properties: { tabId: { type: "number" }, selector: { type: "string" }, maxChars: { type: "number" } } },
  },
  {
    name: "page.text",
    description: "读取页面或某个元素的可见文本。",
    inputSchema: { type: "object", properties: { tabId: { type: "number" }, selector: { type: "string" }, maxChars: { type: "number" } } },
  },
  {
    name: "page.eval",
    description: "在页面里执行一段 JS。代码按 async 函数体执行：可以 await，用 return 返回结果（return 的值会序列化回来）。world=MAIN 可拿到页面自己的变量。",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" }, code: { type: "string" }, world: { type: "string", enum: ["ISOLATED", "MAIN"] } },
      required: ["code"],
    },
  },
  {
    name: "page.navigate",
    description: "打开或跳转到一个 http/https 页面，等加载完成后返回 url/标题/已应用规则。写规则做自验证时用它打开目标页。",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, newTab: { type: "boolean" }, tabId: { type: "number" } },
      required: ["url"],
    },
  },
  {
    name: "page.reload",
    description: "刷新标签页并等加载完成，返回刷新后的页面状态（用来验证 document_start 注入的规则）。",
    inputSchema: { type: "object", properties: { tabId: { type: "number" }, bypassCache: { type: "boolean" } } },
  },
  {
    name: "page.click",
    description: "按选择器或可见文字点击元素（派发完整鼠标事件序列），等一小会儿后返回 url/标题/已应用规则，方便验证点击后规则是否生效。",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" }, text: { type: "string" }, index: { type: "number" }, tabId: { type: "number" } },
    },
  },
  {
    name: "page.type",
    description: "聚焦输入框并写入文本（兼容 React 受控组件），可选回车提交。返回输入后的值。",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
        submit: { type: "boolean" },
        clear: { type: "boolean" },
        tabId: { type: "number" },
      },
      required: ["selector", "text"],
    },
  },
  {
    name: "page.press",
    description: "向当前焦点元素（或指定元素）发送按键，如 Enter / Escape / Tab。",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, selector: { type: "string" }, tabId: { type: "number" } },
      required: ["key"],
    },
  },
  {
    name: "page.scroll",
    description: "滚动页面：给 selector 滚到元素，或 direction=up/down/top/bottom 滚动指定距离。",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        direction: { type: "string", enum: ["up", "down", "top", "bottom"] },
        amount: { type: "number" },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "page.waitFor",
    description: "等某个选择器或某段文字出现，返回 found 与 waitedMs；默认等元素可见，visible=false 只等它进 DOM；超时返回 found=false 而不是报错。",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
        timeoutMs: { type: "number" },
        visible: { type: "boolean" },
        tabId: { type: "number" },
      },
    },
  },
  {
    name: "page.screenshot",
    description: "截当前可见区域，返回 data URL。",
    inputSchema: { type: "object", properties: { tabId: { type: "number" } } },
  },
  {
    name: "page.lastPick",
    description: "读取用户在弹窗/工作台里最后一次拾取的元素（不重新发起拾取）。配合 page.context 里的 last_pick 使用。",
    inputSchema: { type: "object", properties: { tabId: { type: "number" } } },
  },
  {
    name: "page.pick",
    description: "让用户在页面上点一个元素，返回选择器/属性/文本/HTML。适合先拿到目标再写规则。",
    inputSchema: { type: "object", properties: { tabId: { type: "number" }, timeoutMs: { type: "number" } } },
  },
  {
    name: "page.apply",
    description: "把规则应用到标签页（不填 id 就应用所有匹配规则）。",
    inputSchema: { type: "object", properties: { tabId: { type: "number" }, id: { type: "string" } } },
  },
  {
    name: "page.remove",
    description: "从标签页撤掉规则（不填 id 就撤掉全部）。",
    inputSchema: { type: "object", properties: { tabId: { type: "number" }, id: { type: "string" } } },
  },
];
