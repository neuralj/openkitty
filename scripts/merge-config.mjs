#!/usr/bin/env node
// OpenKitty 配置合并器
// 由 scripts/install.sh 调用。负责：
//   1. 解析 registry.jsonc（去注释）
//   2. 拷贝 plugins / skills 文件到 PREFIX
//   3. 拷贝模板文件到 <project>/.opencode/
//   4. 将 opencode 配置片段合并进目标 opencode.jsonc（带备份）

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, renameSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
let PREFIX = process.env.OPENKITTY_PREFIX || join(process.env.HOME || "~", ".openkitty");
let PROJECT = ".";
let CONFIG = "";
let DRY_RUN = false;
let FORCE = false;
const ONLY = [];

function usage() {
  console.log(`OpenKitty 安装器

用法:
  node merge-config.mjs [选项]

选项:
  --prefix DIR      插件/技能安装根目录 (默认: $HOME/.openkitty)
  --project DIR     项目根目录，模板与配置写入此处 (默认: 当前目录)
  --config FILE     目标 opencode.jsonc 路径 (默认: <project>/.opencode/opencode.jsonc)
  --component NAME  仅安装指定组件，可多次；默认全部
  --dry-run         只打印将要执行的操作，不实际修改
  --force           覆盖已存在的文件
  -h, --help        显示本帮助
`);
}

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--prefix") PREFIX = args[++i];
  else if (a === "--project") PROJECT = args[++i];
  else if (a === "--config") CONFIG = args[++i];
  else if (a === "--component") ONLY.push(args[++i]);
  else if (a === "--dry-run") DRY_RUN = true;
  else if (a === "--force") FORCE = true;
  else if (a === "-h" || a === "--help") { usage(); process.exit(0); }
  else { console.error(`error: 未知参数 ${a}`); process.exit(1); }
}

PREFIX = resolve(PREFIX);
PROJECT = resolve(PROJECT);
if (!CONFIG) CONFIG = join(PROJECT, ".opencode", "opencode.jsonc");
else CONFIG = resolve(CONFIG);

// ---- 解析 registry.jsonc（去除 // 与 /* */ 注释）----
function stripJsonc(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const registryPath = join(REPO_ROOT, "registry.jsonc");
const registry = JSON.parse(stripJsonc(readFileSync(registryPath, "utf-8")));
const allComponents = registry.components || [];

const selected = ONLY.length
  ? allComponents.filter((c) => ONLY.includes(c.name))
  : allComponents;
if (ONLY.length && selected.length !== ONLY.length) {
  const missing = ONLY.filter((n) => !allComponents.some((c) => c.name === n));
  console.error(`error: 未找到组件: ${missing.join(", ")}`);
  process.exit(1);
}

// ---- 工具函数 ----
function srcBaseOf(file) {
  if (file.startsWith("dist/plugins/")) return "dist/plugins/";
  if (file.startsWith("skills/")) return "skills/";
  if (file.startsWith("assets/")) return "assets/";
  return "";
}
function copyTo(files, targetDir, baseOut) {
  for (const f of files) {
    const dest = join(baseOut, targetDir, f.slice(srcBaseOf(f).length));
    const destDir = dirname(dest);
    plan(`copy ${f} -> ${dest}`);
    if (!DRY_RUN) {
      if (existsSync(dest) && !FORCE) {
        console.warn(`  ! 已存在，跳过 (使用 --force 覆盖): ${dest}`);
        continue;
      }
      mkdirSync(destDir, { recursive: true });
      copyFileSync(join(REPO_ROOT, f), dest);
    }
  }
}
const plans = [];
function plan(msg) { plans.push(msg); console.log(`  · ${msg}`); }

// ---- 1. 拷贝 plugins / skills ----
console.log(`==> 安装到 PREFIX=${PREFIX}`);
for (const c of selected) {
  if (c.type === "plugin" || c.type === "skill") {
    copyTo(c.files || [], c.target, PREFIX);
  }
  if (c.template) {
    const dest = join(PROJECT, ".opencode", basename(c.template));
    plan(`copy ${c.template} -> ${dest}`);
    if (!DRY_RUN) {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(REPO_ROOT, c.template), dest);
    }
  }
}

// ---- 2. 合并 opencode.jsonc ----
function deepMerge(base, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      deepMerge(base[k], v);
    } else if (Array.isArray(v)) {
      base[k] = Array.from(new Set([...(base[k] || []), ...v]));
    } else {
      base[k] = v;
    }
  }
  return base;
}
function fillPrefix(obj, prefix) {
  return JSON.parse(JSON.stringify(obj).replace(/\{prefix\}/g, prefix));
}

// 从 /dev/tty 读取密钥（即便 stdin 被管道占用也能交互）；读不到则返回 ""
function promptSecret(varName) {
  try {
    const out = execSync(
      `read -s -p '请输入 ${varName} 的值（仅写入本地 opencode.jsonc，不会提交到仓库）: ' v; echo "$v"`,
      { stdio: ["/dev/tty", "pipe", "pipe"] }
    );
    process.stdout.write("\n");
    return out.toString().trim();
  } catch {
    return "";
  }
}

// 解析 {env:VAR}：已取值则替换；未取到则删除该键，避免覆盖已有配置
function resolveEnv(obj, envMap) {
  const walk = (node) => {
    if (typeof node === "string") {
      const m = node.match(/^\{env:(\w+)\}$/);
      if (m) {
        const v = envMap[m[1]];
        return v === undefined ? undefined : v;
      }
      return node;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out = {};
      for (const [k, val] of Object.entries(node)) {
        const r = walk(val);
        if (r !== undefined) out[k] = r;
      }
      return out;
    }
    return node;
  };
  return walk(obj);
}

// ---- 收集 {env:VAR} 并在需要时交互提示（key 仅存于本地，不进仓库）----
const needed = new Set();
for (const c of selected) {
  if (c.opencode) {
    for (const m of JSON.stringify(c.opencode).matchAll(/\{env:(\w+)\}/g)) needed.add(m[1]);
  }
}
const envMap = {};
const unresolved = [];
for (const v of needed) {
  if (process.env[v] !== undefined) { envMap[v] = process.env[v]; continue; }
  if (DRY_RUN) { unresolved.push(v); continue; }
  const val = promptSecret(v);
  if (val) envMap[v] = val;
  else unresolved.push(v);
}

const merged = {};
for (const c of selected) {
  if (c.opencode) {
    const resolved = resolveEnv(fillPrefix(c.opencode, PREFIX), envMap);
    deepMerge(merged, resolved);
  }
}

let current = {};
if (existsSync(CONFIG)) {
  try { current = JSON.parse(stripJsonc(readFileSync(CONFIG, "utf-8"))); }
  catch (e) { console.error(`error: 无法解析现有配置 ${CONFIG}: ${e.message}`); process.exit(1); }
}
const result = deepMerge(current, merged);

plan(`merge opencode config -> ${CONFIG}`);
if (!DRY_RUN) {
  if (existsSync(CONFIG)) {
    const bak = `${CONFIG}.bak`;
    copyFileSync(CONFIG, bak);
    console.log(`  · 已备份原配置到 ${bak}`);
  }
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(result, null, 2) + "\n", "utf-8");
}

console.log("\n✅ 完成。");
if (DRY_RUN) console.log("(dry-run 模式，未做任何实际修改)");
console.log(`   插件/Skills 位置: ${PREFIX}`);
console.log(`   配置已写入: ${CONFIG}`);
const mcpComps = selected.filter((c) => c.type === "mcp");
if (mcpComps.length) {
  if (unresolved.length) {
    console.log("\n⚠️ 以下环境变量未提供，opencode.jsonc 中保留 {env:...} 占位符，需先设置后 MCP 才生效:");
    for (const v of unresolved) console.log(`   - ${v}`);
  } else {
    console.log("\nℹ️ 以下 MCP 组件已写入 opencode.jsonc 并填入密钥（remote 类型，可直接使用）:");
  }
  for (const c of mcpComps) {
    console.log(`   - ${c.name}: 见 ${join(REPO_ROOT, c.setupDoc)}`);
  }
}
