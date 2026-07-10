# AGENTS.md — OpenKitty

OpenCode 插件 / 技能 / MCP 集合（NeuralJ）。无需 OCX，通过 `scripts/install.sh` 分发。

## 命令

```bash
npm run build          # 编译 TS → dist/
npm run typecheck      # 类型检查
bash scripts/install.sh --dry-run   # 预览安装（拷贝 + 合并 opencode.jsonc）
```

## 目录结构

| 目录 | 用途 |
|------|------|
| `src/plugins/` | TypeScript 插件源码 |
| `dist/plugins/` | 编译产物（提交到仓库） |
| `skills/` | Skill 定义（每个子目录一个 `SKILL.md`） |
| `mcp/` | MCP 接入说明文档（`*.md`） |
| `assets/` | 插件配套资源（如 `wecom-template.md`） |
| `scripts/` | 安装器 `install.sh` + `merge-config.mjs` |
| `registry.jsonc` | 组件清单（替代 OCX registry，供安装器读取） |
| `install.sh` | 一键安装入口（用户 `curl` 调用） |

## 开发规范

- 插件使用 TypeScript 编写，导出函数命名：`XxxPlugin`
- 每个插件一个文件
- 新增 skill：在 `skills/<name>/SKILL.md` 创建，并在 `registry.jsonc` 登记
- 新增 MCP：在 `mcp/<name>.md` 写说明，并在 `registry.jsonc` 登记 `mcp` 片段
- **所有可分发组件必须在 `registry.jsonc` 登记**，安装器据此拷贝与合并配置
- 编译产物 `dist/` 由 GitHub Actions 自动提交

## 组件登记（registry.jsonc 字段）

| 字段 | 说明 |
|------|------|
| `files` | 需拷贝到 PREFIX 的源文件（相对仓库根） |
| `target` | PREFIX 下的顶层目标目录（`plugins` / `skills`） |
| `template` | 需拷贝到 `<project>/.opencode/` 的资源文件 |
| `setupDoc` | MCP 安装说明文档路径 |
| `opencode` | 合并进 `opencode.jsonc` 的配置片段（`{prefix}` 占位符会被替换） |

## 分发流程

1. 打 tag `v*` → GitHub Action 构建并打包 `openkitty.tar.gz` 到 Release
2. 用户运行 `curl .../install.sh | bash` → 下载 Release 包 → 调用内置安装器
3. 安装器拷贝插件/技能/模板，合并 `plugin`/`mcp`/`skills` 到 `opencode.jsonc`

## 插件引用（手动方式）

使用绝对路径引用编译后的 JS 文件：

```jsonc
{
  "plugin": [
    "/Users/travis/Developer/repos/openkitty/dist/plugins/xxx.js"
  ]
}
```
