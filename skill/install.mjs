#!/usr/bin/env node
// 把 skill 安装到本机各 agent 的 skills 目录，并写入仓库路径。
//   node skill/install.mjs            # 默认装 codex + claude
//   node skill/install.mjs --dry-run
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "skill/web-tweaks");
const dry = process.argv.includes("--dry-run");

const targets = [
  path.join(os.homedir(), ".codex/skills/web-tweaks"),
  path.join(os.homedir(), ".claude/skills/web-tweaks"),
];

if (!fs.existsSync(path.join(src, "SKILL.md"))) {
  console.error("找不到 skill 源目录：" + src);
  process.exit(1);
}

for (const dest of targets) {
  if (dry) {
    console.log(`[dry] ${src} -> ${dest}`);
    continue;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: true });
  fs.writeFileSync(
    path.join(dest, "awt.config.json"),
    JSON.stringify({ home: root, bridge: "http://127.0.0.1:8787" }, null, 2) + "\n"
  );
  console.log(`已安装：${dest}`);
}

console.log(`\n仓库路径：${root}`);
console.log("验证：node ~/.codex/skills/web-tweaks/scripts/awt.mjs status");
