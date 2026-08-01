import type { ReactNode } from "react";

type DemoEvent = Readonly<{
  label: string;
  detail: string;
  tone: "safe" | "warning" | "neutral";
}>;

const demoEvents: readonly DemoEvent[] = [
  {
    label: "Policy Guardrail",
    detail: "危险命令被拒绝：POLICY_DENIED；工具调用次数：0",
    tone: "warning",
  },
  {
    label: "Verification",
    detail: "第 1 轮测试失败：expected 2, received 1；输出已脱敏为 [REDACTED]",
    tone: "neutral",
  },
  {
    label: "Feedback loop",
    detail: "失败反馈已进入下一轮；下一步动作：propose_patch",
    tone: "safe",
  },
  {
    label: "Human approval",
    detail: "补丁必须绑定审批状态和基线哈希后才能写入",
    tone: "safe",
  },
];

function EvidenceCard({ title, children, tone = "neutral" }: Readonly<{ title: string; children: ReactNode; tone?: DemoEvent["tone"] }>) {
  return (
    <article className={`evidence-card evidence-card--${tone}`}>
      <h3>{title}</h3>
      <p>{children}</p>
    </article>
  );
}

export function App() {
  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">AI4SE · Coding Agent Harness</p>
          <h1>CodeSentinel</h1>
          <p className="lede">
            用确定性的治理、反馈和人工审批，把 Coding Agent 限制在可审查的工作区内。
          </p>
        </div>
        <div className="status-pill" aria-label="演示状态">
          <span className="status-dot" />
          Mock session · offline
        </div>
      </header>

      <section className="notice" aria-label="公开演示边界">
        <strong>公开演示不会读取或接收 API Key</strong>
        <span>本页面只展示预置事件，不访问本地文件、不执行命令、不连接真实 Provider。</span>
      </section>

      <section className="grid" aria-label="会话概览">
        <article className="panel session-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">SESSION / MOCK-001</p>
              <h2>失败测试修复</h2>
            </div>
            <span className="state-badge">completed</span>
          </div>
          <dl className="facts">
            <div><dt>工作区</dt><dd>fixture/failing-project</dd></div>
            <div><dt>Provider</dt><dd>ScriptedMockProvider</dd></div>
            <div><dt>轮次</dt><dd>2 / 3</dd></div>
            <div><dt>凭据状态</dt><dd>不适用（Mock）</dd></div>
          </dl>
        </article>

        <article className="panel contribution-panel">
          <p className="eyebrow">MAIN CONTRIBUTION</p>
          <h2>治理护栏 + 反馈闭环</h2>
          <div className="evidence-stack">
            <EvidenceCard title="默认拒绝" tone="warning">危险 Action 被代码策略拦截，而不是依赖提示词服从。</EvidenceCard>
            <EvidenceCard title="客观反馈" tone="safe">失败测试摘要回灌给下一轮，驱动动作从验证转为补丁提议。</EvidenceCard>
          </div>
        </article>
      </section>

      <section className="panel timeline-panel" aria-labelledby="timeline-title">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">AUDIT TIMELINE</p>
            <h2 id="timeline-title">可验证的机制证据</h2>
          </div>
          <span className="round-count">4 events</span>
        </div>
        <ol className="timeline">
          {demoEvents.map((event, index) => (
            <li className="timeline-item" key={event.label}>
              <span className={`timeline-marker timeline-marker--${event.tone}`}>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h3>{event.label}</h3>
                <p>{event.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <footer className="footer">
        <span>Local-first · no remote execution · secrets stay in the OS credential store</span>
        <span>CodeSentinel public Mock demo</span>
      </footer>
    </main>
  );
}
