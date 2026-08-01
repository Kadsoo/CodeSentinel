# CodeSentinel

CodeSentinel 是一个面向程序员的、本地优先的 Coding Agent Harness。它把 Agent 的动作限制在显式工作区、受控验证命令和人工批准流程内，并把策略判定、测试反馈、审批和脱敏时间线保存为可审查证据。

## 课程交付状态

本仓库对应 AI4SE Final Project A：Coding Agent Harness。`SPEC.md`、`PLAN.md`、`SPEC_PROCESS.md` 和 `AGENT_LOG.md` 记录设计、计划、冷启动验证与实现过程；每个功能批次保留独立 commit/PR 历史。

公开 Mock WebUI 会由 GitHub Pages 工作流发布。首次 Pages 工作流成功后，将实际 URL 写入本节；在此之前不要把预期地址当作已部署地址。

## 为什么值得使用

给 CodeSentinel 一个失败测试修复任务，它会在受控工作区中运行预配置验证命令，向 Provider 请求一个结构化 Action，经过 Policy Guardrail 后执行读取、搜索或验证；任何源码写入都先生成 diff，必须由用户批准后才会应用。失败摘要会脱敏并回灌到下一轮，最多运行三轮。

首版刻意不提供任意 shell、任意网络访问、自动 Git 发布、删除数据或绕过审批的写入能力。

## 核心能力

- 自研 Agent Loop：上下文裁剪、单 Action 解析、Policy 决策、工具分发、反馈回灌和有界停机。
- 治理护栏：工作区边界、敏感路径、命令白名单、补丁内容哈希与基线哈希、人工审批状态机。
- 本地持久化：SQLite 会话、Action、审批、验证和时间线记录；公开文本在持久化前脱敏。
- Provider 抽象：Scripted Mock、DeepSeek 兼容 Provider、NJU SE Hub 兼容 Provider。
- 安全凭据：CLI 只在明确请求凭据或启动本地服务时加载 Windows Credential Manager；终端只显示状态，不回显 Key。
- 本地回环 API：固定监听 `127.0.0.1:48761`，不绑定公网网卡。
- 无凭据公开演示：`apps/web` 只渲染预置 Mock 机制证据，不读取本地文件、不运行命令、不接收 Key。

## 环境要求

- Windows x64 是本地 CLI 和 Windows Credential Manager 的目标平台。
- Node.js `22.17.0`。
- npm `10.9.2`。
- 真实 Provider 需要用户自行准备对应账号和 Key；公开演示不需要 Key。

## 安装与测试

```bash
npm ci
npm test
npm run typecheck
npm run lint
npm run build
npm run demo:mechanisms
```

`npm run demo:mechanisms` 完全离线运行，并输出三条稳定证据：危险 Action 被拒绝且工具调用为零；失败验证反馈驱动下一步改为 `propose_patch`；补丁只有在匹配基线并完成审批后才进入 approved 状态。

## 本地 Mock WebUI

```bash
npm run web:build
npm run web:dev
```

Vite 会启动本地静态演示。生产构建位于 `apps/web/dist`。该页面是公开安全演示，不连接真实 API，不接收工作区路径，不保存浏览器凭据，也不会执行访问者提交的代码。

## 本地 API 与 CLI

启动本地 API（需要 Windows Credential Manager 可用）：

```bash
npm exec -- tsx apps/cli/src/main.ts start
```

API 只监听 `127.0.0.1:48761`。健康检查：

```bash
curl http://127.0.0.1:48761/health
```

CLI 帮助和凭据命令：

```bash
npm exec -- tsx apps/cli/src/main.ts --help
npm exec -- tsx apps/cli/src/main.ts credentials set deepseek-default --provider deepseek --model deepseek-v4-flash
npm exec -- tsx apps/cli/src/main.ts credentials status deepseek-default
npm exec -- tsx apps/cli/src/main.ts credentials probe deepseek-default
npm exec -- tsx apps/cli/src/main.ts credentials clear deepseek-default
```

`credentials set` 使用隐藏输入读取 Key；`status` 只输出 `configured` 或 `missing`；`clear` 先删除系统凭据，再删除本地 Profile。DeepSeek 的 endpoint 固定为官方兼容地址；NJU SE Hub 必须显式提供 HTTPS endpoint。

## 分发

### 静态 Mock 演示容器

容器只承载无凭据静态演示，不承载本地 Agent、SQLite 或 Windows Credential Manager：

```bash
docker build -t codesentinel-mock-demo .
docker run --rm -p 8080:80 codesentinel-mock-demo
```

打开 `http://localhost:8080`。镜像不会复制 `.env`、数据库、日志、工作区或 `node_modules`。

### GitHub Pages

`.github/workflows/pages.yml` 会在 `main` push 后构建 `apps/web/dist` 并发布到 GitHub Pages。首次使用需要仓库管理员在 Settings → Pages 中将 Source 设为 GitHub Actions；只有 workflow 成功后才能把 Actions 输出的 `page_url` 作为课程提交 URL。

## 目录结构

```text
packages/contracts   共享 Action、事件、配置和错误契约
packages/core        自研 Agent Loop、反馈和停机
packages/policy      路径/命令护栏与审批状态机
packages/tools       工作区读取、补丁和验证工具
packages/providers   Mock、兼容 Provider、凭据抽象
packages/persistence SQLite repository 与脱敏
packages/host        Profile、Workspace、Session 服务
apps/api             Fastify 本地回环 API
apps/cli             CLI、Keytar 动态加载和本地服务启动
apps/web             无凭据 React/Vite Mock WebUI
scripts              离线机制演示
docs/superpowers     设计与实现计划
```

## 安全边界

- API Key 不进入源代码、Git 历史、SQLite、日志、终端回显或公开演示。
- Provider 只接收经上下文策略允许的脱敏片段；公开演示永远使用 Mock 数据。
- Action 先经过 Schema 和 Policy；危险路径、敏感文件、未知命令、网络和发布默认拒绝。
- `propose_patch` 只产生候选 diff；`apply_approved_patch` 需要一次性审批、精确 patch hash 和未变化的 base hash。
- 验证命令来自 `codesentinel.json`，以无 shell 的受控 launcher 启动，并有超时和输出上限。

## CI 与验证记录

GitHub Actions 的 `unit-test` job 在 push/PR 上运行 `npm ci`、`npm test`、机制演示、typecheck、lint 和 WebUI build。`.gitlab-ci.yml` 同样提供课程要求的 `unit-test` job。提交作业前，请在目标 NJU Git 仓库或镜像仓库中确认最后一次 CI/CD 记录为 pass，并将记录链接写入提交说明。

## 已知限制

- 本地 API 面向单机 Windows 开发环境，不是可公开执行任意代码的 SaaS。
- SQLite 和 `keytar` 含原生依赖；新机器需要按 Node/npm 版本和操作系统完成安装冒烟测试。
- GitHub Pages 只展示 Mock 事件，不能操作用户本地工作区，也不能替代本地 API。
- 复杂真实项目的修复成功率不属于安全承诺；系统承诺的是可限制、可审查、可反馈的工作流。

## 参考与许可证

产品交互和模块边界参考 OpenCode 的公开使用形式，但 CodeSentinel 不调用或包装 OpenCode 的 Agent Runner。项目使用的第三方包及其许可证以 npm lockfile 和各包元数据为准；提交前应根据课程要求补充完整的许可证清单。
