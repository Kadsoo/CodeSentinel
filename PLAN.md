# CodeSentinel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build a Windows-local, OpenCode-inspired coding-agent harness that safely repairs a configured failing test or implements a small verified feature through structured actions, deterministic policy guardrails, human patch approval, and feedback-driven retries.

**Architecture:** An npm workspace separates shared contracts, policy, tools, provider adapters, persistence, and the self-authored agent loop. A local Fastify API and CLI expose the harness to a React WebUI; only the backend owns filesystem and process access. A Scripted Mock Provider drives all mechanism tests, while DeepSeek and NJU SE Hub adapters remain optional runtime integrations.

**Tech Stack:** Node.js 22, TypeScript, npm workspaces, Vitest, Zod, Fastify, React/Vite, SQLite, keytar-compatible Windows Credential Manager adapter, and GitHub Actions.

---

## Execution invariants

- Do not call a real LLM in unit, integration, CI, or mechanism-demonstration tests.
- Write the named failing test before each behavior change; record the red result before writing the minimum implementation.
- Run commands without a shell. Never construct a shell string from an LLM action.
- Do not add an action or tool beyond the actions defined in SPEC.md.
- Pin every direct npm dependency to the exact version named in Task 1 (no `^` or `~`) and commit the npm-generated package-lock.json; only a documented plan revision may change that baseline.
- Update PLAN.md with the completed task and its commit hash immediately after every merged task.
- Each implementation task gets a separate worktree, branch, pull request, spec-compliance review, and code-quality review.

## Planned file layout

| Path | Responsibility |
|---|---|
| package.json, tsconfig.json, vitest.config.ts | Root workspace, scripts and quality gates. |
| packages/contracts/src | Zod schemas and shared domain types; no filesystem, process, database, or provider dependency. |
| packages/policy/src | Path/command policy evaluation and approval state machine. |
| packages/tools/src | Controlled workspace reads, patch application and verification process runner. |
| packages/providers/src | Provider interface, deterministic scripted mock, OpenAI-compatible provider, credential-store abstraction. |
| packages/core/src | Context assembly, loop state machine, action dispatch, retry and stop rules. |
| packages/persistence/src | SQLite session repository and log redaction. |
| apps/api/src | Local Fastify routes that join the harness components. |
| apps/cli/src | CLI startup, credential management and local server lifecycle. |
| apps/web/src | React task, timeline, diff and approval interface. |
| fixtures/failing-project | Deliberately faulty sample project used only by controlled integration tests and demo. |
| scripts/mechanism-demo.ts | Repeatable Mock Provider demonstration for the three mandatory harness behaviors. |
| .github/workflows/ci.yml, .gitlab-ci.yml | Primary GitHub CI and compatible unit-test job. |

## Dependency and parallelism map

~~~text
Task 1 → Task 2
Task 2 → Tasks 3, 4, 7, 9
Task 3 → Tasks 5, 6
Tasks 4, 5, 6, 7 → Task 8
Tasks 8, 9 → Task 10
Tasks 8, 10 → Task 11
Task 10 → Task 12
Tasks 10, 11, 12 → Task 13
~~~

Tasks 3, 4, 7 and 9 can use separate worktrees after Task 2 is merged. Tasks 5 and 6 can run in parallel after Task 3. No task may start until all listed dependencies are merged and their test baseline is green.

### Task 1: Create the TypeScript workspace and deterministic test baseline

**Dependencies:** None.

**Files:**
- Create: package.json
- Create: package-lock.json
- Create: tsconfig.json
- Create: vitest.config.ts
- Create: eslint.config.mjs
- Create: packages/contracts/package.json
- Create: packages/contracts/src/id.ts
- Create: packages/contracts/src/id.test.ts
- Create: .gitignore

- [x] **Step 1: Write the failing identifier contract test**

~~~ts
import { describe, expect, it } from "vitest";
import { createId } from "./id.js";

describe("createId", () => {
  it("returns a non-empty UUID-shaped identifier", () => {
    expect(createId()).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
~~~

- [x] **Step 2: Run the test to record the red baseline**

Run: npm test -- --run packages/contracts/src/id.test.ts
Expected: FAIL because the workspace scripts and module packages do not yet exist.

- [x] **Step 3: Add the smallest workspace configuration and identifier implementation**

Use exactly Node.js 22.17.0 with its bundled npm 10.9.2. The root `package.json` is private, ESM, has `name: "codesentinel-workspace"`, `packageManager: "npm@10.9.2"`, `engines: { node: "22.17.0", npm: "10.9.2" }`, and `workspaces: ["packages/*", "apps/*"]`. Its initial scripts are exactly `test: "vitest run"`, `lint: "eslint ."`, `typecheck: "tsc --noEmit"`, `build: "tsc --noEmit"`, and `demo: "tsx scripts/mechanism-demo.ts"`. Task 12 will replace the initial build script with the WebUI build pipeline before its `npm run build` check.

Install the following direct runtime dependencies with the exact values shown: `better-sqlite3@13.0.1`, `commander@15.0.0`, `diff@9.0.0`, `fastify@5.10.0`, `keytar@7.9.0`, `react@19.2.8`, `react-dom@19.2.8`, and `zod@4.4.3`. Install these exact development dependencies: `@eslint/js@10.0.1`, `@testing-library/dom@10.4.1`, `@testing-library/react@16.3.2`, `@testing-library/user-event@14.6.1`, `@types/better-sqlite3@7.6.13`, `@types/node@22.17.0`, `@types/react@19.2.17`, `@types/react-dom@19.2.3`, `@vitejs/plugin-react@6.0.4`, `eslint@10.8.0`, `jsdom@27.3.0`, `tsx@4.23.1`, `typescript@5.9.3`, `typescript-eslint@8.65.0`, `vite@8.1.5`, and `vitest@4.1.10`. Use exact entries (no version range) in package.json, run `npm install` once to generate npm lockfile version 3, and commit the generated package-lock.json. All later CI and clean-install checks use `npm ci`, never `npm install`.

Create `tsconfig.json` with ESM `module` and `moduleResolution` both set to `NodeNext`, `target: "ES2022"`, `jsx: "react-jsx"`, `strict: true`, `noEmit: true`, `skipLibCheck: true`, and an include list covering `packages/**/*.ts`, `apps/**/*.ts`, `apps/**/*.tsx`, `scripts/**/*.ts`, `tests/**/*.ts`, and `vitest.config.ts`. Create `vitest.config.ts` with the test include patterns `packages/**/*.test.ts`, `apps/**/*.test.ts`, `apps/**/*.test.tsx`, and `tests/**/*.test.ts`. Future app web tests must declare `/** @vitest-environment jsdom */` at the top of each file. Create `eslint.config.mjs` using `@eslint/js` recommended rules and `typescript-eslint` recommended rules, ignoring `node_modules`, `dist`, `coverage`, `.worktrees`, `fixtures/**/node_modules`, and generated database/log files. Set `packages/contracts/package.json` to a private ESM package named `@kadsoo/codesentinel-contracts`.

Implement:

~~~ts
import { randomUUID } from "node:crypto";

export function createId(): string {
  return randomUUID();
}
~~~

Add a .gitignore that excludes `.worktrees/`, node_modules, dist, coverage, `.env*`, *.db, *.sqlite, *.log, and local credential export files, while allowing `!.env.example`.

- [x] **Step 4: Run the focused and whole baseline checks**

Run: npm test -- --run packages/contracts/src/id.test.ts
Expected: PASS.
Run: npm run typecheck
Expected: PASS.
Run: npm test
Expected: PASS with one test.

- [x] **Step 5: Commit**

Run:

~~~bash
git add package.json package-lock.json tsconfig.json vitest.config.ts eslint.config.mjs .gitignore packages/contracts
git commit -m "chore: establish TypeScript test workspace"
~~~

Completed locally: implementation commit `6e0176fb35fbadc7e39acd57888efa64c05b86a5`; reviewed and merged into main by `83cf0b1`.

### Task 2: Define and validate shared harness contracts

**Dependencies:** Task 1.

**Files:**
- Create: packages/contracts/src/action.ts
- Create: packages/contracts/src/config.ts
- Create: packages/contracts/src/events.ts
- Create: packages/contracts/src/index.ts
- Create: packages/contracts/src/action.test.ts
- Create: packages/contracts/src/config.test.ts

- [ ] **Step 1: Write failing schema tests**

~~~ts
import { describe, expect, it } from "vitest";
import { ActionSchema } from "./action.js";
import { CodeSentinelConfigSchema } from "./config.js";

describe("ActionSchema", () => {
  it("accepts one structured patch proposal", () => {
    expect(ActionSchema.parse({
      kind: "propose_patch",
      path: "src/math.ts",
      baseHash: "a".repeat(64),
      patch: "@@ -1 +1 @@\n-export const add = () => 0;\n+export const add = () => 2;",
      reason: "Fix incorrect addition",
    }).kind).toBe("propose_patch");
  });

  it("rejects an arbitrary shell field", () => {
    expect(() => ActionSchema.parse({ kind: "shell", command: "rm -rf /" })).toThrow();
  });
});

describe("CodeSentinelConfigSchema", () => {
  it("requires executable and argument-array verification commands", () => {
    expect(() => CodeSentinelConfigSchema.parse({
      verificationCommands: [{ id: "test", command: "npm test" }],
    })).toThrow();
  });
});
~~~

- [ ] **Step 2: Run the focused tests to record red**

Run: npm test -- --run packages/contracts/src/action.test.ts packages/contracts/src/config.test.ts
Expected: FAIL because ActionSchema and CodeSentinelConfigSchema do not exist.

- [ ] **Step 3: Implement the exact domain contracts**

Define Zod discriminated-union actions: list_files, read_file, search_text, propose_patch, apply_approved_patch, run_verification and finish. Define TaskKind as test_repair or feature_implementation; PolicyDecision as allow, ask or deny; SessionState as created, running, awaiting_approval, completed, blocked, failed or stopped. Define configuration verification commands as id, executable, args, timeoutMs and maxOutputBytes. In events.ts define EventSink with append(event): Promise<void>, so core can emit events without depending on SQLite. Export all public types only through index.ts.

- [ ] **Step 4: Run contract checks**

Run: npm test -- --run packages/contracts/src/action.test.ts packages/contracts/src/config.test.ts
Expected: PASS.
Run: npm run typecheck
Expected: PASS.

- [ ] **Step 5: Commit**

Run:

~~~bash
git add packages/contracts
git commit -m "feat: define validated harness contracts"
~~~

### Task 3: Implement deterministic path and command policy decisions

**Dependencies:** Task 2.

**Files:**
- Create: packages/policy/package.json
- Create: packages/policy/src/guardrail.ts
- Create: packages/policy/src/path-policy.ts
- Create: packages/policy/src/command-policy.ts
- Create: packages/policy/src/index.ts
- Create: packages/policy/src/guardrail.test.ts

- [ ] **Step 1: Write failing guardrail tests**

~~~ts
import { describe, expect, it } from "vitest";
import { evaluateAction } from "./guardrail.js";

const context = {
  workspaceRoot: "C:/repo",
  config: { allowedPaths: ["src/**"], verificationCommands: [] },
};

describe("evaluateAction", () => {
  it("denies a sensitive .env read", () => {
    expect(evaluateAction({ kind: "read_file", path: ".env" }, context))
      .toMatchObject({ decision: "deny", reason: "SENSITIVE_PATH" });
  });

  it("denies a path outside the workspace", () => {
    expect(evaluateAction({ kind: "read_file", path: "../secret.txt" }, context))
      .toMatchObject({ decision: "deny", reason: "OUTSIDE_WORKSPACE" });
  });

  it("asks before a valid patch proposal", () => {
    expect(evaluateAction({
      kind: "propose_patch",
      path: "src/math.ts",
      baseHash: "a".repeat(64),
      patch: "@@ -1 +1 @@\n-a\n+b",
      reason: "repair",
    }, context)).toMatchObject({ decision: "ask" });
  });

  it("denies an unconfigured verification command", () => {
    expect(evaluateAction({ kind: "run_verification", commandId: "publish" }, context))
      .toMatchObject({ decision: "deny", reason: "UNKNOWN_COMMAND" });
  });
});
~~~

- [ ] **Step 2: Run the guardrail test to record red**

Run: npm test -- --run packages/policy/src/guardrail.test.ts
Expected: FAIL because evaluateAction is missing.

- [ ] **Step 3: Implement default-deny policy**

Implement path normalization that rejects absolute foreign paths, parent traversal, symlink escape, .env, .git, node_modules, binary extensions and configured sensitive patterns. Allow only configured verification command ids, and only when executable and args exactly match config. Return immutable decision objects with reason codes SENSITIVE_PATH, OUTSIDE_WORKSPACE, UNKNOWN_COMMAND, PATCH_REQUIRES_APPROVAL or ALLOWED. Export a Policy interface with evaluate(action, context), and createPolicy(context) as the adapter used by the core loop; evaluateAction remains the pure function used by unit tests.

- [ ] **Step 4: Verify policy behavior**

Run: npm test -- --run packages/policy/src/guardrail.test.ts
Expected: PASS.
Run: npm test
Expected: PASS.

- [ ] **Step 5: Commit**

Run:

~~~bash
git add packages/policy
git commit -m "feat: add default-deny action guardrail"
~~~

### Task 4: Implement the patch approval state machine

**Dependencies:** Task 2.

**Files:**
- Create: packages/policy/src/approval.ts
- Create: packages/policy/src/approval.test.ts
- Modify: packages/policy/src/index.ts

- [ ] **Step 1: Write failing approval tests**

~~~ts
import { describe, expect, it } from "vitest";
import { approvePatch, createPendingApproval } from "./approval.js";

describe("approval state machine", () => {
  it("expires approval when the current base hash changes", () => {
    const approval = createPendingApproval("patch-a", "base-a", 1_000);
    expect(approvePatch(approval, "base-b", 500)).toMatchObject({ status: "expired" });
  });

  it("approves only the matching patch and base hash", () => {
    const approval = createPendingApproval("patch-a", "base-a", 1_000);
    expect(approvePatch(approval, "base-a", 500)).toMatchObject({ status: "approved" });
  });
});
~~~

- [ ] **Step 2: Run the approval test to record red**

Run: npm test -- --run packages/policy/src/approval.test.ts
Expected: FAIL because approval functions are missing.

- [ ] **Step 3: Implement pending, approved, rejected and expired transitions**

Represent an approval as actionId, patchHash, baseHash, status, createdAt and expiresAt. Permit only pending to approved, pending to rejected, and pending to expired transitions. Ensure an expired or rejected approval cannot later become approved.

- [ ] **Step 4: Verify transitions**

Run: npm test -- --run packages/policy/src/approval.test.ts
Expected: PASS.

- [ ] **Step 5: Commit**

Run:

~~~bash
git add packages/policy/src/approval.ts packages/policy/src/approval.test.ts packages/policy/src/index.ts
git commit -m "feat: bind patch writes to approval state"
~~~

### Task 5: Add controlled workspace reads, searches and patch application

**Dependencies:** Tasks 3 and 4.

**Files:**
- Create: packages/tools/package.json
- Create: packages/tools/src/workspace.ts
- Create: packages/tools/src/patch.ts
- Create: packages/tools/src/workspace.test.ts
- Create: packages/tools/src/patch.test.ts
- Create: packages/tools/src/index.ts

- [ ] **Step 1: Write failing workspace and patch tests**

~~~ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { readWorkspaceFile } from "./workspace.js";
import { applyApprovedPatch } from "./patch.js";

it("reads a text file inside the selected workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "codesentinel-tools-"));
  await writeFile(join(root, "allowed.txt"), "allowed");
  await expect(readWorkspaceFile({ workspaceRoot: root, path: "allowed.txt", maxBytes: 1024 }))
    .resolves.toContain("allowed");
});

it("does not write when approval is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "codesentinel-tools-"));
  await writeFile(join(root, "math.ts"), "export const value = 1;\n");
  await expect(applyApprovedPatch({
    workspaceRoot: root,
    path: "math.ts",
    patch: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;",
    approval: { id: "a1", actionId: "p1", patchHash: "p", baseHash: "b", status: "rejected", createdAt: 0, expiresAt: 1000 },
  })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
});
~~~

- [ ] **Step 2: Run focused tests to record red**

Run: npm test -- --run packages/tools/src/workspace.test.ts packages/tools/src/patch.test.ts
Expected: FAIL because tool modules are missing.

- [ ] **Step 3: Implement safe tools**

Expose readWorkspaceFile({ workspaceRoot, path, maxBytes }) and applyApprovedPatch({ workspaceRoot, path, patch, approval }). Use Node fs/promises and realpath checks to resolve reads under the selected workspace. Enforce a file-size limit before reading and return a truncated marker when necessary. Apply a single-file unified diff only after policy and approval verification; re-hash current file content and reject a changed base hash before writing. Use the diff package to apply the patch, then atomically replace only the approved file.

- [ ] **Step 4: Verify safe tool behavior**

Run: npm test -- --run packages/tools/src/workspace.test.ts packages/tools/src/patch.test.ts
Expected: PASS.

- [ ] **Step 5: Commit**

Run:

~~~bash
git add packages/tools
git commit -m "feat: add guarded workspace and patch tools"
~~~

### Task 6: Add the configured verification runner

**Dependencies:** Task 3.

**Files:**
- Create: packages/tools/src/verification.ts
- Create: packages/tools/src/verification.test.ts
- Modify: packages/tools/src/index.ts

- [ ] **Step 1: Write failing verification tests**

~~~ts
import { describe, expect, it } from "vitest";
import { runVerification } from "./verification.js";

it("uses an executable and argument array without a shell", async () => {
  const result = await runVerification({
    command: { id: "echo", executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 1_000, maxOutputBytes: 1_024 },
    cwd: process.cwd(),
  });
  expect(result).toMatchObject({ exitCode: 0, timedOut: false });
});

it("reports timeout without throwing raw process errors", async () => {
  const result = await runVerification({
    command: { id: "hang", executable: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"], timeoutMs: 20, maxOutputBytes: 1_024 },
    cwd: process.cwd(),
  });
  expect(result).toMatchObject({ timedOut: true });
});
~~~

- [ ] **Step 2: Run verification tests to record red**

Run: npm test -- --run packages/tools/src/verification.test.ts
Expected: FAIL because runVerification is missing.

- [ ] **Step 3: Implement no-shell execution and bounded capture**

Use child_process.spawn with shell set to false. Capture bounded stdout and stderr, kill the process on timeout, redact output before returning it, and return commandId, exitCode, durationMs, timedOut and summary instead of throwing unstructured child-process errors.

- [ ] **Step 4: Verify runner behavior**

Run: npm test -- --run packages/tools/src/verification.test.ts
Expected: PASS.

- [ ] **Step 5: Commit**

Run:

~~~bash
git add packages/tools/src/verification.ts packages/tools/src/verification.test.ts packages/tools/src/index.ts
git commit -m "feat: run configured verification safely"
~~~

### Task 7: Add Provider and Windows credential abstractions

**Dependencies:** Task 2.

**Files:**
- Create: packages/providers/package.json
- Create: packages/providers/src/provider.ts
- Create: packages/providers/src/mock.ts
- Create: packages/providers/src/openai-compatible.ts
- Create: packages/providers/src/credential-store.ts
- Create: packages/providers/src/provider.test.ts
- Create: packages/providers/src/credential-store.test.ts
- Create: packages/providers/src/index.ts

- [ ] **Step 1: Write failing provider and credential tests**

~~~ts
import { describe, expect, it } from "vitest";
import { ScriptedMockProvider } from "./mock.js";
import { InMemoryCredentialStore } from "./credential-store.js";

it("returns scripted actions in order", async () => {
  const provider = new ScriptedMockProvider([{ kind: "finish", outcome: "completed", summary: "done" }]);
  await expect(provider.complete({ messages: [] })).resolves.toMatchObject({ kind: "finish" });
});

it("reports credential status without returning the secret", async () => {
  const store = new InMemoryCredentialStore();
  await store.set("deepseek-default", "secret-value");
  await expect(store.status("deepseek-default")).resolves.toEqual("configured");
  await store.clear("deepseek-default");
  await expect(store.status("deepseek-default")).resolves.toEqual("missing");
});
~~~

- [ ] **Step 2: Run focused tests to record red**

Run: npm test -- --run packages/providers/src/provider.test.ts packages/providers/src/credential-store.test.ts
Expected: FAIL because provider and credential abstractions are missing.

- [ ] **Step 3: Implement adapters with injected secrets**

Define Provider.complete(request) returning one unknown response that is parsed by contracts outside the Provider. Implement ScriptedMockProvider with finite scripted responses and an immutable requests array for feedback-loop assertions. Implement OpenAICompatibleProvider using fetch and a supplied API key, never logging the key. Define CredentialStore with set, get, status and clear. Use InMemoryCredentialStore only for tests and a keytar-backed Windows store only at CLI runtime.

- [ ] **Step 4: Verify Provider isolation**

Run: npm test -- --run packages/providers/src/provider.test.ts packages/providers/src/credential-store.test.ts
Expected: PASS without network calls.
Run: npm run typecheck
Expected: PASS.

- [ ] **Step 5: Commit**

Run:

~~~bash
git add packages/providers
git commit -m "feat: add provider and credential abstractions"
~~~

### Task 8: Implement the self-authored Agent Loop and feedback stops

**Dependencies:** Tasks 4, 5, 6 and 7.

**Files:**
- Create: packages/core/package.json
- Create: packages/core/src/agent-loop.ts
- Create: packages/core/src/context.ts
- Create: packages/core/src/in-memory-event-sink.ts
- Create: packages/core/src/tool-dispatcher.ts
- Create: packages/core/src/agent-loop.test.ts
- Create: packages/core/src/index.ts

- [ ] **Step 1: Write failing loop tests**

~~~ts
import { describe, expect, it, vi } from "vitest";
import { ScriptedMockProvider } from "@codesentinel/providers";
import { InMemoryEventSink } from "./in-memory-event-sink.js";
import { createToolDispatcher } from "./tool-dispatcher.js";
import { runAgentSession } from "./agent-loop.js";

const failedVerification = { commandId: "test", exitCode: 1, timedOut: false, durationMs: 4, summary: "expected 2, received 1" };

it("feeds a failed verification result into the next provider request", async () => {
  const provider = new ScriptedMockProvider([
    { kind: "run_verification", commandId: "test" },
    { kind: "finish", outcome: "needs_human", summary: "inspect failure" },
  ]);
  const trace = await runAgentSession({
    session: { id: "s1", taskKind: "test_repair", state: "created", round: 0, workspaceId: "w1", providerId: "p1" },
    provider,
    policy: { evaluate: () => ({ decision: "allow", reason: "ALLOWED" }) },
    tools: createToolDispatcher({ runVerification: vi.fn().mockResolvedValue(failedVerification) }),
    eventSink: new InMemoryEventSink(),
  });
  expect(trace.providerRequests[1].messages.at(-1)?.content).toContain("expected 2");
});

it("stops after three unsuccessful repair rounds", async () => {
  const provider = new ScriptedMockProvider([
    { kind: "run_verification", commandId: "test" },
    { kind: "run_verification", commandId: "test" },
    { kind: "run_verification", commandId: "test" },
  ]);
  const trace = await runAgentSession({
    session: { id: "s2", taskKind: "test_repair", state: "created", round: 0, workspaceId: "w2", providerId: "p2" },
    provider,
    policy: { evaluate: () => ({ decision: "allow", reason: "ALLOWED" }) },
    tools: createToolDispatcher({ runVerification: vi.fn().mockResolvedValue(failedVerification) }),
    eventSink: new InMemoryEventSink(),
  });
  expect(trace.session.state).toBe("failed");
  expect(trace.session.round).toBe(3);
});
~~~

- [ ] **Step 2: Run loop tests to record red**

Run: npm test -- --run packages/core/src/agent-loop.test.ts
Expected: FAIL because runAgentSession is missing.

- [ ] **Step 3: Implement the loop without framework agent runners**

Create runAgentSession with explicit session, provider, policy, tools and EventSink dependencies. Define ToolDispatcher with a method per Action and createToolDispatcher(overrides) to supply deterministic unsupported-tool errors for omitted methods in tests. It assembles sanitized context, calls the injected Provider once per step, validates one returned Action with ActionSchema, evaluates it with Policy Guardrail, dispatches it through injected tools, appends an event through EventSink and feeds a structured result into the next request. Enter awaiting_approval for a patch proposal; do not apply it until the separate approval route resumes the session. Stop on pass, non-reproducible initial test, user rejection, deny decision, unrecoverable tool error or round three. InMemoryEventSink exists only for core tests; Task 9 supplies the SQLite implementation.

- [ ] **Step 4: Verify feedback and stopping**

Run: npm test -- --run packages/core/src/agent-loop.test.ts
Expected: PASS with no network calls.
Run: npm test
Expected: PASS.

- [ ] **Step 5: Commit**

Run:

~~~bash
git add packages/core
git commit -m "feat: add bounded feedback-driven agent loop"
~~~

### Task 9: Persist sessions and redact stored output

**Dependencies:** Task 2.

**Files:**
- Create: packages/persistence/package.json
- Create: packages/persistence/src/redaction.ts
- Create: packages/persistence/src/session-repository.ts
- Create: packages/persistence/src/redaction.test.ts
- Create: packages/persistence/src/session-repository.test.ts
- Create: packages/persistence/src/index.ts

- [ ] **Step 1: Write failing redaction and repository tests**

~~~ts
import { expect, it } from "vitest";
import { redactText } from "./redaction.js";
import { createSessionRepository } from "./session-repository.js";

it("redacts an API-key-like value before persistence", () => {
  expect(redactText("Authorization: Bearer sk-1234567890abcdef")).not.toContain("sk-1234567890abcdef");
});

it("clears every persisted record for one session", async () => {
  const repository = createSessionRepository(":memory:");
  await repository.createSession({ id: "s1", taskKind: "test_repair", state: "created", round: 0, workspaceId: "w1", providerId: "p1" });
  await repository.appendAction({ sessionId: "s1", kind: "finish", inputSummary: "done", policyDecision: "allow", resultSummary: "done" });
  await repository.clearSession("s1");
  await expect(repository.loadTimeline("s1")).resolves.toEqual([]);
});
~~~

- [ ] **Step 2: Run persistence tests to record red**

Run: npm test -- --run packages/persistence/src/redaction.test.ts packages/persistence/src/session-repository.test.ts
Expected: FAIL because redaction and repository modules are missing.

- [ ] **Step 3: Implement local-only persistence**

Create SQLite tables for sessions, action records, approvals, verification runs and session memory. Persist only redacted summaries, never Provider API keys. Make SessionRepository implement EventSink by translating appended events into redacted action or verification records. Expose createSession, appendAction, saveApproval, appendVerification, loadTimeline and clearSession. Make clearSession remove all records associated with one session.

- [ ] **Step 4: Verify persistence**

Run: npm test -- --run packages/persistence/src/redaction.test.ts packages/persistence/src/session-repository.test.ts
Expected: PASS.

- [ ] **Step 5: Commit**

Run:

~~~bash
git add packages/persistence
git commit -m "feat: persist redacted local session history"
~~~

### Task 10: Expose the local Fastify API and CLI

**Dependencies:** Tasks 8 and 9.

**Files:**
- Create: apps/api/package.json
- Create: apps/api/src/server.ts
- Create: apps/api/src/routes.ts
- Create: apps/api/src/routes.test.ts
- Create: apps/cli/package.json
- Create: apps/cli/src/main.ts
- Create: apps/cli/src/credentials.ts
- Create: apps/cli/src/main.test.ts

- [ ] **Step 1: Write failing route tests**

~~~ts
import { expect, it, vi } from "vitest";
import { buildServer } from "./server.js";

it("creates a test-repair session only for a configured command", async () => {
  const app = buildServer({
    configLoader: { load: async () => ({ allowedPaths: ["src/**"], verificationCommands: [] }) },
    sessionService: { create: vi.fn() },
    credentialService: { status: vi.fn(), set: vi.fn(), clear: vi.fn() },
  });
  const response = await app.inject({
    method: "POST",
    url: "/sessions",
    payload: { taskKind: "test_repair", commandId: "unknown", workspacePath: "C:/repo" },
  });
  expect(response.statusCode).toBe(400);
});

it("rejects a feature session without acceptance criteria", async () => {
  const app = buildServer({
    configLoader: { load: async () => ({ allowedPaths: ["src/**"], verificationCommands: [{ id: "test", executable: "node", args: ["--version"], timeoutMs: 1000, maxOutputBytes: 1024 }] }) },
    sessionService: { create: vi.fn() },
    credentialService: { status: vi.fn(), set: vi.fn(), clear: vi.fn() },
  });
  const response = await app.inject({
    method: "POST",
    url: "/sessions",
    payload: { taskKind: "feature_implementation", commandId: "test", workspacePath: "C:/repo" },
  });
  expect(response.statusCode).toBe(400);
});
~~~

- [ ] **Step 2: Run API and CLI tests to record red**

Run: npm test -- --run apps/api/src/routes.test.ts apps/cli/src/main.test.ts
Expected: FAIL because server and CLI modules are missing.

- [ ] **Step 3: Implement local-only surfaces**

Define ServerDependencies with configLoader.load(workspacePath), sessionService.create(input), and credentialService.status/set/clear methods, then build Fastify routes for health, workspace configuration validation, session creation, timeline reading, patch approval, patch rejection, session stop, credential status/set/clear and local WebUI asset serving. Bind the server to 127.0.0.1 by default. Implement CLI commands start, credentials set, credentials status and credentials clear; use hidden input for set and never print a secret.

- [ ] **Step 4: Verify local API**

Run: npm test -- --run apps/api/src/routes.test.ts apps/cli/src/main.test.ts
Expected: PASS.
Run: npm run typecheck
Expected: PASS.

- [ ] **Step 5: Commit**

Run:

~~~bash
git add apps/api apps/cli
git commit -m "feat: expose local harness API and CLI"
~~~

### Task 11: Add the deterministic failure fixture and required mechanism demonstration

**Dependencies:** Tasks 8 and 10.

**Files:**
- Create: fixtures/failing-project/package.json
- Create: fixtures/failing-project/src/math.ts
- Create: fixtures/failing-project/src/math.test.ts
- Create: tests/mechanism-demo.test.ts
- Create: scripts/mechanism-demo.ts

- [ ] **Step 1: Write failing mechanism tests**

~~~ts
import { expect, it } from "vitest";
import { runMechanismDemo } from "../scripts/mechanism-demo.js";

it("demonstrates denial, feedback-driven repair and approval binding", async () => {
  const result = await runMechanismDemo();
  expect(result.dangerousAction.toolCalls).toBe(0);
  expect(result.repair.finalVerification.exitCode).toBe(0);
  expect(result.staleApproval.writeApplied).toBe(false);
});
~~~

- [ ] **Step 2: Run the demonstration test to record red**

Run: npm test -- --run tests/mechanism-demo.test.ts
Expected: FAIL because the fixture and demo script are missing.

- [ ] **Step 3: Implement only the controlled fixture and scripted demo**

Create a small math fixture whose direct test intentionally fails because its add implementation returns an incorrect value. Do not include its direct failing command in root CI. In the demo, copy the fixture to a temporary directory, use ScriptedMockProvider to request a dangerous action, then a verification, then a patch, require an approval, re-run the test successfully, and finally attempt a stale approval. Return only deterministic summary data.

- [ ] **Step 4: Verify all mandatory demonstrations**

Run: npm test -- --run tests/mechanism-demo.test.ts
Expected: PASS.
Run: npm run demo
Expected: prints denial, repaired verification and stale-approval results with no network access.

- [ ] **Step 5: Commit**

Run:

~~~bash
git add fixtures/failing-project tests/mechanism-demo.test.ts scripts/mechanism-demo.ts
git commit -m "test: demonstrate guarded repair feedback loop"
~~~

### Task 12: Build the local React WebUI

**Dependencies:** Task 10.

**Files:**
- Create: apps/web/package.json
- Create: apps/web/vite.config.ts
- Create: apps/web/src/main.tsx
- Create: apps/web/src/App.tsx
- Create: apps/web/src/api.ts
- Create: apps/web/src/components/TaskForm.tsx
- Create: apps/web/src/components/Timeline.tsx
- Create: apps/web/src/components/DiffApproval.tsx
- Create: apps/web/src/App.test.tsx

- [ ] **Step 1: Write the failing approval UI test**

~~~tsx
/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { App } from "./App.js";

it("sends an approval only after the user clicks Approve patch", async () => {
  const approve = vi.fn();
  const pendingPatchSession = {
    id: "s1",
    state: "awaiting_approval",
    approval: { id: "approval-1", patch: "@@ -1 +1 @@\n-a\n+b" },
    timeline: [],
  };
  render(<App api={{ loadSession: async () => pendingPatchSession, approvePatch: approve }} />);
  await userEvent.click(screen.getByRole("button", { name: "Approve patch" }));
  expect(approve).toHaveBeenCalledWith("approval-1");
});
~~~

- [ ] **Step 2: Run the UI test to record red**

Run: npm test -- --run apps/web/src/App.test.tsx
Expected: FAIL because App and API components are missing.

- [ ] **Step 3: Implement the minimum review-first UI**

Set `apps/web/package.json` to a private ESM workspace named `@kadsoo/codesentinel-web`, with `build: "vite build"` and exact local dependency declarations for `react@19.2.8`, `react-dom@19.2.8`, `vite@8.1.5`, and `@vitejs/plugin-react@6.0.4`. Create `apps/web/vite.config.ts` with the React plugin. Replace the root `build` script with `npm run typecheck && npm --workspace @kadsoo/codesentinel-web run build` before Step 4. Define a typed WebApiClient with loadSession, createSession, approvePatch, rejectPatch and stopSession methods. Render a task form for workspace path, task kind and configured command; a timeline of action/policy/test events; a read-only unified diff; explicit Approve patch, Reject patch and Stop session buttons; and terminal state summaries. Disable approval controls unless session state is awaiting_approval. Use only the local API client and never access filesystem APIs in browser code.

- [ ] **Step 4: Verify the UI**

Run: npm test -- --run apps/web/src/App.test.tsx
Expected: PASS.
Run: npm run build
Expected: PASS.

- [ ] **Step 5: Commit**

Run:

~~~bash
git add apps/web
git commit -m "feat: add review-first local web interface"
~~~

### Task 13: Complete distribution, CI, documentation and public Mock demo

**Dependencies:** Tasks 10, 11 and 12.

**Files:**
- Create: README.md
- Create: SECURITY.md
- Create: .github/workflows/ci.yml
- Create: .gitlab-ci.yml
- Create: apps/demo/package.json
- Create: apps/demo/src/main.tsx
- Create: scripts/package-smoke-test.ts
- Create: tests/release-config.test.ts
- Modify: package.json
- Modify: AGENT_LOG.md

- [ ] **Step 1: Write failing packaging and CI configuration tests**

~~~ts
import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";

it("declares an npm test script and a GitLab unit-test job", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const gitlab = await readFile(".gitlab-ci.yml", "utf8");
  expect(packageJson.scripts.test).toBeTruthy();
  expect(gitlab).toMatch(/^unit-test:/m);
});
~~~

- [ ] **Step 2: Run the release test to record red**

Run: npm test -- --run tests/release-config.test.ts
Expected: FAIL because release configuration and test are missing.

- [ ] **Step 3: Implement reproducible delivery**

Write README sections for project purpose, architecture, Windows x64 prerequisites, npm install command, local start, credential set/status/clear, codesentinel.json format, test commands, security boundary, OpenCode reference attribution, known limits and online Mock demo. Add SECURITY.md threat summary. Configure GitHub Actions to run npm ci, npm test, lint, typecheck and build on push and pull request. Add .gitlab-ci.yml with a job named unit-test that runs npm ci and npm test. Build a static demo that uses only the recorded Mock mechanism timeline. Add a package smoke test that installs the packed tarball into a temporary directory and invokes the CLI help command.

- [ ] **Step 4: Verify delivery artifacts**

Run: npm test -- --run tests/release-config.test.ts
Expected: PASS.
Run: npm test
Expected: PASS.
Run: npm run lint && npm run typecheck && npm run build
Expected: PASS.
Run: npm run package:smoke
Expected: PASS on Windows x64.

- [ ] **Step 5: Commit**

Run:

~~~bash
git add README.md SECURITY.md .github/workflows/ci.yml .gitlab-ci.yml apps/demo scripts/package-smoke-test.ts package.json AGENT_LOG.md tests/release-config.test.ts
git commit -m "chore: add distribution and CI delivery artifacts"
~~~

## Cold-start validation protocol

Before any production implementation task is merged, start a brand-new session using a different Agent type. Give it only the absolute paths to SPEC.md and PLAN.md; do not provide this conversation, AGENT_LOG.md, repository history, verbal clarifications or additional requirements. Ask it to attempt Tasks 1 and 2 in a disposable verification worktree and to stop immediately whenever the documents leave an implementation decision ambiguous.

Record its questions, deviations, generated changes, verification output, and the exact resulting SPEC.md/PLAN.md revisions in SPEC_PROCESS.md. Do not merge the cold-start code into main. Only after the project owner reviews the cold-start findings and the documentation is revised may the implementation worktrees begin.

## Plan self-review

| SPEC requirement | Planned task coverage |
|---|---|
| Self-authored loop, structured actions, Mock LLM | Tasks 2, 7 and 8 |
| Main governance contribution and HITL approval | Tasks 3, 4, 5 and 11 |
| Safe tool dispatch, bounded test feedback, three-round stop | Tasks 5, 6, 8 and 11 |
| Memory, observability and local redacted storage | Task 9 and Task 10 |
| DeepSeek/NJU credentials and provider adapters | Task 7 and Task 10 |
| Local WebUI and public safe WebUI demo | Tasks 10, 12 and 13 |
| npm distribution, CI, README and GitLab compatibility job | Task 13 |
| One-click offline tests and mechanism demonstration | Tasks 1, 11 and 13 |

No implementation task lacks a named red test, a focused verification command, a minimal behavior target, or a commit boundary. The plan intentionally excludes arbitrary shell, remote code execution, unapproved writes, TUI parity, MCP and multi-agent runtime features defined as out of scope in SPEC.md.
