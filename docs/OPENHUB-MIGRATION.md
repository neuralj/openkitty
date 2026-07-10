# OpenHub 迁移方案（daemon + MCP）

本文定义如何将 OpenKit 的 `openhub`（Go 守护进程 + Vue 后台）以**纯 TypeScript** 形态迁移进 OpenKitty，
作为常驻编排服务分发。这是「OpenKit 溯源」分析的后续决策（见 `docs/DESIGN.md`）。

## 一、已确认决策

| # | 议题 | 决策 |
|---|------|------|
| 1 | 持久化选型 | **`lowdb`（JSON 文件）**，保持 OpenKitty 纯 TS、零原生编译依赖（不引入 `better-sqlite3`） |
| 2 | daemon 与 OpenCode 关系 | **同机假设**：daemon 通过 `OPENHUB_SERVER_URL`（默认 `http://localhost:4096`）连接本机 OpenCode Server；OpenCode 未启动则排队不执行（文档需讲清） |
| 3 | Web UI 构建来源 | 复用现有 `openhub-web` 前端，将其构建产物 `dist/` 作为静态资源随 daemon 分发并托管；MVP 先交付 daemon + MCP，webui 后续增强 |
| 4 | probe 探测语义 | **发送一个无害 ping，看任务是否仍被中断**；若返回不再是 `aborted`，说明 agent 已脱离 cooldown，则重入队失败任务并恢复队列 |

---

## 二、功能设计

### 2.1 总体定位

`openhub` 是一个**不执行 AI 的编排守护进程**：作为 OpenCode Server 的 HTTP 客户端，把"任务"派发到 OpenCode 的多个 session，负责队列、定时、cooldown 自愈、持久化与实时事件。

迁移后在 OpenKitty 拆成 **两个可分发单元**：

- **`openhub-daemon`**（常驻 Node 进程）：真正干活的"大脑"，不依赖 OpenCode 是否打开 TUI，7×24 运行。
- **`openhub-mcp`**（MCP server）：被 OpenCode 拉起的"agent 操作入口"，暴露工具给 AI 调用，内部转调 daemon 的 HTTP API。

两者通过本机 HTTP 通信。Web UI 复用原 Vue 代码，由 daemon 内嵌 HTTP 托管。

### 2.2 与 OpenCode 的集成关系

```
OpenCode Server (AI 运行时, 默认 :4096)
   ▲  HTTP /session/* (6 端点)          ▲ 同上
   │                                     │
openhub-daemon ── 编排 ──► 多 session    openhub-daemon 主动 poll /session/{id}/message
   │  HTTP API + SSE + 静态 webui
   ├── openhub-mcp (agent 入口, OpenCode 拉起)
   └── openhub-web (Vue dashboard, 浏览器)
```

- daemon 是 OpenCode Server 的**客户端**，不是插件。通过 `OPENHUB_SERVER_URL` 连接。
- daemon 维护"受管目录 → agent session"映射（`OPENHUB_DIRECTORIES` 配置）。

### 2.3 任务生命周期（队列状态机）

```
submit ─► pending ─► running ─► completed
                  │            └─► failed ─► (重试<max) pending
                  │                          └─► (重试≥max) failed(终态)
                  └─ (message aborted) ─► cooldown(paused) ─► 恢复后 pending
```

- `pending`：入队，等待 `QueueProcessor` 取出。
- `running`：`QueueProcessor` 建 session + `POST /session/{id}/message` 派发。一次只跑一个 running（避免并发打爆限流）。
- `completed`/`failed`：读 `GET /session/{id}/message` 判定终态。
- 超时（默认 30min）→ `failed`，重试计数 +1，未超 `maxAttempts`(默认 5) 则重入队。
- 收到 `message aborted` → 进 cooldown，队列 `Pause`。

### 2.4 定时任务（recurring）

- cron 格式：**5 字段**（`分 时 日 月 周`）+ 简写 `@hourly`/`@daily`。
- `RecurringScheduler` 每分钟 tick，算 `nextRun` 落入当前分钟则生成任务实例入队。
- 支持 `timezone`、`enabled` 开关、`lastRunAt` 防重复；重启从持久化恢复下一次触发时间。

### 2.5 Cooldown 自愈闭环（核心）

1. `QueueProcessor` 派发后，`SendMessage` 返回 `Info.Error.Name === "MessageAbortedError"`（字符串 `"message aborted"`）。
2. → `cooldown.add(agentID, resumePrompt)`：记录该 agent 进入冷却，`QueueProcessor.Pause()`。
3. `probeLoop`（按 `OPENHUB_PING_INTERVAL`，默认 14min）对该 agent 的 session 发送一个**无害 ping**（如文本 `"only ping"`）。
4. **探测语义（决策 4）**：若 ping 的返回**不再是 `aborted`**，说明 agent 已脱离 cooldown 状态；此时 `RetryFailedByAgent(agentID)` 把该 agent 的失败任务重入队 + `QueueProcessor.Resume()`。若仍 `aborted`，继续等待下一轮 probe。
5. 前端 `cooldown-guard` 插件（已迁移）负责真正 abort；daemon 负责检测与恢复——两件套构成分布式限流防护。

### 2.6 实时事件与 Web UI

- `EventHub` 基于 `EventEmitter`，事件类型 `task | agent | status`，经 SSE `GET /events` 推送给 webui。
- Web UI（原 `openhub-web` Vue）复用，连 daemon HTTP 端口：Dashboard / Kanban / Agents / Tasks / TaskDetail / Recurring / Cooldown 七页。Cooldown 页可手动 `Trigger/Cancel Probe`、配每 agent 恢复 prompt。
- webui 构建产物（dist）作为静态资源，由 daemon 静态托管（决策 3）。

### 2.7 持久化

- 原 openhub 用 SQLite（`go-sqlite3`）。为保证纯 TS、零原生依赖，改为 **`lowdb`（JSON 文件）**（决策 1）。
- 集合：`tasks[]`、`recurring_tasks[]`。重启 `retryFromDB` 恢复未终态任务。

---

## 三、代码设计

### 3.1 目录结构（落在 OpenKitty 仓库内）

```
src/daemon/
  index.ts            # daemon 入口（替代 openhub/main.go 的 flags 解析）
  config.ts           # 读取 env: OPENHUB_SERVER_URL / DIRECTORIES / PORT / PING_INTERVAL / MODEL / DB_PATH
  opencode-client.ts  # 封装 OpenCode Server 6 个 HTTP 端点（替代 adapters/opencode.go）
  store.ts            # lowdb 持久化（替代 SQLite）
  queue.ts            # QueueProcessor + 状态机
  recurring.ts        # cron 解析 + RecurringScheduler
  cooldown.ts         # CooldownManager + probe 循环
  agents.ts           # agent/session 映射管理
  eventhub.ts         # EventEmitter + SSE 序列化
  server.ts           # HTTP API + 静态托管 openhub-web/dist
src/mcp/
  openhub-mcp.ts      # MCP server：agent 操作入口（替代 CLI submit/status）
assets/openhub-web/   # 原 Vue 构建产物 dist（决策 3）
```

### 3.2 核心类型（TS）

```ts
// opencode-client.ts
export interface SessionPart { type: "text"; text: string }
export interface SendMessageBody { parts: SessionPart[]; model: string }
export interface SessionInfo { id: string; parentID: string | null; directory?: string }
export interface SendMessageResult {
  info?: { error?: { name: string; message?: string } }
}

export class OpenCodeClient {
  constructor(private baseUrl: string, private defaultModel: string) {}
  async createSession(directory: string): Promise<{ id: string }>
  async listSessions(directory: string): Promise<SessionInfo[]>   // 跳过 parentID!=null
  async sendMessage(sessionId: string, prompt: string, model?: string): Promise<SendMessageResult>
  async abortSession(sessionId: string): Promise<void>
  async getMessages(sessionId: string): Promise<unknown[]>
  async deleteSession(sessionId: string): Promise<void>
  // 内部: parseModel("provider/model") -> {providerID, modelID}
  // 内部: isAborted(r) => r.info?.error?.name === "MessageAbortedError"
}
```

```ts
// store.ts
export type TaskStatus = "pending" | "running" | "completed" | "failed";
export interface TaskRecord {
  id: string; directory: string; prompt: string; model: string;
  status: TaskStatus; agentID?: string;
  attempts: number; maxAttempts: number;
  createdAt: number; updatedAt: number; cooldownUntil?: number;
}
export interface RecurringRecord {
  id: string; name: string; directory: string; prompt: string; model: string;
  cron: string; timezone?: string; enabled: boolean; lastRunAt?: number;
}
export class Store {
  async load(): Promise<void>
  async addTask(t: TaskRecord): Promise<void>
  async updateTask(id: string, patch: Partial<TaskRecord>): Promise<void>
  async getTask(id: string): Promise<TaskRecord | undefined>
  async listTasks(filter?: Partial<TaskRecord>): Promise<TaskRecord[]>
  async addRecurring(r: RecurringRecord): Promise<void>
  async listRecurring(): Promise<RecurringRecord[]>
  async retryFromDB(): Promise<TaskRecord[]>   // 重启恢复
}
```

```ts
// queue.ts
export class QueueProcessor {
  private paused = false;
  constructor(private client: OpenCodeClient, private store: Store,
              private events: EventHub, private cooldown: CooldownManager) {}
  enqueue(task: TaskRecord): void
  pause(): void
  resume(): void
  private async loop(): Promise<void>   // 单循环: dequeue -> running -> 派发 -> 判定
  private async runOne(task: TaskRecord): Promise<void> {
    // 1. createSession(task.directory) -> agentID
    // 2. sendMessage -> 若 isAborted -> cooldown.add + this.pause()
    // 3. 轮询 getMessages 直到终态 -> completed/failed
    // 4. 超时 30min -> failed + 重试
  }
}
```

```ts
// recurring.ts
export interface CronSchedule { /* 解析后的 5 字段匹配器 */ }
export function parseCron(expr: string): CronSchedule   // 支持 @hourly/@daily
export function nextRun(s: CronSchedule, from: Date): Date
export class RecurringScheduler {
  constructor(private store: Store, private queue: QueueProcessor) {}
  start(): void { setInterval(() => this.tick(), 60_000) }
  private tick(): void { /* 计算到期 -> 生成 TaskRecord -> queue.enqueue */ }
}
```

```ts
// cooldown.ts
export interface CooldownEntry { agentID: string; until: number; resumePrompt: string }
export class CooldownManager {
  private entries = new Map<string, CooldownEntry>();
  constructor(private client: OpenCodeClient, private queue: QueueProcessor,
              private pingIntervalMs: number) {}
  add(agentID: string, resumePrompt: string): void { this.queue.pause() }
  start(): void { setInterval(() => this.probe(), this.pingIntervalMs) }
  private async probe(): Promise<void> {
    for (const [agentID, e] of this.entries) {
      // 决策 4: 发送无害 ping，探测是否仍处 cooldown
      const r = await this.client.sendMessage(agentID, "only ping");
      if (!this.client.isAborted(r)) {
        await this.retryFailedByAgent(agentID);  // 重入队失败任务
        this.entries.delete(agentID);
        this.queue.resume();
      }
    }
  }
  private async retryFailedByAgent(agentID: string): Promise<void> { /* store 过滤重入队 */ }
}
```

```ts
// eventhub.ts
export type EventKind = "task" | "agent" | "status";
export class EventHub extends EventEmitter {
  emitTask(p: object): void { this.emit("task", p) }
  emitAgent(p: object): void { this.emit("agent", p) }
  emitStatus(p: object): void { this.emit("status", p) }
  toSSE(req, res): void { /* text/event-stream, 监听三类事件序列化下发 */ }
}
```

```ts
// server.ts
export function startHttpServer(opts: {
  port: number; events: EventHub; queue: QueueProcessor;
  store: Store; webDistDir: string;
}) {
  // GET  /events                     SSE
  // GET  /tasks           list
  // GET  /tasks/:id       detail
  // POST /tasks           submit  {directory, prompt, model}
  // POST /tasks/:id/abort
  // GET  /agents
  // GET  /recurring  POST /recurring
  // GET  /health        (cooldown 倒计时, 供 webui Cooldown 页)
  // static /  -> webDistDir (openhub-web/dist)
}
```

```ts
// src/mcp/openhub-mcp.ts  (agent 操作入口)
// 工具清单 (MCP tool schema):
//   openhub_submit_task({directory, prompt, model})   -> {taskId}
//   openhub_get_task_status({id})                     -> TaskRecord
//   openhub_list_tasks({status?})                     -> TaskRecord[]
//   openhub_abort_task({id})
//   openhub_schedule_recurring({name, directory, prompt, cron, timezone?})
//   openhub_list_agents()
// 实现: 每个 tool 内部 fetch(`http://localhost:${DAEMON_PORT}/...`)
```

### 3.3 registry.jsonc 登记（接入现有分发）

```jsonc
{ "type": "daemon", "name": "openhub",
  "files": ["src/daemon/**", "dist/daemon/**", "assets/openhub-web/**"], "target": "daemon",
  "opencode": {},
  "launch": { "pingInterval": "{env:OPENHUB_PING_INTERVAL}",
              "serverUrl": "{env:OPENHUB_SERVER_URL}",
              "directories": "{env:OPENHUB_DIRECTORIES}" } }
{ "type": "mcp", "name": "openhub",
  "opencode": { "mcp": { "openhub": { "type": "local",
    "command": "node", "args": ["{prefix}/daemon/openhub-mcp.mjs"],
    "enabled": true,
    "env": { "OPENHUB_DAEMON_PORT": "{env:OPENHUB_DAEMON_PORT}" } } } } }
```

`install.sh` 增加 `--daemon` 模式：注册 **launchd (macOS `~/Library/LaunchAgents`) / systemd --user** 用户服务，开机自启、后台常驻；密钥仍走 `{env:...}` + 交互提示（沿用已实现逻辑）。

### 3.4 运行时对照

| 能力 | 原 openhub (Go) | 迁移后 (TS) |
|------|----------------|------------|
| 常驻进程 | `go run main.go -server ...` | `node dist/daemon/index.mjs`（用户服务） |
| 队列/cron/cooldown | 协程 + channel | `setInterval` + `EventEmitter` |
| OpenCode 客户端 | `adapters/opencode.go` | `opencode-client.ts`（6 端点一致） |
| 持久化 | SQLite (go-sqlite3) | lowdb (JSON，零原生依赖) |
| 实时事件 | SSE `/events` | 同，daemon 内嵌 |
| Web UI | `-web` 挂静态 | daemon 静态托管 `openhub-web/dist` |
| agent 入口 | CLI `submit/status` | MCP server `openhub_*` 工具 |
| probe | 发 ping 探活 | 同：`sendMessage(agentID,"only ping")`，仍 aborted 则继续等待 |

---

## 四、与 OpenKitty 分发的契合度

- **纯 TS、零原生依赖**：符合 OpenKitty 定位（lowdb 替代 SQLite）。
- **复用现有 install/registry/密钥提示全链路**：daemon 与 mcp 两个单元均走 `registry.jsonc` 登记，`{env:...}` + 交互提示保证密钥不进 public 仓库。
- **定位升级**：OpenKitty 从"被动组件分发库"扩展为"可分发常驻编排服务"。需接受此升级（已由用户确认推进本方案）。

## 五、待办 / 后续

1. 最小 spike：`opencode-client.ts` + `queue.ts` + `cooldown.ts` 跑通对接真实 OpenCode Server（决策 4 的 probe 语义待实测验证）。
2. 移植前回读 `handlers/cooldown.go` + `scheduler/` 校准字段名（如 `message aborted` 确切来源）。
3. webui：`openhub-web` 构建产物纳入 `assets/openhub-web/`（决策 3，MVP 后可做）。
4. `install.sh --daemon` 服务注册实现（launchd / systemd --user）。
