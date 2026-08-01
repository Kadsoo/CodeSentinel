# Task 8 有界 Agent Loop 与审批恢复设计

**日期：** 2026-07-29
**状态：** 已完成设计确认，等待书面规格审阅
**范围：** `packages/contracts`、`packages/tools` 与新的 `packages/core`。本任务实现可离线验证的 Agent Loop、受控只读浏览、待审批补丁和批准后的安全恢复。

## 目标

Task 8 将 CodeSentinel 已有的 Action、Policy、Tool 与 Provider 抽象组合为一个自研、可审计的 Coding Agent Loop：

- 测试修复必须先用受控验证命令复现失败，初测通过时零 Provider 调用、零写入并以 `not_reproducible` 停止；
- 每次 Provider 只可产生一个通过 `ActionSchema` 的结构化 Action；Core 在任何工具调用前执行 Policy；
- 模型只可提议补丁，不能写文件、批准补丁、执行任意命令或绕过三轮上限；
- 本地用户批准后，系统只应用与原待审记录精确绑定的一次补丁，随后重新验证并在仍失败时把脱敏反馈带入剩余轮次；
- 小功能实现强制经历测试补丁、RED、实现补丁、GREEN；
- 所有外部依赖均可注入，单测不访问真实 Provider、网络、凭据库或用户工作区。

## 范围与非目标

本任务新增私有的内存会话/待审记录、Core 上下文构建、工具分发、事件汇聚和受控只读浏览工具。它会扩展 Action 合同，以表达补丁所处阶段，并扩展事件合同以记录审批摘要。

本任务不实现 SQLite 持久化、HTTP/CLI 路由、Web UI、真实 Key、真实 Provider 调用、真实凭据库、自动 Git 操作或任意 shell。Task 9 会把 Core 的内存记录替换为持久化实现；Task 10 会把 Core 暴露为本地 API/CLI；Task 12 会显示事件与审批控件。

## 架构与可信边界

### Core 组合根

`AgentSessionController` 是本任务的会话协调器。它只接受以下注入依赖：

- 一个单次 `Provider`；
- 一个已绑定工作区和命令白名单的 `BoundPolicy`；
- 一个已绑定工作区、受控验证命令和路径过滤器的 `ToolDispatcher`；
- `EventSink`、时钟和 ID 工厂；
- 私有 `PendingPatchStore`。

Core 不接收任意 shell 字符串，不直接导入 Node 文件系统、子进程、网络或凭据库。工作区根目录、验证命令和可读路径在 composition root 创建 Dispatcher 时已绑定，不能由模型请求重写。

`runAgentSession` 启动或继续一个会话；`resolvePendingPatch` 是单独的本地审批入口。两者返回只读 Session Snapshot、事件摘要、最终结果或展示用的待审 diff。它们绝不把内部可写记录交给调用方。

### 私有待审批记录

`PendingPatchStore` 是 Core 唯一信任的待审补丁所有者。内存实现按 `sessionId + approvalId` 保存：

- 原始 `propose_patch` Action（path、patch、baseHash、stage、reason）；
- Core 生成的 action ID、approval ID、补丁 SHA-256、基线 SHA-256、创建时间和固定 15 分钟有效期；
- 记录是否已被解决/消费。

UI/API 只能提交 `sessionId`、`approvalId` 和 `approve | reject`。它们不能提交或替换 patch、path、baseHash、action ID 或完整 Approval 对象。批准前，Dispatcher 从受控工作区读取当前基线哈希，Core 使用既有 `approvePatch`/`rejectPatch` 状态机更新记录；过期、拒绝或基线变化均终止且零写入。批准记录在应用前被一次性消费；应用失败也不允许重放。补丁工具随后再次校验批准状态、补丁哈希、基线哈希与有效期，因此基线检查和写入之间的竞态仍会安全失败。

模型返回的 `apply_approved_patch` 继续由 Guardrail 无条件拒绝，绝不作为恢复入口。

### 会话与状态转移

会话拥有既有 `id`、`taskKind`、`workspaceId`、`providerId`、`state`、`round`，以及 Core 私有的任务阶段、最近验证摘要、已验证结果和待审批引用。`round` 仅计数 Provider 决策，初始验证和批准后的验证均不占用轮次。

```text
created --initial controlled verification--> running | stopped(not_reproducible) | failed
running --valid action + allow--> running | completed | failed | blocked
running --propose_patch + ask--> awaiting_approval
awaiting_approval --reject/expire/base change--> stopped
awaiting_approval --approve--> apply original patch --> controlled verification
    verification pass --> completed
    verification fail + rounds remain --> running
    verification fail + round limit --> failed
```

对 `test_repair`，初始验证以退出码 0 判定为不可复现；正常非零退出码成为第一条 Provider 反馈；超时、启动失败、输出限制或工具错误是不可恢复失败。达到三次 Provider 决策后不会发起第四次请求。第三轮产生的补丁仍可等待审批，但批准后的验证若失败则直接以轮次耗尽结束。

`finish` 是模型的请求，而不是成功证据：`completed` 或 `not_reproducible` 不能替代受控验证；未满足独立验证条件时 Core 以 `blocked`/`needs_human` 结束。模型请求 `apply_approved_patch`、非法 Action、Provider 异常、Policy deny、工具异常和 EventSink 异常均 fail closed，且不调用后续工具或 Provider。

### 小功能的 test-first 阶段

`propose_patch` 增加严格必填字段 `stage`：`repair | test | implementation`。现有所有 Action fixture 同步显式填写该字段；该字段只表达可审计的意图，不授予权限。

Core 额外维护不可由模型重置的内部阶段：

1. `feature_implementation` 启动时必须提供非空验收说明和受控验证命令，否则拒绝开始。
2. 第一份可写候选只能是 `stage: test`；批准后必须运行验证，并且验证必须以普通失败结束（RED）。通过、超时、启动失败或输出限制都不会解锁实现补丁。
3. 接下来只能提议 `stage: implementation`；批准后重新验证，只有通过（GREEN）才能进入 `completed`。
4. `test_repair` 的每一份补丁提议只接受 `stage: repair`。

即使模型谎报阶段，也仍须经过用户看到的 diff、Policy 和人工批准；Core 只使用阶段来限制流程顺序，不凭它授予文件写入能力。

## Provider、Policy 与工具执行

每轮严格遵循：构造最小上下文 → Provider 一次 `complete` → `ActionSchema` 解析 → `BoundPolicy.evaluate` → Dispatcher → 事件摘要 → 下一轮反馈。

Provider 上下文只含任务摘要、当前受控阶段、允许的动作协议、已批准的路径/命令标识和限长脱敏反馈。它不含 API key、凭据状态细节、任意环境变量、原始底层异常或未验证的任意文件内容。Provider 返回的 `unknown` 必须先经过 `ActionSchema`；解析失败只产生稳定的非秘密终止摘要。

`ToolDispatcher` 对允许 Action 逐个提供窄方法：`listFiles`、`readFile`、`searchText`、`runVerification`、`getCurrentBaseHash` 和 `applyApprovedPatch`。`propose_patch` 不调用文件写入工具；`finish` 不调用工具。每个未配置方法返回稳定的 `UNSUPPORTED_TOOL`，而不是隐式退回到 Node API。

### 受控只读浏览

为使 Agent 能实际诊断项目，Task 8 补齐 Tools 包的列表与搜索能力：

- `list_files` 仅遍历 Dispatcher 绑定的工作区内真实目录，拒绝符号链接、保留设备名、越界路径，以及深度大于 8 或条目数大于 500 的请求；
- `search_text` 仅在受控路径内的已验证文本文件中工作，逐文件限制读取字节数，最多扫描 100 个文件、总计 1 MiB，并把 `maxResults` 限制为 100；
- 本任务不支持省略 `path` 的工作区根枚举或根搜索：既有 BoundPolicy 会在分发前拒绝这类 Action；
- 对每一个递归候选路径，Dispatcher 都用同一受信路径规则确认其可读，故一个允许目录不能泄露其下的 `.env`、凭据、`.git`、依赖目录或其他敏感文件；
- 到达边界时返回明确的截断摘要而非继续扫描或读取二进制内容。

Core 本身不认识真实路径，也不自行展开目录。Policy 在分发前保护原始 Action；Dispatcher 在递归中再次过滤候选，形成纵深防御。

## 事件、错误与可观测性

`HarnessEvent` 增加 `approval` kind。每个事件只保留 session ID、轮次、类别、稳定的脱敏摘要和时钟生成的 ISO 时间。典型顺序为：`action → policy → state(awaiting_approval) → approval → tool_result → verification → state`。初始验证和所有状态迁移也会产生摘要事件。

在任何有副作用的 Dispatcher 调用前，Core 必须先成功记录相应的 Action/Policy/Approval 事件；若写入失败，不启动该副作用。若副作用后无法记录结果，则会话安全失败且不继续 Provider 循环。Core 以稳定分类码表达失败，禁止把 Provider 响应、工具错误对象、文件内容、命令输出或 secret 原样放入事件或错误消息。

`InMemoryEventSink` 仅用于 Core 单测，保存不可变事件快照。Task 9 的 SQLite repository 会替代它，同时保持 `EventSink` 端口而不让 Core 依赖数据库。

## 测试策略

所有新增或变更行为先以失败测试记录 RED，再写最小实现。测试全部使用 `ScriptedMockProvider`、受控 Dispatcher fake、确定性时钟/ID 和临时工作区；不访问网络、真实 Provider、Credential Manager 或真实用户项目。

必测场景包括：

1. 初测通过零 Provider/零写入并以不可复现结束；初测失败摘要进入**第一个** Provider 请求。
2. 最多恰好三次 Provider 调用；第三轮失败不触发第四次调用。
3. 非法 Provider 输出、Provider 错误、Policy deny、工具错误、EventSink 错误均零越权调用且不泄露哨兵 secret。
4. 补丁提议只产生待审批记录和展示 diff；未批准、拒绝、过期、基线变化、伪造 session/approval/action ID、伪造 patch/hash 与重放均零写入。
5. 合法批准只应用原始补丁一次；应用后验证通过完成，验证失败进入剩余轮次反馈。
6. `feature_implementation` 覆盖缺少验收/命令拒绝、`test → RED → implementation → GREEN`，以及错误阶段、意外 GREEN、超时和轮次耗尽。
7. 列表/读取/搜索覆盖越界、符号链接、敏感子路径、二进制、大文件、深度/结果上限和截断。
8. 事件顺序、不可变快照和摘要脱敏保持稳定；完整 test、typecheck、lint 与 diff 检查作为收尾验证。

## 文件边界与兼容性

计划将创建 `packages/core` 的 package manifest、controller/loop、context、dispatcher、in-memory event sink、pending store、测试与公共 exports；扩展 `packages/contracts/src/action.ts`（包括 `stage`、`depth <= 8`、`maxResults <= 100`）和 `events.ts` 及对应测试；在 `packages/tools` 添加受控列表/搜索/基线哈希能力与测试；同步 Policy 测试 fixture 以适配严格的新补丁阶段字段。

已有 Provider 接口保持单次 `unknown` 返回，Guardrail 对 `apply_approved_patch` 的 deny 行为保持不变，补丁工具继续执行最终原子校验。没有接口允许 Task 8 读取或配置真实凭据、把自由命令传给验证器，或把用户审批变成模型可调用的工具。

## 设计自检

- 无 TBD、TODO 或未选定的默认安全行为；所有恢复输入、过期与重放语义均显式定义。
- Core、Policy、Tools、Provider、EventSink 和未来 Persistence 的职责单向且可替换；Core 不绕过既有 Guardrail 或 patch 工具。
- 三轮限制、初始复现、test-first、审批绑定、递归浏览过滤和事件失败处理均具有可独立验证的测试点。
- 设计没有引入真实网络、真实 Key、任意 shell、自动写入或 Git 发布；任何代码写入都仍依赖本地用户对展示 diff 的明确批准。
