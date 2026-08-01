# AGENT_LOG

## 2026-08-01 — TASK-010: Local API, CLI and integration delivery evidence

- Branch: `feat/task10-api-cli`; all changes remain local. No push, PR, merge, real Provider, network, or credential service was used.
- TDD RED/GREEN: Task 10 sections 1–8 are checked off in the plan; representative RED counts included config 2 failures, persistence 4 failures, Core stop 3 failures, Host profile 16 failures, runtime 13 failures, session service 7 failures, API missing-package failure, and CLI missing-package failure. Corrective RED tests covered compatibility, audit races, stale locks, approval consistency, and package boundaries.
- Integration RED/GREEN: initial fixture ordering failed with `PERSISTENCE_FAILED`; an invalid feature-phase fixture produced `FEATURE_STAGE_INVALID`; the corrected controlled `test_repair` fixture passed. Final integration verifies API/Host/CLI/fake Provider composition, concurrent-create 409, stop idempotence, bounded timeline, `[REDACTED]` persistence, and sentinel absence from profiles, SQLite sidecar files, HTTP and CLI output.
- Final verification: focused integration 16 files / 663 passed; full `npm test` 36 files / 1003 passed / 6 skipped; `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check` exited 0. Child verification processes and Fastify/repository resources were closed in `finally`; no long-lived process remains.
- Task 10 implementation commits include `75c8bf8`, `a736767`, `bff16dd`, `7e8b929`, `6c6b5cf`, `09a3af1`, `99eaf5d`, `e210185`, `8d97258`, `d4ad558`, `bb9ca7f`, `289a4d2`, `63b3eb4`, `6f38452`, `ac4e4e3`, `2265912`, `0795cd8`, and `583258d`.
- Independent reviews: Task 1–8 specifications and quality reviews were compliant/Ready; the Task 9 final audit found no code C/I/M blockers after evidence was recorded.

## 2026-07-28T23:15:27+08:00 — SPEC-001：设计规约阶段

- 触发技能：using-superpowers、brainstorming、writing-plans（计划尚未开始）。
- 关键上下文：课程要求 A 方向；公开空仓库 Kadsoo/CodeSentinel；用户确认参考 OpenCode 的交互与模块形态，但自研 harness 内核。
- 人工决策：主验收为修复给定失败测试；源码写入必须人工批准；最多三轮反馈；Provider 为 NJU SE Hub、DeepSeek 与 Mock；内置故障样例；Windows x64 npm 分发；本地数据和敏感文件保护。
- Agent 输出：给出三种实现路径，用户选择“OpenCode 风格的精简本地 Agent Workbench”；随后逐段确认架构、模块、隐私、测试与验收。
- 人工干预：用户把初始“通用两者都做”收敛为“测试修复为主、小功能为受限扩展”。
- 教训：参考成熟 Agent 产品时，必须区分可借鉴的交互形式与不能复用的 agent runner；安全边界需要以代码状态机和测试表达，而不能停留在 prompt。
- 凭据：未接收、未记录、未使用任何真实 API Key。

## 2026-07-28T23:15:27+08:00 — ENV-001：技能与仓库准备

- 触发技能：skill-installer。
- 事实：初始环境未暴露课程要求的 brainstorming 技能；已从官方 obra/superpowers 安装 brainstorming 和 finishing-a-development-branch。
- 仓库操作：GitHub 克隆因网络连接中断失败；由于远程仓库为空，在课程工作区初始化本地 Git 仓库并设置同一 origin，尚未推送。
- 人工干预：无。
- 教训：网络/远程失败不得伪造已推送状态；本地文档提交与后续显式推送应分开记录。

## 2026-07-28T23:33:12+08:00 — PLAN-001：书面规格批准后的实现计划

- 触发技能：writing-plans。
- 输入：项目所有者明确批准 SPEC.md；只使用已批准的 SPEC.md，不引入未确认的功能。
- 输出：根目录 PLAN.md 与 docs/superpowers/plans/2026-07-28-codesentinel-implementation.md。计划含 13 个任务、依赖图、每项失败测试、绿灯检查、提交边界及冷启动协议。
- 人工干预：无；尚未写任何实现代码、安装依赖、运行产品测试或调用真实 Provider。
- 自检：已检查功能规约覆盖、任务依赖、类型名一致性及无模糊占位语；冷启动验证仍是进入实现前的硬门。

## 2026-07-28T23:48:04+08:00 — COLD-001：隔离冷启动验证与文档修订

- 触发技能：using-git-worktrees；为隔离创建了被 `.gitignore` 忽略的 `.worktrees/cold-start-validation`，其分支不合并。
- 验证 Agent：不同类型的 `codex-auto-review`，无本次对话历史；仅接收该工作树中的 SPEC.md 和 PLAN.md 绝对路径。
- 实际产物与检查：它仅新建 `packages/contracts/src/id.test.ts`，运行 `npm test -- --run packages/contracts/src/id.test.ts`；因根 package.json 尚不存在而得到预期 ENOENT 失败，未进行 Task 2、未提交、未调用网络或真实 Provider。
- 发现：Task 1 没有锁定依赖版本、npm 版本和 lockfile 策略，冷启动 Agent 按规则停止而未猜测。
- 修正：依据 npm 官方注册表与本机 Node.js 22.17.0 / npm 10.9.2，SPEC.md 和 PLAN.md 现明确精确工具链、直接依赖、npm lockfile v3、`npm ci` 和配置基线；选择 jsdom 27.3.0 与 TypeScript 5.9.3 以满足已验证的 Node/ESLint 兼容条件。
- 后续：需由另一无上下文 Agent 复核修订后 Task 1 和 Task 2；在其通过且文档无新歧义前，不开始正式实现。

## 2026-07-28 — COLD-002：复核通过、npm 安装环境阻塞

- 验证 Agent：不同类型的 `gpt-5.6-terra`，无对话历史；只接收第二个可丢弃 worktree 的 SPEC.md 与 PLAN.md 绝对路径。
- 文档结论：未发现 Task 1–2 的实现歧义；它按计划完成了 Task 1 的文件创建，初始 `npm test -- --run packages/contracts/src/id.test.ts` 得到预期 ENOENT 红灯。
- 实际阻塞：`npm install` 两次在约两分钟后超时；后续 `npm install --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=20000` 的日志显示 npm 官方 registry 多个 GET 请求发生 `ECONNRESET`/`ETIMEDOUT`，并以 npm 的 `Exit handler never called!` 非零失败结束。未产生 package-lock.json 或 node_modules。
- 范围控制：所有改动、日志和诊断均位于 `.worktrees/cold-start-validation-2`；没有主分支代码、提交、推送、真实 Provider 调用或凭据。
- 结论与后续：规格/计划冷启动歧义已消除，但正式实现和任何“测试通过”声明必须等待 npm 安装能够完成；保留可丢弃工作树作为证据，不合并其代码。

## 2026-07-28 — TASK-001：TypeScript 工作区与确定性基线

- 隔离与提交：在 `feat/task-1-workspace` worktree 中完成，实施提交为 `6e0176fb35fbadc7e39acd57888efa64c05b86a5`，经两阶段审查后合并到本地 main（`83cf0b1`）；未推送远程。
- TDD 证据：先创建 `packages/contracts/src/id.test.ts`，`npm test -- --run packages/contracts/src/id.test.ts` 因根 package.json 不存在得到预期 ENOENT 红灯；随后以最小 `randomUUID()` 实现转绿。
- 依赖与网络：用户明确授权临时使用 `https://registry.npmmirror.com` 进行单次下载，不写入 `.npmrc` 或全局配置。安装后将 package-lock 中 349 个临时镜像 resolved URL 标准化为 `https://registry.npmjs.org/`，并以 `npm ci --offline --ignore-scripts --no-audit --no-fund` 验证 lockfile。
- 实际检查：Node 22.17.0、npm 10.9.2、lockfile v3；聚焦 Vitest、`npm run typecheck`、全量 `npm test`、`npm run lint` 和 `git diff --check` 均通过。安装与离线 CI 有 `whatwg-encoding` 的 npm 弃用警告，但没有检查失败。
- 审查与修正：规格审查通过；质量审查发现 Vitest 4 不支持 `environmentMatchGlobs`，已改为未来 Web 测试逐文件 `@vitest-environment jsdom` 注释，并把 vitest.config.ts 纳入类型检查。安全地扩展 `.gitignore` 为 `.env*` 且允许 `.env.example`。contracts 包的 `index.ts`/exports 按计划留给 Task 2。
- 非阻塞观察：现有 UUID 形状断言较宽松；由于 Task 1 需保留计划中的精确测试，该增强留待后续 contracts 任务处理。

## 2026-07-28 — TASK-002：共享 Harness 契约

- 隔离与提交：在 `feat/task-2-contracts` worktree 中完成，实施提交为 `cf79de6d1cd5557c312e2c377eb1cf7f63d1efa5`；规格复核和最终质量复核均通过后，合并到本地 main（`2ea211b`），未推送远程。
- TDD 证据：先执行聚焦 contracts 测试，因 `ActionSchema` 与 `CodeSentinelConfigSchema` 尚不存在而得到预期红灯；随后以最小 Zod 契约实现转绿。
- 契约范围：定义严格的七类受控动作、任务种类、策略决定、会话状态、结构化验证命令和无 SQLite 依赖的事件接口；未知字段、任意 shell 动作、空白路径和错误命令形状均被拒绝。
- 一致性与审查修正：共享标识符会去除首尾空白，以保证 verification action 的 `commandId` 与配置 ID 一致；语义性字符串（如路径、查询）保持原样。重复命令 ID 会定位到重复项的嵌套字段。
- 实际检查：聚焦 contracts 测试 12/12、全量测试 13/13、`npm run typecheck`、`npm run lint` 和 `git diff --check` 均通过；最终质量复核未发现 Critical、Important 或 Minor 问题。

## 2026-07-28 — TASK-003：默认拒绝策略护栏

- 隔离与提交：在 `feat/task-3-policy-guardrail` worktree 中完成，最终实施提交为 `25ad4254f8b82c9dee11daacd7b0bde4f3519d13`；多轮规格和质量复核均通过后合并到本地 main（`4221c6c`），未推送远程。
- TDD 证据：先创建 guardrail 测试，`npm test -- --run packages/policy/src/guardrail.test.ts` 因 `guardrail.js` 不存在而得到预期红灯；每个后续安全回归均先以失败测试复现，再进行最小修复。
- 安全范围：实现冻结的五种理由码、显式路径白名单、敏感/二进制/凭据路径拒绝、Windows 和 POSIX 路径差异、规范路径快照的失败关闭复检，以及在 Task 4 前持续拒绝 `apply_approved_patch`。
- 命令策略：验证命令不再因“已配置”自动放行；只允许精确的包管理器测试/受限脚本数组，拒绝安装、更新、卸载、发布、Git、shell、网络/fetch runner、可执行文件路径伪装、NUL、命令链及任何尾随参数。
- 复核修正：修复 Unicode 非 BMP glob 匹配、过长路径/模式的有界拒绝、Windows 保留设备和尾随别名、驼峰凭据名、规范目标二次检查、工作区根末尾分隔符及 `--prefix`/`--script-shell` 参数逃逸。实时 realpath/junction/TOCTOU 复检仍明确留给 Task 5 工具层。
- 实际检查：聚焦策略测试 35/35、全量测试 4 文件/48 测试、`npm run typecheck`、`npm run lint` 和 `git diff --check` 均通过。最终规格复核为 COMPLIANT；最终质量复核未发现 Critical、Important 或 Minor 问题。

## 2026-07-28 — LOCK-001：policy workspace lockfile 同步

- 触发：Task 4 隔离工作树执行 `npm ci --offline --ignore-scripts --no-audit --no-fund` 时稳定失败，提示 `Missing: @kadsoo/codesentinel-policy@ from lock file`。
- 根因：Task 3 新增 `packages/policy` workspace 后，`package-lock.json` 仍只有 contracts workspace link；干净安装无法从根 lockfile 解析 policy package。
- 修正：使用离线、仅 lockfile 的 `npm install --package-lock-only --offline --ignore-scripts --no-audit --no-fund` 补齐 `node_modules/@kadsoo/codesentinel-policy` link 与 `packages/policy` package 条目，未改变第三方依赖版本或 registry URL。
- 验证：修正后离线 `npm ci` 成功安装 292 个包；全量测试 4 文件/48 测试、`npm run typecheck`、`npm run lint` 和 `git diff --check` 均通过。npm 仍显示已有的 `whatwg-encoding` 弃用警告，但无检查失败。

## 2026-07-28 — TASK-004：补丁审批状态机

- 隔离与提交：在 `feat/task-4-approval-state` worktree 中完成，最终实施提交为 `0924c0dd12e697e6233bc941ea657a044aa9aa66`；独立规格/安全复核和最终质量复核通过后合并到本地 main（`b719d31`），未推送远程。
- TDD 证据：先运行 approval 聚焦测试，因 `approval.js` 不存在得到预期红灯；后续针对随机默认 ID、`now < createdAt` 和缺少当前基线的兼容拒绝调用均先写失败测试再修复。
- 状态语义：审批记录保留 id、actionId、patchHash、baseHash、createdAt、expiresAt 和有限状态。只有 pending 可转为 approved、rejected 或 expired；基线变化、无效时间、创建前时间和到期时间均失败关闭为 expired，任何终态都不可重新批准。
- API 边界：三参数兼容工厂使用显式的非授权确定性 sentinel 身份；生产调用需提供可信 metadata。两参数 `rejectPatch` 兼容形式在无法验证当前基线时失败关闭为 expired，只有带当前基线的形式能产生 rejected。所有转换返回新的冻结记录，不修改输入。
- 后续约束：该状态对象不是独立写入授权。Task 5 必须从可信状态解析 approval/action，并再次核验目标路径、精确补丁哈希、基线哈希、过期和一次性使用。
- 实际检查：聚焦 approval 测试 14/14、全量测试 5 文件/62 测试、`npm run typecheck`、`npm run lint` 和 `git diff --check` 均通过；最终质量复核未发现 Critical、Important 或 Minor 问题。

## 2026-07-28 — TASK-005：受控工作区读取与补丁写入

- 隔离与提交：在 `feat/task-5-tools` worktree 中完成，最终实施提交为 `9e7f32c83aa79beead9fe2ca820ced13071987fd`；多轮独立规格/安全复核和质量复核通过后合并到本地 main（`eb39829`），未拉取远程、未推送 GitHub。
- TDD 证据：先记录缺少工具模块导致的预期红灯；后续每项安全回归均先复现失败，再做最小修复，包括危险路径/硬链接、未绑定审批 sentinel、冲突或被忽略的 diff 头尾、hunk 重定位与重叠、重复 no-newline marker、大小限制、临时文件身份，以及初始读取后和临时文件创建后的权限漂移。
- 工具边界：`readWorkspaceFile` 只返回有界 UTF-8 文本，拒绝工作区逃逸、符号链接、硬链接、非普通文件、二进制和危险 Windows 路径别名。`applyApprovedPatch` 只接受严格的单文件 unified diff；写入前机械校验 approved 状态、拒绝 unbound sentinel、校验时间、精确 UTF-8 patch hash 与当前原始字节 base hash，并以同目录临时文件、身份/内容哈希/mode 快照复验后原子替换。
- 权限与审批边界：该层仅验证调用者给出的 approval 记录在机械上匹配，不证明其来自人工批准，也不承担 Task 3 policy allowlist 的执行。后续 Task 8/9 必须由受控 dispatcher 与权威存储绑定 action、路径、会话、过期和一次性消费。普通 POSIX `mode & 0o777` 会被保留；不声称保留 ACL、owner、ADS 或 xattr。
- 实际检查：最终实施分支全量 `npm test` 为 8 文件、83 通过、3 个已记录的平台跳过；`npm run typecheck`、`npm run lint` 和 `git diff --check` 均通过。合并后的 main 再次运行全量测试，同为 83 通过、3 跳过，类型检查、lint 和 merge diff 检查均通过。
- 保留边界：便携式 `fs/promises` 无法完全消除最终复验到 `rename` 之间的 OS 级 TOCTOU；Windows junction/reparse 直接竞态回归仍建议在具备权限的环境补充。实现明确记录这些限制，未将其表述为已解决。

## 2026-07-29 — TASK-006：受信任 npm 验证运行器

- 隔离与提交：在 `feat/task-6-verification-runner` worktree 中完成；实现经多轮 TDD 和独立安全/质量复核后，本地合并到 `main`（`57faaa0`）。未拉取远程、未推送 GitHub。
- 命令模型：验证配置由任意 executable 迁移为严格的 `node_npm_cli` launcher；仅允许固定 npm test/run script 参数、受限 timeout/output 预算及受控 command ID。Policy 只从严格配置按 ID 匹配，Task 6 不承担 Policy、approval 或 workspace containment 授权。
- 运行时边界：只通过 canonical `process.execPath` 执行 canonical npm CLI，并显式 `shell: false`；不使用 PATH、`.cmd`、`cmd.exe`、`exec` 或任意调用方环境。cwd 与命令配置在运行时重验，stdout/stderr 共享字节上限，超时/溢出/启动和流错误均返回稳定、无原始 OS 错误的结果。
- 输出安全：分别处理 stdout/stderr，固定顺序汇总；对终端控制序列、Cc/Cf、JSON/环境变量形式和常见 token/secret 进行有界脱敏。未知或未完成的终端序列、未闭合 JSON 或悬空敏感赋值会保守返回安全摘要。实现不把 npm script 当作 sandbox，也只尽力终止直接 child。
- 实际检查：最终 focused runner 测试 77/77；跨包回归 131/131；合并前全量 `npm test` 为 167 通过、3 个平台跳过；`npm run typecheck`、`npm run lint` 和 diff 检查通过。合并后的 `main` 再次运行 `npm test`，为 9 文件通过、167 通过、3 跳过。
- 保留边界：信任本机 Node/npm 安装，不能消除本地管理员替换或 OS 级 TOCTOU；不保证终止子孙进程，也不提供 OS 级隔离。Task 8 仍必须使用同一配置快照完成 Action/Policy/workspace 授权。

## 2026-07-29 — TASK-007：Provider 与 Windows 凭据抽象

- 实现与集成：在隔离分支 `feat/task-7-providers` 完成 Provider contract、确定性 Mock、受限 OpenAI-compatible transport、测试内存凭据与注入式 Windows Credential Manager port。GitHub PR #1 已以普通 merge commit `fc2c29864a41cafe08fc674f2555bb15468a3348` 合并到 `main`。
- TDD 与加固：先记录缺少模块的红灯；后续针对 Mock 快照、transport 超时/延迟响应清理、内存 Map 与 Keytar port 的运行时私有性、畸形 Keytar 返回值，以及 Provider 构造参数 throwing getter 分别新增红绿回归。
- 安全边界：没有静态或动态加载 `keytar`，没有 `.env`、环境变量、文件、SQLite、日志或明文回退；不读取真实 Key、不在测试中调用真实 Provider 或 Windows Credential Manager；不为 HTTP endpoint 添加例外。
- 审查：独立规格、安全与质量审查先后提出并验证修复运行时私有字段、注入端口返回契约和构造参数错误泄露；最终复审均为 COMPLIANT。Mock 对恶意 Proxy 的反射副作用仍保守地作为测试输入边界。
- 实际验证：Feature 分支和 GitHub 合并后的本地 `main` 均运行 `npm test`（12 文件、264 通过、3 跳过）、`npm run typecheck`、`npm run lint` 与 diff 检查并通过。
- 发布：远程 `main` 与 `feat/task-7-providers` 已推送；PR #1 当前已合并。未推送或记录任何真实 Provider/凭据秘密。

## 2026-07-30 — TASK-008：受控 Agent Loop

- 隔离与状态：在 feat/task8-agent-loop 隔离分支完成，最终提交为 bb159d1，未推送。没有长驻进程；全部 test process 均已完成/退出。未调用真实 Provider、network 或 credentials。
- TDD 事实：Task 8 feature-flow RED 的 8 个新用例中有 3 个失败，分别为缺 Expected stage、意外将 test GREEN 作为完成、以及 RED 后未转入 implementation。Task 8 approval-resume 的 Date 最大值/15min TTL 情形会错误创建 pending。命令绑定 repair RED 为 58 tests 中 1 failed（完成而非阻断）；feature RED 为 9 tests 中 1 failed（得到 FEATURE_STAGE_INVALID 而非 POLICY_DENIED）。
- 后续补充两轮 mutation testing：额外的 verification event 会使期望 1 收到 2；改变 selected feature phase 码会失败；将 policy event 从 ALLOWED 改为 POLICY_DENIED 时，两条事件序列测试均失败。
- 关键实施 commits：559a899、c036664、ad74f7e、dab1d0a、6cd0898、0e47fd7、bb159d1。
- 独立审查：发现并修复 TTL Date upper-bound、selected verification command substitution 与 feature mismatch ordering。最终规格与质量审查均为 COMPLIANT；workspace 旧审查三项已复核为早已修复，无需改动。
- 最终独立验证：npm test 为 19 files / 382 passed / 6 skipped；npm run typecheck、npm run lint，以及 git diff --check docs-task8-agent-loop-design...HEAD 均 exit 0。

## 2026-07-31 — TASK-009：结构化脱敏持久化

- 范围与隔离：在 `feat/task9-persistence` 本地 worktree 完成。交付 Harness 结构化审计事实、会话/有序时间线/Action/审批/验证/内存的 SQLite 持久化、会话级安全清除，以及中断会话与待审批项的恢复处理；不持久化原始 patch 或 API key。
- TDD 事实：针对结构化赋值、转义片段、引号/注释/URL 边界、Bearer 边界、截断/幂等性、物理 SQLite 字节和错误契约先补 RED 用例。代表性 RED 为已知前缀转义尾部 3 项失败、注释分隔 Bearer 8 项失败、错误契约 1 项失败；随后以最小实现修复。
- 脱敏边界：可可靠解析的合法语法仅替换敏感值并保留相邻安全文本；全局引号/转义无法可靠分段，或敏感候选无法安全解析时，整段输入替换为 `[REDACTED]`。DB、journal、WAL 和 SHM 均纳入字节扫描。
- 错误与完整性：持久化错误码以不可写、不可配置的自有属性公开；repository 对 session/action/approval/verification/memory/recovery 的因果与顺序完整性 fail closed。
- 最终检查：focused redaction/repository/error 为 418/418；六个 Task 9 persistence 测试文件为 491/491；全量 `npm test` 为 26 files、907 passed、6 skipped；`npm run typecheck`、`npm run lint`、`npm run build` 和 `git diff --check` 均 exit 0。
- 独立复核：最终规格/质量和安全/错误契约两次复核均为 Ready，Critical/Important/Minor 均为 0；复验原始及 escaped token 尾部、注释分隔 Bearer、SQLite 全部旁文件字节，以及运行时错误码不可变性。
- 本地提交：`7f9cc43` 至 `36fa320` 的 Task 9 提交均只在本地分支；未调用真实 Provider、network 或 credentials，未推送、创建 PR 或合并。

## 2026-08-01 — SUBMISSION-MATERIALS：课程交付清单审计

- 资料依据：`作业要求/通用要求.md` §4.7–§5 与 `AI4SE_Final_Project_A_Coding_Agent_Harness.md` §A.6–§A.7。
- 审计结果：代码、`SPEC.md`、`PLAN.md`、`SPEC_PROCESS.md` 与 `AGENT_LOG.md` 已存在；根目录缺少 README、REFLECTION、`.gitlab-ci.yml`、GitHub Actions、分发配置和公开 WebUI 演示入口。
- 计划：在隔离分支 `feat/submission-materials` 补齐材料，增加无凭据、无网络的 React Mock WebUI 和机制演示；真实 Provider、真实 Key、本地工作区和任意远程执行不进入公开演示。
- 人工责任：`REFLECTION.md` 仅提供学生可编辑初稿，提交前必须由学生本人核对、重写并标注 AI 辅助润色；线上 URL 只有在 Pages 工作流实际发布后才记录。

## 2026-08-01 — SUBMISSION-MATERIALS：WebUI、演示与交付文件

- TDD：先新增 `apps/web/src/App.test.tsx`，确认缺失 `App` 时 RED；实现无凭据 React Mock UI 后 focused test 为 1/1，Vite build 成功。
- 机制演示：先新增 `tests/mechanism-demo.test.ts`，确认脚本缺失时 RED；`scripts/mechanism-demo.ts` 现在输出护栏拒绝、失败反馈和审批基线绑定三条离线证据。
- 交付配置：新增 GitHub Actions、课程要求的 `.gitlab-ci.yml`（含 `unit-test`）、GitHub Pages 静态发布工作流、静态演示 Dockerfile 与 `.dockerignore`。
- 文档：新增 `README.md` 和 `REFLECTION.md` 初稿；README 明确区分本地 API 与公开 Mock 演示；反思必须由学生本人重写后提交。
- 实现提交：WebUI `30a383c`；机制演示 `26134cf`；CI/Pages/容器 `eb25700`；材料计划 `b004ee0`。

## 2026-08-01 — SUBMISSION-MATERIALS：本地最终验证与稳定性修正

- 稳定性修正（提交 `93e93f8`、`4df599d`）：Vitest 设置 4 个 worker、15 秒测试/钩子超时；脱敏 65 KiB 墙钟压力用例使用与相邻用例一致的 500ms 环境容差；SQLite 外部锁测试将持锁时间从 1.5 秒延长到 4 秒，避免共享 runner 调度竞态。输出、安全断言和失败关闭语义未改变。
- 干净安装：`npm ci --ignore-scripts --no-audit --no-fund` 成功安装 300 个包；仅有已存在的 `whatwg-encoding` 弃用警告。
- 本地验证：`npm test` 为 38 个文件、1005 passed、6 skipped；`npm run typecheck`、`npm run build`、`npm run lint`、`npm run web:build` 和 `npm run demo:mechanisms` 均通过；机制演示输出 deny/feedback/approval 三条稳定证据。
- 材料检查：所需 `SPEC.md`、`PLAN.md`、`SPEC_PROCESS.md`、`AGENT_LOG.md`、`README.md`、`REFLECTION.md`、`.gitlab-ci.yml`、GitHub Actions、Dockerfile 均存在；反思初稿 2361 字符，提交前仍由学生本人核对、重写并标注 AI 辅助范围。
- 安全扫描：无受跟踪 `.env` 文件；私钥、长 `ghp_`/`sk-` 模式命中 0；演示不读取真实凭据、不连接 Provider、不运行工作区代码。
- 分发边界：已修正 Dockerfile 中不存在的根级 Vite 配置引用。`docker build` 未能执行，因为本机 Docker Desktop Linux daemon 未启动（`dockerDesktopLinuxEngine` pipe 不存在）；未启动或停止任何本任务长驻进程。
- 线上状态：GitHub Actions CI 与 Pages 尚未以本分支实际运行，故没有虚构 pass 记录或 Pages URL；合并并成功发布后再把真实 URL 写入 README 和提交材料。
- 远程同步尝试：匿名 `git ls-remote` 可读取 `main`；本地 `git push` 因 `gh` 未登录且 HTTPS 无交互终端失败；已授权 GitHub connector 读取仓库但创建 ref 返回 API 403。没有修改远程 `main`，没有创建空 PR，也没有发送任何凭据。
- 条款补齐：课程要求容器分发时 CI 构建镜像；已在 `.github/workflows/ci.yml` 的 `unit-test` job 增加 `docker build --pull=false --tag codesentinel-mock-demo:ci .`，并同步 README 说明。当前本机 Docker daemon 未启动，因此该步骤待远程 Actions 实际执行确认。

## 2026-08-01 — CI-004：按目标平台修正 GitHub Actions runner

- 触发：PR #4 的 Ubuntu `unit-test` 中 `packages/tools/src/verification.test.ts` 有 72 项失败，统一返回 `spawn_failed / VERIFICATION_LAUNCHER_UNAVAILABLE`；其余测试通过。
- 根因：项目目标为 Windows x64，受控 runner 和测试按 Windows Node 布局解析 npm CLI；Ubuntu toolcache 使用 `lib/node_modules/npm` 布局，未满足当前安全解析契约。
- 修正：经批准后将完整 `unit-test` job 改为 `windows-latest`；把 Docker 镜像构建拆为独立 Ubuntu `container-build` job，避免改变受控 launcher 的安全规则。

## 2026-08-01 — CI-005：规范 Windows 临时目录的规范路径

- 触发：新的 Windows PR 运行中 `verification.test.ts` 已全部通过，但 7 个 workspace 路径安全断言失败；失败日志显示 fixture 使用 `C:\Users\RUNNER~1\...` 短路径，而 `realpath()` 返回 `C:\Users\runneradmin\...` 长路径。
- 根因：runner 继承的 `TEMP`/`TMP` 别名使测试 fixture 路径与规范路径不一致，依赖 fixture 字符串的竞态模拟因此没有触发。
- 修正：在 Windows job 开始阶段将 `TEMP` 和 `TMP` 统一为 `USERPROFILE\AppData\Local\Temp` 的长路径；不修改路径校验实现或安全契约。
- 验证：重新运行 Windows unit-test，确认 1,011 个 Vitest 用例、typecheck、lint 和 WebUI build 全部通过。

## 2026-08-01 — CI-006：启用 Pages 并完成公开发布

- 触发：PR #4 合并后的 Pages 构建和 artifact 上传成功，但 deploy job 因仓库尚未启用 Pages 返回 404。
- 修正：将仓库 Pages source 设置为 GitHub Actions，并重跑发布 workflow。
- 验证：Publish Mock WebUI 的 build/deploy 两个 job 均成功；公开 URL 为 `https://kadsoo.github.io/CodeSentinel/`。页面只发布无凭据 Mock WebUI，不连接 Provider、不读取本地工作区。
