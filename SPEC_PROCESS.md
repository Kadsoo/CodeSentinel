# CodeSentinel 规格形成过程

> 本文只记录实际发生的协作与决策；不补写不存在的 Agent 输出、测试或人工操作。

## 1. 上下文与方法

- 项目选择：AI4SE Final Project A — Coding Agent Harness。
- 仓库：Kadsoo/CodeSentinel，设计开始时为公开空仓库。
- 主开发 Agent：Codex；设计阶段使用 Superpowers brainstorming 与 writing-plans 方法。
- 课程要求的 brainstorming 技能在初始环境未暴露；在开始正式规格阶段前已从官方 obra/superpowers 安装。此偏差和修正将在 AGENT_LOG.md 中如实记录。

## 2. 关键迭代节选与决策

### 迭代一：确定项目方向

用户决策：“A，程序员编程时使用”。

处理：选择 Coding Agent Harness，而非普通应用项目。由此产生必须自研主循环、工具分发、记忆、治理、反馈、配置，并使用 Mock LLM 可确定性测试的约束。

### 迭代二：从宽泛目标收敛为可验收场景

用户最初要求：“通用两者都做”，即既支持修复失败测试也支持实现小功能；随后将最关键答辩场景确定为：“修复一个给定的失败测试”。

处理：保留测试修复和小功能实现两类任务，但将前者作为内置样例和答辩主流程。后者被限制为必须提供验收描述与验证命令，避免无边界“自动开发整个项目”。

### 迭代三：确定安全控制权

用户确认：“源码写入默认必须人工批准”，以及“三轮上限”。

处理：将治理而非提示词设为主贡献：LLM 只能提出结构化补丁；Policy Guardrail 先判定；UI 中的本地人工批准与补丁/基线哈希绑定后才允许写盘；测试反馈循环至多三轮。

### 迭代四：参考对象与技术形态

用户提出：“我想参考 opencode 的实现形式”。

处理：研究 OpenCode 的会话、工具、权限和 diff/反馈交互；采用“OpenCode 风格的精简本地 Agent Workbench”，但明确不调用、包装或复制 OpenCode 的 agent runner，以满足本课程 A 方向的自研内核边界。

### 迭代五：Provider、隐私、演示和分发

用户指定 NJU SE Hub 与 DeepSeek 官方平台，确认内置可复现故障样例、真实工作区为可选能力、Windows x64 + npm 分发，以及本地 SQLite/敏感文件永不上传的默认隐私策略。

处理：设计可切换 Provider Adapter 和 Scripted Mock；Key 只进 Windows Credential Manager；公开线上演示只使用 Mock 与内置样例，不接收真实工作区、Key 或任意代码。

## 3. AI 建议的采纳与修正

- 已采纳：以“安全治理 + 测试反馈闭环”作为 main contribution；内置失败样例使答辩与 CI 可重复；本地优先运行与线上 Mock 演示兼顾安全和 WebUI 要求。
- 已修正：最初提出 Python/FastAPI 方案，在用户要求参考 OpenCode 形态后改为 TypeScript + Node.js 22、CLI + React WebUI。
- 未采纳：完整复刻 OpenCode 的 TUI、MCP、多 Agent 和任意命令能力。原因是范围过大，且会弱化自研、可验证的治理机制。

## 4. Brainstorming 反思（当前阶段）

逐轮确认使“支持通用编程任务”的模糊目标收敛为可测试的失败测试修复流程，并把“用户控制权”转化为可实现的审批状态机。当前仍需通过陌生 Agent 冷启动来验证：规格是否足以让没有对话上下文的 Agent 正确实现一个最小任务。冷启动发现的问题、修订前后 diff 与最终反思将在该验证完成后补充；本文件不会提前虚构结果。

## 5. 书面规格批准与计划生成

项目所有者明确回复“批准 SPEC”。随后依据已批准的规格生成根目录 PLAN.md：它将实现拆分为 13 个可独立验证的任务，明确文件路径、依赖、先失败后通过的测试、提交边界、并行关系和冷启动协议。计划尚未进入实现；下一步必须由不同 Agent 类型在没有本次对话历史的情况下，仅凭 SPEC.md 与 PLAN.md 尝试 Task 1 和 Task 2。

## 6. 冷启动验证、发现与修订

为满足隔离要求，先在主检出中仅加入 `.worktrees/` 忽略规则并提交；随后创建未合并的 `cold-start-validation` 分支和 `.worktrees/cold-start-validation` 一次性工作树。不同类型的 `codex-auto-review` Agent 没有本次对话历史，只获得该工作树中 `SPEC.md` 与 `PLAN.md` 的绝对路径，且被明确限制不得读取 AGENT_LOG、课程文档或仓库历史。

它在 Task 1 的 Step 1 成功创建了计划规定的 `packages/contracts/src/id.test.ts`，并执行 `npm test -- --run packages/contracts/src/id.test.ts`。该命令按预期失败：根目录尚不存在 `package.json`（ENOENT）；npm 还报告无法向用户缓存目录写日志。它在 Step 3 前停止，没有尝试 Task 2、没有提交，也没有改动任何其他工作树。

停止原因是有效的规格歧义：Task 1 列出了依赖名，却没有说明每个精确版本、npm 版本或 lockfile 策略；在没有这些信息时选择版本属于猜测。处理时查询了 npm 官方注册表及本机工具链，确认开发基线为 Node.js 22.17.0 / npm 10.9.2；同时发现 jsdom 30 需要更高的 Node 22.22.2，故采用兼容的 jsdom 27.3.0，并选用与 `typescript-eslint@8.65.0` 兼容的 `typescript@5.9.3`。

据此修订：SPEC.md 第 9 节增加精确运行时、npm 与 lockfile 原则；PLAN.md 增加依赖版本不可隐式漂移的执行不变量，并在 Task 1 写明根 package.json、精确运行时/开发依赖清单、npm lockfile v3、`npm ci` 策略、TypeScript/Vitest/ESLint 配置和 `.gitignore` 内容。该冷启动工作树中的测试文件保持可丢弃状态，不会合并到 main。修订后将以新的无上下文 Agent 再次复核 Task 1 与 Task 2。

## 7. 第二次冷启动与环境阻塞证据

第二个无上下文、不同类型的 `gpt-5.6-terra` Agent 只读取第二个可丢弃工作树中的 SPEC.md 与 PLAN.md。它没有发现 Task 1 或 Task 2 的实现歧义：准确创建了 Task 1 所列根清单、TypeScript/Vitest/ESLint 配置、私有 contracts 包、`.gitignore`、`id.ts` 与测试；在 `npm test -- --run packages/contracts/src/id.test.ts` 得到计划预期的初始 ENOENT 红灯后，按照精确工具链开始安装。

但 `npm install` 两次在约两分钟后超时，未生成 `package-lock.json` 或 `node_modules`，因此无法运行 Task 1 的绿灯检查，也不能开始依赖 Task 1 的 Task 2。随后在同一可丢弃工作树中以 `--ignore-scripts --no-audit --no-fund` 进行受控诊断；npm 日志记录多个 npm 官方 registry GET 请求出现 `ECONNRESET` 与 `ETIMEDOUT`，最终报出 `Exit handler never called!` 并以非零状态退出。禁用脚本时同样失败，故证据不支持把问题归因于 keytar 或 better-sqlite3 的原生构建。

该轮没有提交、推送、合并或调用任何真实 Provider。结论是：修订后的文档对 Task 1–2 没有新规格歧义，但当前环境到 npm registry 的批量依赖安装不稳定，阻止了必须真实通过的基线验证。保留两个忽略的冷启动工作树及其诊断日志作为过程证据；正式实现应在 `npm install` 成功并生成锁文件后恢复，不能虚报测试通过。
