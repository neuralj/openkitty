# openhub MCP（agent 操作入口）

openhub 编排守护进程的 MCP 入口。被 OpenCode 作为子进程拉起（stdio），让 agent 能直接操作编排器：提交/查询任务、创建定时任务、查看受管目录与 cooldown 状态。

## 前置条件

- 必须先安装并运行 **openhub-daemon**（`registry` 中 `type: "daemon"` 的 `openhub` 组件）。
- daemon 默认监听 `http://localhost:7099`（由 `OPENHUB_PORT` 控制）。

## 安装

```bash
bash install.sh --component openhub --component openhub-mcp
```

安装器会：
1. 把 `dist/daemon/**` 拷到 `$PREFIX/daemon/`，`dist/mcp/openhub-mcp.js` 拷到 `$PREFIX/mcp/`；
2. 把 `openhub` MCP 引用（local 类型）合并进 `opencode.jsonc`；
3. 注册并启用 daemon 常驻服务（需加 `--daemon`）。

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `OPENHUB_DAEMON_PORT` | daemon 监听端口（MCP 连接用） | `7099` |
| `OPENHUB_DAEMON_URL` | daemon 完整地址（可选，覆盖上面的端口拼接） | `http://localhost:<PORT>` |

> 密钥/敏感配置通过 `{env:...}` 占位符在安装时交互填入，仅写入本地 `opencode.jsonc`，不会提交到仓库。

## 暴露的工具

| 工具 | 作用 |
|------|------|
| `openhub_submit_task` | 提交任务（目录 + 提示词），返回 `taskId` |
| `openhub_get_task_status` | 查询单个任务状态 |
| `openhub_list_tasks` | 列出任务，可按 `status` 过滤 |
| `openhub_abort_task` | 中止运行中任务（abort 对应 OpenCode session） |
| `openhub_schedule_recurring` | 创建定时任务（cron 5 字段 / `@hourly` / `@daily`） |
| `openhub_list_agents` | 列出受管目录与 cooldown 状态 |

## 典型用法（agent 视角）

> "帮我在 `/path/to/project` 提交一个重构任务" → 调用 `openhub_submit_task`，随后 `openhub_get_task_status` 轮询结果。

> "每天早上跑一次报表" → 调用 `openhub_schedule_recurring`（`cron: "@daily"`）。
