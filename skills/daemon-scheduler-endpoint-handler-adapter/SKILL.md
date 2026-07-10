---
name: daemon-scheduler-endpoint-handler-adapter
description: 规范事件驱动 + 定时任务混合架构的常驻进程项目，采用 Scheduler + Endpoint → Handler → Adapter 四层架构，支持 TypeScript/Go/Python 三语言
---

## 使用场景

当你需要从零创建一个**既有被动事件响应，又有主动定时任务**的常驻进程项目时，激活此 skill。典型场景包括：
- AI Agent 守护进程（监听事件 + 定时清理/探测）
- Sidecar 控制器（监听 API 限流 + 定时恢复 session）
- 监控 daemon（接收告警 + 定时健康检查）
- 消息队列消费者（被动消费 + 主动重试）

它会引导你搭建一个严格分层的四层架构：Scheduler 层 + Endpoint 层 → Handler 层 → Adapter 层。

## 架构设计哲学（不可违反）

整体固定四层分层：
```
Scheduler 层（主动循环）
Endpoint 层（被动响应）
         ↓
Handler 层（业务编排）
         ↓
Adapter 层（外部交互）
```

### 核心隐喻
- **Scheduler 层**：系统的"闹钟"。定时触发主动任务（轮询、清理、心跳），不依赖外部事件。
- **Endpoint 层**：系统与外部世界的"触角"。接收事件（SSE、Webhook、插件回调），脱壳后丢给 Handler，快速响应。
- **Handler 层**：Daemon 的"大脑"。编排业务逻辑，调度多个 Adapter，状态管理，错误隔离。
- **Adapter 层**：系统与外部基础设施的"手脚"。每个 Adapter 执行一个独立的 I/O 操作（HTTP 请求、文件读写、消息推送）。

### 双驱动模型：主动 + 被动
- **Scheduler 驱动**：定时任务（轮询 API 状态、清理过期数据、心跳检测）
- **Endpoint 驱动**：事件响应（SSE 事件、Webhook 回调、插件通知）
- **共享 Handler**：两种驱动最终都进入 Handler 层，复用业务逻辑
- **共享 Adapter**：Handler 调用 Adapter 执行外部操作

### 事件流契约
- **Scheduler 触发**：定时器到期 → Handler 执行主动任务 → Adapter 执行外部操作
- **Endpoint 触发**：外部事件到达 → Endpoint 脱壳 → Handler 执行业务 → Adapter 执行外部操作
- **快速响应**：Endpoint 接收事件后立即返回（异步处理），严禁同步等待长耗时任务
- **状态收敛**：Scheduler 和 Endpoint 共同驱动状态向期望状态收敛

### 通用铁律
- 单向依赖：Scheduler/Endpoint → Handler → Adapter，无环形依赖、无跨层调用、无反向调用
- 职责纯粹：Scheduler 只触发定时任务；Endpoint 只接收和脱壳事件；Adapter 不感知业务流程
- 崩溃隔离：Daemon 必须长青，错误在 Handler 层被统一拦截，单个任务失败绝不允许导致进程宕机
- 无全局可变状态、无硬编码密钥或地址
- Handler 不区分事件来源（Scheduler 或 Endpoint），只关心业务逻辑

---

## 工作流 Steps

### Step 1：确认项目语言和初始化项目骨架

**任务目标**：根据用户选择的语言（TypeScript/Go/Python），创建标准的项目根目录和四层骨架目录 `scheduler/`、`endpoints/`、`handlers/`、`adapters/`。

**你需要做的**：
1. 询问用户项目使用的编程语言（TypeScript/Go/Python）
2. 在项目根目录下创建四个核心目录：`scheduler/`、`endpoints/`、`handlers/`、`adapters/`
3. 根据语言初始化项目配置文件（如 Go 的 `go.mod`，TypeScript 的 `package.json`，Python 的 `pyproject.toml`）
4. 创建入口启动文件（如 `daemon.ts`、`daemon.go` 或 `daemon.py`），负责：
   - 初始化日志系统（Logger）
   - 注册信号处理（SIGTERM/SIGINT → 优雅退出）
   - 启动 Scheduler（定时任务循环）
   - 启动 Endpoint（事件监听器）
   - 捕获全局未处理异常，防止进程意外崩溃

**验收条件**：
- [ ] 项目根目录下存在 `scheduler/`、`endpoints/`、`handlers/`、`adapters/` 四个目录，缺一不可
- [ ] 项目配置文件已正确初始化
- [ ] 目录命名严格使用小写复数，不可使用 `cron/`、`controllers/`、`services/`、`utils/` 等替代命名
- [ ] 入口启动文件存在，包含日志系统初始化、信号处理、Scheduler 和 Endpoint 启动逻辑
- [ ] 入口启动文件包含全局异常捕获逻辑

---

### Step 2：搭建 Scheduler 层（主动循环层）

**任务目标**：在 `scheduler/` 目录下创建定时任务文件，实现周期性主动任务（轮询、清理、心跳）。

**你需要做的**：
1. 在 `scheduler/` 目录下为每个定时任务创建一个文件（如 `cooldown-probe.ts`、`session-cleaner.ts`）
2. 每个 Scheduler 文件负责：
   - 定义定时任务的执行间隔（interval）
   - 实现任务逻辑（调用 Handler 层的方法）
   - 处理任务执行异常（记录日志，不崩溃）
   - 支持优雅停止（响应 shutdown 信号）
3. 确保 Scheduler 内部**不直接执行 I/O 操作**——必须调用 Handler 层

**验收条件**：
- [ ] `scheduler/` 目录下每个文件对应一个独立的定时任务
- [ ] Scheduler 文件中**不包含任何直接的 HTTP 请求、文件读写或消息推送**
- [ ] Scheduler 通过调用 Handler 层的方法执行业务逻辑
- [ ] Scheduler 支持配置执行间隔（通过环境变量或配置文件）
- [ ] Scheduler 有异常捕获逻辑，单次任务失败不会导致整个 daemon 崩溃
- [ ] Scheduler 支持优雅停止（响应 SIGTERM/SIGINT）

---

### Step 3：搭建 Endpoint 层（被动响应层）

**任务目标**：在 `endpoints/` 目录下创建事件监听器，实现被动事件接收、脱壳与快速响应。

**你需要做的**：
1. 在 `endpoints/` 目录下为每个事件源创建一个端点文件（如 `sse-listener.ts`、`webhook-server.ts`、`plugin-callback.ts`）
2. 每个 Endpoint 文件负责：
   - 建立事件连接（SSE、HTTP Server、消息队列）
   - 接收外部事件
   - 执行签名校验或鉴权（如需要）
   - 组装为标准 EventDTO 数据传输对象
   - 异步派发给 `handlers/` 层
   - 立刻返回响应（如 HTTP 200）
3. 确保 Endpoint 层**不包含任何业务逻辑判断**——只负责接收和脱壳

**验收条件**：
- [ ] `endpoints/` 层代码**不包含任何业务逻辑分支**
- [ ] 所有外部事件在触发 Handler 后立即获得响应，**没有因等待 Handler 执行而阻塞**
- [ ] 数据进入 Handler 之前，已去除强框架依赖（如 Express 的 `req/res`）
- [ ] Endpoint 层**没有直接调用 `adapters/` 下的任何代码**
- [ ] Endpoint 层构建了标准 EventDTO 并异步传递给 Handler
- [ ] `endpoints/` 目录下不存在任何文件 IO 操作、网络请求或数据处理逻辑

---

### Step 4：搭建 Handler 层（业务编排层）

**任务目标**：在 `handlers/` 目录下为每个业务场景创建处理器文件，实现事件编排逻辑——按顺序、分支或循环调用多个 Adapter。

**你需要做的**：
1. 在 `handlers/` 目录下为每个业务场景创建一个文件（如 `cooldown-handler.ts`、`session-manager.ts`）
2. 每个 Handler 文件负责：
   - 接收来自 Scheduler 或 Endpoint 的事件/任务
   - 拆解事件内容，执行业务路由
   - 按顺序、条件分支或循环调用 `adapters/` 下的多个 Adapter
   - 使用全局 try-catch 包裹整个处理过程，记录错误日志
   - 管理业务状态（如限流状态、session 列表）
3. 确保 Handler 内部**不直接执行 I/O 操作**——必须调用 Adapter 层

**验收条件**：
- [ ] `handlers/` 目录下每个文件对应一个完整的业务场景
- [ ] Handler 文件中**只包含对 Adapter 的调用和流程控制**，不包含任何 I/O 实现代码
- [ ] Handler 在调用 Adapter 时，**传递的是具体参数而非整个 EventDTO 对象**
- [ ] Handler 文件中**不包含原始框架依赖**（如 `req`、`res`）
- [ ] Handler 文件中**没有任何直接的 `fetch()`、`http.Get()` 或文件流操作**
- [ ] 代码是线程/协程安全的，**避免修改全局共享状态**
- [ ] 具备崩溃隔离机制：单次任务处理抛异常**不会导致整个进程退出**
- [ ] Handler **不区分事件来源**（Scheduler 或 Endpoint），只关心业务逻辑

---

### Step 5：搭建 Adapter 层（外部交互层）

**任务目标**：在 `adapters/` 目录下创建封装外部交互的文件，每个文件实现一个独立的外部系统对接能力。

**你需要做的**：
1. 在 `adapters/` 目录下为每个外部系统创建一个适配器文件（如 `opencode-api.ts`、`wechat-notify.ts`）
2. 每个 Adapter 文件负责：
   - 封装一个外部系统的交互（HTTP API、文件读写、消息推送）
   - 实现超时（Timeout）、重试（Retry）、错误处理
   - 提供面向抽象的接口定义
   - 只返回成功状态、数据结果或抛出异常
3. 确保 Adapter 内部**不感知业务流程**——不知道自己被哪个 Handler 调用

**验收条件**：
- [ ] `adapters/` 目录下的每个文件只对接一个明确的外部系统
- [ ] Adapter 文件命名以对接目标命名（如 `opencode-api`、`wechat-notify`）
- [ ] Adapter 文件命名**禁止使用** `_handler`、`_endpoint`、`_scheduler`、`_helper` 等冗余后缀
- [ ] Adapter 函数签名中**所有外部 URL、Token、路径参数都通过入参或环境变量传入**，无硬编码
- [ ] Adapter 内部**不感知业务流程**，不知道自己被谁调用
- [ ] 所有 Adapter 都封装了超时和重试策略
- [ ] 无论哪种模式，叶子节点都是对接单一外部系统的文件

---

### Step 6：建立层间通信和依赖关系

**任务目标**：确保四层之间的调用关系正确，无跨层调用，无环形依赖。

**你需要做的**：
1. 检查并确认调用链严格遵循：
   - Scheduler 层只能调用 Handler 层
   - Endpoint 层只能调用 Handler 层
   - Handler 层只能调用 Adapter 层
   - Adapter 层不能调用 Scheduler/Endpoint/Handler 层
2. 确认无全局可变状态：
   - 不存在全局字典、全局列表等可被并发修改的共享状态
   - 如需共享状态，必须通过队列、数据库或带锁的封装结构隔离
3. 确认 Logger 的传递方式：
   - Logger 在入口启动文件中统一初始化
   - 各层通过参数接收 Logger，**不自行初始化日志系统**

**验收条件**：
- [ ] 不存在 Scheduler 直接调用 Adapter 的代码
- [ ] 不存在 Endpoint 直接调用 Adapter 的代码
- [ ] 不存在 Adapter 调用 Scheduler/Endpoint/Handler 的代码
- [ ] 不存在跨层的 import/require 引用
- [ ] 不存在环形依赖
- [ ] 不存在全局可变状态污染并发任务
- [ ] Logger 在入口处统一初始化，其他层通过参数获取

---

### Step 7：确认异常处理和日志规范

**任务目标**：确保错误和日志的处理遵循"分层拦截"原则。

**你需要做的**：
1. 检查 Scheduler 层：
   - 确认每个定时任务都有独立的 try-catch 包裹
   - 确认单次任务失败不会导致整个进程退出
2. 检查 Endpoint 层：
   - 确认有全局异常捕获，保证服务不因未处理异常而崩溃
   - 确认派发给 Handler 的操作是异步的，不阻塞响应
3. 检查 Handler 层：
   - 确认每个任务的处理过程被 try-catch 包裹（错误隔离舱）
   - 确认错误通过 Logger 记录
4. 检查 Adapter 层：
   - 确认所有外部交互都封装了超时和重试策略
   - 确认 I/O 异常通过返回值或异常向上传递

**验收条件**：
- [ ] `scheduler/` 目录下每个定时任务都有独立的 try-catch 包裹
- [ ] `endpoints/` 目录下有全局异常捕获逻辑
- [ ] `handlers/` 目录下每个任务处理都有独立的 try-catch 包裹
- [ ] `adapters/` 目录下所有外部交互都封装了超时和重试逻辑
- [ ] 所有层中不存在直接的 `console.log`、`print`、`fmt.Println` 等输出语句
- [ ] 所有层中不存在日志系统的初始化代码

---

### Step 8：最终架构审查

**任务目标**：对整个项目进行全面的架构审查，确保所有铁律都被遵守。

**你需要做的**：
逐条对照以下铁律清单进行审查：

**铁律清单**：
1. 项目严格使用 `scheduler/`、`endpoints/`、`handlers/`、`adapters/` 作为核心骨架目录
2. 调用链严格遵循 Scheduler/Endpoint → Handler → Adapter，无跨层调用
3. Scheduler 只触发定时任务，Endpoint 只接收和脱壳事件
4. Handler 不区分事件来源（Scheduler 或 Endpoint），只关心业务逻辑
5. Endpoint 实现异步非阻塞响应
6. Handler 包含单次任务异常隔离舱
7. Adapter 封装外部交互的所有超时和重试逻辑
8. 不存在全局可变状态
9. 不存在硬编码的密钥或网络地址
10. Handler 不直接执行 I/O，Adapter 不感知业务流程
11. Logger 统一：入口创建，下层通过参数获取

**验收条件**：
- [ ] 以上 11 条铁律全部通过审查
- [ ] 项目可以被对应语言的运行时正确启动并持续运行
- [ ] 新增一个功能点时，开发者能明确知道应该在哪一层添加代码

---

## 关键设计模式

### 1. 状态管理
- **内存状态**：Handler 层维护业务状态（如限流状态、session 列表）
- **持久化状态**：通过 Adapter 层写入文件或数据库
- **状态收敛**：Scheduler 和 Endpoint 共同驱动状态向期望状态收敛

### 2. 并发安全
- **单线程事件循环**：TypeScript/Python 使用单线程 + 异步 I/O
- **Goroutine/协程**：Go 使用 Goroutine，通过 channel 通信
- **避免共享状态**：使用消息队列或带锁的封装结构

### 3. 优雅退出
- **信号处理**：捕获 SIGTERM/SIGINT
- **停止 Scheduler**：停止所有定时任务
- **停止 Endpoint**：关闭事件监听器
- **等待 Handler**：等待正在执行的任务完成
- **关闭 Adapter**：关闭连接、刷新缓冲区

---

## 新增功能时的操作指引

当项目已有骨架，需要新增一个功能点时：

1. **判断驱动方式**：
   - 如果是定时任务 → 在 `scheduler/` 层添加定时触发器
   - 如果是事件响应 → 在 `endpoints/` 层添加事件监听器
2. **实现业务逻辑**：在 `handlers/` 层创建或修改 Handler，编排 Adapter 调用
3. **对接外部系统**：如果需要新的外部系统 → 在 `adapters/` 层添加 Adapter

> 这个顺序不可颠倒。永远从最底层（Adapter）开始向上构建。

---

## 示例项目结构

```
my-daemon/
├── scheduler/
│   ├── cooldown-probe.ts      # 定时探测 API 限流状态
│   └── session-cleaner.ts     # 定时清理过期 session
├── endpoints/
│   ├── sse-listener.ts        # 监听 opencode SSE 事件流
│   └── plugin-callback.ts     # 接收插件回调
├── handlers/
│   ├── cooldown-handler.ts    # 限流恢复业务逻辑
│   └── session-manager.ts     # session 生命周期管理
├── adapters/
│   ├── opencode-api.ts        # 调用 opencode HTTP API
│   ├── wechat-notify.ts       # 推送企微消息
│   └── file-state.ts          # 读写状态文件
├── daemon.ts                  # 入口启动文件
└── package.json
```
