# 组件功能设计分析（OpenKit 溯源）

本文整理 OpenKit（`xtin/openkit`）各组件的功能设计，并标注其与 OpenKitty（`neuralj/openkitty`）的迁移关系。
OpenKitty 已收纳 OpenCode 插件层 + 技能/MCP 层，并通过 `install.sh` + `registry.jsonc` + GitHub Action 实现无 OCX 分发。

> 范围：排除 `lark-bridge`（Bun + `@opencode-ai/sdk` 独立桥接进程，非 OpenCode 插件）。

## 总体设计脉络

```
OpenCode Server (AI 运行时, session 管理)
   ▲ HTTP /session/*                  ▲ 同左
   │                                   │
cooldown-guard ── abort ──► openhub (编排: 队列/定时/cooldown/agent/SSE)
wecom-notify  ── 推送 ──► 企业微信         │ REST + SSE
                                      openhub-web (Vue Dashboard)
```

贯穿全局的三条设计主线：
1. **分层架构同构**：skill 文档的「三层/四层 + 依赖注入」与 openhub 的 `endpoints/handlers/adapters/scheduler` 完全一致，是团队统一方法论。
2. **cooldown 分布式闭环**：`cooldown-guard` 前端熔断 ↔ `openhub` 后端检测 + probe 自愈，是最精巧的跨组件协作。
3. **密钥/配置外置**：wecom-notify（`.env`/opencode.jsonc）、MCP（`{env:...}`）、cooldown 恢复 prompt 均不入代码——安全与可移植优先。

---

## 一、OpenCode 插件层

### 1. `cooldown-guard` —— 轻量事件守卫 ✅ 已迁移（源码一致）

- **功能**：监听 `session.status`，当某会话 `retry` 次数超过阈值（`RETRY_LIMIT=2`）时调用 `client.session.abort` 强制中止，防止 API 限流下无限重试空耗配额。
- **设计要点**：
  - 纯内存、无状态：`Map<sessionID, count>` 计数，会话 `idle` 清除，`dispose` 清空；不落盘、重启即失忆，契合“即时熔断”语义。
  - 事件驱动：只关心 `session.status`，其它事件直接 return，开销极小。
  - 可开关：`COOLDOWN_GUARD_ENABLED=false` 即禁用。
  - 与 openhub 隐式耦合：abort 后 openhub 通过 `SendMessage` 收到 `message aborted` 被动感知限流，进入 cooldown 恢复流程。

### 2. `wecom-notify` —— 富文本通知聚合器 ✅ 已迁移（源码一致）

- **功能**：把一次会话的全过程（工具调用链、文件变更、AI 思考/回复、异常、授权请求、待确认问题）汇总推送到企业微信群机器人（markdown 卡片）。
- **设计要点**：
  - 每会话状态机：`SessionState{ tools[], files:Map, startTime, isChild, retry }`，在 `tool.execute.after` 累积，到 `session.idle` 成稿推送。
  - 去重窗口：4 个 `DedupeMap`（ready/error/permission/question），各 1.5s 防刷屏。
  - 孤儿回收：`setInterval` 每分钟清理超 30min 无活动会话。
  - 配额感知：检测 `quota exceeded / 429 / rate limit`，发“超限 → 重试 N 次 → 恢复”三段式通知，是 cooldown 主题的配套可观测性。
  - 配置双通道：优先 `opencode.jsonc` 的 `openkit.wecomNotify`，回退 `.env` 的 `WECOM_WEBHOOK_URL`。
  - 模板可插拔：优先渲染 `.opencode/wecom-template.md`（`{{status}}`/`{{prompt}}` 等占位符），无模板则内置分节降级，按 4000 字节切条。
  - 子会话过滤：`isParentSession` 查 `parentID`，只通知父会话。
  - 定位：即时聚合与投递的“可观测性外设”，不介入 agent 执行。

---

## 二、技能 / MCP 层

### 3. 三个架构 Skill（开发规范）✅ 已迁移（内容一致）

纯文档型（`SKILL.md`），给 AI 定架构范式，非运行时组件：
- `cli-task-function-3layer-arch`：CLI → Task → Function
- `end-handler-adapter-3layer-arch`：Endpoint → Handler → Adapter
- `daemon-scheduler-endpoint-handler-adapter`：Scheduler + Endpoint → Handler → Adapter

共性：三层/四层 + 依赖注入 + 接口隔离，与 openhub 分层同构。

### 4. MCP 搜索 Bundle ✅ 已迁移（openkitty 增强）

- `cloudsway-search`：远程 `mcp` 块，`{env:CLOUDSWAY_SEARCH_URL}` 注入，`type: remote` + `enabled: true`。
- `bing-search`（openkitty 增强）：openkit 原仅有 setup 文档、无 opencode 配置；openkitty 补了 `mcp.bing-search` 的 `{env:BING_SEARCH_URL}` 自动注入。
- 定位：外部搜索能力以 `remote` MCP 挂入 OpenCode，密钥走环境变量不落配置（与 wecom-notify 的密钥外置一致）。

---

## 三、服务端编排层（未迁移，非插件）

### 5. `openhub`（Go 守护进程）—— 核心编排层

- **定位**：AI Agent 任务编排平台，自身不执行 AI，作为 OpenCode 的“调度大脑”经 HTTP 派发任务。
- **四层架构**（与 skill 文档同构）：
  ```
  endpoints (HTTP API 门面)
     └─ handlers (QueueHandler / CooldownHandler / AgentHandler / RecurringHandler)
          └─ adapters (OpencodeAPI / Database / EventHub)
               └─ scheduler (QueueProcessor / RecurringScheduler 后台协程)
  ```
- **关键设计**：
  - 任务队列状态机 `pending → running → completed/failed`；`QueueProcessor` 单协程 `Dequeue` 执行，遇 `message aborted` 进入 cooldown + 暂停队列；stale 任务（30min 超时）最多重试 5 次。
  - 定时任务：`RecurringScheduler` 每分钟 tick，cron（5 字段 + `@hourly/@daily`）生成实例入队。
  - Cooldown 自愈：内嵌 `cooldown-guard.ts` 源码字符串；probe 按 `pingInterval`（默认 14min）ping，成功则向被 abort 的 agent 发“继续”恢复 prompt，并把失败任务重入队、resume 队列。
  - 实时监控：`EventHub` 基于 `chan Event` + SSE（`/events`），前端/CLI 实时订阅 `task/agent/status`。
  - 持久化：SQLite（WAL），`tasks`/`recurring_tasks` 表，重启恢复。
  - CLI：`submit/status/task/agents` 子命令，走 `OPENHUB_URL` 直连。

### 6. `openhub-web`（Vue 3）—— 管理后台

- **定位**：openhub 的 Dashboard 前端，axios + `EventSource` 双通道。
- **设计要点**：
  - 6 路由懒加载：Dashboard / Kanban / Agents / Tasks / TaskDetail / Recurring / Cooldown。
  - Pinia store 持有 `status/agents/sseConnected`，订阅 SSE 实时合并增量；写操作封装在 store。
  - Cooldown 页亮点：轮询 `/health` 看倒计时、配每 agent 恢复 prompt、`Trigger/Cancel Probe`——把 cooldown 自愈流程可视化、可手动干预。
  - 不直连 OpenCode：仅“Open in OpenCode”超链跳转到 openhub `/config` 返回的 `opencodeServerUrl`。

### 7. `opencar`（已废弃）

- 仅 `main.go` + `opencode.go`，无第三方依赖，**只做 cooldown 检测与恢复**（插件主动 POST `{sessionID, expiresAt}`）。
- 已被 openhub 取代：openhub 改为被动检测 `message aborted`、直接 ping 被 abort 的 agent，无需独立 probe session 目录，额外提供队列/定时/Web/持久化。**不应再构建部署**。

---

## 迁移状态总览

| 组件 | 类型 | openkit | openkitty | 状态 |
|------|------|---------|-----------|------|
| `cooldown-guard` | plugin | `.ts` 直引 | 编译 `.js` | ✅ 一致 |
| `wecom-notify` | plugin | `.ts` + 模板 | 编译 `.js` + 模板 | ✅ 一致 |
| `wecom-template.md` | asset | `assets/` | `assets/` | ✅ 一致 |
| 3 个 skills | skill | `skills/*.md` | `skills/*.md` | ✅ 一致 |
| `cloudsway-search` | mcp bundle | setup + 配置 | `mcp/*.md` + 配置 | ✅ 一致 |
| `bing-search` | mcp bundle | 仅 setup 文档 | `mcp/*.md` + 自动配置 | ⚠️ openkitty 增强 |
| `openhub` | Go daemon | 编排层 | — | 非插件，不迁移 |
| `openhub-web` | Vue | Dashboard | — | 非插件，不迁移 |
| `opencar` | Go | 已废弃 | — | 不迁移 |
| `lark-bridge` | Bun | 桥接进程 | — | 已排除，不迁移 |

OpenKitty 已收纳「插件层 + 技能/MCP 层」并补了 bing-search 自动配置与无 OCX 一键分发；openhub / openhub-web / opencar / lark-bridge 为独立服务端或桥接程序，本就不在 OCX 分发范围。
