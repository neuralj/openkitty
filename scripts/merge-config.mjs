#!/usr/bin/env node
// OpenKitty 配置合并器
// 由 scripts/install.sh 调用。负责：
//   1. 解析 registry.jsonc（去注释）
//   2. 拷贝 plugins / skills / daemon / mcp 文件到 PREFIX
//   3. 拷贝模板文件到 <project>/.opencode/
//   4. 将 opencode 配置片段合并进目标 opencode.jsonc（带备份）
//   5. 为 daemon 组件生成并（可选）注册用户级常驻服务（launchd / systemd）

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  renameSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.HOME || process.env.USERPROFILE || "~";

const args = process.argv.slice(2);
let PREFIX = process.env.OPENKITTY_PREFIX || join(HOME, ".openkitty");
let PROJECT = ".";
let CONFIG = "";
let DRY_RUN = false;
let FORCE = false;
let ENABLE_DAEMON = false;
const ONLY = [];

function usage() {
  console.log(`OpenKitty 安装器

用法:
  node merge-config.mjs [选项]

选项:
  --prefix DIR      插件/技能/daemon/mcp 安装根目录 (默认: $HOME/.openkitty)
  --project DIR     项目根目录，模板与配置写入此处 (默认: 当前目录)
  --config FILE     目标 opencode.jsonc 路径 (默认: <project>/.opencode/opencode.jsonc)
  --component NAME  仅安装指定组件，可多次；默认全部
  --daemon          安装后注册并启用 openhub 常驻服务（launchd/systemd --user）
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
  else if (a === "--daemon") ENABLE_DAEMON = true;
  else if (a === "--dry-run") DRY_RUN = true;
  else if (a === "--force") FORCE = true;
  else if (a === "-h" || a === "--help") {
    usage();
    process.exit(0);
  } else {
    console.error(`error: 未知参数 ${a}`);
    process.exit(1);
  }
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
  if (file.startsWith("dist/daemon/")) return "dist/daemon/";
  if (file.startsWith("dist/mcp/")) return "dist/mcp/";
  if (file.startsWith("skills/")) return "skills/";
  if (file.startsWith("assets/")) return "assets/";
  return "";
}

// 将 "dist/daemon/**" 之类的 glob 展开为实际文件清单
function expandFiles(patterns) {
  const out = [];
  for (const p of patterns) {
    if (p.endsWith("/**")) {
      const base = p.slice(0, -3); // 去掉 "**"，保留 "dist/daemon/"
      const walk = (dir) => {
        for (const e of readdirSync(join(REPO_ROOT, dir))) {
          const full = join(dir, e);
          if (statSync(join(REPO_ROOT, full)).isDirectory()) walk(full);
          else out.push(full);
        }
      };
      walk(base);
    } else {
      out.push(p);
    }
  }
  return out;
}

function copyTo(files, targetDir, baseOut) {
  for (const f of expandFiles(files)) {
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
function plan(msg) {
  plans.push(msg);
  console.log(`  · ${msg}`);
}

// ---- 1. 拷贝 plugins / skills / daemon / mcp / template ----
console.log(`==> 安装到 PREFIX=${PREFIX}`);
for (const c of selected) {
  if (c.type === "plugin" || c.type === "skill" || c.type === "daemon" || c.type === "mcp") {
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
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      base[k] &&
      typeof base[k] === "object" &&
      !Array.isArray(base[k])
    ) {
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
      `read -s -p '请输入 ${varName} 的值（仅写入本地 opencode.jsonc / 服务文件，不会提交到仓库）: ' v; echo "$v"`,
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
  if (c.launch?.env) {
    for (const m of JSON.stringify(c.launch.env).matchAll(/\{env:(\w+)\}/g)) needed.add(m[1]);
  }
}
const envMap = {};
const unresolved = [];
for (const v of needed) {
  if (process.env[v] !== undefined) {
    envMap[v] = process.env[v];
    continue;
  }
  if (DRY_RUN) {
    unresolved.push(v);
    continue;
  }
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
  try {
    current = JSON.parse(stripJsonc(readFileSync(CONFIG, "utf-8")));
  } catch (e) {
    console.error(`error: 无法解析现有配置 ${CONFIG}: ${e.message}`);
    process.exit(1);
  }
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

// ---- 3. daemon 常驻服务注册（launchd / systemd --user）----
function buildPlist(label, cmd, env) {
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${k}</key>\n    <string>${v}</string>`)
    .join("\n");
  const logPath = join(HOME, ".openhub", "daemon.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${cmd.map((c) => `    <string>${c}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`;
}

function buildUnit(label, cmd, env) {
  const envSection = Object.entries(env)
    .map(([k, v]) => `Environment=${k}=${v}`)
    .join("\n");
  return `[Unit]\nDescription=${label} (NeuralJ)\n\n[Service]\nExecStart=${cmd.join(" ")}\n${envSection}\nRestart=always\n\n[Install]\nWantedBy=default.target\n`;
}

function installDaemonService(c) {
  const launch = c.launch;
  if (!launch) return;
  const cmd = (launch.command || ["node", "{prefix}/daemon/index.js"]).map((x) =>
    x.replace(/{prefix}/g, PREFIX),
  );
  const resolved = resolveEnv(fillPrefix({ env: launch.env }, PREFIX), envMap);
  const envObj = resolved.env || {};

  const label = `com.neuralj.${c.name}`;
  if (process.platform === "darwin") {
    const plistPath = join(HOME, "Library", "LaunchAgents", `${label}.plist`);
    const plist = buildPlist(label, cmd, envObj);
    plan(`write launchd plist -> ${plistPath}`);
    if (!DRY_RUN) {
      mkdirSync(dirname(plistPath), { recursive: true });
      writeFileSync(plistPath, plist);
    }
    if (ENABLE_DAEMON && !DRY_RUN) {
      try {
        execSync(`launchctl load ${plistPath}`);
        console.log("  · launchctl load 完成（开机自启 + 后台常驻）");
      } catch (e) {
        console.warn(`  ! launchctl load 失败: ${e.message}`);
      }
    } else {
      console.log(`  ℹ️ 启用常驻服务: launchctl load ${plistPath}`);
    }
  } else if (process.platform === "linux") {
    const unitPath = join(HOME, ".config", "systemd", "user", `${c.name}.service`);
    const unit = buildUnit(label, cmd, envObj);
    plan(`write systemd user unit -> ${unitPath}`);
    if (!DRY_RUN) {
      mkdirSync(dirname(unitPath), { recursive: true });
      writeFileSync(unitPath, unit);
    }
    if (ENABLE_DAEMON && !DRY_RUN) {
      try {
        execSync("systemctl --user daemon-reload");
        execSync(`systemctl --user enable --now ${c.name}.service`);
        console.log("  · systemd 已 enable + start（开机自启 + 后台常驻）");
      } catch (e) {
        console.warn(`  ! systemctl 失败: ${e.message}`);
      }
    } else {
      console.log(`  ℹ️ 启用常驻服务: systemctl --user enable --now ${c.name}.service`);
    }
  } else {
    const envStr = Object.entries(envObj)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.log(`  ℹ️ 手动启动: ${envStr} ${cmd.join(" ")}`);
  }
}

for (const c of selected) {
  if (c.type === "daemon") installDaemonService(c);
}

console.log("\n✅ 完成。");
if (DRY_RUN) console.log("(dry-run 模式，未做任何实际修改)");
console.log(`   插件/Skills/Daemon/MCP 位置: ${PREFIX}`);
console.log(`   配置已写入: ${CONFIG}`);
const mcpComps = selected.filter((c) => c.type === "mcp");
if (mcpComps.length) {
  if (unresolved.length) {
    console.log("\n⚠️ 以下环境变量未提供，opencode.jsonc 中保留 {env:...} 占位符，需先设置后 MCP 才生效:");
    for (const v of unresolved) console.log(`   - ${v}`);
  } else {
    console.log("\nℹ️ 以下 MCP 组件已写入 opencode.jsonc 并填入密钥（local 类型，OpenCode 拉起）:");
  }
  for (const c of mcpComps) {
    console.log(`   - ${c.name}: 见 ${join(REPO_ROOT, c.setupDoc)}`);
  }
}
const daemonComps = selected.filter((c) => c.type === "daemon");
if (daemonComps.length && !ENABLE_DAEMON && !DRY_RUN) {
  console.log("\n💡 使用 `bash install.sh --daemon` 可注册并启用 openhub 常驻服务。");
}
