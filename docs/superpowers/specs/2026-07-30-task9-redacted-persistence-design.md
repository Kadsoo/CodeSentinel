# Task 9 结构化事件与脱敏 SQLite 持久化设计

**日期：** 2026-07-30
**状态：** 已批准
**范围：** 扩展 `packages/contracts` 的事件合同、补齐 `packages/core` 的安全事件元数据，并新增 `packages/persistence`。本任务提供可按会话清除的本地审计时间线，不持久化补丁正文或其他原始敏感载荷。

## 目标

Task 9 为 CodeSentinel 增加本地、可审计、可清除的 SQLite 会话历史：

- 持久化会话快照、结构化动作记录、Policy 结论、审批元数据、验证运行和会话摘要；
- 保留每个会话的事件插入顺序、轮次、发生时间和稳定摘要；
- 在每一个入库入口再次执行限长与脱敏，确保 API Key、Bearer Token 和已知密钥模式不进入 SQLite；
- 让 SQLite repository 实现既有 `EventSink`，保持 Core 依赖端口而不依赖数据库；
- 让一次事件追加及其派生结构化记录处于同一事务，写入失败时整体回滚并由 Core fail closed；
- 让用户按会话清除全部关联记录，并启用 SQLite 安全删除；
- 明确程序重启后的安全语义：未完成会话不能恢复执行，待审批补丁失效且不能写入。

## 已选方案与排除方案

本任务采用“结构化、脱敏的审计持久化”方案。现有根依赖已经固定并锁定 `better-sqlite3@13.0.1` 与 `@types/better-sqlite3@7.6.13`，当前 Windows、Node.js 22.17.0 和 ESM 环境已验证可加载、建表和读写，因此不增加或替换数据库依赖。

未采用以下方案：

- 只保存当前通用 `HarnessEvent`：现有事件只有 `kind` 与 `summary`，不能可靠重建验证命令、退出码、耗时、状态或审批绑定字段，不满足项目数据模型与可观测性要求。
- 保存原始待审批补丁以支持跨重启恢复：补丁可能包含源代码、凭据或其他秘密；安全实现还需要加密、平台密钥、原子 claim、防重放和 Core 存储端口重构，超出 Task 9 的已批准范围。
- 切换到 `node:sqlite`：固定的 Node.js 22.17.0 中该模块仍发出实验功能警告，且项目已经锁定并验证 `better-sqlite3`。

## 范围与非目标

### 本任务包含

- 新的 `packages/persistence` workspace、SQLite schema、repository、脱敏器、错误类型和测试；
- 将 `HarnessEvent` 改为带安全结构化 `details` 的判别联合；
- 让 Core 在产生事件时附带数据库需要的非秘密事实；
- 让 `InMemoryEventSink` 与会话结果继续返回不可变深拷贝；
- repository 的创建、读取、更新、事件追加、会话摘要、清除、显式中断恢复和关闭接口；
- 文件型临时数据库的原始字节哨兵检查，以及 Core 到 SQLite 的集成测试。

### 本任务不包含

- 原始 patch、diff、源文件、Provider 请求/响应、完整验证输出或底层异常的持久化；
- 跨重启继续 Agent Loop、恢复内存上下文或批准旧补丁；
- 数据库加密、远程数据库、云同步、多用户服务或数据库导入；
- HTTP、CLI、WebUI、Credential Manager 或真实 Provider 接线；
- 任意 shell、网络访问、Git 发布或用户项目文件写入；
- 自动选择数据库路径。文件路径只由未来的可信 composition root 提供，不能来自 Provider 或远程请求。

## 架构与端口

### 结构化事件合同

`HarnessEvent` 保留现有公共字段：

- `sessionId`
- `round`
- `kind`
- `summary`
- `occurredAt`

它同时按 `kind` 增加必填、只含非秘密事实的 `details`：

| kind | details |
|---|---|
| `action` | `actionId`、`actionKind` |
| `policy` | `decision` |
| `tool_result` | `toolKind`，其值只允许 `list_files`、`read_file`、`search_text` 或 `apply_approved_patch` |
| `verification` | `commandId`、`exitCode`、`durationMs`、`status`、`timedOut` |
| `state` | `state` |
| `approval` | `approvalId`、`actionId`、`patchHash`、`baseHash`、`status`、`createdAt`、`expiresAt` |

`details` 不允许放入 patch、path、reason、文件内容、验证输出、Provider 文本、凭据值或任意扩展键。摘要仍是面向人类的稳定、脱敏文本；结构化字段用于约束、查询和重建时间线，不能从摘要字符串反向解析。

Contracts 定义事件所需的窄字符串联合，不反向依赖 Policy、Tools 或 Core。现有 Policy/Tools 类型保持结构兼容；Core 负责从真实结果构造事件。

### Core 事件生成

Core 继续是事件事实的唯一来源：

- `action` 使用 Core 在解析成功后生成的动作 ID 和已通过 `ActionSchema` 的动作类型；
- `policy` 使用实际 `BoundPolicy` 决策，而不是从 reason 猜测；
- `verification` 使用 Dispatcher 返回且经过校验的 `VerificationResult`；
- `state` 使用会话的真实有限状态；
- `approval` 使用 Core 私有 `PendingPatchStore` 中的 Approval 元数据；
- `tool_result` 只记录受控工具的稳定类型。

Core 在成功解析每个 Provider Action 后、追加 `action` 事件前生成一次 `actionId`；同轮后续 Policy、工具结果和 Approval 都绑定该记录。为生成待审元数据，`PendingPatchStore.create` 必须复用这个 `actionId`，并向 Core 返回一个私有注册结果，其中同时包含展示用 `PendingPatchView` 和不可变 Approval 副本。公开的 `AgentSessionResult.pendingPatch` 仍只返回原有展示视图，调用方不能替换 path、patch、hash 或 Approval。

事件追加顺序和 Task 8 的副作用边界保持不变：任何有副作用的工具调用前，相关事件必须先成功写入；repository 抛错时 Core 进入既有的稳定失败状态且不继续副作用。

### Persistence repository

`createSessionRepository(databasePath)` 返回同时实现 `SessionRepository` 与 `EventSink` 的对象。`databasePath` 是可信 composition root 输入；测试使用 `:memory:` 或受控临时文件。Repository 公开以下能力：

- `createSession`：接收可信 composition root 生成的规范 ISO 8601 UTC `createdAt`，只接受 `state: created` 与 `round: 0`，创建不含原始任务文本的会话快照，并把 `updated_at` 初始化为同一时间；
- `loadSession`：读取不可变、经过类型重建的会话快照；
- `append`：实现 `EventSink`，以一个事务追加时间线和派生记录；
- `appendAction`：供明确的非 Core 调用方使用的窄入口，只接受 `actionId`、session、round、occurredAt、actionKind 和 inputSummary，合成恰好一个 `action` 事件；Policy 与结果必须另行追加，不能塞入 action 输入；
- `saveApproval`、`appendVerification`：对应合成恰好一个 `approval` 或 `verification` 事件，并进入与 `append` 相同的内部验证、脱敏和事务路径；
- `saveSessionMemory`、`loadSessionMemory`：保存或读取一条限长脱敏摘要；
- `loadTimeline`：按数据库插入顺序返回一个会话的不可变结构化事件；
- `recoverInterruptedSessions`：由未来本地服务启动流程显式调用，使旧的非终态会话停止并使 pending Approval 过期；
- `clearSession`：事务删除一个会话的全部关联数据；
- `close`：幂等关闭连接；关闭后调用返回稳定错误。

Repository 不公开原始数据库连接、Statement、可写行对象或执行任意 SQL 的入口。

同一个事实只能选择 `append` 或一个类型化入口，不能双写。Task 10 的实时 Core 路径只使用 `EventSink.append`；类型化入口用于明确的导入、测试或没有 Core 事件来源的调用。

可信 composition root 必须先成功调用 `createSession`，再把同一个 session ID 和 repository 的 `EventSink` 交给 `AgentSessionController`。建会话失败时不得启动 Controller、Provider、Policy 或工具。漏建会话后的第一次 `append` 返回 `SESSION_NOT_FOUND`，Core 按既有 EventSink 失败路径停止。Task 9 的 Core 集成测试必须同时覆盖正确组合顺序和漏建时的 fail-closed 行为。

## SQLite schema

数据库初始 schema 使用 `PRAGMA user_version = 1`。打开后首先只读检查版本和用户表；仅当 `user_version = 0` 且数据库没有用户表时，repository 才在一个 `BEGIN IMMEDIATE` 事务中创建完整表、索引和约束，并在最后设置版本；空库初始化失败时不得留下部分 schema。`user_version = 1` 只有在必需表和索引完整时才正常打开；其他版本、version 0 的非空数据库以及残缺的 version 1 schema 均在任何业务映射前稳定拒绝，不猜测、不降级、不自动覆盖。

打开连接时启用：

- `journal_mode = DELETE`
- `foreign_keys = ON`
- `secure_delete = ON`
- `busy_timeout = 5000`

Repository 必须读取并验证每个 PRAGMA 的实际返回值。若既有数据库无法从 WAL 切换为 DELETE、仍被另一个进程锁定，或任一安全 PRAGMA 未生效，则关闭连接并返回稳定失败；不能在未知 journal mode 下继续。首版是单本地服务进程模型。未来若切换 WAL，必须另行处理文件权限、清除与备份语义。

唯一例外是精确的测试路径 `:memory:`：SQLite 对纯内存连接返回 `journal_mode = memory`，此时 repository 必须验证返回值确为 `memory`，并继续验证其余安全 PRAGMA；它没有数据库文件或 sidecar。所有文件型路径仍必须实际得到 `delete`。测试覆盖 `:memory:` 成功初始化、普通文件库采用 DELETE，以及预先设为 WAL 的文件库能够安全切换或稳定拒绝。

### `sessions`

保存：

- `id` 主键；
- `task_kind`、`state`、`round`；
- `workspace_id`、`provider_id`、`verification_command_id`；
- `created_at`、`updated_at`。

约束：

- `task_kind` 与 `state` 使用已知有限集合；
- `round` 是 `0..3` 的整数；
- 所有 ID/命令标识必须匹配 ASCII 语法 `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`；匹配已知 API Key 前缀或敏感赋值模式的标识被拒绝，不以修改后的值充当主键；
- 不保存 workspace 路径、task summary、acceptance criteria 或凭据引用值。

### `timeline_events`

每次成功追加产生一行：

- 自增 `event_id`；
- `session_id` 外键；
- `round`、`kind`、脱敏 `summary`、`occurred_at`；
- 仅容纳对应事件类型的结构化非秘密列。

`event_id` 是数据库事实上的插入序列；`loadTimeline` 只按它升序返回，不接受调用方排序或重排。每个事件的类型专属列由 `CHECK` 约束保证必填或为空，禁止把任意 JSON 作为逃生口写入。

### `action_records`

每个 Provider `action` 事件产生一行，以对应 `event_id` 关联时间线，保存：

- 事件提供的 `action_id` 主键；
- `session_id`、`round`、`action_kind`；
- 脱敏 `input_summary`；
- 后续 `policy` 事件写入的 `policy_decision`；
- 后续工具或验证事件写入的脱敏 `result_summary`。

`policy_decision` 与 `result_summary` 均允许为 null：Action 事件可能在 Policy 前持久化，Policy deny 后不会有工具结果，`finish` 也可能只有 Policy 和 State。返回类型必须保留这种可空语义。

同一会话同一轮最多一个 Provider 动作，`action_id` 全局唯一。Policy 事件必须填充同会话、同轮、位于它之前且尚未拥有 Policy 的动作记录；第二个 Policy 是非法顺序。`tool_result` 把 `result_summary` 更新为最新受控工具摘要，后续 Verification 可以覆盖为更晚的客观验证摘要；时间线仍保留每一个中间结果，State 事件不改 Action result。初始复现验证没有 Action，只创建 `verification_runs`。缺少前置 Action 的 Policy/`tool_result`、或其他非法顺序使整个事件事务回滚。Approval 的 `action_id` 必须外键引用该会话同一轮的 `propose_patch` 动作。

### `approvals`

保存：

- `id` 主键、`session_id`、`action_id`；
- `patch_hash`、`base_hash`；
- `status`、`created_at`、`expires_at`。

它不保存 patch、path、reason 或 diff。状态只允许 `pending → approved | rejected | expired`；终态不能回到 pending。Repository 验证 64 位十六进制 SHA-256、时间范围和 `createdAt < expiresAt`，但真正的批准权限与补丁应用仍只属于 Core。

### `verification_runs`

每个 `verification` 事件产生一行，以 `event_id` 关联时间线，保存：

- repository 生成的运行 ID；
- `session_id`、`round`、`command_id`；
- `exit_code`、`duration_ms`、`status`、`timed_out`；
- 脱敏 `summary`。

`duration_ms` 是非负安全整数；`exit_code` 在 `completed` 状态下允许为整数或进程被信号终止时的 `null`，在其他状态下必须为 `null`；`timed_out` 只有在 `timed_out` 状态下为 true；状态必须属于 Tools 的已知集合。Repository 不保存 stdout、stderr、命令可执行文件、参数数组或环境变量。

### `session_memory`

每个会话至多一行：

- `session_id` 主键；
- 脱敏 `summary`；
- `updated_at`。

保存使用 upsert，但必须属于已存在会话。它不自动进入 Provider 上下文；未来调用方必须显式加载并仍受 Core 上下文预算限制。

所有子表都显式声明级联删除：`timeline_events.session_id`、`action_records.session_id`、`approvals.session_id`、`verification_runs.session_id` 和 `session_memory.session_id` 使用 `ON DELETE CASCADE`；`action_records.event_id` 与 `verification_runs.event_id` 引用时间线并使用 `ON DELETE CASCADE`；`approvals.action_id` 引用 `action_records.action_id` 并使用 `ON DELETE CASCADE`。业务层不提供单独删除事件或 Action 的接口。DDL 与测试必须逐项检查这些外键动作。

## 数据流与事务

一次 `append(event)` 执行以下步骤：

1. 对整个事件做结构、枚举、数值、ID、时间和类型专属字段验证；
2. 对 `summary` 做完整输入扫描、控制/格式字符归一、已知密钥脱敏和输出限长；
3. 开启 SQLite 事务并确认 session 存在；
4. 插入 `timeline_events`；
5. 按事件 kind 插入或更新对应的 `action_records`、`approvals`、`verification_runs` 或 `sessions`；
6. 将 `sessions.updated_at` 更新为事件时间；`action` 事件还把 session round 推进恰好一轮；
7. 提交后返回；任何一步失败均回滚。

验证必须发生在事务和 SQL 绑定前；所有 SQL 使用预编译参数，不拼接输入。同步 SQLite 异常不会把 SQL、数据库路径或原始输入传播给 Core，而被归类为稳定的 Persistence error code。

会话从 round 0 创建。只有 `action` 事件可以把持久化 round 从 `n` 推进到 `n + 1`，且上限是 3；其他事件的 round 必须等于当前值。每次成功 append 都更新 `updated_at`，State 事件额外更新 `sessions.state`。`occurredAt` 必须是可解析并可无损规范化的 ISO 8601 UTC 时间，且不得早于当前 `updated_at`；相同时间允许用于确定性测试。旧事件、跳轮、越界轮次、未知枚举、找不到 session、重复 Approval、非法 Approval 状态转移和非法 Action/Policy 顺序均 fail closed。

## 脱敏与数据边界

`redactText` 是 `packages/persistence` 的纯函数，并在所有可持久化人类文本入口调用。统一替换文本是 `[REDACTED]`。它至少覆盖：

- `Authorization: Bearer ...` 和独立 Bearer token；
- `api_key`、`token`、`secret`、`password`、`credential` 等命名赋值；
- JSON 中的敏感键值；
- `sk-`、`sk_`、`pk_`、`rk_`、`ghp_` 后接至少 12 个 ASCII 字母、数字、下划线或连字符的前缀 token；
- 至少 32 个 `[A-Za-z0-9+/_=-]` 字符组成的通用长 key-like token；
- 被零宽、双向或其他 Unicode 格式字符拆分的敏感名称。

每个待扫描文本输入最多 65,536 个字符，每个持久化摘要最多 4,096 个字符。处理顺序是：验证输入类型与最大扫描长度 → 删除控制/格式字符 → 扫描并替换秘密 → 最后限制持久化摘要长度。不得先截断再扫描，以免在边界留下密钥前缀。超出最大扫描长度的输入被稳定拒绝，而不是部分持久化。

结构化标识、枚举、时间、退出码和 hash 走严格验证，不用脱敏改变其语义；标识一旦匹配已知密钥模式就整体拒绝。任何可能包含用户文本的字段都必须走 `redactText`。错误对象、日志和测试失败消息不得包含原始待写文本。

防御是双层的：Core 仍只生成稳定摘要；Persistence 不能信任上游已脱敏，必须再次处理所有公开入口。

## 清除与重启语义

`clearSession(sessionId)` 在一个事务中删除 `sessions` 行，依靠外键级联删除 timeline、actions、approvals、verification runs 和 memory。删除不存在的会话是幂等成功。测试同时检查所有业务表均无该 session 的行；其他会话不受影响。

数据库启用 `secure_delete = ON`，使 SQLite 在删除单元时覆盖已删除内容。该承诺是本地 SQLite 文件内的安全删除，不声称能够清除操作系统备份、磁盘快照或用户自行复制的数据库。

Task 9 不保存恢复补丁所需的原始 action。未来本地服务每次真正启动 Agent 服务时必须显式调用 `recoverInterruptedSessions(now)`；`now` 是 Date 可表示范围内的安全整数毫秒时间戳，并转换为规范 ISO 8601 UTC 事件时间：

- `created`、`running`、`awaiting_approval` 会话变为 `stopped`；
- 它们的 pending Approval 变为 `expired`；
- 只处理属于这些会话且当前状态确为 pending 的 Approval；
- 所有会话在一个事务中按 session ID 升序处理；每个会话先按 Approval ID 升序追加 `APPROVAL_EXPIRED_ON_RESTART`，再追加 `SESSION_INTERRUPTED`；
- 恢复事件沿用各会话已持久化的 round 和同一个 `now`，第二次调用不再产生事件；
- 不调用 Provider、Policy 或工具，不写用户工作区。

普通只读数据库打开、凭据命令或测试查询不会自动中断另一个进程的活动会话。跨进程并发运行同一 Agent 数据库不在首版支持范围；Task 10 必须保证单服务实例。

若 `recoverInterruptedSessions(now)` 早于任一待恢复会话的 `updated_at`，整个恢复事务以 `INVALID_PERSISTENCE_INPUT` 回滚，避免写出倒退时间线。

## 错误处理

Persistence 暴露一个不含底层 message 的稳定错误类型，至少区分：

- `INVALID_PERSISTENCE_INPUT`
- `SESSION_NOT_FOUND`
- `INVALID_EVENT_SEQUENCE`
- `DUPLICATE_RECORD`
- `UNSUPPORTED_SCHEMA_VERSION`
- `REPOSITORY_CLOSED`
- `PERSISTENCE_FAILED`

公开的 Persistence error 实例只含固定 `name`、固定 `message` 和只读 `code`；不设置 `.cause`，不附带 SQL、数据库路径、输入或原生错误对象，也不记录原生异常。Task 9 不实现原生错误 telemetry。测试注入带唯一 secret 的数据库异常，并断言 `message`、`stack`、自有属性和 JSON 序列化都不泄露。打开未知 schema 的数据库必须在业务读写前拒绝；首版不尝试猜测或降级 schema。

## TDD 与验证策略

实现按独立 RED → GREEN 批次进行，每个行为先写测试并确认在生产改动前失败：

1. **脱敏器：** Bearer、命名密钥、JSON、长 token、Unicode 拆分、幂等、正常文本和边界长度。
2. **Schema 与会话：** `:memory:` 初始化、schema version、约束、创建/读取、重复 ID、关闭语义。
3. **结构化事件：** action/policy/result、verification、approval、state 的映射和不可变时间线顺序。
4. **事务与失败：** 找不到 session、非法顺序、非法状态转移、失败回滚、稳定错误且无秘密。
5. **清除：** 级联删除五类业务记录、幂等、其他会话隔离和 `secure_delete`。
6. **重启恢复：** 非终态停止、pending Approval 过期、终态不变、零工具调用。
7. **真实文件哨兵：** 向每个文本入口提供唯一 secret；完成写入、`clearSession` 和 `close` 后，以 `Buffer` 扫描实际存在的数据库、`-journal`、`-wal` 和 `-shm` 文件，任何位置不得出现明文哨兵；另写入一个唯一的非秘密删除标记，并断言 clear + close 后它同样不出现在这些 Buffer 中，以机械验证 `secure_delete` 路径。
8. **Core 集成：** 以真实 repository 作为 `EventSink` 跑确定性 Mock 会话，验证数据库拥有动作、Policy、验证、审批与状态事实，且不持久化 patch/source/Provider 文本。
9. **兼容性：** 既有 InMemoryEventSink、Agent Loop、Policy、Tools 和 Provider 测试继续通过。

收尾必须实际运行：

- Task 9 定向测试；
- `npm test`；
- `npm run typecheck`；
- `npm run lint`；
- `git diff --check`。

独立审查必须检查最终 diff、事件类型兼容性、事务边界、数据库约束、错误泄露、秘密哨兵、清除隔离和测试覆盖，而不只复述实现。

## 文件边界

预计修改或创建：

- `packages/contracts/src/events.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/events.test.ts`
- `packages/core/src/agent-loop.ts`
- `packages/core/src/in-memory-event-sink.ts`
- `packages/core/src/pending-patch-store.ts`
- 对应 Core 测试
- `packages/persistence/package.json`
- `packages/persistence/src/redaction.ts`
- `packages/persistence/src/redaction.test.ts`
- `packages/persistence/src/errors.ts`
- `packages/persistence/src/session-repository.ts`
- `packages/persistence/src/session-repository.test.ts`
- `packages/persistence/src/core-integration.test.ts`
- `packages/persistence/src/index.ts`

实现计划可以把大测试文件按 schema、events、recovery 拆分，但不得把数据库访问扩散到 Core 或 API。除为结构化事件所需的最小 Core 变化外，不进行无关重构。

`packages/persistence/package.json` 使用私有 ESM workspace 名 `@kadsoo/codesentinel-persistence`，导出 `./src/index.ts`，并精确声明 `better-sqlite3@13.0.1`。根 `package-lock.json` 已有同版本解析；实现不升级依赖。

现有根 `PLAN.md` 的 Task 9 只列出早期 persistence 文件，且示例 `appendAction` 同时携带 Policy/结果，已被本规格的结构化事件方案取代。用户书面审阅本规格后，`writing-plans` 阶段必须生成新的 Task 9 实施计划，覆盖 Contracts/Core/Persistence、固定 RED → GREEN 批次和新的提交范围；在该计划审阅通过前不得编码。

## 验收标准

Task 9 完成必须同时满足：

1. SQLite 持久化会话、动作、审批元数据、验证运行、会话摘要和严格有序时间线。
2. 结构化事件包含数据模型需要的非秘密事实，且没有通用 JSON 或原始载荷逃生口。
3. 任意公开文本入口的哨兵 API Key 在数据库文件、sidecar、timeline 返回值和错误中均不可见。
4. Repository 实现 `EventSink`；一个事件及其派生记录原子提交，失败时整体回滚。
5. `clearSession` 删除指定会话的全部关联记录、保持其他会话不变并启用安全删除。
6. 重启恢复只停止不可恢复的非终态会话并使 pending Approval 过期，绝不应用或恢复原始补丁。
7. Core 仍保持事件先于副作用、Policy 先于工具、补丁只经本地审批写入和三轮上限。
8. 所有新增行为保留真实 RED 证据；定向测试、完整测试、typecheck、lint 和 diff 检查通过。

## 设计自检

- 本规格没有未完成章节、可选安全默认值或未选定数据库依赖。
- “持久化审计历史”与“跨重启恢复补丁”已经明确分离；Approval 元数据可持久化，但 patch 正文永不进入 SQLite。
- EventSink、Repository、Core 和未来 API 的职责单向；Persistence 不获得 Provider、Policy、文件系统工具或补丁写入权限。
- schema、事件合同、事务、脱敏、清除、恢复和错误均有可独立验证的验收点。
- 扩展 Contracts/Core 是满足既有验证与审批数据模型所需的最小兼容变化，不扩大工具或凭据权限。
