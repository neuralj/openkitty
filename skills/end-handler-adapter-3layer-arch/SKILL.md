---
name: end-handler-adapter-3layer-arch
description: 规范新 Daemon 项目的代码结构，采用 Endpoint → Handler → Adapter 三层架构，支持 Python/Node.js/Go 三语言
---

## 使用场景

当你需要从零创建一个事件驱动的常驻进程项目（如 Webhook 网关、AI Agent 守护进程、消息队列消费者）时，激活此 skill。它会引导你搭建一个严格分层的三层架构：Endpoint 层 → Handler 层 → Adapter 层。

## 架构设计哲学（不可违反）

整体固定三层分层：
```
Endpoint 层 → Handler 层 → Adapter 层
```

### 核心隐喻
- **Endpoint 层**：系统与外部世界的"触角"。只负责接收事件、鉴权拦截、脱壳，并将干净的数据丢给下一层，绝对不能阻塞等待底层执行完毕。
- **Handler 层**：Daemon 的"大脑"。像导演一样调度事件流转，控制执行顺序、分支、状态管理，并提供单次事件的"错误隔离舱"。
- **Adapter 层**：系统与外部基础设施的"手脚"。每个 Adapter 是一个独立的 I/O 执行单元（发 HTTP 请求、调 LLM、读写文件），盲目且忠实地执行指令。

### 事件流契约：Event → Dispatch → Action
- **对外接口快速响应**：Endpoint 接收外部事件后，立即返回 HTTP 200 / Accepted，严禁同步等待长耗时任务，防止上游超时重发。
- **内部链路异步编排**：事件经 Endpoint 脱壳后，由 Handler 和 Adapter 根据业务需求异步组合处理。
- **上下文按需传递**：Endpoint 将原始请求脱壳为标准 EventDTO 传给 Handler；Handler 按需拆包，**仅将 Adapter 需要的具体参数传给它**，严禁 EventDTO 一路透传到底。

### 通用铁律
- 单向依赖：Endpoint → Handler → Adapter，无环形依赖、无跨层调用、无反向调用
- 职责纯粹：Endpoint 不写业务逻辑判断；Adapter 不感知业务上下文流转
- 崩溃隔离：Daemon 必须长青，错误在 Handler 层被统一拦截捕获，单个事件失败绝不允许导致整个进程宕机
- 无全局可变状态、无硬编码密钥或地址

---

## 工作流 Steps

### Step 1：确认项目语言和初始化项目骨架

**任务目标**：根据用户选择的语言（Python、Node.js 或 Go），创建标准的项目根目录和三层骨架目录 `endpoints/`、`handlers/`、`adapters/`。

**你需要做的**：
1. 询问用户项目使用的编程语言（Python、Node.js 或 Go）
2. 在项目根目录下创建三个核心目录：`endpoints/`、`handlers/`、`adapters/`
3. 根据语言初始化对应的项目配置文件（如 Go 的 `go.mod`，Python 的 `pyproject.toml`，Node.js 的 `package.json`）
4. 创建入口启动文件（如 `daemon.py`、`serve.go` 或 `serve.ts`），负责：
   - 初始化日志系统（Logger）
   - 注册信号处理（SIGTERM/SIGINT → 优雅退出）
   - 启动服务或监听器（HTTP Server / MQ Consumer）
   - 捕获全局未处理异常，防止进程意外崩溃

**验收条件**：
- [ ] 项目根目录下存在 `endpoints/`、`handlers/`、`adapters/` 三个目录，缺一不可
- [ ] 项目配置文件已正确初始化，可以被对应语言的包管理器识别
- [ ] 目录层级正确：这三个目录是平级的，都在项目根目录下
- [ ] 目录命名严格使用小写复数，不可使用 `controllers/`、`services/`、`utils/`、`core/` 等替代命名
- [ ] 入口启动文件存在，可被对应语言的运行时识别
- [ ] 入口启动文件包含日志系统初始化逻辑
- [ ] 入口启动文件包含信号处理逻辑，支持优雅退出
- [ ] 入口启动文件包含全局异常捕获逻辑

---

### Step 2：搭建 Endpoint 层（端点网关层）

**任务目标**：在 `endpoints/` 目录下创建 HTTP 路由或事件监听器，实现请求解析、鉴权、脱壳与快速响应。

**你需要做的**：
1. 在 `endpoints/` 目录下创建入口路由文件（如 `router.py` 或 `router.go`），负责：
   - 初始化服务（HTTP Server / MQ Consumer）
   - 注册路由或监听器
   - 挂载全局中间件（鉴权、请求日志）
2. 在 `endpoints/` 目录下为每个外部事件源创建端点文件（如 `lark_webhook.py` 或 `github_webhook.go`），每个端点文件负责：
   - 解析 HTTP Request / Webhook Payload
   - 执行签名校验（Auth Token Verify）
   - 组装为内部标准的 EventDTO 数据传输对象
   - 异步派发给 `handlers/` 层
   - 立刻返回 200 OK 或 `{"status": "received"}`

**验收条件**：
- [ ] `endpoints/` 层代码**不包含任何业务逻辑分支**（如 `if event == 'code_review'`）
- [ ] 所有外部请求在触发 Handler 后立即获得 HTTP 响应，**没有因等待 LLM 或 I/O 而阻塞**
- [ ] 数据进入 Handler 之前，已去除强框架依赖（如 Express 的 `req/res` 或 FastAPI 的 `Request` 对象）
- [ ] Endpoint 层**没有直接调用 `adapters/` 下的任何代码**
- [ ] Endpoint 层构建了标准 EventDTO 并异步传递给 Handler
- [ ] `endpoints/` 目录下不存在任何文件 IO 操作、网络请求或数据处理逻辑

---

### Step 3：搭建 Handler 层（处理器编排层）

**任务目标**：在 `handlers/` 目录下为每个业务场景创建处理器文件，实现事件编排逻辑——按顺序、分支或循环调用多个 Adapter。

**你需要做的**：
1. 根据业务需求，在 `handlers/` 目录下为每个业务场景创建一个文件（如 `message_router.py` 或 `code_review.go`）
2. 每个 Handler 文件的逻辑应遵循以下流程：
   - 接收来自 Endpoint 的 EventDTO
   - 拆解事件内容，执行业务路由（如判断是指令还是普通消息）
   - 构建处理上下文（如携带 CallbackTarget）
   - 按顺序、条件分支或循环调用 `adapters/` 下的多个 Adapter
   - 使用全局 try-catch/recover 包裹整个处理过程，记录错误日志
   - 在需要时通过 Adapter 通知用户失败原因
3. 确保 Handler 内部**不直接执行 I/O 操作**——网络请求、文件读写必须下沉到 Adapter 层

**验收条件**：
- [ ] `handlers/` 目录下每个文件对应一个完整的业务场景
- [ ] Handler 文件中**只包含对 Adapter 的调用和流程控制**（顺序、分支、循环），不包含任何 I/O 实现代码
- [ ] Handler 在调用 Adapter 时，**传递的是具体参数而非整个 EventDTO 对象**
- [ ] Handler 文件中**不包含原始 HTTP 框架依赖**（如 `req`、`res`、`Request`）
- [ ] Handler 文件中**没有任何直接的 `requests.post()`、`fetch()`、`http.Get()` 或文件流操作**
- [ ] 代码是线程/协程安全的，**避免修改全局共享状态**
- [ ] 具备崩溃隔离机制：单次事件处理抛异常**不会导致整个进程退出**
- [ ] 一个 Handler 可以调用多个 Adapter，形成组合复用关系

---

### Step 4：搭建 Adapter 层（适配器动作层）

**任务目标**：在 `adapters/` 目录下创建封装外部交互的文件，每个文件实现一个独立的外部系统对接能力。

**你需要做的**：
1. 根据业务需要对接的外部系统，在 `adapters/` 目录下创建对应的文件
2. 根据项目规模选择组织模式：
   - **模式 A（推荐，中小项目）**：扁平结构，所有 Adapter 文件直接放在 `adapters/` 下
   - **模式 B（复杂项目）**：按外部目标领域分组，在 `adapters/` 下创建领域子目录（如 `im/`、`llm/`、`db/`），领域子目录下再放适配器文件
3. 每个 Adapter 文件遵循以下原则：
   - 只对接一个外部系统或一类外部操作（如发飞书消息、调 LLM API、写数据库）
   - 封装所有韧性策略：HTTP 超时（Timeout）、失败重试（Retry）、API 防抖（Debounce）
   - 所有外部地址、Token、路径由上层或环境变量传入，**禁止硬编码**
   - 提供面向抽象的接口定义（强类型语言需提供 Interface/Protocol）
   - 只返回成功状态、具体数据结果或抛出 I/O 异常
   - 不感知业务流程，不知道自己被哪个 Handler 调用

**验收条件**：
- [ ] `adapters/` 目录下的每个文件只对接一个明确的外部系统或操作
- [ ] Adapter 文件命名以对接目标命名（如 `lark_api`、`openai_client`、`db_repo`）
- [ ] Adapter 文件命名**禁止使用** `_handler`、`handler_`、`_endpoint`、`endpoint_`、`_helper`、`helper_`、`util` 等冗余后缀
- [ ] Adapter 函数签名中**所有外部 URL、Token、路径参数都通过入参或环境变量传入**，无硬编码
- [ ] Adapter 内部**不感知业务流程**，不知道自己被谁调用、调用前后还有什么步骤
- [ ] Adapter 内部**不直接打印日志或输出到控制台**
- [ ] Adapter 内部**不调用 Handler 层或 Endpoint 层的任何代码**
- [ ] 所有 Adapter 都封装了超时和重试策略
- [ ] 如果使用模式 B（领域分组），领域子目录命名清晰明确，不存在 `utils/` 或 `helpers/` 等含义模糊的目录
- [ ] 无论哪种模式，叶子节点都是对接单一外部系统的文件

---

### Step 5：建立层间通信和依赖关系

**任务目标**：确保三层之间的调用关系正确，无跨层调用，无环形依赖，上下文传递符合分层注入原则。

**你需要做的**：
1. 检查并确认调用链严格遵循：Endpoint → Handler → Adapter
   - Endpoint 层只能调用 Handler 层，不能直接调用 Adapter 层
   - Handler 层只能调用 Adapter 层，不能调用 Endpoint 层
   - Adapter 层不能调用 Handler 层或 Endpoint 层
2. 确认 EventDTO 传递方式：
   - Endpoint 层将原始请求脱壳为标准 EventDTO 传给 Handler
   - Handler 层拆解 EventDTO，仅将 Adapter 需要的具体参数传给 Adapter
   - Adapter 层接收的是具体参数，不接收 EventDTO 对象
3. 确认 Logger 的传递方式：
   - Logger 在入口启动文件中统一初始化
   - 各层通过依赖注入或参数接收 Logger，**不自行初始化日志系统**
4. 确认无全局可变状态：
   - 不存在全局字典、全局列表等可被并发修改的共享状态
   - 如需共享状态，必须通过队列、数据库或带锁的封装结构隔离

**验收条件**：
- [ ] 不存在 Endpoint 直接调用 Adapter 的代码
- [ ] 不存在 Adapter 调用 Handler 或 Endpoint 的代码
- [ ] 不存在 Handler 调用 Endpoint 的代码
- [ ] 不存在跨层的 import/require 引用（如 Adapter 文件 import 了 Handler 文件）
- [ ] 不存在环形依赖（A 调 B，B 调 A）
- [ ] Adapter 的函数签名中不包含 EventDTO 类型参数
- [ ] 不存在全局可变状态（全局字典、全局列表等）污染并发任务
- [ ] Logger 在入口处统一初始化，其他层通过参数或依赖注入获取

---

### Step 6：确认异常处理和日志规范

**任务目标**：确保错误和日志的处理遵循"分层拦截"原则——Endpoint 保证服务不崩，Handler 保证单事件隔离，Adapter 保证外部韧性。

**你需要做的**：
1. 检查 Endpoint 层：
   - 确认有全局异常捕获中间件，保证任何未处理异常都返回 500 而非进程崩溃
   - 确认派发给 Handler 的操作是异步的，不阻塞 HTTP 响应
   - 确认没有自行初始化日志系统
2. 检查 Handler 层：
   - 确认每个事件的处理过程被 try-catch/recover 包裹（错误隔离舱）
   - 确认单次事件处理失败不会导致整个进程退出
   - 确认错误通过 Logger 记录（Logger 从入口层传入）
   - 确认需要通知用户时，通过调用 Adapter 发送通知，而非直接输出
3. 检查 Adapter 层：
   - 确认所有外部交互都封装了超时（Timeout）和重试（Retry）策略
   - 确认 I/O 异常通过返回值或异常向上传递
   - 确认没有自行初始化日志系统

**验收条件**：
- [ ] `endpoints/` 目录下有全局异常捕获逻辑，保证服务不因未处理异常而崩溃
- [ ] `handlers/` 目录下每个事件处理都有独立的 try-catch/recover 包裹
- [ ] `adapters/` 目录下所有外部交互都封装了超时和重试逻辑
- [ ] `endpoints/` 和 `handlers/` 目录下不存在直接的 `requests.post()`、`fetch()` 等 I/O 操作
- [ ] `endpoints/`、`handlers/`、`adapters/` 目录下所有文件中不存在 `print`、`fmt.Println`、`console.log` 或类似的直接输出语句
- [ ] 所有层中不存在日志系统的初始化代码（如 `logging.basicConfig`、`log.New`）
- [ ] Handler 层需要通知用户时，通过调用 Adapter 完成，而非直接输出

---

### Step 7：最终架构审查

**任务目标**：对整个项目进行全面的架构审查，确保所有铁律都被遵守。

**你需要做的**：
逐条对照以下铁律清单进行审查，任何一条不通过则要求修正：

**铁律清单**：
1. 项目严格使用 `endpoints/`、`handlers/`、`adapters/` 作为核心骨架目录，命名不可替换
2. 调用链严格遵循 Endpoint → Handler → Adapter，无跨层调用
3. EventDTO 分层传递：Endpoint 脱壳为 EventDTO 给 Handler，Handler 传具体参数给 Adapter
4. Endpoint 实现异步非阻塞返回（Fast Return）
5. Handler 包含单次事件异常隔离舱（Try/Catch）
6. Adapter 封装外部交互的所有超时和重试逻辑
7. 不存在全局可变状态
8. 不存在硬编码的密钥或网络地址
9. Handler 不直接执行 I/O，Adapter 不感知业务流程
10. 每个端点遵循：Endpoint 文件 → Handler 文件 → 多个 Adapter 文件的映射关系
11. 文件命名规范：Adapter 文件以对接目标命名，禁止 `_handler`、`_endpoint`、`_helper` 等后缀

**验收条件**：
- [ ] 以上 11 条铁律全部通过审查
- [ ] 项目可以被对应语言的运行时正确启动并持续运行
- [ ] 新增一个功能点时，开发者能明确知道应该在哪一层添加代码

---

## 两种运行模式（统一架构）

1. **HTTP 网关模式（Webhook/Gateway）**：Endpoint（HTTP Route） → Handler → Adapter
2. **消息消费模式（MQ Consumer）**：Endpoint（Queue Listener） → Handler → Adapter

> Handler 层和 Adapter 层在两种模式下完全复用，只替换上层入口。如果项目后续需要从 HTTP 网关扩展到消息消费模式，Handler 和 Adapter 代码无需修改。

---

## 新增功能时的操作指引

当项目已有骨架，需要新增一个通道或功能点时：

1. **先在 `adapters/` 层实现对接能力**：如果涉及新的外部系统（如新增 Slack 支持），先写好 HTTP Client 适配器
2. **再在 `handlers/` 层编排业务**：创建或修改 Handler 文件，组合调用多个 Adapter 完成业务流程
3. **最后在 `endpoints/` 层暴露路由**：新增 HTTP Route 或事件监听器，将外部请求校验脱壳后路由到 Handler

> 这个顺序不可颠倒。永远从最底层（适配器）开始向上构建。
