# Task 8 Bounded Agent Loop and Approval Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build an offline-testable, three-round Coding Agent Loop that safely reproduces failures, proposes reviewable patches, resumes only from a trusted local approval, and verifies the result.

**Architecture:** A new Core workspace owns private session and pending-patch state while receiving Provider, BoundPolicy, ToolDispatcher, EventSink, clock, and ID factory through injection. Contracts express bounded patch stages and approval events; Tools owns safe listing, searching, and base-hash reads; Core never accesses the filesystem, network, shell, or credential storage directly.

**Tech Stack:** Node.js 22.17.0, TypeScript 5.9.3 in ESM mode, Vitest 4.1.10, Zod 4.4.3, Node crypto for SHA-256, and the existing Contract/Policy/Tool/Provider workspaces.

---

## File map

| File | Responsibility |
| --- | --- |
| packages/contracts/src/action.ts | Add PatchStageSchema, require patch stage, and bound browse Action parameters. |
| packages/contracts/src/action.test.ts | Lock the new Action contract and strict-property behavior. |
| packages/contracts/src/events.ts | Add the approval event kind. |
| packages/tools/src/workspace.ts | Add bounded, symlink-safe listing, text search, and current-base-hash capabilities using the existing verified-file primitives. |
| packages/tools/src/workspace.test.ts | Cover the new workspace capabilities with temporary directories. |
| packages/tools/src/index.ts | Export the new public Tool types and functions. |
| packages/policy/src/guardrail.test.ts | Update the existing valid patch fixture with its required stage. |
| packages/core/package.json | Register the private Core workspace. |
| packages/core/src/errors.ts | Define stable Core error codes with no raw causes or inputs. |
| packages/core/src/types.ts | Define public task, session, result, and controller contracts. |
| packages/core/src/context.ts | Build bounded, redacted Provider requests from task and tool feedback. |
| packages/core/src/in-memory-event-sink.ts | Provide an immutable EventSink test implementation. |
| packages/core/src/pending-patch-store.ts | Keep original patch proposals in a one-time private in-memory store. |
| packages/core/src/tool-dispatcher.ts | Bind workspace tools and configured verification commands behind a narrow dispatcher. |
| packages/core/src/test-support.ts | Share typed deterministic fake sessions, verification results, clocks, IDs, and Dispatcher fakes across Core tests. |
| packages/core/src/agent-loop.ts | Run initial verification, bounded Provider cycles, Policy gates, and trusted approval resumes. |
| packages/core/src/context.test.ts | Test context bounds and secret redaction. |
| packages/core/src/in-memory-event-sink.test.ts | Test immutable event snapshots. |
| packages/core/src/tool-dispatcher.test.ts | Test dispatcher binding and deterministic unavailable-tool errors. |
| packages/core/src/agent-loop.test.ts | Test initial reproduction, feedback, round limits, terminal errors, and Policy ordering. |
| packages/core/src/approval-resume.test.ts | Test private patch binding, approve/reject/expiry/replay behavior, and post-patch verification. |
| packages/core/src/feature-flow.test.ts | Test test-patch → RED → implementation-patch → GREEN sequencing. |
| packages/core/src/index.ts | Export the public Core API only. |
| package-lock.json | Register the Core workspace without adding a runtime dependency. |
| PLAN.md | Mark Task 8 complete after all implementation evidence is available. |
| AGENT_LOG.md | Record actual RED, GREEN, review, and verification results after implementation. |

## Non-negotiable implementation rules

- Use a fresh worktree and a new feature branch. Never modify the existing Task 7 feature worktree or delete any existing worktree.
- Import sibling workspace source through existing relative ESM paths such as ../../contracts/src/index.js. Do not assume every workspace package name is importable because contracts, policy, and tools do not currently declare package exports.
- Keep Policy denial of model-emitted apply_approved_patch unchanged. The local approval API is the only write path.
- Keep the original patch Action private after it is proposed. No public resolver argument may contain patch, path, baseHash, actionId, or a complete Approval object.
- Emit only stable summaries. Never include raw Provider errors, tool Error messages, command output, source contents, credentials, or authorization values in Core errors or HarnessEvents.
- Every changed behavior starts with a targeted red test. Do not use a real Provider, network, Credential Manager, shell command outside the existing verification tool, or user workspace in unit tests.

### Task 0: Create the Task 8 implementation worktree and record a clean baseline

**Files:**
- No source file changes.

- [ ] **Step 1: Create a new worktree from the approved design commit**

Run from the repository root:

~~~powershell
git -c safe.directory="$PWD" status --short --branch
git -c safe.directory="$PWD" worktree add .worktrees/task8-agent-loop -b feat/task8-agent-loop docs-task8-agent-loop-design
~~~

Expected: the current checkout is clean; the new worktree is based on commit 9348156 or its committed plan descendant and retains the approved design document. Do not use git pull, git push, or a global safe.directory setting.

- [ ] **Step 2: Install locked dependencies without native install scripts**

Run inside CodeSentinel/.worktrees/task8-agent-loop:

~~~powershell
npm ci --offline --ignore-scripts --no-audit --no-fund
npm test -- --run packages/contracts/src/action.test.ts packages/policy/src/guardrail.test.ts
~~~

Expected: the focused baseline suite passes before Task 8 changes. Record the actual output; these commands do not create a long-running process.

- [ ] **Step 3: Commit no code**

Do not create a baseline commit. The first commit must contain a tested Task 8 behavior change.

### Task 1: Tighten the structured Action and event contracts

**Files:**
- Modify: packages/contracts/src/action.ts
- Modify: packages/contracts/src/action.test.ts
- Modify: packages/contracts/src/events.ts
- Modify: packages/contracts/src/index.ts
- Modify: packages/policy/src/guardrail.test.ts

- [ ] **Step 1: Write failing contract tests**

Add these cases to packages/contracts/src/action.test.ts before changing the schema:

~~~ts
it("requires an explicit bounded stage on each patch proposal", () => {
  const proposal = {
    kind: "propose_patch",
    path: "src/math.ts",
    baseHash: "a".repeat(64),
    patch: "@@ -1 +1 @@\n-export const add = () => 0;\n+export const add = () => 2;",
    reason: "Fix incorrect addition",
  };

  expect(ActionSchema.safeParse(proposal).success).toBe(false);
  for (const stage of ["repair", "test", "implementation"]) {
    expect(ActionSchema.parse({ ...proposal, stage }).stage).toBe(stage);
  }
  expect(ActionSchema.safeParse({ ...proposal, stage: "publish" }).success).toBe(false);
});

it("rejects browse requests beyond the fixed resource bounds", () => {
  expect(
    ActionSchema.safeParse({ kind: "list_files", path: "src", depth: 9 }).success,
  ).toBe(false);
  expect(
    ActionSchema.safeParse({
      kind: "search_text",
      path: "src",
      query: "needle",
      maxResults: 101,
    }).success,
  ).toBe(false);
});
~~~

Add an events test file only if the project needs one; otherwise add the following compile-time-facing runtime assertion to the new Core event-sink tests in Task 3:

~~~ts
const approvalEvent: HarnessEvent = {
  sessionId: "session-1",
  round: 1,
  kind: "approval",
  summary: "APPROVAL_PENDING",
  occurredAt: "2026-07-29T00:00:00.000Z",
};
expect(approvalEvent.kind).toBe("approval");
~~~

Update the valid patch fixture in packages/policy/src/guardrail.test.ts with stage: "repair". It should compile only after the schema change and must still receive ask/PATCH_REQUIRES_APPROVAL.

- [ ] **Step 2: Run the focused contract tests to record RED**

Run:

~~~powershell
npm test -- --run packages/contracts/src/action.test.ts packages/policy/src/guardrail.test.ts
~~~

Expected: FAIL because a proposal without stage is still accepted and the new bounds are not enforced.

- [ ] **Step 3: Implement the minimum contract changes**

In packages/contracts/src/action.ts, add and export this schema and type immediately above ProposePatchActionSchema:

~~~ts
export const PatchStageSchema = z.enum(["repair", "test", "implementation"]);
export type PatchStage = z.infer<typeof PatchStageSchema>;
~~~

Change the relevant Action shapes exactly as follows:

~~~ts
const ListFilesActionSchema = z
  .object({
    kind: z.literal("list_files"),
    path: NonEmptyString.optional(),
    depth: z.number().int().positive().max(8).optional(),
  })
  .strict();

const SearchTextActionSchema = z
  .object({
    kind: z.literal("search_text"),
    query: NonEmptyString,
    path: NonEmptyString.optional(),
    maxResults: z.number().int().positive().max(100).optional(),
  })
  .strict();

const ProposePatchActionSchema = z
  .object({
    kind: z.literal("propose_patch"),
    path: NonEmptyString,
    baseHash: Sha256Hash,
    patch: z.string().min(1),
    reason: NonEmptyString,
    stage: PatchStageSchema,
  })
  .strict();
~~~

Export PatchStageSchema and PatchStage from packages/contracts/src/index.ts. In packages/contracts/src/events.ts, change kind to:

~~~ts
kind: "action" | "policy" | "tool_result" | "verification" | "approval" | "state";
~~~

Do not change Policy logic: evaluateAction must continue to ask for every valid propose_patch and deny every model-supplied apply_approved_patch.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run:

~~~powershell
npm test -- --run packages/contracts/src/action.test.ts packages/policy/src/guardrail.test.ts
npm run typecheck
~~~

Expected: both commands pass. The old proposal fixtures must now explicitly include stage and arbitrary unknown stage values must remain invalid.

- [ ] **Step 5: Commit the contract boundary**

~~~powershell
git add packages/contracts/src/action.ts packages/contracts/src/action.test.ts packages/contracts/src/events.ts packages/contracts/src/index.ts packages/policy/src/guardrail.test.ts
git commit -m "feat: add bounded patch stages and approval events"
~~~

### Task 2: Add safe workspace listing, text search, and current-base hashing

**Files:**
- Modify: packages/tools/src/workspace.ts
- Modify: packages/tools/src/workspace.test.ts
- Modify: packages/tools/src/index.ts

- [ ] **Step 1: Write failing workspace capability tests**

Add tests to packages/tools/src/workspace.test.ts using its existing temporary-directory helpers:

~~~ts
it("lists sorted workspace entries without following symlinks and stops at the entry limit", async () => {
  const workspaceRoot = await createWorkspace();
  await writeTextFile(join(workspaceRoot, "src", "a.ts"), "a");
  await writeTextFile(join(workspaceRoot, "src", "nested", "b.ts"), "b");
  await writeTextFile(join(workspaceRoot, "src", "z.ts"), "z");

  await expect(
    listWorkspaceFiles({
      workspaceRoot,
      path: "src",
      depth: 8,
      maxEntries: 2,
      shouldInclude: () => true,
    }),
  ).resolves.toEqual({
    entries: [
      { kind: "file", path: "src/a.ts" },
      { kind: "directory", path: "src/nested" },
    ],
    truncated: true,
  });
});

it("filters disallowed descendants before search reads their text", async () => {
  const workspaceRoot = await createWorkspace();
  await writeTextFile(join(workspaceRoot, "src", "safe.ts"), "const needle = 1;");
  await writeTextFile(join(workspaceRoot, "src", ".env"), "TOKEN=needle-secret");

  await expect(
    searchWorkspaceText({
      workspaceRoot,
      path: "src",
      query: "needle",
      maxResults: 100,
      shouldInclude: (path) => path !== "src/.env",
    }),
  ).resolves.toEqual({
    matches: [{ path: "src/safe.ts", line: 1, snippet: "const needle = 1;" }],
    truncated: false,
  });
});

it("returns the verified SHA-256 base hash and changes it when file bytes change", async () => {
  const workspaceRoot = await createWorkspace();
  const file = join(workspaceRoot, "src", "math.ts");
  await writeTextFile(file, "export const value = 1;\n");
  const first = await getWorkspaceFileHash({ workspaceRoot, path: "src/math.ts" });
  await writeTextFile(file, "export const value = 2;\n");
  const second = await getWorkspaceFileHash({ workspaceRoot, path: "src/math.ts" });

  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(second).toMatch(/^[0-9a-f]{64}$/);
  expect(second).not.toBe(first);
});
~~~

Also add tests that reject depth 0 and 9, maxEntries 0 and 501, maxResults 0 and 101, traversal, explicit symlink roots, hard-linked search files, binary content, and an exact file path whose query has no match. Expect existing stable ToolErrorCode values where an existing primitive already defines them; use new values only for invalid browse input or non-directory roots.

- [ ] **Step 2: Run the focused workspace test to record RED**

Run:

~~~powershell
npm test -- --run packages/tools/src/workspace.test.ts
~~~

Expected: FAIL because listWorkspaceFiles, searchWorkspaceText, and getWorkspaceFileHash do not exist.

- [ ] **Step 3: Implement bounded helpers in workspace.ts**

Add these exported data types near WorkspaceFileInput:

~~~ts
export type WorkspacePathFilter = (path: string) => boolean;

export type WorkspaceListEntry = Readonly<{
  kind: "file" | "directory";
  path: string;
}>;

export type ListWorkspaceFilesInput = Readonly<{
  workspaceRoot: string;
  path?: string;
  depth: number;
  maxEntries: number;
  shouldInclude: WorkspacePathFilter;
}>;

export type ListWorkspaceFilesResult = Readonly<{
  entries: readonly WorkspaceListEntry[];
  truncated: boolean;
}>;

export type SearchTextMatch = Readonly<{
  path: string;
  line: number;
  snippet: string;
}>;

export type SearchWorkspaceTextInput = Readonly<{
  workspaceRoot: string;
  path?: string;
  query: string;
  maxResults: number;
  shouldInclude: WorkspacePathFilter;
}>;

export type SearchWorkspaceTextResult = Readonly<{
  matches: readonly SearchTextMatch[];
  truncated: boolean;
}>;
~~~

Add constants MAX_LIST_DEPTH = 8, MAX_LIST_ENTRIES = 500, MAX_SEARCH_FILES = 100, MAX_SEARCH_TOTAL_BYTES = 1_048_576, MAX_SEARCH_RESULTS = 100, and MAX_SEARCH_SNIPPET_CHARACTERS = 240. Extend ToolErrorCode with INVALID_DEPTH, INVALID_MAX_ENTRIES, INVALID_MAX_RESULTS, INVALID_QUERY, NOT_A_DIRECTORY, LIST_FAILED, and SEARCH_FAILED.

Implement the three public functions with this exact control flow:

~~~ts
export async function getWorkspaceFileHash(input: WorkspaceFileInput): Promise<string> {
  const resolved = await resolveExistingWorkspaceFile(input);
  const verified = await readVerifiedWorkspaceFile(resolved);
  return createHash("sha256").update(verified.bytes).digest("hex");
}
~~~

For listWorkspaceFiles, first canonicalize workspaceRoot with the existing resolveWorkspaceRoot. If path is undefined, use the root directory; otherwise use normalizeRelativePath, assertNoSymbolicPathComponents, realpathOrThrow, isPathContainedBy, and inspectSafeDirectory to resolve an existing directory. Use readdir with withFileTypes: true, sort names with locale-independent string comparison, lstat each candidate before accepting it, skip every symbolic link, and accept only lstat/stat-consistent ordinary directories or single-link files. Compute each returned path relative to the canonical root with forward slashes. Call shouldInclude before appending a candidate. Descend only while currentDepth is less than depth. Stop immediately after maxEntries accepted entries, set truncated true, and freeze the returned objects and array. Convert unexpected filesystem exceptions to LIST_FAILED.

For searchWorkspaceText, validate a nonblank query with length at most 4_096 and a maxResults in 1..100. Reuse the same directory traversal and candidate checks, never scan more than 100 files or one MiB total verified bytes, and call shouldInclude before opening each candidate. For each candidate, use resolveExistingWorkspaceFile plus readVerifiedWorkspaceFile then decodeWorkspaceText; skip BINARY_CONTENT and FILE_TOO_LARGE candidates without putting their name or content in a match. Split valid text by CRLF/LF, append at most one bounded line snippet per occurrence until maxResults, and set truncated whenever a result, file, byte, or traversal bound is reached. Convert unexpected errors to SEARCH_FAILED and freeze all results.

Do not use fs.promises.readFile, glob libraries, recursive shell commands, or a follow-symlink option.

- [ ] **Step 4: Export and verify the Tool API**

Add this public surface to packages/tools/src/index.ts:

~~~ts
export {
  getWorkspaceFileHash,
  listWorkspaceFiles,
  searchWorkspaceText,
} from "./workspace.js";
export type {
  ListWorkspaceFilesInput,
  ListWorkspaceFilesResult,
  SearchTextMatch,
  SearchWorkspaceTextInput,
  SearchWorkspaceTextResult,
  WorkspaceListEntry,
  WorkspacePathFilter,
} from "./workspace.js";
~~~

Run:

~~~powershell
npm test -- --run packages/tools/src/workspace.test.ts
npm run typecheck
~~~

Expected: GREEN. The test output must demonstrate that rejected descendants do not appear in entries or search snippets.

- [ ] **Step 5: Commit the read-only Tool boundary**

~~~powershell
git add packages/tools/src/workspace.ts packages/tools/src/workspace.test.ts packages/tools/src/index.ts
git commit -m "feat: add bounded workspace browse tools"
~~~

### Task 3: Create the Core contracts, immutable event sink, context builder, and dispatcher

**Files:**
- Create: packages/core/package.json
- Create: packages/core/src/errors.ts
- Create: packages/core/src/types.ts
- Create: packages/core/src/context.ts
- Create: packages/core/src/context.test.ts
- Create: packages/core/src/in-memory-event-sink.ts
- Create: packages/core/src/in-memory-event-sink.test.ts
- Create: packages/core/src/tool-dispatcher.ts
- Create: packages/core/src/tool-dispatcher.test.ts
- Create: packages/core/src/test-support.ts
- Create: packages/core/src/index.ts
- Modify: package-lock.json

- [ ] **Step 1: Add failing Core unit tests**

Create packages/core/src/context.test.ts with a fake Provider-facing feedback case:

~~~ts
it("bounds and redacts feedback before constructing a provider request", () => {
  const request = buildProviderRequest({
    taskSummary: "Repair the selected test",
    phase: "repair",
    feedback: [
      {
        kind: "verification",
        summary: "Authorization: Bearer sentinel-secret-value\n" + "x".repeat(5_000),
      },
    ],
  });

  const content = request.messages.at(-1)?.content ?? "";
  expect(content).toContain("Repair the selected test");
  expect(content).not.toContain("sentinel-secret-value");
  expect(content.length).toBeLessThanOrEqual(4_096);
});
~~~

Create packages/core/src/in-memory-event-sink.test.ts:

~~~ts
it("returns immutable event snapshots", async () => {
  const sink = new InMemoryEventSink();
  const event: HarnessEvent = {
    sessionId: "session-1",
    round: 0,
    kind: "approval",
    summary: "APPROVAL_PENDING",
    occurredAt: "2026-07-29T00:00:00.000Z",
  };

  await sink.append(event);
  event.summary = "mutated";

  expect(sink.events).toEqual([{ ...event, summary: "APPROVAL_PENDING" }]);
  expect(Object.isFrozen(sink.events)).toBe(true);
  expect(Object.isFrozen(sink.events[0])).toBe(true);
});
~~~

Create packages/core/src/tool-dispatcher.test.ts with an injected, no-filesystem test:

~~~ts
it("uses only the selected command and reports an omitted capability deterministically", async () => {
  const dispatcher = createToolDispatcher({
    workspaceRoot: "C:/workspace",
    verificationCommands: [testCommand],
    canReadPath: () => true,
    runVerification: async () => failedVerification,
  });

  await expect(
    dispatcher.runVerification({ kind: "run_verification", commandId: "test" }),
  ).resolves.toEqual(failedVerification);
  await expect(
    dispatcher.searchText({
      kind: "search_text",
      path: "src",
      query: "needle",
      maxResults: 1,
    }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_TOOL" });
});
~~~

Create packages/core/src/test-support.ts before running the tests. It is test-only code and must export testCommand, failedVerification, passingVerification, allowPolicy, askForPatchPolicy, fixedNow, sequenceIds, createdRepairSession, createdFeatureSession, and fakeTools. Use the following stable fixtures:

~~~ts
export const testCommand: VerificationCommand = {
  id: "test",
  launcher: "node_npm_cli",
  args: ["test"],
  timeoutMs: 1_000,
  maxOutputBytes: 1_024,
};

export const failedVerification: VerificationResult = {
  commandId: "test",
  exitCode: 1,
  durationMs: 4,
  timedOut: false,
  status: "completed",
  summary: "expected 2, received 1",
};

export const passingVerification: VerificationResult = {
  ...failedVerification,
  exitCode: 0,
  summary: "verification passed",
};

export const allowPolicy: BoundPolicy = Object.freeze({
  evaluate: () => Object.freeze({ decision: "allow", reason: "ALLOWED" }),
});

export const askForPatchPolicy: BoundPolicy = Object.freeze({
  evaluate: (action) =>
    Object.freeze(
      action.kind === "propose_patch"
        ? { decision: "ask", reason: "PATCH_REQUIRES_APPROVAL" }
        : { decision: "allow", reason: "ALLOWED" },
    ),
});

export const fixedNow = () => Date.parse("2026-07-29T00:00:00.000Z");

export function sequenceIds(): () => string {
  let next = 0;
  return () => `id-${++next}`;
}
~~~

Define FakeToolOverrides with optional verification, runVerification, currentBaseHash, and applyApprovedPatch values. fakeTools must return an object with tools: ToolDispatcher and individually exposed Vitest spies for applyApprovedPatch, getCurrentBaseHash, and runVerification. Its default read/browse methods reject CodeSentinelCoreError("UNSUPPORTED_TOOL"); its default current hash is "a".repeat(64); and its default verification is failedVerification. createdRepairSession and createdFeatureSession must return created AgentSession objects with all required ids, round 0, verificationCommandId "test", and a nonblank feature acceptanceCriteria.

- [ ] **Step 2: Run the new Core tests to record RED**

Run:

~~~powershell
npm test -- --run packages/core/src/context.test.ts packages/core/src/in-memory-event-sink.test.ts packages/core/src/tool-dispatcher.test.ts
~~~

Expected: FAIL because the Core workspace and modules do not exist.

- [ ] **Step 3: Implement the Core foundation**

Create packages/core/package.json:

~~~json
{
  "name": "@kadsoo/codesentinel-core",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts"
}
~~~

In errors.ts, define the following closed code set and error class. The class message must equal the code, must not accept a cause, and must freeze itself:

~~~ts
export type CoreErrorCode =
  | "INVALID_SESSION_INPUT"
  | "INVALID_ACTION"
  | "PROVIDER_FAILED"
  | "POLICY_DENIED"
  | "UNSUPPORTED_TOOL"
  | "TOOL_FAILED"
  | "EVENT_SINK_FAILED"
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_ALREADY_RESOLVED"
  | "ROUND_LIMIT_REACHED"
  | "VERIFICATION_REQUIRED"
  | "FEATURE_STAGE_INVALID"
  | "FEATURE_TEST_DID_NOT_FAIL";

export class CodeSentinelCoreError extends Error {
  readonly code: CoreErrorCode;

  constructor(code: CoreErrorCode) {
    super(code);
    this.name = "CodeSentinelCoreError";
    this.code = code;
    Object.freeze(this);
  }
}
~~~

In types.ts, define AgentStage as repair | test | implementation, SessionPhase as repair | awaiting_test_patch | awaiting_red | awaiting_implementation_patch | awaiting_green, and public readonly AgentSession, PendingPatchView, StartSessionInput, ResolvePendingPatchInput, AgentSessionResult, AgentLoopDependencies, and AgentSessionController interfaces. AgentLoopDependencies must use Provider, BoundPolicy, ToolDispatcher, EventSink, now, and createId. StartSessionInput must require a created session with a selected verificationCommandId, nonblank taskSummary, and nonblank acceptanceCriteria when taskKind is feature_implementation.

In context.ts, set MAX_CONTEXT_CHARACTERS to 4_096 and MAX_FEEDBACK_ITEMS to 3. Replace bearer tokens and long key-like values with [REDACTED], remove control characters, keep only the most recent three summaries, truncate deterministically, and return a two-message ProviderRequest: a fixed system message requiring exactly one Action JSON object and a user message containing task summary, phase, command ID, and feedback.

In in-memory-event-sink.ts, copy each primitive HarnessEvent into a new Object.freeze object before appending. The events getter must return Object.freeze of fresh copied event objects so callers cannot mutate internal history.

In tool-dispatcher.ts, define this narrow public interface:

~~~ts
export interface ToolDispatcher {
  listFiles(action: Extract<Action, { kind: "list_files" }>): Promise<ListWorkspaceFilesResult>;
  readFile(action: Extract<Action, { kind: "read_file" }>): Promise<string>;
  searchText(action: Extract<Action, { kind: "search_text" }>): Promise<SearchWorkspaceTextResult>;
  runVerification(
    action: Extract<Action, { kind: "run_verification" }>,
  ): Promise<VerificationResult>;
  getCurrentBaseHash(path: string): Promise<string>;
  applyApprovedPatch(input: Readonly<{
    path: string;
    patch: string;
    approval: PatchApproval;
  }>): Promise<ApplyApprovedPatchResult>;
}
~~~

ToolDispatcherOptions must bind workspaceRoot, readonly verificationCommands, and canReadPath. Its optional method overrides are only test seams. Default implementations call the newly exported workspace functions, readWorkspaceFile with MAX_READ_BYTES, existing runVerification with the matching configured command, and existing applyApprovedPatch. A missing override plus missing binding must reject CodeSentinelCoreError("UNSUPPORTED_TOOL"). The command lookup must reject an unconfigured ID before starting a process.

Use existing sibling relative imports, for example:

~~~ts
import type { Action, EventSink, HarnessEvent, VerificationCommand } from "../../contracts/src/index.js";
import type { BoundPolicy } from "../../policy/src/index.js";
import type { Provider } from "../../providers/src/index.js";
import {
  MAX_READ_BYTES,
  applyApprovedPatch,
  getWorkspaceFileHash,
  listWorkspaceFiles,
  readWorkspaceFile,
  runVerification,
  searchWorkspaceText,
} from "../../tools/src/index.js";
~~~

Export only the public types/functions from index.ts. Update package-lock.json with:

~~~powershell
npm install --package-lock-only --offline --ignore-scripts --no-audit --no-fund
~~~

- [ ] **Step 4: Run Core foundation tests to verify GREEN**

Run:

~~~powershell
npm test -- --run packages/core/src/context.test.ts packages/core/src/in-memory-event-sink.test.ts packages/core/src/tool-dispatcher.test.ts
npm run typecheck
~~~

Expected: all Core unit tests pass, no test calls a real Provider or starts a verification process except an explicitly injected fake.

- [ ] **Step 5: Commit Core foundations**

~~~powershell
git add packages/core package-lock.json
git commit -m "feat: add agent loop core foundations"
~~~

### Task 4: Implement bounded initial reproduction and Provider feedback cycles

**Files:**
- Create: packages/core/src/agent-loop.ts
- Create: packages/core/src/agent-loop.test.ts
- Create: packages/core/src/pending-patch-store.ts
- Modify: packages/core/src/types.ts
- Modify: packages/core/src/index.ts

- [ ] **Step 1: Write failing Agent Loop tests**

Create packages/core/src/agent-loop.test.ts with deterministic fakes. Use a ScriptedMockProvider only after Action contract fixtures include stage:

~~~ts
it("stops a passing initial repair verification without calling the provider", async () => {
  const provider = new ScriptedMockProvider([]);
  const fake = fakeTools({ verification: passingVerification });
  const controller = createAgentSessionController({
    provider,
    policy: allowPolicy,
    tools: fake.tools,
    eventSink: new InMemoryEventSink(),
    now: () => Date.parse("2026-07-29T00:00:00.000Z"),
    createId: sequenceIds(),
  });

  const result = await controller.runAgentSession({ session: createdRepairSession() });

  expect(result.session.state).toBe("stopped");
  expect(result.finalSummary).toBe("NOT_REPRODUCIBLE");
  expect(provider.requests).toEqual([]);
  expect(fake.applyApprovedPatch).not.toHaveBeenCalled();
});

it("puts initial failed verification feedback in the first provider request", async () => {
  const provider = new ScriptedMockProvider([
    { kind: "finish", outcome: "needs_human", summary: "inspect the failure" },
  ]);
  const fake = fakeTools({ verification: failedVerification });
  const controller = createAgentSessionController({
    provider,
    policy: allowPolicy,
    tools: fake.tools,
    eventSink: new InMemoryEventSink(),
    now: fixedNow,
    createId: sequenceIds(),
  });

  await controller.runAgentSession({ session: createdRepairSession() });

  expect(provider.requests).toHaveLength(1);
  expect(provider.requests[0]?.messages.at(-1)?.content).toContain("expected 2, received 1");
});

it("stops after exactly three unsuccessful provider decisions", async () => {
  const provider = new ScriptedMockProvider([
    { kind: "run_verification", commandId: "test" },
    { kind: "run_verification", commandId: "test" },
    { kind: "run_verification", commandId: "test" },
  ]);
  const fake = fakeTools({ verification: failedVerification });
  const controller = createAgentSessionController({
    provider,
    policy: allowPolicy,
    tools: fake.tools,
    eventSink: new InMemoryEventSink(),
    now: fixedNow,
    createId: sequenceIds(),
  });

  const result = await controller.runAgentSession({ session: createdRepairSession() });

  expect(result.session.round).toBe(3);
  expect(result.session.state).toBe("failed");
  expect(result.finalSummary).toBe("ROUND_LIMIT_REACHED");
  expect(provider.requests).toHaveLength(3);
});
~~~

Add tests for invalid Provider output, thrown ProviderError, denied Action, EventSink append rejection, and a model finish outcome of completed. Each must assert a stable Core summary, no later Provider request, and no tool call after the failure point.

- [ ] **Step 2: Run the loop test to record RED**

Run:

~~~powershell
npm test -- --run packages/core/src/agent-loop.test.ts
~~~

Expected: FAIL because createAgentSessionController and AgentSessionController do not exist.

- [ ] **Step 3: Implement private state and the loop**

In pending-patch-store.ts, use a controller-private Map keyed by sessionId plus approvalId. The stored record must contain the original Extract<Action, { kind: "propose_patch" }>, an Approval record, and a consumed boolean. Generate patchHash with createHash("sha256").update(action.patch, "utf8").digest("hex"). The view returned to the caller may include a readable diff but must be freshly copied/frozen. The internal record is never returned.

In agent-loop.ts, createAgentSessionController(deps). It must keep a private Map of stored sessions and one PendingPatchStore per controller instance. Implement this exact sequence:

1. Validate StartSessionInput before storing it. Reject an invalid state, round outside 0..3, blank summary, missing command ID, or a feature task without acceptance criteria with INVALID_SESSION_INPUT and no Provider/tool invocation.
2. For a created test_repair session, call tools.runVerification with the selected command before any Provider call. Append a verification event and state event. A completed exitCode 0 becomes stopped/NOT_REPRODUCIBLE. A non-completed status becomes failed/TOOL_FAILED. A completed nonzero result becomes the first bounded feedback item.
3. While state is running and round is below 3, call buildProviderRequest, then provider.complete exactly once. Parse the unknown response with ActionSchema. On parse error, use INVALID_ACTION; on thrown Provider error, use PROVIDER_FAILED; neither case may expose the thrown message.
4. Increment round only after a valid Action parses and append action. For propose_patch, reject a stage that does not match the private phase with blocked/FEATURE_STAGE_INVALID before Policy or tools. Otherwise evaluate BoundPolicy, then append policy. Policy deny becomes blocked/POLICY_DENIED. Policy ask is legal only for propose_patch; create a pending record, append state awaiting_approval, append approval pending, then return without calling a write tool.
5. For an allow decision, dispatch only list_files, read_file, search_text, and run_verification. Append tool_result after a successful read/browse call. A failed verification becomes bounded feedback; a passed repair verification becomes completed. The model finish outcome needs_human/blocked becomes blocked, failed becomes failed, and completed/not_reproducible becomes blocked/VERIFICATION_REQUIRED.
6. If a tool or EventSink fails, convert it to its stable Core code, set failed, append a final state only when doing so cannot trigger another action, and return. Never call another Provider after that result.
7. When a third decision completes without a terminal success or pending patch, set failed/ROUND_LIMIT_REACHED and append state. Do not make a fourth Provider call.

Every emitted HarnessEvent uses the injected clock converted to ISO text. Its summary must be a code, command ID, Action kind, policy reason, or already-redacted verification summary; never use error.message.

- [ ] **Step 4: Run the bounded-loop tests to verify GREEN**

Run:

~~~powershell
npm test -- --run packages/core/src/agent-loop.test.ts
npm run typecheck
~~~

Expected: all initial-reproduction, feedback, error, Policy-ordering, and three-round tests pass.

- [ ] **Step 5: Commit the bounded loop**

~~~powershell
git add packages/core/src/agent-loop.ts packages/core/src/agent-loop.test.ts packages/core/src/pending-patch-store.ts packages/core/src/types.ts packages/core/src/index.ts
git commit -m "feat: add bounded feedback agent loop"
~~~

### Task 5: Add trusted local patch approval and resume behavior

**Files:**
- Create: packages/core/src/approval-resume.test.ts
- Modify: packages/core/src/agent-loop.ts
- Modify: packages/core/src/pending-patch-store.ts
- Modify: packages/core/src/types.ts

- [ ] **Step 1: Write failing approval-resume tests**

Create packages/core/src/approval-resume.test.ts. Define this local builder before the tests; fakeTools accepts the named override values and returns its dispatcher under tools:

~~~ts
function createControllerThatProposesPatch(
  overrides: Parameters<typeof fakeTools>[0] = {},
) {
  const fake = fakeTools({
    currentBaseHash: "a".repeat(64),
    verification: passingVerification,
    ...overrides,
  });
  const provider = new ScriptedMockProvider([
    {
      kind: "propose_patch",
      stage: "repair",
      path: "src/math.ts",
      baseHash: "a".repeat(64),
      patch: "@@ -1 +1 @@\n-export const add = () => 0;\n+export const add = () => 2;",
      reason: "Fix incorrect addition",
    },
  ]);
  return {
    fake,
    controller: createAgentSessionController({
      provider,
      policy: askForPatchPolicy,
      tools: fake.tools,
      eventSink: new InMemoryEventSink(),
      now: fixedNow,
      createId: sequenceIds(),
    }),
  };
}
~~~

askForPatchPolicy must return ask/PATCH_REQUIRES_APPROVAL for propose_patch and allow/ALLOWED for every other Action. Start each test by making this Provider propose a valid repair-stage patch with a baseline hash, then assert:

~~~ts
it("returns a pending view without applying an unapproved patch", async () => {
  const applyApprovedPatch = vi.fn();
  const { controller } = createControllerThatProposesPatch({ applyApprovedPatch });

  const pending = await controller.runAgentSession({ session: createdRepairSession() });

  expect(pending.session.state).toBe("awaiting_approval");
  expect(pending.pendingPatch).toMatchObject({ stage: "repair", path: "src/math.ts" });
  expect(applyApprovedPatch).not.toHaveBeenCalled();
});

it("accepts only IDs, applies the original stored patch once, and verifies afterward", async () => {
  const applyApprovedPatch = vi.fn().mockResolvedValue({
    path: "src/math.ts",
    hash: "b".repeat(64),
  });
  const { controller } = createControllerThatProposesPatch({
    applyApprovedPatch,
    currentBaseHash: "a".repeat(64),
    verification: passingVerification,
  });

  const pending = await controller.runAgentSession({ session: createdRepairSession() });
  const result = await controller.resolvePendingPatch({
    sessionId: pending.session.id,
    approvalId: pending.pendingPatch?.approvalId ?? "",
    decision: "approve",
  });

  expect(applyApprovedPatch).toHaveBeenCalledOnce();
  expect(applyApprovedPatch.mock.calls[0]?.[0]).toMatchObject({
    path: "src/math.ts",
    patch: "@@ -1 +1 @@\n-export const add = () => 0;\n+export const add = () => 2;",
  });
  expect(result.session.state).toBe("completed");
  expect(result.finalSummary).toBe("VERIFICATION_PASSED");
});

it("does not write for rejection, expiry, changed baseline, wrong session, wrong approval, or replay", async () => {
  const applyApprovedPatch = vi.fn();
  const { controller } = createControllerThatProposesPatch({ applyApprovedPatch });
  const pending = await controller.runAgentSession({ session: createdRepairSession() });
  const approvalId = pending.pendingPatch?.approvalId ?? "";

  await controller.resolvePendingPatch({
    sessionId: pending.session.id,
    approvalId,
    decision: "reject",
  });
  await expect(
    controller.resolvePendingPatch({
      sessionId: pending.session.id,
      approvalId,
      decision: "approve",
    }),
  ).rejects.toMatchObject({ code: "APPROVAL_ALREADY_RESOLVED" });
  expect(applyApprovedPatch).not.toHaveBeenCalled();
});
~~~

Add separate tests that pass no patch/path/hash in ResolvePendingPatchInput at compile time, expire the clock beyond 15 minutes, return a different current base hash, force applyApprovedPatch to throw BASE_HASH_MISMATCH, and verify event order includes pending then approved/rejected/expired. For an approved patch whose controlled verification still fails, assert that the next Provider request receives the verification feedback only if fewer than three Provider decisions have been used.

- [ ] **Step 2: Run the approval-resume test to record RED**

Run:

~~~powershell
npm test -- --run packages/core/src/approval-resume.test.ts
~~~

Expected: FAIL because resolvePendingPatch is missing or cannot resolve the pending record safely.

- [ ] **Step 3: Implement the explicit local-only resolver**

Add ResolvePendingPatchInput exactly as:

~~~ts
export type ResolvePendingPatchInput = Readonly<{
  sessionId: string;
  approvalId: string;
  decision: "approve" | "reject";
}>;
~~~

resolvePendingPatch must atomically claim the private record before any decision. If it cannot find a matching unconsumed record, throw APPROVAL_NOT_FOUND or APPROVAL_ALREADY_RESOLVED. It must:

1. Call tools.getCurrentBaseHash using only the stored action.path.
2. Call rejectPatch or approvePatch using only the claimed Approval, current hash, and injected now value.
3. Emit an approval event before any possible patch write. Rejection, expiry, or a base mismatch changes the session to stopped and returns with no call to applyApprovedPatch.
4. On approved status, call tools.applyApprovedPatch with only the stored path, stored patch, and approved record. Never reconstruct this input from a caller payload.
5. Append tool_result, call the selected controlled verification, append verification, and map pass/fail through the same session transition helper used by the loop.
6. Treat a patch-tool BASE_HASH_MISMATCH, PATCH_HASH_MISMATCH, PATCH_NOT_APPLICABLE, or any other tool failure as failed/TOOL_FAILED; never reopen the consumed record.

Use the existing approvePatch, rejectPatch, and createPendingApproval functions from ../../policy/src/index.js. Make action and approval IDs using the injected createId. Set expiresAt to now() + 15 * 60 * 1000. Do not modify packages/policy/src/guardrail.ts or allow model-provided apply_approved_patch.

- [ ] **Step 4: Run approval tests to verify GREEN**

Run:

~~~powershell
npm test -- --run packages/core/src/approval-resume.test.ts packages/core/src/agent-loop.test.ts
npm run typecheck
~~~

Expected: every unapproved, forged, expired, changed-baseline, and replay scenario reports a stable result with zero writes; the valid approval applies exactly one stored patch and verifies it.

- [ ] **Step 5: Commit the approval boundary**

~~~powershell
git add packages/core/src/agent-loop.ts packages/core/src/pending-patch-store.ts packages/core/src/types.ts packages/core/src/approval-resume.test.ts
git commit -m "feat: add trusted patch approval resume"
~~~

### Task 6: Enforce feature test-first phases and complete Core integration coverage

**Files:**
- Create: packages/core/src/feature-flow.test.ts
- Modify: packages/core/src/agent-loop.ts
- Modify: packages/core/src/context.ts
- Modify: packages/core/src/agent-loop.test.ts
- Modify: packages/core/src/index.ts

- [ ] **Step 1: Write failing feature-flow tests**

Create packages/core/src/feature-flow.test.ts. Define this local builder before the tests:

~~~ts
function createFeatureController(input: {
  provider: Provider;
  verification: readonly VerificationResult[];
}) {
  const results = [...input.verification];
  const fake = fakeTools({
    runVerification: vi.fn(async () => results.shift() ?? passingVerification),
  });
  return createAgentSessionController({
    provider: input.provider,
    policy: askForPatchPolicy,
    tools: fake.tools,
    eventSink: new InMemoryEventSink(),
    now: fixedNow,
    createId: sequenceIds(),
  });
}
~~~

Define testStageProposal and implementationStageProposal in the same test file as valid propose_patch Actions with one stable path/baseHash/patch/reason pair and stage set to test and implementation respectively.

Then add:

~~~ts
it("requires acceptance criteria before a feature session calls the provider", async () => {
  const provider = new ScriptedMockProvider([]);
  const controller = createAgentSessionController({
    provider,
    policy: allowPolicy,
    tools: fakeTools().tools,
    eventSink: new InMemoryEventSink(),
    now: fixedNow,
    createId: sequenceIds(),
  });

  await expect(
    controller.runAgentSession({
      session: {
        ...createdFeatureSession(),
        acceptanceCriteria: "   ",
      },
    }),
  ).rejects.toMatchObject({ code: "INVALID_SESSION_INPUT" });
  expect(provider.requests).toEqual([]);
});

it("requires test proposal, RED, implementation proposal, and GREEN in order", async () => {
  const provider = new ScriptedMockProvider([
    testStageProposal,
    implementationStageProposal,
  ]);
  const controller = createFeatureController({
    provider,
    verification: [failedVerification, passingVerification],
  });

  const pendingTest = await controller.runAgentSession({
    session: createdFeatureSession(),
  });
  expect(pendingTest.pendingPatch?.stage).toBe("test");

  const pendingImplementation = await controller.resolvePendingPatch({
    sessionId: pendingTest.session.id,
    approvalId: pendingTest.pendingPatch?.approvalId ?? "",
    decision: "approve",
  });
  expect(pendingImplementation.pendingPatch?.stage).toBe("implementation");

  const completed = await controller.resolvePendingPatch({
    sessionId: pendingImplementation.session.id,
    approvalId: pendingImplementation.pendingPatch?.approvalId ?? "",
    decision: "approve",
  });
  expect(completed.session.state).toBe("completed");
  expect(completed.finalSummary).toBe("VERIFICATION_PASSED");
});
~~~

Add tests that reject repair-stage and implementation-stage proposals before a test patch, block an unexpected passing verification after an approved test patch with FEATURE_TEST_DID_NOT_FAIL, reject a test timeout/spawn failure, and preserve the three-Provider-decision budget across both approvals.

- [ ] **Step 2: Run feature-flow tests to record RED**

Run:

~~~powershell
npm test -- --run packages/core/src/feature-flow.test.ts
~~~

Expected: FAIL because the current loop has no private feature phase gate.

- [ ] **Step 3: Implement phase gates without changing Policy authorization**

In agent-loop.ts, store a private SessionPhase. A new feature session starts in awaiting_test_patch. Before evaluating a propose_patch, require:

~~~ts
function expectedPatchStage(phase: SessionPhase): AgentStage | undefined {
  if (phase === "awaiting_test_patch") {
    return "test";
  }
  if (phase === "awaiting_implementation_patch") {
    return "implementation";
  }
  if (phase === "repair") {
    return "repair";
  }
  return undefined;
}
~~~

If action.stage differs from expectedPatchStage, terminate blocked/FEATURE_STAGE_INVALID before Policy or tool dispatch. After approval of a test-stage patch, run the bound command. A completed nonzero verification transitions to awaiting_implementation_patch and resumes the loop with the RED summary. A zero exit transitions to blocked/FEATURE_TEST_DID_NOT_FAIL. A non-completed verification status transitions to failed/TOOL_FAILED. After approval of an implementation-stage patch, a zero exit completes with VERIFICATION_PASSED; a normal nonzero exit becomes feedback for another implementation proposal only while the round budget remains.

Update buildProviderRequest input to include the private phase and explicitly state the expected stage. The text is advisory only; expectedPatchStage is the authoritative gate. Keep stage strict in ActionSchema so the trace and user-visible pending view always state the declared intent.

- [ ] **Step 4: Run complete Task 8 focused tests to verify GREEN**

Run:

~~~powershell
npm test -- --run packages/contracts/src/action.test.ts packages/policy/src/guardrail.test.ts packages/tools/src/workspace.test.ts packages/core/src/context.test.ts packages/core/src/in-memory-event-sink.test.ts packages/core/src/tool-dispatcher.test.ts packages/core/src/agent-loop.test.ts packages/core/src/approval-resume.test.ts packages/core/src/feature-flow.test.ts
~~~

Expected: all Task 8 unit and integration tests pass with no network or real credential access.

- [ ] **Step 5: Commit feature sequencing**

~~~powershell
git add packages/core/src/agent-loop.ts packages/core/src/context.ts packages/core/src/feature-flow.test.ts packages/core/src/agent-loop.test.ts packages/core/src/index.ts
git commit -m "feat: enforce test-first feature repair flow"
~~~

### Task 7: Review the complete diff, run full verification, and record evidence

**Files:**
- Modify: PLAN.md
- Modify: AGENT_LOG.md
- Review: every Task 8 file listed above

- [ ] **Step 1: Perform a final implementation review**

Inspect the complete feature diff:

~~~powershell
git -c safe.directory="$PWD" diff --check docs-task8-agent-loop-design...HEAD
git -c safe.directory="$PWD" diff -- docs-task8-agent-loop-design...HEAD
~~~

Review these explicit questions before changing documentation:

1. Can any Provider response cause a file write without resolvePendingPatch receiving only a matching sessionId, approvalId, and approve decision?
2. Can a caller replace a stored path, patch, base hash, approval ID, action ID, or reuse a consumed record?
3. Does every path-based browse/read/search result remain inside the canonical workspace and skip symlinks, hard links, binary data, sensitive descendants, and bounds?
4. Does any event or Core error expose a sentinel secret, raw Error message, source file, command output, or Provider response?
5. Do test_repair and feature_implementation both preserve the three Provider-decision maximum and require controlled verification for completion?
6. Does the model-emitted apply_approved_patch Action remain denied by Policy?

Fix every confirmed issue with a new red test followed by the minimum implementation and a separate commit before continuing.

- [ ] **Step 2: Run all required verification**

Run:

~~~powershell
npm test
npm run typecheck
npm run lint
git -c safe.directory="$PWD" diff --check docs-task8-agent-loop-design...HEAD
~~~

Expected: all commands pass. Record actual test file/count/skip output and exact commands; do not claim the result if a command is skipped or fails.

- [ ] **Step 3: Update planning and evidence records**

In PLAN.md, mark Task 8 complete only after Step 2 is green and replace its old two-test outline with the final tested scope: initial verification, bounded loop, private approval resume, feature phase gates, events, controlled browse tools, and full verification commands.

In AGENT_LOG.md, record the actual red command/results, each implementation commit, reviewer findings and disposition, the final test/typecheck/lint/diff output, and that no long-running process was started. Do not write invented result counts or placeholder dates.

- [ ] **Step 4: Re-run documentation-sensitive verification**

Run:

~~~powershell
npm test
npm run typecheck
npm run lint
git -c safe.directory="$PWD" status --short --branch
~~~

Expected: code checks remain green and only the planned documentation files are unstaged or staged for the final evidence commit.

- [ ] **Step 5: Commit the evidence record**

~~~powershell
git add PLAN.md AGENT_LOG.md
git commit -m "docs: record Task 8 completion"
~~~

## Plan self-review

| Approved design requirement | Plan coverage |
| --- | --- |
| Initial test repair verification and not-reproducible stop | Task 4 |
| One schema-validated Action followed by Policy before tools | Tasks 1 and 4 |
| Three Provider-decision limit and feedback loop | Task 4 |
| Patch proposal only reaches awaiting approval | Tasks 4 and 5 |
| Trusted session/approval identity, expiry, baseline binding, and one-time write | Task 5 |
| Model cannot invoke apply_approved_patch | Tasks 1, 4, and 5 |
| Feature test → RED → implementation → GREEN | Tasks 1 and 6 |
| Bounded safe list/read/search/hash capabilities | Task 2 and Task 3 dispatcher wiring |
| Redacted, ordered approval/event observability | Tasks 1, 3, 4, and 5 |
| No real Provider/network/credential access in tests | Tasks 0 through 7 |
| Final security review, full validation, and evidence | Task 7 |

The file map gives every planned artifact one owner. Contract types are introduced before Core consumes them; Tool capabilities are introduced before the dispatcher binds them; the controller owns private state before any approval resolver exists. The plan contains no unselected behavior, placeholder task, or unbounded command path.
