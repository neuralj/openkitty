---
name: cli-task-function-3layer-arch
description: 规范新 CLI 项目的代码结构，采用 CLI → Task → Function(funcs) 三层架构，支持 Python + Go 双语言
---

## 使用场景

当你需要从零创建一个 CLI 工具项目（Python 或 Go）时，激活此 skill。它会引导你搭建一个严格分层的三层架构：CLI 层 → Task 层 → Function 层。

## 架构设计哲学（不可违反）

整体固定三层分层：
```
CLI 层 → Task 层 → Function(funcs) 层
```

### 核心隐喻
- **CLI 层**：入口触发器，是 I/O 契约的守护者。它只负责接收人类输入、构建上下文、触发 Task、统一输出结果。
- **Task 层**：流程编排者。它像导演一样调度多个 Function，控制执行顺序、分支、循环，处理任务级异常。
- **Function 层**：原子能力提供者。每个 Function 是一个独立的点状功能，像乐高积木一样可被任意 Task 复用。

### I/O 契约：Source → Destination
- **对外接口枯燥固定**：CLI 对外只暴露 `source`（从哪来）和 `destination`（到哪去）。人类无需记忆繁杂参数，只需定义输入源和输出目标。
- **内部链路动态生长**：Source 到 Destination 之间的处理链路，由 Task 和 Function 根据业务需求自由组合编排。
- **上下文分层注入**：CLI 构建完整的 Context（包含 Source、Destination、Options）传给 Task；Task 按需拆包，**仅将 Function 需要的具体参数传给它**，严禁 Context 一路透传到底。

### 通用铁律
- 上层只调度，不实现；下层只做原子能力，不做流程编排
- 无环形依赖、无跨层调用、无全局变量、无硬编码路径
- 错误和日志统一向上收敛，只有 CLI 层允许输出到控制台

---

## 工作流 Steps

### Step 1：确认项目语言和初始化项目骨架

**任务目标**：根据用户选择的语言（Python 或 Go），创建标准的项目根目录和三层骨架目录 `cli/`、`tasks/`、`funcs/`。

**你需要做的**：
1. 询问用户项目使用的编程语言（Python 或 Go）
2. 在项目根目录下创建三个核心目录：`cli/`、`tasks/`、`funcs/`
3. 根据语言初始化对应的项目配置文件（如 Go 的 `go.mod`，Python 的 `requirements.txt` 或 `pyproject.toml`）

**验收条件**：
- [ ] 项目根目录下存在 `cli/`、`tasks/`、`funcs/` 三个目录，缺一不可
- [ ] 项目配置文件已正确初始化，可以被对应语言的包管理器识别
- [ ] 目录层级正确：这三个目录是平级的，都在项目根目录下
- [ ] 目录命名严格使用小写，不可使用 `cmd/`、`handler/`、`service/`、`utils/`、`core/` 等替代命名

---

### Step 2：搭建 CLI 层（入口层）

**任务目标**：在 `cli/` 目录下创建项目入口文件和子命令文件，实现参数解析、上下文构建、Task 路由和统一错误处理。

**你需要做的**：
1. 在 `cli/` 目录下创建主入口文件（`main.py` 或 `main.go`），负责：
   - 初始化日志系统（Logger）
   - 注册子命令
   - 捕获全局异常，统一处理 Exit Code
2. 在 `cli/` 目录下为每个业务子命令创建一个文件（如 `decode.py` 或 `decode.go`），每个子命令文件负责：
   - 定义命令行参数：输入源必须映射为 `--src` 或 `--input`，输出目标必须映射为 `--dst` 或 `--output`
   - 将参数组装成 Context 对象（包含 Source、Destination、Options、Logger）
   - 调用 `tasks/` 层对应的 Task 函数
   - 将 Task 返回的结果或错误格式化输出

**验收条件**：
- [ ] `cli/main.{py,go}` 存在，包含日志初始化和子命令注册逻辑
- [ ] 每个子命令对应一个独立文件在 `cli/` 目录下，文件命名与子命令名称一致
- [ ] CLI 层文件中**不包含任何业务逻辑实现**，只有参数解析、Context 构建和 Task 调用
- [ ] CLI 层**没有直接调用 `funcs/` 下的任何函数**
- [ ] 所有子命令都接受 `--src`/`--input` 和 `--dst`/`--output` 参数
- [ ] CLI 层构建了包含 Logger 的 Context 对象并传递给 Task
- [ ] CLI 层有统一的错误拦截逻辑，能捕获 Task 返回的错误并打印
- [ ] `cli/` 目录下不存在任何文件 IO 操作、网络请求或数据处理逻辑

---

### Step 3：搭建 Task 层（流程编排层）

**任务目标**：在 `tasks/` 目录下为每个完整业务动作创建一个 Task 文件，实现流程编排逻辑——按顺序、分支或循环调用多个 Function。

**你需要做的**：
1. 根据业务需求，在 `tasks/` 目录下为每个完整的业务动作创建一个文件（如 `decode.py` 或 `decode.go`）
2. 每个 Task 文件的逻辑应遵循以下流程：
   - 接收从 CLI 层传来的 Context（或直接接收拆包后的参数）
   - 按业务需要拆解 Context，提取出具体参数
   - 按顺序、条件分支或循环调用 `funcs/` 下的多个 Function
   - 处理中间态错误（如重试、回滚、降级）
   - 将最终结果或错误返回给 CLI 层
3. 确保 Task 内部**不写死**具体的文件路径、网络请求 URL 或复杂计算逻辑——这些必须下沉到 Function 层

**验收条件**：
- [ ] `tasks/` 目录下每个文件对应一个完整的业务动作
- [ ] Task 文件中**只包含对 Function 的调用和流程控制**（顺序、分支、循环），不包含任何原子功能的实现代码
- [ ] Task 在调用 Function 时，**传递的是具体参数而非整个 Context 对象**
- [ ] Task 文件内**没有硬编码的文件路径**
- [ ] Task 文件内**没有直接的文件 IO 操作**（必须调用 Function 来完成）
- [ ] Task 文件内**没有直接打印日志或输出到控制台**
- [ ] 一个 Task 可以调用多个 Function，形成组合复用关系

---

### Step 4：搭建 Function 层（原子功能层）

**任务目标**：在 `funcs/` 目录下创建提供单一原子能力的文件，每个文件实现一个独立的、可复用的功能点。

**你需要做的**：
1. 根据业务需要的原子能力，在 `funcs/` 目录下创建对应的文件
2. 根据项目规模选择组织模式：
   - **模式 A（推荐，中小项目）**：扁平结构，所有 Function 文件直接放在 `funcs/` 下
   - **模式 B（复杂项目）**：按领域分组，在 `funcs/` 下创建领域子目录（如 `io/`、`net/`），领域子目录下再放原子文件
3. 每个 Function 文件遵循以下原则：
   - 只做一件点状功能（如读取文件、解压 zip、解析 JSON）
   - 函数是无状态的，输入参数决定输出结果，不依赖全局环境
   - 所有路径由上层传入，**禁止硬编码**
   - 不包含任何业务流程逻辑（如"先读文件再解析再写入"这种串联逻辑属于 Task 层）

**验收条件**：
- [ ] `funcs/` 目录下的每个文件只做一件明确的原子功能
- [ ] Function 文件命名使用**纯动词或名词**（如 `decode`、`parse`、`zip`、`file`）
- [ ] Function 文件命名**禁止使用** `_task`、`task_`、`_ops`、`ops_`、`_helper`、`helper_`、`util` 等冗余后缀
- [ ] Function 函数签名中**所有路径参数都通过入参传入**，无硬编码路径
- [ ] Function 内部**不感知业务流程**，不知道自己被谁调用、调用前后还有什么步骤
- [ ] Function 内部**不直接打印日志或输出到控制台**
- [ ] Function 内部**不调用 Task 层或 CLI 层的任何代码**
- [ ] 如果使用模式 B（领域分组），领域子目录命名清晰明确，不存在 `utils/` 或 `helpers/` 等含义模糊的目录
- [ ] 无论哪种模式，叶子节点都是实现单一功能的文件

---

### Step 5：建立层间通信和依赖关系

**任务目标**：确保三层之间的调用关系正确，无跨层调用，无环形依赖，上下文传递符合分层注入原则。

**你需要做的**：
1. 检查并确认调用链严格遵循：CLI → Task → Function
   - CLI 层只能调用 Task 层，不能直接调用 Function 层
   - Task 层只能调用 Function 层，不能调用 CLI 层
   - Function 层不能调用 Task 层或 CLI 层
2. 确认 Context 传递方式：
   - CLI 层构建完整 Context（Source + Destination + Options + Logger）传给 Task
   - Task 层拆解 Context，仅将 Function 需要的具体参数传给 Function
   - Function 层接收的是具体参数，不接收 Context 对象
3. 确认 Logger 的传递方式：
   - Logger 只在 CLI 层创建和初始化
   - Logger 通过 Context 注入到 Task 层
   - Task 层和 Function 层通过入参接收 Logger，**不自行初始化日志系统**

**验收条件**：
- [ ] 不存在 CLI 直接调用 Function 的代码
- [ ] 不存在 Function 调用 Task 或 CLI 的代码
- [ ] 不存在 Task 调用 CLI 的代码
- [ ] 不存在跨层的 import/require 引用（如 Function 文件 import 了 Task 文件）
- [ ] 不存在环形依赖（A 调 B，B 调 A）
- [ ] Function 的函数签名中不包含 Context 类型参数
- [ ] Logger 只在 CLI 层初始化，其他层通过参数接收

---

### Step 6：确认异常处理和日志规范

**任务目标**：确保错误和日志的处理遵循"向上收敛"原则，只有 CLI 层负责输出到控制台。

**你需要做的**：
1. 检查 Function 层：
   - 确认所有错误通过返回值或异常向上传递
   - 确认没有任何 `print`、`fmt.Println`、`console.log` 等直接输出
   - 确认没有自行初始化日志系统
2. 检查 Task 层：
   - 确认所有错误通过返回值或异常向上传递
   - 确认没有任何直接输出到控制台的代码
   - 确认没有自行初始化日志系统
   - 如需记录中间态信息，使用从 CLI 传入的 Logger
3. 检查 CLI 层：
   - 确认有统一的错误拦截逻辑（如 try-catch 或 defer-recover）
   - 确认所有 Task/Function 返回的错误最终在 CLI 层被捕获并格式化输出
   - 确认 Exit Code 根据执行结果正确设置（成功为 0，失败为非 0）

**验收条件**：
- [ ] `funcs/` 目录下所有文件中不存在 `print`、`fmt.Println`、`console.log` 或类似的直接输出语句
- [ ] `tasks/` 目录下所有文件中不存在 `print`、`fmt.Println`、`console.log` 或类似的直接输出语句
- [ ] `funcs/` 和 `tasks/` 目录下所有文件中不存在日志系统的初始化代码（如 `logging.basicConfig`、`log.New`）
- [ ] `cli/` 目录下有全局错误捕获逻辑
- [ ] CLI 层根据执行成功或失败返回正确的 Exit Code

---

### Step 7：最终架构审查

**任务目标**：对整个项目进行全面的架构审查，确保所有铁律都被遵守。

**你需要做的**：
逐条对照以下铁律清单进行审查，任何一条不通过则要求修正：

**铁律清单**：
1. 项目严格使用 `cli/`、`tasks/`、`funcs/` 作为核心骨架目录，命名不可替换
2. 调用链严格遵循 CLI → Task → Function，无跨层调用
3. Context 分层传递：CLI 传完整 Context 给 Task，Task 传具体参数给 Function
4. 不存在全局变量
5. 不存在硬编码的文件路径或网络地址
6. 错误向上收敛：Funcs 和 Tasks 不直接输出，CLI 统一处理
7. Logger 统一：CLI 创建，下层通过参数获取，不自行初始化
8. Task 只编排流程，Function 只实现原子功能
9. 每个子命令遵循：CLI 子命令文件 → Task 文件 → 多个 Function 文件的映射关系
10. 文件命名规范：Function 文件使用纯动词或名词，禁止 `_task`、`_helper`、`_ops` 等后缀

**验收条件**：
- [ ] 以上 10 条铁律全部通过审查
- [ ] 项目可以被对应语言的编译器/解释器正确识别和运行
- [ ] 新增一个功能点时，开发者能明确知道应该在哪一层添加代码

---

## 两种运行模式（统一架构）

1. **命令行模式（CMD）**：CLI → Task → Function
2. **服务模式（API/Server）**：API 入口 → Task → Function

> Task 层和 Function 层在两种模式下完全复用，只替换上层入口。如果项目后续需要从 CLI 扩展到 API 服务模式，Task 和 Function 代码无需修改。

---

## 新增功能时的操作指引

当项目已有骨架，需要新增一个功能点时：

1. **先在 `funcs/` 层实现原子函数**：创建一个文件，实现单一的原子能力
2. **再在 `tasks/` 层编排调用**：创建或修改 Task 文件，组合调用多个 Function 完成业务流程
3. **最后在 `cli/` 层暴露命令**：创建子命令文件，解析参数、构建 Context、路由到 Task

> 这个顺序不可颠倒。永远从最底层（原子能力）开始向上构建。
