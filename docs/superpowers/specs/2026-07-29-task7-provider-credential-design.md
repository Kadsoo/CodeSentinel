# Task 7 Provider 与 Windows 凭据抽象设计

**日期：** 2026-07-29
**状态：** 已完成设计确认，等待书面规格审阅
**范围：** `packages/providers`；不接入真实 Key、真实 Provider、CLI、API、SQLite 或 Agent Loop。

## 目标

为 CodeSentinel 建立可离线验证的 Provider 与 Windows 凭据抽象：

- Scripted Mock 能稳定驱动后续 Agent Loop 测试；
- DeepSeek 官方平台和 NJU SE Hub 可共用一个 OpenAI-compatible 传输适配器；
- Key 只经 Windows Credential Manager 读写，绝不落入源码、配置、日志、SQLite、测试输出或 Git；
- 真实连通性检查只能由用户显式触发，默认测试、CI 和演示均不访问网络或真实凭据。

## 范围和非目标

本任务创建 `@kadsoo/codesentinel-providers` 工作区及其 Provider、Mock、兼容传输和凭据存储模块。

本任务不实现以下内容：

- Agent Loop、Action 执行、Policy 决策、工作区读写或补丁审批；
- ProviderProfile 的持久化、CLI 隐藏输入、Web/API 路由或用户设置页；
- 真实 Key 的配置、读取、网络调用或任何真实 Provider 冒烟测试；
- NJU SE Hub 的 endpoint、模型名或 HTTP 例外的公开硬编码；
- `.env`、JSON、SQLite 或文件形式的凭据回退。

Task 10 的 CLI composition root 负责动态加载 `keytar`、请求隐藏输入、装配 Provider，并把本任务的显式 probe 能力暴露成用户手动命令。

## 架构

### Provider 边界

`Provider` 是单次、无状态的传输接口：

- 输入为只读消息列表；消息至少有稳定的 `role` 和 `content` 字段；
- `complete(request)` 每次只返回一个 `unknown`；
- Provider 不解析 `ActionSchema`、不调用工具、不维护轮次，也不拥有 Policy；
- Task 8 的 Agent Loop 将对返回的 `unknown` 执行 Action schema 验证和后续治理。

`ScriptedMockProvider` 接收有限的预设响应，按调用顺序返回。它保存请求的深拷贝、深冻结快照，使调用方不能改写反馈循环证据；脚本耗尽时抛出稳定的、无秘密错误。Mock 永不调用 `fetch`。

`OpenAICompatibleProvider` 接收构造时提供的 endpoint、model、API key、`fetch` 实现和受限 transport 选项。它只向兼容的聊天补全 endpoint 发起一次 POST，提取 `choices[0].message.content`，并将该内容解析为 JSON 后作为 `unknown` 交给上层。缺失 choice、非字符串内容或非法 JSON 均是安全的无效响应，而不是 Action 验证或执行。

DeepSeek 与 NJU SE Hub 使用同一适配器。公共仓库不包含 NJU endpoint、内部 URL、模型名或 Key。

### 凭据边界

`CredentialStore` 定义 `set`、`get`、`status` 和 `clear`：

- `get` 仅供后端 composition root 在装配 Provider 时使用；UI/API 不暴露它；
- `status` 只表达 `configured` 或 `missing`，从不返回、截断或散列 secret；
- `clear` 仅删除指定引用的记录；后续 CLI/API 再按规格删除 ProviderProfile 引用；
- 凭据引用是短、非空、无控制字符、无路径分隔符的标识；例如 `deepseek-default`。

`InMemoryCredentialStore` 仅用于测试。`WindowsCredentialStore` 接收一个窄的 `KeytarLike` 依赖，只允许 `getPassword`、`setPassword` 和 `deletePassword`。它使用固定的 CodeSentinel service 名称和受验证的 account/ref，不使用 `findPassword` 或 `findCredentials`，因此不会枚举其他账户或密码。

Provider 包不静态导入 `keytar`。当前平台可能没有可加载的 keytar 原生二进制；静态导入会让无关的 Mock 单测在模块加载阶段失败。未来 CLI 只在显式 Windows 运行时动态加载 keytar 并注入该端口。加载失败时返回安全的不可用错误，不会降级为明文存储。

### 网络与显式 probe

兼容 Provider 强制下列 transport 约束：

- endpoint 必须为 HTTPS，且不得包含用户名、密码、query 或 fragment；
- 固定 POST，`redirect: "error"`，不自动重试；
- 使用 AbortController 设定单次超时；
- 对响应体实施有限字节读取，拒绝过大正文；
- 不记录 Authorization header、请求体、响应正文、底层错误消息或错误 cause。

本任务提供可由 composition root 显式调用的 probe 能力；它仅调用已装配 Provider 的一次受限补全，不执行 Action。未来 CLI 将其包装为手动命令。它不会被单测、CI、启动流程或公开演示调用，也不会要求、读取或记录用户的真实 Key。

NJU SE Hub 如只提供 HTTP，不会静默发送 Key；必须在后续任务中由用户显式批准一个受限、可审计的安全例外后才可设计支持。

## 错误语义

Provider 和凭据适配器只暴露稳定、可分类、无秘密的错误码：

| 场景 | 错误码 |
|---|---|
| 凭据库/原生绑定不可用或调用失败 | `CREDENTIAL_UNAVAILABLE` |
| 非法凭据引用或 secret 输入 | `CREDENTIAL_INVALID_INPUT` |
| 非 HTTPS 或不安全 endpoint | `PROVIDER_INVALID_ENDPOINT` |
| 请求超时 | `PROVIDER_TIMEOUT` |
| 网络层失败或非成功 HTTP 状态 | `PROVIDER_NETWORK_ERROR` |
| 过大、畸形或不符合兼容结构的响应 | `PROVIDER_INVALID_RESPONSE` |
| Mock 脚本耗尽 | `PROVIDER_SCRIPT_EXHAUSTED` |

错误实例不保留可访问的底层 `cause`、原始 fetch/keytar 异常、HTTP body、URL query 或 Key。调用方可以据错误码创建非秘密事件，但不得把输入或 transport 细节原样持久化。

## 测试策略

所有 Task 7 测试先写为红灯，并只使用伪造依赖：

1. Mock：按顺序返回、耗尽时安全失败、请求和响应快照不可由调用方修改、零网络调用。
2. Compatible Provider：验证受限 endpoint、固定请求形状、Authorization 仅进入注入 fake fetch 的请求；覆盖超时、网络失败、非成功状态、重定向、超大响应和畸形 JSON/响应结构；所有错误均不得含哨兵 Key 或响应正文；不发生重试。
3. Credential store：覆盖内存 set/get/status/clear、ref/secret 边界、Windows store 对固定 service/account 的定点调用、missing 与 unavailable 的区分，以及底层异常中含哨兵 secret 时仍只暴露安全错误码。
4. 隔离：测试不加载真实 keytar 原生模块，不调用 Windows Credential Manager，不读取环境变量、`.env` 或工作区文件，也不访问 DeepSeek/NJU 网络。

完成实现后运行 focused provider/credential tests、全量 `npm test`、`npm run typecheck`、`npm run lint` 和 diff 检查。真实连通性只作为用户后续显式、人工执行的 Windows 冒烟步骤。

## 兼容性与后续衔接

新包名固定为 `@kadsoo/codesentinel-providers`，与现有 `@kadsoo/codesentinel-*` 命名一致。Task 8 计划中的旧 `@codesentinel/providers` 示例必须同步改为该名称，避免未来 workspace 解析错误。

Task 8 将消费 Provider 的请求快照和 `unknown` 结果，并在自己的边界执行 `ActionSchema`、Policy、工具分发、轮次和停机逻辑。Task 9/10 才分别负责持久化、CLI/API 与 profile 引用清理。

## 设计自检

- 无 TBD、TODO 或尚未选择的默认安全行为；NJU 的 HTTP 例外明确要求未来显式批准。
- Mock、兼容传输和凭据库职责互不重叠；Action 校验明确留给 Task 8。
- 真实 Key、真实网络、CLI/API、profile 持久化均被明确排除，避免 Task 7 越界。
- 所有失败都用固定无秘密错误码表达，且测试策略包含泄露回归。
