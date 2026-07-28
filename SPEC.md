# CodeSentinel 规格说明（SPEC）

> 状态：已完成设计确认，待陌生 Agent 冷启动验证。
> 项目方向：AI4SE Final Project A — Coding Agent Harness。
> 设计日期：2026-07-28。

## 1. 问题陈述

编程 Agent 能提高修复测试和实现小功能的速度，但它直接读写本地文件、运行命令时会带来三个实际风险：模型可能生成越界或危险操作；开发者难以理解和审查变更；测试失败后 Agent 容易陷入无反馈的重复尝试。CodeSentinel 是一个面向程序员的、本地优先的 Coding Agent Harness：它让 Agent 在一个显式选择的工作区内诊断失败测试或实现小功能，同时用确定性的策略护栏、人工批准与测试反馈闭环约束其行动。

目标用户是希望获得 AI 辅助、但仍要保留代码与系统控制权的 Windows 开发者。用户可以在 30 秒内理解它的价值：**“给它一个失败测试，它会在你批准每次源码修改的前提下分析、提出 diff、重跑测试；危险操作和越界访问会被代码规则拦下。”**

### 1.1 成功指标

- 内置样例中，用户能从失败测试启动会话，看到 Agent 的文件读取、补丁提议、人工批准和最终测试结果。
- 即使 LLM 输出危险命令、越界路径或敏感文件访问请求，后端也能在不调用真实工具的情况下拒绝该动作。
- 每个实际源码写入都有可见 diff 与明确的本地用户批准记录。
- 核心机制在没有网络和真实 LLM 的情况下可由 Mock LLM 确定性测试。

## 2. 范围

### 2.1 首版包含

- 测试修复任务：验证给定测试确实失败，诊断并提出补丁，批准后重跑验证。
- 小功能实现任务：接收功能描述、验收条件和预先配置的验证命令；Agent 必须先提议测试变更，再提议实现变更。
- 本地 CLI、React WebUI、会话时间线、diff 审批、测试结果与策略拦截展示。
- DeepSeek 官方平台、NJU SE Hub 和 Scripted Mock 三种可切换 Provider。
- 工作区/路径/命令/敏感文件护栏，写入前人工审批，最多三轮修复反馈循环。
- 内置故障样例项目、离线测试、npm 包分发与仅 Mock 的公开 Web 演示。

### 2.2 首版不包含

- 完整 TUI、MCP/插件市场、多 Agent 编排、后台自治任务。
- 任意 shell 命令、自动 Git push/发布、删除数据、访问工作区外文件。
- 公开服务端执行访问者提交的代码，或读取访问者的本地工作区。
- 绕过用户批准的源码写入。

## 3. 用户故事

| 编号 | 用户故事 | 验收条件 |
|---|---|---|
| US-01 | 作为程序员，我想选择一个本地工作区并从配置选择测试命令，以便 Agent 只在该项目内工作。 | 工作区被规范化为绝对路径；未配置的命令不可运行；工作区外路径被拒绝。 |
| US-02 | 作为程序员，我想提交一个失败测试修复任务，以便 Agent 先复现问题再提出修改。 | 若初始测试通过，任务以“不可复现”停止且零文件写入；若失败，失败摘要进入下一轮上下文。 |
| US-03 | 作为程序员，我想在写入前查看并批准 diff，以便保留代码控制权。 | 未批准补丁永不写盘；拒绝后任务停止并保留审计记录。 |
| US-04 | 作为程序员，我想看到测试/策略反馈如何影响下一步，以便判断 Agent 是否可靠。 | UI 显示每轮动作、策略决策、测试状态与最多三轮计数。 |
| US-05 | 作为程序员，我想安全配置 NJU SE Hub 或 DeepSeek 的 Key，以便不把凭据提交进仓库。 | Key 仅存 Windows Credential Manager；状态页从不回显明文；更新和清除可用。 |
| US-06 | 作为程序员，我想让 Agent 实现一个小功能，同时提供验收与测试命令，以便它在受控条件下工作。 | 缺少验收条件或验证命令时不允许进入写入阶段；先提出测试补丁，再提出实现补丁。 |

这些故事按单一价值和独立验收条件拆分：每个故事可单独测试、估算和演示，不依赖未定义的外部行为。

## 4. 功能规约

### 4.1 工作区与配置

输入为用户在 CLI/WebUI 中选择的本地目录和项目根目录中的 codesentinel.json。配置包含命名验证命令、允许路径模式、Provider 默认值和工具策略。后端规范化工作区路径，验证配置结构，并拒绝不存在的目录、配置错误或超出允许路径的动作。

每条验证命令被表示为受控的“可执行文件 + 参数数组”，而不是交给 shell 解释的自由字符串。未知命令、网络安装命令、发布命令和命令链均不在首版允许范围。若没有可用验证命令，系统不允许自动写入源码。

### 4.2 凭据与 Provider

ProviderProfile 包含 Provider 名称、模型、非秘密 base URL 与 Windows Credential Manager 中的凭据引用。DeepSeek 使用其官方的兼容接口；NJU SE Hub 采用可配置兼容 Provider，内部 URL 和 Key 只在用户本机录入。Provider 抽象只提供单次结构化补全，不拥有会话循环、工具分发或安全策略。

首次添加或更新 Key 时，CLI 使用隐藏输入并写入系统凭据库；查看时仅显示“已配置/未配置”。用户可从 CLI 或设置页执行清除：系统先删除对应的凭据库记录，再删除本地 ProviderProfile 引用，并显示已清除状态。无法读取凭据、Provider 超时、网络故障或无效响应都会生成非秘密错误事件，且不会触发文件写入。

### 4.3 任务、决策与停机

任务类型是测试修复或小功能实现。每个会话绑定一个工作区、一个 Provider、一个任务、最多三轮循环及用户确认的隐私提示。

测试修复首先运行用户选择的验证命令：通过时以“不可复现”停止；失败时才向 Provider 提供脱敏失败摘要和经策略允许的上下文。小功能实现必须包含验收描述和验证命令，并首先要求 Agent 提议测试变更。

Agent Loop 按下列顺序运行：构建最小上下文 → 调用 Provider → 解析单个结构化 Action → Policy 校验 → 工具执行或请求批准 → 持久化事件 → 将工具/测试结果回灌。达到三轮、用户拒绝补丁、策略拒绝不可恢复动作、测试通过或发生不可恢复错误时停止。

### 4.4 工具与动作

首版 Action 仅包括：

- list_files、read_file、search_text：仅允许读取工作区内、非敏感且大小受限的文本文件；
- propose_patch：生成含目标文件、预期基线哈希、统一 diff 与理由的候选补丁，不写入磁盘；
- apply_approved_patch：只有对应审批记录为批准且基线哈希未变化时才写入；
- run_verification：只运行 codesentinel.json 中已命名和批准的命令；
- finish：给出结构化的成功、需要人工处理或不可复现结论。

LLM 不能输出任意 shell 字符串，也不能直接调用 Node 文件系统、子进程或网络。所有 Action 在执行前都经过 JSON Schema 验证和 Policy Guardrail。

### 4.5 策略护栏与人工审批

Policy Guardrail 是本项目的主要贡献。它对每个 Action 返回 allow、ask 或 deny，并附带确定性理由：

- 工作区外路径、符号链接逃逸、.env、凭据文件、.git、依赖目录和二进制文件默认 deny；
- 删除、重命名、Git 发布、依赖安装、网络访问和未知命令默认 deny；
- 读取允许范围内文件与配置内验证命令可 allow；
- 所有 propose_patch 进入 ask，其后只能在本地用户点击批准后由 apply_approved_patch 写入。

批准状态机为 pending → approved 或 rejected 或 expired。批准一次只匹配一个补丁的内容哈希和目标文件基线；文件在等待期间变化时批准失效。用户拒绝候选补丁后，该任务停止，防止 Agent 静默尝试另一个写入方案。

### 4.6 反馈、记忆与可观测性

每次工具调用与测试运行生成带轮次的事件。测试结果包括命令标识、退出码、耗时、脱敏摘要和通过/失败状态；失败会成为下一轮的客观反馈。SQLite 保存本地会话摘要、动作、审批和验证记录；用户可按会话清除。系统从不保存 Key，也在持久化前对已知密钥模式进行脱敏。

WebUI 显示任务状态、每轮时间线、策略结论、补丁 diff、批准控制、验证输出和最终结论。它通过本地 API 与后端通信，不能直接访问用户文件系统或执行命令。

## 5. 非功能性需求与威胁模型

| 目标/威胁 | 对策 |
|---|---|
| LLM 幻觉或恶意 Action | 单 Action JSON Schema、Policy Guardrail、默认拒绝、Mock 单测。 |
| 代码/日志中的提示注入 | 将工作区内容视为不可信数据；只有后端策略可授权工具，文本不能修改策略。 |
| 命令注入 | 使用无 shell 的进程启动，命令只能来自配置中的可执行文件与参数数组。 |
| 路径逃逸或敏感读取 | 路径规范化、真实路径检查、允许列表、敏感模式和符号链接拒绝。 |
| 未授权修改 | 全部源码写入必须经 diff 审批、内容哈希和基线哈希双重校验。 |
| Key 泄露 | Windows Credential Manager；不写源码、Git、SQLite、日志或明文配置；隐藏输入和状态掩码。 |
| Provider 数据暴露 | 首次工作区选择时显式告知只发送允许的代码片段/日志；敏感文件永不进入上下文；公开演示仅用 Mock。 |
| 循环失控/资源消耗 | 三轮上限、单命令超时、输出大小上限、用户可随时停止。 |

本地 UI 在普通开发机上应在启动后 10 秒内可访问；单次验证命令的默认超时、最大输出与最大读取文件数均可在配置中收紧。所有错误均使用可读、脱敏的状态与事件 ID，便于排查而不泄露内容。

## 6. 系统架构

~~~mermaid
flowchart LR
    U["程序员 / 本地 WebUI"] --> API["本地 Session API"]
    CLI["CLI"] --> API
    API --> LOOP["自研 Agent Loop"]
    LOOP --> PROVIDER["Provider Adapter<br/>NJU SE Hub / DeepSeek / Mock"]
    LOOP --> POLICY["Policy Guardrail"]
    POLICY --> TOOLS["受控 Tools"]
    TOOLS --> WS["显式选择的工作区"]
    TOOLS --> VERIFY["受控验证命令"]
    VERIFY --> LOOP
    POLICY --> APPROVAL["本地人工审批"]
    APPROVAL --> TOOLS
    LOOP --> STORE["SQLite 会话存储"]
    CLI --> KEYRING["Windows Credential Manager"]
~~~

实现采用 npm workspaces 的 TypeScript 单仓库：

- packages/contracts：共享类型、Action Schema、事件和错误码；
- packages/core：Agent Loop、会话状态和上下文裁剪；
- packages/policy：策略判定、路径/命令解析、审批状态机；
- packages/tools：受控工作区与验证工具；
- packages/providers：DeepSeek、NJU SE Hub、Mock Adapter；
- packages/persistence：SQLite repository 与脱敏；
- apps/cli：本地启动、凭据管理、工作区选择；
- apps/web：React WebUI；
- fixtures/failing-project：内置失败测试样例。

## 7. 数据模型

| 实体 | 关键字段 | 约束 |
|---|---|---|
| Workspace | id、canonicalPath、configDigest、createdAt | 路径必须存在且绑定单一会话工作区。 |
| ProviderProfile | id、kind、model、baseUrl、credentialRef | 无 API Key 字段；credentialRef 仅指向系统凭据库。 |
| Session | id、taskKind、state、round、workspaceId、providerId | round 在 0–3；状态是有限状态机。 |
| ActionRecord | id、sessionId、kind、inputSummary、policyDecision、resultSummary | 原始敏感内容脱敏；动作顺序不可重排。 |
| Approval | id、actionId、patchHash、baseHash、status、expiresAt | 只能批准待处理补丁；基线变化自动失效。 |
| VerificationRun | id、sessionId、commandId、exitCode、durationMs、summary | 命令必须来自配置；输出限制并脱敏。 |
| SessionMemory | sessionId、summary、updatedAt | 可由用户清除；不存 Key。 |

## 8. Coding Agent Harness 领域与机制设计

### 8.1 工具

Coding 场景需要安全浏览项目、读取少量文件、搜索文本、提议/批准补丁及运行预配置验证。工具能力刻意小于 OpenCode：没有任意 shell、外部网络或发布工具，以保证边界可测试。

### 8.2 客观反馈

核心反馈是受控测试、lint 或类型检查的退出码与脱敏输出。它们由后端工具产生，不由 LLM 自评。失败被分类为“仍失败”“命令错误/超时”“不可复现”，再回灌到 Loop。

### 8.3 危险动作与治理

路径逃逸、敏感文件、删除/发布、未知命令和所有源码写入均是危险动作。治理以可单测的 Policy Guardrail 和审批状态机实现，而非提示词。重点维度为**治理**：路径边界、命令白名单、补丁内容/基线绑定、人工批准及默认拒绝。

### 8.4 记忆

跨轮记忆只保留任务目标、已读取文件摘要、前一轮测试反馈、审批决定和用户明确补充的限制。跨会话记忆是本地 SQLite 的可清除摘要，不自动把整个仓库或旧日志加载进模型。

### 8.5 离线可验证性与机制演示

ScriptedMockProvider 按预设 Action 返回响应。机制演示必须稳定复现：

1. Mock 请求危险命令时，Guardrail 返回 deny 且工具零调用；
2. Mock 先运行失败测试，再根据反馈提出补丁，批准后运行通过测试；
3. 未批准或基线已变的补丁无法写入，体现治理主贡献。

以上测试均不访问网络或真实模型。

## 9. 技术选型、凭据、分发与部署

- **语言/运行时**：TypeScript + Node.js 22；当前开发环境已安装 Node.js，适合结构化 Action、跨包类型共享和本地 CLI。
- **本地 WebUI**：React + TypeScript + Vite；仅连接本机 API，便于展示 diff 和审批。
- **本地存储**：SQLite；适合单机离线会话记录。
- **凭据**：Windows Credential Manager；首版目标平台为 Windows x64，使用系统凭据抽象实现录入、状态、更新和清除。
- **Provider**：DeepSeek 官方兼容 API、NJU SE Hub 兼容端点、Scripted Mock。真实 Provider 不参与单测。
- **分发**：公开 scoped npm 包 @kadsoo/codesentinel，目标为 Windows x64。README 将提供安装、运行、凭据配置、平台限制和卸载/清除步骤。
- **线上演示**：GitHub Pages 托管静态 Mock 演示 UI；它只呈现内置样例的预设事件，不接收真实 Key、本地路径或任意代码。
- **CI**：GitHub Actions 作为主 CI，在 push/PR 运行 npm test、lint、类型检查和构建。根目录保留含 unit-test job 的 .gitlab-ci.yml，以便按课程最终要求或镜像到 NJU GitLab。

OpenCode 仅作为产品交互与模块分层的研究参考；CodeSentinel 不调用、包装或复制其 agent runner。README 将注明参考来源与任何第三方许可证。

## 10. 验收标准

项目完成必须同时满足：

1. npm test 离线通过，核心 Policy、Loop、Tool、Provider Mock 测试覆盖主要机制；
2. CI 最近一次运行通过；
3. 内置样例从失败测试到批准补丁后通过，完整时间线可见；
4. Mock 演示可复现危险 Action 拦截、失败反馈导致下一步改变、补丁批准绑定三种行为；
5. 拒绝补丁、超时、Provider 错误、配置错误和三轮耗尽均给出可读且无秘密的终态；
6. Key 录入/更新/清除可用且任何仓库文件、日志、SQLite 数据库不含明文 Key；
7. Windows 新机器遵照 README 能通过 npm 安装并启动本地 UI；公开 Web 演示可访问；
8. 所有实现任务保留测试先红后绿、独立分支/PR、评审与 AGENT_LOG.md 证据。

## 11. 风险与未决问题

- NJU SE Hub 的实际端点、模型名和兼容程度必须在用户本机安全验证，不能写进公开仓库。
- npm scoped 包发布与 GitHub Pages 部署需要项目所有者的账号授权。
- 课程文本同时提到 GitHub Actions 与 .gitlab-ci.yml；在提交前应向助教确认是否需将仓库镜像到 NJU GitLab 并留下最终通过的执行记录。
- Windows Credential Manager 的 Node.js 绑定、SQLite 原生依赖和 npm 打包需要在干净 Windows 环境做安装冒烟测试。
- LLM 对复杂真实项目的修复成功率不作为安全机制；产品只承诺可审查、可限制、可反馈的工作流。
