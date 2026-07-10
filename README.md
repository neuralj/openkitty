# OpenKitty

OpenCode 插件 / 技能 / MCP 集合（NeuralJ）。

提供三类可分发组件：

| 类型 | 组件 | 说明 |
|------|------|------|
| plugin | `cooldown-guard` | API 限流 retry 阻断：会话重试超过阈值时自动 abort |
| plugin | `wecom-notify` | 会话摘要 / 异常 / 权限请求推送企业微信群机器人 |
| skill | `cli-task-function-3layer-arch` | 规范 CLI 项目结构：CLI → Task → Function |
| skill | `end-handler-adapter-3layer-arch` | 规范事件驱动 Daemon：Endpoint → Handler → Adapter |
| skill | `daemon-scheduler-endpoint-handler-adapter` | 规范事件 + 定时任务混合 Daemon 四层架构 |
| mcp | `bing-search` | 必应搜索 MCP（需 `BING_SEARCH_URL`） |
| mcp | `cloudsway-search` | 小宿科技智能搜索 MCP（需 `CLOUDSWAY_SEARCH_URL`） |

## 安装（推荐，无需 OCX）

一行命令完成插件 / 技能 / 模板拷贝，并自动合并进 `opencode.jsonc`：

```bash
curl -fsSL https://raw.githubusercontent.com/neuralj/openkitty/main/install.sh | bash
```

可选参数：

```bash
curl -fsSL https://raw.githubusercontent.com/neuralj/openkitty/main/install.sh | bash -s -- \
  --prefix ~/.openkitty \
  --project ~/my-project \
  --component wecom-notify \      # 仅安装指定组件，可多次；默认全部
  --dry-run                       # 只预览，不修改
```

- `--prefix`：插件 / 技能安装根目录（默认 `~/.openkitty`）
- `--project`：项目根目录，模板与 `opencode.jsonc` 写入此处（默认当前目录）
- `--config`：指定要合并的 `opencode.jsonc` 路径
- `--force`：覆盖已存在的文件

安装器会先备份原 `opencode.jsonc`（`.bak`），再合并 `plugin` / `mcp` / `skills` 条目（自动去重）。

## 手动安装

```bash
git clone https://github.com/neuralj/openkitty ~/Developer/repos/openkitty
cd ~/Developer/repos/openkitty
npm install
npm run build
bash scripts/install.sh --prefix ~/.openkitty --project .
```

## MCP 配置

`bing-search` / `cloudsway-search` 安装后写入 MCP 引用，需提供对应 URL 才会生效。有两种方式：

**方式一：安装时交互输入（推荐）** — 在终端直接运行安装命令，未设置环境变量时会从 `/dev/tty` 隐藏式提示输入密钥，并写入本地 `opencode.jsonc`（**不会进入本仓库**）：

```bash
curl -fsSL https://raw.githubusercontent.com/neuralj/openkitty/main/install.sh | bash
```

**方式二：预置环境变量** — 跳过交互，安装器用环境变量值填充配置：

```bash
export BING_SEARCH_URL="https://agentrs.jd.com/mcp/YOUR_TOKEN/sse"
export CLOUDSWAY_SEARCH_URL="https://agentrs.jd.com/mcp/YOUR_TOKEN/sse"
```

> CI / 无终端（无 TTY）场景下不会提示，配置保留 `{env:...}` 占位符，之后手动设环境变量即可。

获取 URL 与计费说明见 `mcp/bing-search.md`、`mcp/cloudsway-search.md`。

## 更新

```bash
cd ~/Developer/repos/openkitty && git pull && npm install && npm run build
bash scripts/install.sh --force
```

## 发布

打 tag 触发 GitHub Action 自动构建并打包 `openkitty.tar.gz` 到 Release：

```bash
git tag v1.0.0 && git push origin v1.0.0
```

## 开发

```bash
# 编辑 src/plugins/*.ts
npm run build
npm run typecheck
```

## 设计文档

- [组件功能设计分析（OpenKit 溯源）](docs/DESIGN.md)：各组件功能设计、cooldown 分布式闭环、与 OpenKit 的迁移关系。
- [OpenHub 迁移方案（daemon + MCP）](docs/OPENHUB-MIGRATION.md)：将 openhub 编排守护进程以纯 TS 重写为常驻 daemon + MCP 入口的详细功能与代码设计。

## 目录结构

```
openkitty/
├── src/plugins/        # TypeScript 插件源码
├── dist/plugins/       # 编译产物（提交到仓库）
├── skills/             # Skill 定义（SKILL.md）
├── mcp/                # MCP 接入说明文档
├── assets/             # 插件配套资源（如 wecom-template.md）
├── scripts/            # install.sh + merge-config.mjs 安装器
├── registry.jsonc      # 组件清单（替代 OCX registry，供安装器读取）
├── install.sh          # 一键安装入口（curl 调用）
└── package.json
```
