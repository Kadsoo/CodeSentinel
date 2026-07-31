# Task 10 本地 API 与 CLI 设计

**日期：** 2026-07-31
**状态：** 已依据项目所有者的“采用推荐方案并持续推进”授权定稿
**范围：** `packages/host`、`apps/api`、`apps/cli`，以及为安全装配所需的 Contracts、Core 与 Persistence 最小扩展。

## 目标

把既有的 Provider、Credential Store、Policy、Tool Dispatcher、Agent Loop 和 SQLite
session repository 装配为可在 Windows 本机运行的产品边界：

- 本机 Fastify API 在固定 loopback 地址和端口提供会话、时间线、审批、停止和凭据状态接口；
- CLI 启动 API，并安全地设置、查看、清除和显式探测 Provider 凭据；
- 每个工作区由其 `codesentinel.json` 绑定一个非秘密 Provider profile；
- Profile 只保存本机非秘密元数据；API key 只进入 Windows Credential Manager；
- 任何会话写入、工具调用和验证均继续经过既有 Core/Policy/Tools/Persistence 边界；
- 所有单测使用注入的文件系统、时钟、Provider、Credential Store 和服务器端口，不访问真实网络、凭据库或用户工作区。

## 范围与非目标

本任务新增本地控制面，不重写既有 Agent Loop、策略、补丁审批或 SQLite 脱敏规则。

本任务不做以下事情：

- 不自动读取环境变量、`.env`、浏览器存储或任意文件中的 API key；
- 不硬编码 NJU SE Hub 的私有 endpoint、模型或 HTTP 例外；
- 不在启动、测试、CI 或公开演示中调用真实 Provider；
- 不实现 React WebUI、npm 发布、GitHub Pages、CI 或课程演示 fixture；
- 不将“停止”伪装成能够杀死已进入 OS 或网络层的任意子进程；它是可审计的协作式停止。

## 方案选择

考虑过三种实现方式：

1. **推荐：共享 Host 层，API 和 CLI 为薄适配器。** Host 统一拥有 Profile、凭据引用、工作区配置、会话排队和停止状态；两个入口只负责 HTTP/终端交互。这避免双写和不一致。
2. 只在 Fastify 内实现所有状态，CLI 经 HTTP 调用。CLI 在服务未启动时无法安全设置凭据，并把本地管理绑定到服务可用性。
3. 把会话同步执行在 HTTP 请求中。会阻塞请求、无法可靠支持停止和审批等待，也不符合长任务 API 语义。

采用方案 1。

## 模块与数据流

```text
CLI ───────┐
           ├─> Host application services ─> Core / Policy / Tools
Fastify ───┘              │                      │
                           ├─ Provider profile ──> Credential Store
                           └─ Session repository ─> local SQLite
```

新增私有工作区包 `@kadsoo/codesentinel-host`：

- `profile-store`：profile 文件的严格验证、原子读写和删除；
- `workspace-config-loader`：规范化目录、读取并验证 `codesentinel.json`；
- `session-service`：创建后台会话、维护一个活动会话、审批续跑、协作停止、会话查询和恢复；
- `runtime-composition`：动态装配 Credential Store、Provider、Policy、Tool Dispatcher、Core 和 Repository；
- `errors`：稳定、无秘密、无路径的 Host 错误码。

`apps/api` 只负责 Fastify server 与受严格 schema 保护的路由。`apps/cli` 只负责
Commander 参数、隐藏密钥输入和进程生命周期；两者都使用 Host 服务，绝不复制其
安全检查。

## 本地状态与 Provider profile

生产状态目录固定为 `%LOCALAPPDATA%\\Kadsoo\\CodeSentinel`：

- `profiles.json`：版本化、严格的非秘密 JSON；
- `sessions.sqlite`：现有的脱敏 SQLite repository；
- 不存储 API key、Authorization header、原始 patch、原始 Provider 响应或用户工作区绝对路径。

Profile 结构为：

```ts
type ProviderProfile = Readonly<{
  id: string;
  kind: "deepseek" | "nju_se_hub";
  endpoint: string;
  model: string;
  credentialRef: string;
}>;
```

`id` 和 `credentialRef` 使用既有 Credential Store 接受的安全 identifier 语法；两者
都不是 secret。profile 文件使用“写入同目录随机临时文件、关闭文件、原子 rename”
更新；读取时拒绝未知字段、重复 ID、控制字符、非 HTTPS endpoint、query/fragment
和损坏/超限 JSON。损坏文件不会被覆盖，Host 返回稳定错误。

DeepSeek 的默认 profile 可使用官方 OpenAI-compatible Chat Completions endpoint
`https://api.deepseek.com/chat/completions` 和当前文档中的默认轻量模型
`deepseek-v4-flash`。NJU SE Hub 的 endpoint 与 model 必须由本机用户显式传入，且
同样必须是 HTTPS；不存在 HTTP 降级。

工作区的 `codesentinel.json` 扩展为严格 JSON：保留受控
`verificationCommands`，并增加非空 `allowedPaths`、可选 `sensitivePatterns` 和
`providerProfileId`。请求体不能覆盖该 profile。Host 规范化工作区的真实路径，
用其 SHA-256 派生不含绝对路径的 `workspaceId`，再为 Policy、Tool Dispatcher 和
Persistence 使用同一个 canonical root。

## 会话服务与停止语义

`POST /sessions` 先完成工作区/config/profile/credential 状态和 verification command
验证；然后先持久化 `created` session，再启动后台 Promise，并返回
`202 { sessionId, state: "created" }`。应用进程全局最多一个非终结会话，包含
`running` 和 `awaiting_approval`；冲突请求得到 `409 SESSION_ACTIVE`。

会话入口创建一个短生命周期 runtime：从 Credential Store 读取 secret（仅在 composition
root），装配 OpenAI-compatible Provider、BoundPolicy、ToolDispatcher、Core controller
和现有 repository event sink。Core 的运行时扩展一个只读 stop probe，在每一个外部
await 前后检查；被请求停止时产生脱敏 `STOP_REQUESTED` 状态事件并进入 `stopped`，
随后不发出新的 Provider/工具/写入动作。

`POST /sessions/:id/stop` 只设置该 probe：

- 正在执行的 Provider 请求或验证不能承诺被强杀；它们结束后 Core 在下一安全边界停止；
- `awaiting_approval` 没有进行中的外部调用，Host 立即写入 stopped 状态并废弃内存中的
  approval runtime；
- 同一个停止请求可重复调用，结果幂等；终结或未知会话返回稳定状态而不是重新启动。

恢复时 Host 在接受请求前调用现有 `recoverInterruptedSessions(now)`；它停止遗留的
非终结会话并使待审批项过期，不恢复原始 patch 或运行中的任务。

列表与读取接口受界限保护：`GET /sessions` 最多 100 条按最近更新时间排序；
`GET /sessions/:id/timeline` 最多 500 个已脱敏事件。为支持该边界，Persistence 增加
严格 limit 参数和有序 `listSessions`，而不是由 API 读取未限制的数据库结果。

## API、服务器与 CLI

Fastify 以 `logger: false` 构建，body 上限为 16 KiB，生产监听固定
`127.0.0.1:48761`。没有公开 host/port 覆盖、CORS、远程监听或进程探测/终止功能；端口
已占用时安全失败为 `SERVER_ALREADY_RUNNING`。服务器启动只做恢复，不做 Provider probe。

路由均使用 strict Zod body/query/params schema，并返回 `{ code }` 或无秘密资源：

| 路由 | 行为 |
|---|---|
| `GET /health` | 本机健康状态，不含路径或配置。 |
| `POST /workspaces/validate` | 验证目录和 `codesentinel.json`，仅返回可用 command ID 与 profile ID。 |
| `POST /sessions` | 验证后异步创建会话，返回 202。 |
| `GET /sessions`、`GET /sessions/:id`、`GET /sessions/:id/timeline` | 读取有界、已脱敏的持久化视图。 |
| `POST /sessions/:id/approvals/:approvalId` | 只接受 `approve` 或 `reject`，调用当前活跃 runtime。 |
| `POST /sessions/:id/stop` | 请求协作停止。 |
| `GET /credentials/:profileId/status` | 只返回 configured/missing。 |
| `PUT /credentials/:profileId`、`DELETE /credentials/:profileId` | 仅对已存在 profile 设置或清除 secret；响应、日志和持久化均不回显 secret。profile 创建/更新只由 CLI 的 `credentials set` 完成；清除先删除 Credential Manager 记录，再删除 profile。 |

CLI 命令为：

```text
codesentinel start
codesentinel credentials set <profileId> --provider <deepseek|nju-se-hub> --model <model> [--endpoint <https-url>]
codesentinel credentials status <profileId>
codesentinel credentials clear <profileId>
codesentinel credentials probe <profileId>
```

`set` 在 TTY 使用隐藏输入，并在非 TTY 明确失败而非读取环境变量或回显 secret。
DeepSeek 未提供 endpoint 时使用上述公开默认值；NJU 必须提供 endpoint。`probe` 是唯一
触发真实网络的 CLI 命令，永不由测试、启动或 CI 调用。`keytar` 仅在显式运行 CLI 时
或已接收本机 API 请求时按需动态加载，绝不在模块导入、启动、测试或 CI 时加载；加载
失败保持 `CREDENTIAL_UNAVAILABLE`，不会回退到明文文件。

## 错误、安全与兼容性

Host 错误码包括 `WORKSPACE_INVALID`、`CONFIG_INVALID`、`PROFILE_NOT_FOUND`、
`CREDENTIAL_MISSING`、`SESSION_ACTIVE`、`SESSION_NOT_FOUND`、`SESSION_NOT_ACTIVE`、
`STATE_UNAVAILABLE`、`STATE_CORRUPT` 和 `SERVER_ALREADY_RUNNING`。错误实例没有
可访问的 native cause；HTTP 不返回原始路径、SQLite/OS 错误、请求体或 secret。

所有 API 输入在记录任何 session 前验证。Fastify 不记录请求/响应；Host 不把 secret
传给 repository、event sink 或异常。Provider 仍受 Task 7 的 HTTPS、超时、无重试和
有界响应约束；Task 8/9 的 path/command/approval/persistence 不变量保持不变。

## 测试与验证策略

先写 RED 测试，再实现最小通过代码：

1. Profile store：原子更新、损坏/超限 JSON、未知字段、重复 ID、endpoint/ref 校验，
   以及文件中绝无 secret。
2. Workspace loader：真实路径/目录/config 校验、allowlist/profile binding、派生
   workspace ID 不包含原始路径。
3. Session service：202 后台启动、单活跃冲突、恢复、受界限列表、审批续跑、停止
   前后边界和 stop 幂等性；所有 Provider/工具均为 fake。
4. API：错误码/状态、strict body、loopback listen 选项、无日志 secret、route 边界。
5. CLI：隐藏输入、非 TTY 拒绝、绝不打印 secret、动态 keytar 注入、clear 顺序和
   显式 probe。
6. Persistence/Core 回归：list/timeline limit 与 stop probe 不放宽既有审批、policy、
   事件顺序或脱敏安全性。

完成后执行 focused RED/GREEN、全部 `npm test`、`npm run typecheck`、`npm run lint`、
`npm run build`、diff 检查和独立规格/安全审查。测试启动的 Fastify 实例使用端口 0 或
`inject`，在每个测试后显式 `close()`；不保留长驻进程。

## 设计自检

- 未保留占位事项、默认 HTTP 或明文凭据回退；
- Host 是唯一 profile/session 协调者，CLI/API 的职责不重叠；
- 已明确异步创建、一个活动会话、停止边界、恢复和有界读取；
- NJU 私有配置和所有真实网络调用均要求用户之后在本机显式执行；
- 与 Task 7、8、9 的凭据、Policy、审批和脱敏边界一致。
