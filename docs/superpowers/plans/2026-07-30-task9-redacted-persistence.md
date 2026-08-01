# Task 9 Redacted Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist CodeSentinel sessions as an ordered, structured, redacted SQLite audit timeline while keeping raw patches and secrets process-local.

**Architecture:** `packages/contracts` defines a strict discriminated event union, Core emits only safe structured facts, and a new `packages/persistence` workspace implements both `EventSink` and a typed session repository. Every event is validated and redacted before one SQLite transaction writes the timeline plus normalized records; file-backed databases use DELETE journal mode, session deletion cascades securely, and explicit restart recovery expires non-resumable approvals.

**Tech Stack:** TypeScript 5.9, Node.js 22.17.0 ESM, npm workspaces, Vitest 4.1, `better-sqlite3@13.0.1`, Zod 4.4 where an existing contract schema is reused.

**Authoritative spec:** `docs/superpowers/specs/2026-07-30-task9-redacted-persistence-design.md`

---

## File map

### Contracts and Core

- Modify `packages/contracts/src/events.ts`: strict event/detail unions and the `EventSink` port.
- Modify `packages/contracts/src/index.ts`: export the new event detail types.
- Create `packages/contracts/src/events.test.ts`: event detail and immutable-copy fixtures.
- Modify `packages/core/src/agent-loop.ts`: generate action IDs early and emit typed state/action/policy/tool/verification/approval facts.
- Modify `packages/core/src/pending-patch-store.ts`: return a private registration containing both view and Approval metadata.
- Modify `packages/core/src/in-memory-event-sink.ts`: deep-copy the typed details.
- Modify `packages/core/src/in-memory-event-sink.test.ts`: prove details are retained without aliasing.
- Modify `packages/core/src/agent-loop.test.ts`, `packages/core/src/approval-resume.test.ts`, and `packages/core/src/feature-flow.test.ts`: verify structured facts and preserve Task 8 security behavior.

### Persistence workspace

- Create `packages/persistence/package.json`: private ESM workspace and exact SQLite dependency.
- Create `packages/persistence/src/constants.ts`: all fixed storage, text, ID, timeout, and schema limits.
- Create `packages/persistence/src/errors.ts`: stable public error codes without native causes.
- Create `packages/persistence/src/redaction.ts`: bounded, idempotent persistence redaction.
- Create `packages/persistence/src/types.ts`: immutable session, memory, typed entry, and repository interfaces.
- Create `packages/persistence/src/schema.ts`: connection hardening, schema bootstrap, validation, DDL, indexes, and triggers.
- Create `packages/persistence/src/session-repository.ts`: validation, prepared statements, transactions, mapping, clear, and recovery.
- Create `packages/persistence/src/index.ts`: public exports only.

### Tests and evidence

- Create `packages/persistence/src/redaction.test.ts`: known secret patterns and boundary behavior.
- Create `packages/persistence/src/schema.test.ts`: PRAGMA, version, schema, cascade, and safe-error tests.
- Create `packages/persistence/src/session-repository.test.ts`: ordered events and normalized record behavior.
- Create `packages/persistence/src/session-lifecycle.test.ts`: memory, clear, and restart recovery.
- Create `packages/persistence/src/core-integration.test.ts`: real Core → SQLite event flow and file-byte sentinel checks.
- Modify `PLAN.md`: replace the obsolete Task 9 sketch with links to this spec and plan.
- Modify `AGENT_LOG.md`: record RED/GREEN evidence, review results, and final verification.

## Fixed public types and constants

These names and values are authoritative for every task below:

```ts
export const PERSISTENCE_SCHEMA_VERSION = 1;
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;
export const MAX_PERSISTED_IDENTIFIER_CHARACTERS = 128;
export const MAX_PERSISTED_TEXT_INPUT_CHARACTERS = 65_536;
export const MAX_PERSISTED_SUMMARY_CHARACTERS = 4_096;
export const REDACTED_VALUE = "[REDACTED]";
```

```ts
export type PersistenceErrorCode =
  | "INVALID_PERSISTENCE_INPUT"
  | "SESSION_NOT_FOUND"
  | "INVALID_EVENT_SEQUENCE"
  | "DUPLICATE_RECORD"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "REPOSITORY_CLOSED"
  | "PERSISTENCE_FAILED";
```

```ts
export interface SessionRepository extends EventSink {
  createSession(input: CreatePersistedSessionInput): Promise<void>;
  loadSession(sessionId: string): Promise<PersistedSession | undefined>;
  appendAction(input: AppendActionInput): Promise<void>;
  saveApproval(input: SaveApprovalInput): Promise<void>;
  appendVerification(input: AppendVerificationInput): Promise<void>;
  saveSessionMemory(input: SaveSessionMemoryInput): Promise<void>;
  loadSessionMemory(sessionId: string): Promise<PersistedSessionMemory | undefined>;
  loadTimeline(sessionId: string): Promise<readonly HarnessEvent[]>;
  recoverInterruptedSessions(now: number): Promise<number>;
  clearSession(sessionId: string): Promise<void>;
  close(): void;
}

export function createSessionRepository(databasePath: string): SessionRepository;
```

`loadSession`, `loadSessionMemory`, and `loadTimeline` return `undefined`, `undefined`, and `[]` respectively for an unknown or cleared session. All mutating calls except idempotent `clearSession` require an existing session.

---

### Task 1: Add strict structured Harness events

**Files:**
- Modify: `packages/contracts/src/events.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/events.test.ts`
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/src/pending-patch-store.ts`
- Modify: `packages/core/src/in-memory-event-sink.ts`
- Modify: `packages/core/src/in-memory-event-sink.test.ts`
- Modify: `packages/core/src/agent-loop.test.ts`
- Modify: `packages/core/src/approval-resume.test.ts`
- Modify: `packages/core/src/feature-flow.test.ts`

- [ ] **Step 1: Add failing event-detail tests**

Add tests that require a deep-copied `details` object and real Core facts:

```ts
it("retains an immutable structured action detail", async () => {
  const sink = new InMemoryEventSink();
  const event: HarnessEvent = {
    sessionId: "session-1",
    round: 1,
    kind: "action",
    summary: "read_file",
    occurredAt: "2026-07-30T00:00:00.000Z",
    details: { actionId: "action-1", actionKind: "read_file" },
  };

  await sink.append(event);
  const stored = sink.events[0];
  expect(stored).toEqual(event);
  expect(stored?.details).not.toBe(event.details);
  expect(Object.isFrozen(stored?.details)).toBe(true);
});
```

```ts
it("emits non-secret verification facts", async () => {
  const result = await createController(
    new ScriptedMockProvider([{ kind: "finish", outcome: "needs_human", summary: "stop" }]),
    fakeTools({ verification: failedVerification }).tools,
  ).runAgentSession({ session: createdRepairSession() });

  expect(result.events[0]).toMatchObject({
    kind: "verification",
    details: {
      commandId: "test",
      exitCode: 1,
      durationMs: 4,
      status: "completed",
      timedOut: false,
    },
  });
});
```

Add approval coverage that asserts `approval.details.actionId` equals the preceding `action.details.actionId`, and existing tests that mutate/copy events must assert no `details` alias survives.

Add table-driven Core tests for a verification result with negative `durationMs`, non-safe-integer `durationMs`, and a status/`timedOut` mismatch. Each must end on the existing `TOOL_FAILED` path without emitting a verification event for the malformed result. Cover the initial verification path and one post-action or post-patch path so every detail mapper consumes the same validated observation type.

Add action-ID tests where `createId` throws or returns an out-of-grammar/key-like value. Each must fail closed before the action event and before any Provider-selected tool side effect; no unsafe ID may appear in the result.

- [ ] **Step 2: Run the tests to record RED**

Run:

```powershell
npm test -- --run packages/contracts/src/events.test.ts packages/core/src/in-memory-event-sink.test.ts packages/core/src/agent-loop.test.ts packages/core/src/approval-resume.test.ts packages/core/src/feature-flow.test.ts
```

Expected: FAIL because current events omit `details`, the in-memory sink drops it, and the Core action/approval IDs are not shared.

- [ ] **Step 3: Define the discriminated event union**

Replace `packages/contracts/src/events.ts` with the following shape:

```ts
import type { Action, PolicyDecision, SessionState } from "./action.js";

type EventBase = Readonly<{
  sessionId: string;
  round: number;
  summary: string;
  occurredAt: string;
}>;

export type HarnessVerificationStatus =
  | "completed"
  | "timed_out"
  | "spawn_failed"
  | "output_limit";
export type HarnessApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type HarnessToolKind =
  | "list_files"
  | "read_file"
  | "search_text"
  | "apply_approved_patch";

export type HarnessEvent =
  | (EventBase & Readonly<{
      kind: "action";
      details: Readonly<{ actionId: string; actionKind: Action["kind"] }>;
    }>)
  | (EventBase & Readonly<{
      kind: "policy";
      details: Readonly<{ decision: PolicyDecision }>;
    }>)
  | (EventBase & Readonly<{
      kind: "tool_result";
      details: Readonly<{ toolKind: HarnessToolKind }>;
    }>)
  | (EventBase & Readonly<{
      kind: "verification";
      details: Readonly<{
        commandId: string;
        exitCode: number | null;
        durationMs: number;
        status: HarnessVerificationStatus;
        timedOut: boolean;
      }>;
    }>)
  | (EventBase & Readonly<{
      kind: "state";
      details: Readonly<{ state: SessionState }>;
    }>)
  | (EventBase & Readonly<{
      kind: "approval";
      details: Readonly<{
        approvalId: string;
        actionId: string;
        patchHash: string;
        baseHash: string;
        status: HarnessApprovalStatus;
        createdAt: number;
        expiresAt: number;
      }>;
    }>);

export type HarnessEventPayload = {
  [Kind in HarnessEvent["kind"]]: Omit<
    Extract<HarnessEvent, { kind: Kind }>,
    "sessionId" | "round" | "occurredAt"
  >;
}[HarnessEvent["kind"]];

export interface EventSink {
  append(event: HarnessEvent): Promise<void>;
}
```

Export every new public type from `packages/contracts/src/index.ts`.

- [ ] **Step 4: Emit exact Core details**

Change the Core helper to accept a `HarnessEventPayload`, create/freeze details, and use the real session state:

```ts
async function appendEvent(
  record: SessionRecord,
  payload: HarnessEventPayload,
): Promise<boolean> {
  try {
    const event = Object.freeze({
      sessionId: record.session.id,
      round: record.session.round,
      kind: payload.kind,
      summary: payload.summary,
      occurredAt: new Date(dependencies.now()).toISOString(),
      details: Object.freeze({ ...payload.details }),
    }) as HarnessEvent;
    await dependencies.eventSink.append(event);
    record.events.push(copyEvent(event));
    return true;
  } catch {
    return false;
  }
}
```

Generate `actionId` immediately after `ActionSchema` succeeds and before the action event. Validate it with the same narrow ASCII rule used by Persistence, emit it in the action details, pass it through `handleAction`, and reuse it in `PendingPatchStore.create`:

```ts
const GENERATED_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const GENERATED_KEY_FRAGMENT = /(?:sk-|sk_|pk_|rk_|ghp_)[A-Za-z0-9_-]{12,}/iu;

function isSafeGeneratedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    GENERATED_IDENTIFIER.test(value) &&
    !GENERATED_KEY_FRAGMENT.test(value)
  );
}
```

```ts
let actionId: string;
try {
  actionId = dependencies.createId();
} catch {
  return terminal(record, "failed", "TOOL_FAILED");
}
if (!isSafeGeneratedIdentifier(actionId)) {
  return terminal(record, "failed", "TOOL_FAILED");
}
if (!(await appendEvent(record, {
  kind: "action",
  summary: action.kind,
  details: { actionId, actionKind: action.kind },
}))) {
  return eventSinkFailure(record);
}
```

Make `PendingPatchStore.create` return:

```ts
export type PendingPatchRegistration = Readonly<{
  view: PendingPatchView;
  approval: Approval;
}>;
```

The internal record and public view remain copied and frozen. Add small helpers that map a verified `VerificationResult` and `Approval` into details. Use this exact mapping at every call site:

| Event | Detail source |
|---|---|
| `state` | `record.session.state` after `setState` |
| `policy` | `policy.decision` returned by `BoundPolicy.evaluate` |
| browse `tool_result` | the parsed action kind |
| applied patch `tool_result` | literal `apply_approved_patch` |
| `verification` | validated `VerificationResult` fields |
| `approval` | immutable pending Approval from `PendingPatchStore`, or immutable final Approval returned by the resolution helper |

Never derive a structured field by parsing `summary`.

Extend the private `VerificationObservation` and `readVerification` result to retain the already validated `durationMs` and `timedOut` fields. Reject negative or non-safe durations and inconsistent timeout facts before emitting any verification event; every initial, Provider-requested, and post-patch verification call site must pass the complete observation to the detail mapper.

Change `createPendingPatch` to receive the previously generated `actionId`, generate and validate only a new `approvalId`, and retain the returned `PendingPatchRegistration`. The pending event uses `registration.approval`. On resolution, the approved/rejected/expired event uses the final immutable Approval returned by `approvePatch` or `rejectPatch`; pass that object into `stopResolvedApproval` instead of reconstructing status from the summary.

- [ ] **Step 5: Deep-copy every detail variant**

Use an exhaustive switch in `in-memory-event-sink.ts` and the Agent result copy helper:

```ts
function copyEvent(event: HarnessEvent): HarnessEvent {
  const base = {
    sessionId: event.sessionId,
    round: event.round,
    kind: event.kind,
    summary: event.summary,
    occurredAt: event.occurredAt,
  };
  switch (event.kind) {
    case "action":
      return Object.freeze({
        ...base,
        kind: "action",
        details: Object.freeze({
          actionId: event.details.actionId,
          actionKind: event.details.actionKind,
        }),
      });
    case "policy":
      return Object.freeze({
        ...base,
        kind: "policy",
        details: Object.freeze({ decision: event.details.decision }),
      });
    case "tool_result":
      return Object.freeze({
        ...base,
        kind: "tool_result",
        details: Object.freeze({ toolKind: event.details.toolKind }),
      });
    case "verification":
      return Object.freeze({
        ...base,
        kind: "verification",
        details: Object.freeze({
          commandId: event.details.commandId,
          exitCode: event.details.exitCode,
          durationMs: event.details.durationMs,
          status: event.details.status,
          timedOut: event.details.timedOut,
        }),
      });
    case "state":
      return Object.freeze({
        ...base,
        kind: "state",
        details: Object.freeze({ state: event.details.state }),
      });
    case "approval":
      return Object.freeze({
        ...base,
        kind: "approval",
        details: Object.freeze({
          approvalId: event.details.approvalId,
          actionId: event.details.actionId,
          patchHash: event.details.patchHash,
          baseHash: event.details.baseHash,
          status: event.details.status,
          createdAt: event.details.createdAt,
          expiresAt: event.details.expiresAt,
        }),
      });
  }
}
```

Do not use JSON serialization and do not copy undeclared runtime keys.

- [ ] **Step 6: Run GREEN checks**

Run:

```powershell
npm test -- --run packages/contracts/src/events.test.ts packages/core/src/in-memory-event-sink.test.ts packages/core/src/agent-loop.test.ts packages/core/src/approval-resume.test.ts packages/core/src/feature-flow.test.ts
npm run typecheck
```

Expected: all selected tests PASS and typecheck exits 0. Re-run existing command-binding tests in the selected Core files to prove the extra `createId` call did not weaken Task 8 behavior.

- [ ] **Step 7: Commit**

```powershell
git add packages/contracts/src/events.ts packages/contracts/src/index.ts packages/contracts/src/events.test.ts packages/core/src/agent-loop.ts packages/core/src/pending-patch-store.ts packages/core/src/in-memory-event-sink.ts packages/core/src/in-memory-event-sink.test.ts packages/core/src/agent-loop.test.ts packages/core/src/approval-resume.test.ts packages/core/src/feature-flow.test.ts
git commit -m "feat: add structured harness audit events"
```

---

### Task 2: Add the bounded persistence redactor

**Files:**
- Create: `packages/persistence/package.json`
- Modify: `package-lock.json`
- Create: `packages/persistence/src/constants.ts`
- Create: `packages/persistence/src/errors.ts`
- Create: `packages/persistence/src/redaction.ts`
- Create: `packages/persistence/src/redaction.test.ts`
- Create: `packages/persistence/src/index.ts`

- [ ] **Step 1: Write the failing redaction tests before the workspace implementation**

Create only `packages/persistence/src/redaction.test.ts` at this step. Root Vitest discovers files under `packages/**` without a nested manifest, so the missing `./redaction.js` import is the intended RED. Add table-driven tests:

```ts
it.each([
  ["Authorization: Bearer sk-proj-1234567890abcdef", "sk-proj-1234567890abcdef"],
  ["api_key=sk_1234567890abcdef", "sk_1234567890abcdef"],
  ['{"refresh_token":"token-value-123456"}', "token-value-123456"],
  ["token\u200B=split-secret-value", "split-secret-value"],
  ["ghp_1234567890abcdef", "ghp_1234567890abcdef"],
  ["x".repeat(40), "x".repeat(40)],
])("redacts a known secret before persistence", (input, secret) => {
  const output = redactText(input);
  expect(output).toContain(REDACTED_VALUE);
  expect(output).not.toContain(secret);
  expect(redactText(output)).toBe(output);
});

it("rejects oversized input without echoing it", () => {
  const secret = `sk-proj-${"x".repeat(70_000)}`;
  expect(() => redactText(secret)).toThrowError(
    expect.objectContaining({ code: "INVALID_PERSISTENCE_INPUT" }),
  );
  try {
    redactText(secret);
  } catch (error) {
    expect(JSON.stringify(error)).not.toContain(secret);
  }
});
```

Add these exact boundary assertions:

```ts
it("preserves ordinary text and accepts the exact scan limit", () => {
  expect(redactText("ordinary compiler summary")).toBe("ordinary compiler summary");
  const atLimit = "safe text ".repeat(7_282).slice(0, 65_536);
  expect(atLimit).toHaveLength(65_536);
  expect(redactText(atLimit)).toHaveLength(4_096);
});

it("redacts a token that straddles the output boundary before truncating", () => {
  const input = `${"a ".repeat(2_043)}sk-proj-1234567890abcdef`;
  const output = redactText(input);
  expect(output).toContain(REDACTED_VALUE);
  expect(output).not.toContain("sk-proj-1234567890abcdef");
  expect(output).not.toMatch(/sk-proj-?$/u);
});
```

- [ ] **Step 2: Run the test to record RED**

Run:

```powershell
npm test -- --run packages/persistence/src/redaction.test.ts
```

Expected: FAIL because the persistence workspace and redactor do not exist.

- [ ] **Step 3: Create the workspace manifest, constants, and stable errors**

Create `packages/persistence/package.json` only after the RED result:

```json
{
  "name": "@kadsoo/codesentinel-persistence",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": {
    "better-sqlite3": "13.0.1"
  }
}
```

Create the constants listed in this plan. Implement:

```ts
export class CodeSentinelPersistenceError extends Error {
  readonly code: PersistenceErrorCode;

  constructor(code: PersistenceErrorCode) {
    super(code);
    this.name = "CodeSentinelPersistenceError";
    this.code = code;
  }
}

export function persistenceError(code: PersistenceErrorCode): CodeSentinelPersistenceError {
  return new CodeSentinelPersistenceError(code);
}
```

Do not accept a message or cause argument. Do not log caught values.

- [ ] **Step 4: Implement redact-before-truncate**

Implement `redactText(value: string)` in this exact order:

```ts
export function redactText(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_PERSISTED_TEXT_INPUT_CHARACTERS
  ) {
    throw persistenceError("INVALID_PERSISTENCE_INPUT");
  }

  const normalized = value.replace(/[\p{Cc}\p{Cf}]/gu, "");
  const redacted = normalized
    .replace(/\bBearer\s+[^\s,;}]+/giu, `Bearer ${REDACTED_VALUE}`)
    .replace(
      /(\b(?:authorization|(?:[a-z][a-z0-9_.-]*)?(?:key|token|secret|password|passwd|pwd|credential))\b\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/giu,
      `$1${REDACTED_VALUE}`,
    )
    .replace(/\b(?:sk-|sk_|pk_|rk_|ghp_)[a-z0-9_-]{12,}\b/giu, REDACTED_VALUE)
    .replace(/(?<![a-z0-9+/_=-])[a-z0-9+/_=-]{32,}(?![a-z0-9+/_=-])/giu, REDACTED_VALUE);

  return redacted.length <= MAX_PERSISTED_SUMMARY_CHARACTERS
    ? redacted
    : redacted.slice(0, MAX_PERSISTED_SUMMARY_CHARACTERS);
}
```

The quoted JSON test must produce syntactically bounded output whose secret value is replaced; do not weaken any pattern or move truncation before redaction.

- [ ] **Step 5: Export and run GREEN checks**

Export constants, errors, and `redactText` from `index.ts`.

Run:

```powershell
npm install --package-lock-only --ignore-scripts --offline
npm test -- --run packages/persistence/src/redaction.test.ts
npm run typecheck
```

Expected: the lockfile adds the persistence workspace without changing the pinned SQLite version; tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit**

```powershell
git add package-lock.json packages/persistence/package.json packages/persistence/src/constants.ts packages/persistence/src/errors.ts packages/persistence/src/redaction.ts packages/persistence/src/redaction.test.ts packages/persistence/src/index.ts
git commit -m "feat: add bounded persistence redaction"
```

---

### Task 3: Initialize and validate the SQLite session store

**Files:**
- Create: `packages/persistence/src/types.ts`
- Create: `packages/persistence/src/schema.ts`
- Create: `packages/persistence/src/schema.test.ts`
- Create: `packages/persistence/src/session-repository.ts`
- Modify: `packages/persistence/src/index.ts`

- [ ] **Step 1: Write failing schema and session tests**

Use temporary files and `:memory:`:

```ts
it("initializes a hardened version-one in-memory database", async () => {
  const database = openSessionDatabase(":memory:");
  expect(database.pragma("user_version", { simple: true })).toBe(1);
  expect(database.pragma("journal_mode", { simple: true })).toBe("memory");
  expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
  expect(database.pragma("secure_delete", { simple: true })).toBe(1);
  expect(database.pragma("busy_timeout", { simple: true })).toBe(5_000);
  database.close();
});

it("uses DELETE journal mode for a file database", async () => {
  await withDatabasePath(async (databasePath) => {
    const database = openSessionDatabase(databasePath);
    expect(database.pragma("journal_mode", { simple: true })).toBe("delete");
    database.close();
  });
});
```

`schema.test.ts` imports `openSessionDatabase` directly from `./schema.js`; `packages/persistence/src/index.ts` does not export it. Repository behavior is tested separately through the public factory.

The same test file must contain named assertions for: version 0 nonempty DB → `UNSUPPORTED_SCHEMA_VERSION`; version 2 DB → `UNSUPPORTED_SCHEMA_VERSION`; partial version 1 schema → `UNSUPPORTED_SCHEMA_VERSION`; a version 1 table with the right columns but a removed `CHECK` or `UNIQUE` → `UNSUPPORTED_SCHEMA_VERSION`; a wrong index definition → `UNSUPPORTED_SCHEMA_VERSION`; any extra user table/index/trigger/view → `UNSUPPORTED_SCHEMA_VERSION`; duplicate session ID → `DUPLICATE_RECORD`; invalid ID/state/round/timestamp → `INVALID_PERSISTENCE_INPUT`; two `close()` calls → no throw; and every post-close repository method → `REPOSITORY_CLOSED`.

Add one deterministic native-error sentinel test. Use a controlled nonexistent parent path whose final component contains `sk-proj-native-error-sentinel-1234`, call `createSessionRepository`, and inspect the caught public error. Its `name`, `message`, and `code` must be fixed and it must have no own `cause`. Serialize one inspection object containing `message`, `stack`, `Reflect.ownKeys(error).map(String)`, `Object.getOwnPropertyDescriptors(error)`, and `JSON.stringify(error)`; that inspection string must contain neither the sentinel nor the database path.

- [ ] **Step 2: Run the tests to record RED**

Run:

```powershell
npm test -- --run packages/persistence/src/schema.test.ts
```

Expected: FAIL because schema and repository modules are missing.

- [ ] **Step 3: Define immutable repository types**

In `types.ts`, define:

```ts
export type CreatePersistedSessionInput = Readonly<{
  id: string;
  taskKind: TaskKind;
  state: "created";
  round: 0;
  workspaceId: string;
  providerId: string;
  verificationCommandId: string;
  createdAt: string;
}>;

export type PersistedSession = Readonly<{
  id: string;
  taskKind: TaskKind;
  state: SessionState;
  round: number;
  workspaceId: string;
  providerId: string;
  verificationCommandId: string;
  createdAt: string;
  updatedAt: string;
}>;

export type AppendActionInput = Readonly<{
  sessionId: string;
  round: number;
  occurredAt: string;
  actionId: string;
  actionKind: Extract<HarnessEvent, { kind: "action" }>["details"]["actionKind"];
  inputSummary: string;
}>;

export type SaveApprovalInput = Readonly<{
  sessionId: string;
  round: number;
  occurredAt: string;
  summary: string;
  details: Extract<HarnessEvent, { kind: "approval" }>["details"];
}>;

export type AppendVerificationInput = Readonly<{
  sessionId: string;
  round: number;
  occurredAt: string;
  summary: string;
  details: Extract<HarnessEvent, { kind: "verification" }>["details"];
}>;

export type SaveSessionMemoryInput = Readonly<{
  sessionId: string;
  summary: string;
  updatedAt: string;
}>;

export type PersistedSessionMemory = Readonly<{
  sessionId: string;
  summary: string;
  updatedAt: string;
}>;
```

Define the complete `SessionRepository` interface from the plan header using these exact input types.

- [ ] **Step 4: Create full schema DDL and indexes**

`schema.ts` must create these six tables:

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  task_kind TEXT NOT NULL CHECK(task_kind IN ('test_repair', 'feature_implementation')),
  state TEXT NOT NULL CHECK(state IN (
    'created', 'running', 'awaiting_approval', 'completed', 'blocked', 'failed', 'stopped'
  )),
  round INTEGER NOT NULL CHECK(round BETWEEN 0 AND 3),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 128),
  provider_id TEXT NOT NULL CHECK(length(provider_id) BETWEEN 1 AND 128),
  verification_command_id TEXT NOT NULL CHECK(length(verification_command_id) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE timeline_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  round INTEGER NOT NULL CHECK(round BETWEEN 0 AND 3),
  kind TEXT NOT NULL CHECK(kind IN (
    'action', 'policy', 'tool_result', 'verification', 'state', 'approval'
  )),
  summary TEXT NOT NULL CHECK(length(summary) <= 4096),
  occurred_at TEXT NOT NULL,
  action_id TEXT CHECK(action_id IS NULL OR length(action_id) BETWEEN 1 AND 128),
  action_kind TEXT CHECK(action_kind IN (
    'list_files', 'read_file', 'search_text', 'propose_patch',
    'apply_approved_patch', 'run_verification', 'finish'
  )),
  policy_decision TEXT CHECK(policy_decision IN ('allow', 'ask', 'deny')),
  tool_kind TEXT CHECK(tool_kind IN (
    'list_files', 'read_file', 'search_text', 'apply_approved_patch'
  )),
  command_id TEXT CHECK(command_id IS NULL OR length(command_id) BETWEEN 1 AND 128),
  exit_code INTEGER,
  duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
  verification_status TEXT CHECK(verification_status IN (
    'completed', 'timed_out', 'spawn_failed', 'output_limit'
  )),
  timed_out INTEGER CHECK(timed_out IN (0, 1)),
  session_state TEXT CHECK(session_state IN (
    'created', 'running', 'awaiting_approval', 'completed', 'blocked', 'failed', 'stopped'
  )),
  approval_id TEXT CHECK(approval_id IS NULL OR length(approval_id) BETWEEN 1 AND 128),
  approval_action_id TEXT CHECK(
    approval_action_id IS NULL OR length(approval_action_id) BETWEEN 1 AND 128
  ),
  patch_hash TEXT CHECK(
    patch_hash IS NULL OR (length(patch_hash) = 64 AND patch_hash NOT GLOB '*[^0-9a-f]*')
  ),
  base_hash TEXT CHECK(
    base_hash IS NULL OR (length(base_hash) = 64 AND base_hash NOT GLOB '*[^0-9a-f]*')
  ),
  approval_status TEXT CHECK(approval_status IN ('pending', 'approved', 'rejected', 'expired')),
  approval_created_at INTEGER,
  approval_expires_at INTEGER,
  CHECK (
    (
      kind = 'action'
      AND action_id IS NOT NULL AND action_kind IS NOT NULL
      AND policy_decision IS NULL AND tool_kind IS NULL
      AND command_id IS NULL AND exit_code IS NULL AND duration_ms IS NULL
      AND verification_status IS NULL AND timed_out IS NULL AND session_state IS NULL
      AND approval_id IS NULL AND approval_action_id IS NULL
      AND patch_hash IS NULL AND base_hash IS NULL AND approval_status IS NULL
      AND approval_created_at IS NULL AND approval_expires_at IS NULL
    ) OR (
      kind = 'policy'
      AND policy_decision IS NOT NULL
      AND action_id IS NULL AND action_kind IS NULL AND tool_kind IS NULL
      AND command_id IS NULL AND exit_code IS NULL AND duration_ms IS NULL
      AND verification_status IS NULL AND timed_out IS NULL AND session_state IS NULL
      AND approval_id IS NULL AND approval_action_id IS NULL
      AND patch_hash IS NULL AND base_hash IS NULL AND approval_status IS NULL
      AND approval_created_at IS NULL AND approval_expires_at IS NULL
    ) OR (
      kind = 'tool_result'
      AND tool_kind IS NOT NULL
      AND action_id IS NULL AND action_kind IS NULL AND policy_decision IS NULL
      AND command_id IS NULL AND exit_code IS NULL AND duration_ms IS NULL
      AND verification_status IS NULL AND timed_out IS NULL AND session_state IS NULL
      AND approval_id IS NULL AND approval_action_id IS NULL
      AND patch_hash IS NULL AND base_hash IS NULL AND approval_status IS NULL
      AND approval_created_at IS NULL AND approval_expires_at IS NULL
    ) OR (
      kind = 'verification'
      AND command_id IS NOT NULL AND duration_ms IS NOT NULL
      AND verification_status IS NOT NULL AND timed_out IS NOT NULL
      AND action_id IS NULL AND action_kind IS NULL AND policy_decision IS NULL
      AND tool_kind IS NULL AND session_state IS NULL
      AND approval_id IS NULL AND approval_action_id IS NULL
      AND patch_hash IS NULL AND base_hash IS NULL AND approval_status IS NULL
      AND approval_created_at IS NULL AND approval_expires_at IS NULL
    ) OR (
      kind = 'state'
      AND session_state IS NOT NULL
      AND action_id IS NULL AND action_kind IS NULL AND policy_decision IS NULL
      AND tool_kind IS NULL AND command_id IS NULL AND exit_code IS NULL
      AND duration_ms IS NULL AND verification_status IS NULL AND timed_out IS NULL
      AND approval_id IS NULL AND approval_action_id IS NULL
      AND patch_hash IS NULL AND base_hash IS NULL AND approval_status IS NULL
      AND approval_created_at IS NULL AND approval_expires_at IS NULL
    ) OR (
      kind = 'approval'
      AND approval_id IS NOT NULL AND approval_action_id IS NOT NULL
      AND patch_hash IS NOT NULL AND base_hash IS NOT NULL
      AND approval_status IS NOT NULL
      AND approval_created_at IS NOT NULL AND approval_expires_at IS NOT NULL
      AND approval_expires_at > approval_created_at
      AND action_id IS NULL AND action_kind IS NULL AND policy_decision IS NULL
      AND tool_kind IS NULL AND command_id IS NULL AND exit_code IS NULL
      AND duration_ms IS NULL AND verification_status IS NULL
      AND timed_out IS NULL AND session_state IS NULL
    )
  )
);

CREATE TABLE action_records (
  action_id TEXT PRIMARY KEY CHECK(length(action_id) BETWEEN 1 AND 128),
  event_id INTEGER NOT NULL UNIQUE REFERENCES timeline_events(event_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  round INTEGER NOT NULL CHECK(round BETWEEN 1 AND 3),
  action_kind TEXT NOT NULL CHECK(action_kind IN (
    'list_files', 'read_file', 'search_text', 'propose_patch',
    'apply_approved_patch', 'run_verification', 'finish'
  )),
  input_summary TEXT NOT NULL CHECK(length(input_summary) <= 4096),
  policy_decision TEXT CHECK(policy_decision IN ('allow', 'ask', 'deny')),
  result_summary TEXT CHECK(result_summary IS NULL OR length(result_summary) <= 4096),
  UNIQUE(session_id, round)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  action_id TEXT NOT NULL UNIQUE REFERENCES action_records(action_id) ON DELETE CASCADE,
  patch_hash TEXT NOT NULL CHECK(length(patch_hash) = 64 AND patch_hash NOT GLOB '*[^0-9a-f]*'),
  base_hash TEXT NOT NULL CHECK(length(base_hash) = 64 AND base_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at)
);

CREATE TABLE verification_runs (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL UNIQUE REFERENCES timeline_events(event_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  round INTEGER NOT NULL CHECK(round BETWEEN 0 AND 3),
  command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 128),
  exit_code INTEGER,
  duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
  status TEXT NOT NULL CHECK(status IN ('completed', 'timed_out', 'spawn_failed', 'output_limit')),
  timed_out INTEGER NOT NULL CHECK(timed_out IN (0, 1)),
  summary TEXT NOT NULL CHECK(length(summary) <= 4096)
);

CREATE TABLE session_memory (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  summary TEXT NOT NULL CHECK(length(summary) <= 4096),
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_timeline_session_event ON timeline_events(session_id, event_id);
CREATE INDEX idx_approvals_session_status ON approvals(session_id, status);
CREATE INDEX idx_verification_session_event ON verification_runs(session_id, event_id);

CREATE TRIGGER approval_status_forward
BEFORE UPDATE OF status ON approvals
WHEN NOT (
  OLD.status = 'pending'
  AND NEW.status IN ('approved', 'rejected', 'expired')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid approval transition');
END;
```

Keep each `CREATE TABLE`, `CREATE INDEX`, and `CREATE TRIGGER` statement above in its own named constant. Build `SCHEMA_SQL` only by joining those ten constants in the displayed order; do not maintain a second, divergent DDL copy. Compare normalized schema text with:

```ts
function normalizeSchemaSql(value: string | undefined): string {
  return (value ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/;$/u, "")
    .toLowerCase();
}
```

- [ ] **Step 5: Harden connection and bootstrap atomically**

Implement:

```ts
export function openSessionDatabase(databasePath: string): Database.Database {
  let database: Database.Database | undefined;
  try {
    database = new Database(databasePath);
    const bootstrap = readBootstrapState(database);
    const expectedJournal = databasePath === ":memory:" ? "memory" : "delete";
    const journal = String(database.pragma("journal_mode = DELETE", { simple: true })).toLowerCase();
    if (journal !== expectedJournal) throw persistenceError("PERSISTENCE_FAILED");

    database.pragma("foreign_keys = ON");
    database.pragma("secure_delete = ON");
    database.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    assertPragmas(database, expectedJournal);
    if (bootstrap === "initialize") initializeSchema(database);
    else assertVersionOneSchema(database);
    return database;
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Closing is best-effort; never expose the native close error.
    }
    if (error instanceof CodeSentinelPersistenceError) throw error;
    throw persistenceError("PERSISTENCE_FAILED");
  }
}
```

Define the bootstrap helpers without reading business rows:

```ts
type BootstrapState = "initialize" | "validate";

function readBootstrapState(database: Database.Database): BootstrapState {
  const version = Number(database.pragma("user_version", { simple: true }));
  const userObjects = database.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger', 'view')
  `).all();
  if (version === 0 && userObjects.length === 0) return "initialize";
  if (version === PERSISTENCE_SCHEMA_VERSION) return "validate";
  throw persistenceError("UNSUPPORTED_SCHEMA_VERSION");
}

function initializeSchema(database: Database.Database): void {
  database.transaction(() => {
    database.exec(SCHEMA_SQL);
    database.pragma(`user_version = ${PERSISTENCE_SCHEMA_VERSION}`);
  }).immediate();
  assertVersionOneSchema(database);
}

function assertVersionOneSchema(database: Database.Database): void {
  const expectedSqlByName = new Map<string, string>([
    ["sessions", CREATE_SESSIONS_SQL],
    ["timeline_events", CREATE_TIMELINE_EVENTS_SQL],
    ["action_records", CREATE_ACTION_RECORDS_SQL],
    ["approvals", CREATE_APPROVALS_SQL],
    ["verification_runs", CREATE_VERIFICATION_RUNS_SQL],
    ["session_memory", CREATE_SESSION_MEMORY_SQL],
    ["idx_timeline_session_event", CREATE_TIMELINE_INDEX_SQL],
    ["idx_approvals_session_status", CREATE_APPROVAL_INDEX_SQL],
    ["idx_verification_session_event", CREATE_VERIFICATION_INDEX_SQL],
    ["approval_status_forward", APPROVAL_TRIGGER_SQL],
  ]);
  const rows = database.prepare(`
    SELECT name, sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger', 'view')
    ORDER BY type, name
  `).all() as Array<{ name: string; sql?: string }>;
  if (rows.length !== expectedSqlByName.size) {
    throw persistenceError("UNSUPPORTED_SCHEMA_VERSION");
  }
  for (const row of rows) {
    const expected = expectedSqlByName.get(row.name);
    if (
      expected === undefined ||
      normalizeSchemaSql(row.sql) !== normalizeSchemaSql(expected)
    ) {
      throw persistenceError("UNSUPPORTED_SCHEMA_VERSION");
    }
  }

  const expectedColumns: Readonly<Record<string, readonly string[]>> = {
    sessions: [
      "id", "task_kind", "state", "round", "workspace_id", "provider_id",
      "verification_command_id", "created_at", "updated_at",
    ],
    timeline_events: [
      "event_id", "session_id", "round", "kind", "summary", "occurred_at",
      "action_id", "action_kind", "policy_decision", "tool_kind", "command_id",
      "exit_code", "duration_ms", "verification_status", "timed_out", "session_state",
      "approval_id", "approval_action_id", "patch_hash", "base_hash",
      "approval_status", "approval_created_at", "approval_expires_at",
    ],
    action_records: [
      "action_id", "event_id", "session_id", "round", "action_kind",
      "input_summary", "policy_decision", "result_summary",
    ],
    approvals: [
      "id", "session_id", "action_id", "patch_hash", "base_hash",
      "status", "created_at", "expires_at",
    ],
    verification_runs: [
      "run_id", "event_id", "session_id", "round", "command_id", "exit_code",
      "duration_ms", "status", "timed_out", "summary",
    ],
    session_memory: ["session_id", "summary", "updated_at"],
  };
  for (const [table, expected] of Object.entries(expectedColumns)) {
    const actual = database.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (actual.map(({ name }) => name).join("\u0000") !== expected.join("\u0000")) {
      throw persistenceError("UNSUPPORTED_SCHEMA_VERSION");
    }
  }

  const cascadeParents: Readonly<Record<string, readonly string[]>> = {
    timeline_events: ["sessions"],
    action_records: ["sessions", "timeline_events"],
    approvals: ["action_records", "sessions"],
    verification_runs: ["sessions", "timeline_events"],
    session_memory: ["sessions"],
  };
  for (const [table, expectedParents] of Object.entries(cascadeParents)) {
    const foreignKeys = database.pragma(`foreign_key_list(${table})`) as Array<{
      table: string;
      on_delete: string;
    }>;
    const actualParents = foreignKeys
      .filter(({ on_delete }) => on_delete.toUpperCase() === "CASCADE")
      .map(({ table: parent }) => parent)
      .sort();
    if (actualParents.join("\u0000") !== [...expectedParents].sort().join("\u0000")) {
      throw persistenceError("UNSUPPORTED_SCHEMA_VERSION");
    }
  }

}

function assertPragmas(database: Database.Database, journal: "memory" | "delete"): void {
  const actualJournal = String(database.pragma("journal_mode", { simple: true })).toLowerCase();
  const foreignKeys = Number(database.pragma("foreign_keys", { simple: true }));
  const secureDelete = Number(database.pragma("secure_delete", { simple: true }));
  const busyTimeout = Number(database.pragma("busy_timeout", { simple: true }));
  if (
    actualJournal !== journal ||
    foreignKeys !== 1 ||
    secureDelete !== 1 ||
    busyTimeout !== SQLITE_BUSY_TIMEOUT_MS
  ) {
    throw persistenceError("PERSISTENCE_FAILED");
  }
}
```

Do not collapse deliberate `UNSUPPORTED_SCHEMA_VERSION` into `PERSISTENCE_FAILED`. Set `user_version` last and validate required tables/indexes/triggers before preparing business statements.

- [ ] **Step 6: Implement session create/load/close**

Validate identifiers against:

```ts
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const KNOWN_KEY_FRAGMENT = /(?:sk-|sk_|pk_|rk_|ghp_)[A-Za-z0-9_-]{12,}/iu;
```

`assertIdentifier` requires `IDENTIFIER.test(value)` and `!KNOWN_KEY_FRAGMENT.test(value)`.

Require canonical UTC timestamps:

```ts
function canonicalIso(value: string): string | undefined {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  const canonical = new Date(timestamp).toISOString();
  return canonical === value ? canonical : undefined;
}
```

Create and load sessions with prepared statements and explicit row mapping. Implement and export the synchronous `createSessionRepository(databasePath)` factory from `session-repository.ts`/`index.ts`; it calls the internal `openSessionDatabase` once and exposes no connection or Statement. `close()` is idempotent; every other method begins with an `assertOpen`.

- [ ] **Step 7: Run GREEN checks**

Run:

```powershell
npm test -- --run packages/persistence/src/schema.test.ts
npm run typecheck
```

Expected: PASS. The tests must explicitly verify `:memory:` returns `memory`, a file DB returns `delete`, a pre-WAL file switches to `delete` or returns fixed `PERSISTENCE_FAILED`, and no raw native error secret is reachable.

- [ ] **Step 8: Commit**

```powershell
git add packages/persistence/src/types.ts packages/persistence/src/schema.ts packages/persistence/src/schema.test.ts packages/persistence/src/session-repository.ts packages/persistence/src/index.ts
git commit -m "feat: initialize hardened session persistence"
```

---

### Task 4: Persist ordered action, policy, tool, and state events

**Files:**
- Modify: `packages/persistence/src/session-repository.ts`
- Create: `packages/persistence/src/session-repository.test.ts`
- Modify: `packages/persistence/src/index.ts`

- [ ] **Step 1: Write failing ordered-event tests**

```ts
it("persists one ordered action-policy-tool-state timeline", async () => {
  const repository = createRepositoryWithSession();
  await repository.append(stateEvent({
    round: 0,
    state: "running",
    occurredAt: "2026-07-30T00:00:00.000Z",
  }));
  await repository.append(actionEvent({ round: 1, actionId: "a1", actionKind: "read_file" }));
  await repository.append(policyEvent({ round: 1, decision: "allow" }));
  await repository.append(toolEvent({ round: 1, toolKind: "read_file" }));
  await repository.append(stateEvent({ round: 1, state: "running" }));

  const timeline = await repository.loadTimeline("s1");
  expect(timeline.slice(1)).toMatchObject([
    { kind: "action", details: { actionId: "a1" } },
    { kind: "policy", details: { decision: "allow" } },
    { kind: "tool_result", details: { toolKind: "read_file" } },
    { kind: "state", details: { state: "running" } },
  ]);
  await expect(repository.loadSession("s1")).resolves.toMatchObject({
    round: 1,
    state: "running",
    updatedAt: "2026-07-30T00:00:04.000Z",
  });
});
```

Give the Action, Policy, tool, and final State helpers monotonically increasing `occurredAt` defaults of `00:00:01Z` through `00:00:04Z` in this fixture. Keep a separate freshly created-session helper for round-0 verification and invalid `created`-state tests; do not hide or delete the initial `running` timeline event.

The same file must assert:

- action jump 0→2, second action in one round, non-action round advance, Policy/tool before Action, tool before Policy, second Policy, and decreasing occurredAt → `INVALID_EVENT_SEQUENCE`;
- an Action while the session is still `created`, `created → completed`, and every event after `completed`, `blocked`, `failed`, or `stopped` → `INVALID_EVENT_SEQUENCE`;
- a round-0 verification for `feature_implementation`, or any State transition back/to `running` at round 3, → `INVALID_EVENT_SEQUENCE`;
- a browse `tool_result` whose `toolKind` differs from the same-round Action, or whose Policy is not `allow`, → `INVALID_EVENT_SEQUENCE`;
- the complete allowed state-edge table below; in particular, a stage-invalid action may be followed directly by its terminal State with null Policy/result fields, denied and finish actions may be followed by Policy then State with a null result, `running → running` remains valid after a failed verification before round 3, and any transition to `running` at round 3 is rejected;
- unknown session → `SESSION_NOT_FOUND`; oversized summary → `INVALID_PERSISTENCE_INPUT`; secret summary → `[REDACTED]`;
- runtime objects with an extra top-level or `details` key, including an extra-key sentinel, → `INVALID_PERSISTENCE_INPUT`, zero new timeline rows, and no sentinel in the error;
- any failed derived insert leaves the timeline row count unchanged.

- [ ] **Step 2: Run the tests to record RED**

Run:

```powershell
npm test -- --run packages/persistence/src/session-repository.test.ts
```

Expected: FAIL because `append` and timeline mapping are not implemented.

- [ ] **Step 3: Validate events before SQL**

Implement exhaustive structural validation and redaction before opening the write transaction. It must copy only declared fields into a new immutable event and reject accessor failures, symbol keys, non-plain objects, and undeclared own keys. Then validate session-dependent order inside the transaction:

```ts
function validateEventSequence(
  event: ValidatedEvent,
  session: PersistedSession,
): void {
  assertIdentifier(event.sessionId);
  assertCanonicalIso(event.occurredAt);
  if (event.occurredAt < session.updatedAt) {
    throw persistenceError("INVALID_EVENT_SEQUENCE");
  }
  if (event.kind === "action") {
    if (event.round !== session.round + 1) {
      throw persistenceError("INVALID_EVENT_SEQUENCE");
    }
  } else if (event.round !== session.round) {
    throw persistenceError("INVALID_EVENT_SEQUENCE");
  }
}
```

Use exhaustive kind switches in the pre-transaction validator and reject undeclared own keys on event/details. Never accept a generic JSON details blob. `append` first computes `validated = validateAndRedactEvent(input)`; the transaction receives only that copied value, reloads the session, and calls `validateEventSequence`.

Use this exact state machine and reject all events once the persisted session is terminal:

```ts
const TERMINAL_STATES = new Set<SessionState>([
  "completed",
  "blocked",
  "failed",
  "stopped",
]);

const ALLOWED_STATE_TRANSITIONS: Readonly<
  Record<"created" | "running" | "awaiting_approval", ReadonlySet<SessionState>>
> = {
  created: new Set(["running", "stopped", "failed"]),
  running: new Set([
    "running",
    "awaiting_approval",
    "completed",
    "blocked",
    "failed",
    "stopped",
  ]),
  awaiting_approval: new Set([
    "running",
    "completed",
    "blocked",
    "failed",
    "stopped",
  ]),
};
```

Before kind-specific SQL, enforce the current-state/event matrix:

| Event | Allowed current state |
|---|---|
| `action`, `policy`, browse `tool_result` | `running` |
| pending or terminal `approval`, applied-patch `tool_result` | `awaiting_approval` |
| initial round-0 `verification` | `created` and `taskKind: test_repair` |
| later `verification` | `running` for an allowed `test_repair` verification Action, `awaiting_approval` for an approved/applied patch of either task kind |
| `state` | only a target in `ALLOWED_STATE_TRANSITIONS[current]` |

The matrix is checked in addition to the round, task kind, Policy, Approval, tool-kind, and command-binding rules; it does not replace them. A State target of `running` also requires the current round to be less than 3. Use an exhaustive state switch/type guard before indexing `ALLOWED_STATE_TRANSITIONS`; do not silence terminal-state narrowing with an unchecked cast.

- [ ] **Step 4: Append timeline and normalized records atomically**

Create one `database.transaction` that:

1. reloads the current session row;
2. validates the already copied/redacted event's session-dependent round, time, and semantic sequence;
3. inserts `timeline_events`;
4. maps the kind:
   - action inserts `action_records`;
   - policy updates the one action with null policy;
   - browse tool result requires the same-round Action kind, a recorded `allow` Policy, and updates that Action result;
   - `apply_approved_patch` tool result requires the same-round `propose_patch` Action, its recorded `ask` Policy, and an `approved` Approval for that Action;
   - state updates session state;
5. updates session round for action and `updated_at` for every event.

Require `changes === 1` for every expected insert/update. Convert constraint failures to `DUPLICATE_RECORD` only when the repository can classify them without exposing the native message; otherwise return `PERSISTENCE_FAILED`.

- [ ] **Step 5: Reconstruct immutable timeline events**

Query `timeline_events ORDER BY event_id ASC`, map snake_case rows explicitly, switch on kind, and freeze the event plus its details. Do not return DB row objects. Unknown session returns `[]`.

- [ ] **Step 6: Run GREEN checks**

Run:

```powershell
npm test -- --run packages/persistence/src/session-repository.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add packages/persistence/src/session-repository.ts packages/persistence/src/session-repository.test.ts packages/persistence/src/index.ts
git commit -m "feat: persist ordered session action timelines"
```

---

### Task 5: Persist approval metadata and verification runs

**Files:**
- Modify: `packages/persistence/src/session-repository.ts`
- Modify: `packages/persistence/src/session-repository.test.ts`

- [ ] **Step 1: Add failing approval and verification tests**

```ts
it("binds approval metadata to the persisted propose-patch action", async () => {
  const repository = createRepositoryWithSession();
  await repository.append(stateEvent({ round: 0, state: "running" }));
  await repository.append(actionEvent({
    round: 1,
    actionId: "patch-action",
    actionKind: "propose_patch",
  }));
  await repository.append(policyEvent({ round: 1, decision: "ask" }));
  await repository.append(stateEvent({ round: 1, state: "awaiting_approval" }));
  await repository.append(approvalEvent({
    round: 1,
    approvalId: "approval-1",
    actionId: "patch-action",
    status: "pending",
  }));

  expect(await repository.loadTimeline("s1")).toContainEqual(
    expect.objectContaining({
      kind: "approval",
      details: expect.objectContaining({
        approvalId: "approval-1",
        actionId: "patch-action",
        status: "pending",
      }),
    }),
  );
});
```

```ts
it("stores verification facts and replaces the action's latest result summary", async () => {
  const repository = createRepositoryWithSession();
  await appendAllowedVerificationAction(repository);
  await repository.append(verificationEvent({
    round: 1,
    commandId: "test",
    exitCode: 1,
    durationMs: 25,
    status: "completed",
    timedOut: false,
    summary: "expected 2 received 1",
  }));
  expect(await repository.loadTimeline("s1")).toContainEqual(
    expect.objectContaining({
      kind: "verification",
      details: expect.objectContaining({ commandId: "test", exitCode: 1 }),
    }),
  );
});
```

`appendAllowedVerificationAction` must first append the legal `created → running` State, then a `run_verification` Action and its `allow` Policy with increasing timestamps.

The same test file must assert:

- wrong action ID, non-patch action, missing Policy, or a same-round Policy other than `ask` before pending Approval → `INVALID_EVENT_SEQUENCE`;
- a second pending Approval with a different `approvalId` for the same patch Action, and replay of the same pending insert, → `DUPLICATE_RECORD`;
- invalid hash or `expiresAt <= createdAt` → `INVALID_PERSISTENCE_INPUT`; terminal-to-pending and terminal-to-other-terminal → `INVALID_EVENT_SEQUENCE`;
- inconsistent verification status/exit/timedOut or unsafe duration → `INVALID_PERSISTENCE_INPUT`;
- a command ID different from the session's `verificationCommandId` → `INVALID_EVENT_SEQUENCE`;
- round-0 initial verification without Action → success;
- later verification succeeds only after either an `allow` Policy for a `run_verification` Action, or an `ask` Policy plus approved Approval and applied-patch tool result for a `propose_patch` Action; missing or mismatched prerequisites → `INVALID_EVENT_SEQUENCE`;
- a secret verification summary → stored `[REDACTED]` with no sentinel.

- [ ] **Step 2: Run tests to record RED**

Run:

```powershell
npm test -- --run packages/persistence/src/session-repository.test.ts
```

Expected: new approval and verification tests FAIL.

- [ ] **Step 3: Implement approval mapping**

On pending approval:

- require a matching `propose_patch` action in the same session and round;
- require that Action's unique Policy decision to be `ask`;
- validate lowercase 64-character SHA-256 values and safe Date millisecond integers;
- insert one approval row; the schema's `UNIQUE(action_id)` makes one patch Action bind to exactly one Approval.

On approved/rejected/expired:

- require the same immutable action/hash/base/time metadata;
- update only a pending row;
- reject a repeated identical status as `DUPLICATE_RECORD`;
- reject terminal-to-pending and terminal-to-terminal transitions as `INVALID_EVENT_SEQUENCE`.

The approval timeline event and normalized update are in one transaction.

- [ ] **Step 4: Implement verification mapping**

Validate:

```ts
function validVerificationDetails(details: VerificationDetails): boolean {
  if (!Number.isSafeInteger(details.durationMs) || details.durationMs < 0) return false;
  if (details.status !== "completed" && details.exitCode !== null) return false;
  if (details.exitCode !== null && !Number.isSafeInteger(details.exitCode)) return false;
  return details.timedOut === (details.status === "timed_out");
}
```

Insert `verification_runs`. If the current round has an Action, update its `result_summary` to the redacted verification summary; initial round-0 verification has no Action and remains valid.

Every verification `commandId` must equal the session's selected `verificationCommandId`. For round greater than zero, require one of the two real Core paths before inserting:

1. same-round `run_verification` Action with Policy `allow`; or
2. same-round `propose_patch` Action with Policy `ask`, terminal Approval `approved`, and an earlier `apply_approved_patch` tool-result event.

Do not infer these prerequisites from summaries.

- [ ] **Step 5: Run GREEN checks**

Run:

```powershell
npm test -- --run packages/persistence/src/session-repository.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/persistence/src/session-repository.ts packages/persistence/src/session-repository.test.ts
git commit -m "feat: persist approval and verification facts"
```

---

### Task 6: Add typed entries and bounded session memory

**Files:**
- Modify: `packages/persistence/src/types.ts`
- Modify: `packages/persistence/src/session-repository.ts`
- Modify: `packages/persistence/src/session-repository.test.ts`
- Modify: `packages/persistence/src/index.ts`

- [ ] **Step 1: Write failing typed-entry and memory tests**

```ts
it("uses appendAction as one action event rather than a compound record", async () => {
  const repository = createRepositoryWithSession();
  await repository.append(stateEvent({
    round: 0,
    state: "running",
    occurredAt: "2026-07-30T00:00:00.000Z",
  }));
  const before = (await repository.loadTimeline("s1")).length;
  await repository.appendAction({
    sessionId: "s1",
    round: 1,
    occurredAt: "2026-07-30T00:00:01.000Z",
    actionId: "a1",
    actionKind: "finish",
    inputSummary: "finish",
  });
  const timeline = await repository.loadTimeline("s1");
  expect(timeline.slice(before)).toMatchObject([
    { kind: "action", details: { actionId: "a1", actionKind: "finish" } },
  ]);
});

it("upserts only redacted session memory", async () => {
  const repository = createRepositoryWithSession();
  await repository.saveSessionMemory({
    sessionId: "s1",
    summary: "Authorization: Bearer sk-proj-memory-secret-1234",
    updatedAt: "2026-07-30T00:00:01.000Z",
  });
  const memory = await repository.loadSessionMemory("s1");
  expect(memory?.summary).toContain("[REDACTED]");
  expect(JSON.stringify(memory)).not.toContain("sk-proj-memory-secret-1234");
});
```

Add equivalence tests proving `saveApproval` and `appendVerification` each create exactly one event matching direct `append`. For Action and Approval facts, additionally prove that mixing direct and typed paths returns `DUPLICATE_RECORD` through their stable IDs. Verification has no approved run ID or natural uniqueness key, so do not invent one or reject two legitimately identical runs; its “choose one entry path” rule remains a caller/composition contract verified by using only one path in the Core integration test.

- [ ] **Step 2: Run tests to record RED**

Run:

```powershell
npm test -- --run packages/persistence/src/session-repository.test.ts
```

Expected: new typed-entry and memory tests FAIL.

- [ ] **Step 3: Implement typed entries as thin adapters**

Each adapter constructs exactly one typed event and calls the same internal transaction used by `append`:

```ts
async appendAction(input: AppendActionInput): Promise<void> {
  return append({
    sessionId: input.sessionId,
    round: input.round,
    occurredAt: input.occurredAt,
    kind: "action",
    summary: input.inputSummary,
    details: {
      actionId: input.actionId,
      actionKind: input.actionKind,
    },
  });
}
```

Do not add Policy or result properties to `AppendActionInput`.

- [ ] **Step 4: Implement memory upsert and immutable load**

Validate session, canonical time, monotonic memory `updatedAt`, and redact before SQL. Use:

```sql
INSERT INTO session_memory(session_id, summary, updated_at)
VALUES (@sessionId, @summary, @updatedAt)
ON CONFLICT(session_id) DO UPDATE SET
  summary = excluded.summary,
  updated_at = excluded.updated_at
WHERE excluded.updated_at >= session_memory.updated_at;
```

Require one changed row. Freeze the returned memory object. Memory does not advance the session timeline or session `updated_at`.

An upsert with `updatedAt` earlier than the stored memory timestamp changes zero rows and must map deterministically to `INVALID_EVENT_SEQUENCE`; add that assertion to the RED test before implementation. Equal timestamps remain allowed.

- [ ] **Step 5: Run GREEN checks**

Run:

```powershell
npm test -- --run packages/persistence/src/session-repository.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/persistence/src/types.ts packages/persistence/src/session-repository.ts packages/persistence/src/session-repository.test.ts packages/persistence/src/index.ts
git commit -m "feat: add typed persistence entries and memory"
```

---

### Task 7: Clear and recover sessions without restoring patches

**Files:**
- Create: `packages/persistence/src/session-lifecycle.test.ts`
- Modify: `packages/persistence/src/session-repository.ts`

- [ ] **Step 1: Write failing cascade-clear tests**

Create two sessions with timeline, action, approval, verification, and memory rows. Then:

```ts
await repository.clearSession("s1");
await expect(repository.loadSession("s1")).resolves.toBeUndefined();
await expect(repository.loadTimeline("s1")).resolves.toEqual([]);
await expect(repository.loadSessionMemory("s1")).resolves.toBeUndefined();
await expect(repository.loadSession("s2")).resolves.toBeDefined();
await repository.clearSession("s1"); // idempotent
```

Query `PRAGMA foreign_key_list` for each child table and assert the required `ON DELETE CASCADE` actions.

- [ ] **Step 2: Write failing restart-recovery tests**

```ts
it("expires pending approvals before stopping interrupted sessions", async () => {
  const repository = createRepositoryWithPendingApproval();
  const changed = await repository.recoverInterruptedSessions(Date.parse("2026-07-30T00:10:00.000Z"));
  expect(changed).toBe(1);
  expect(await repository.loadTimeline("s1")).toMatchObject([
    expect.objectContaining({ kind: "approval" }),
    expect.objectContaining({
      kind: "state",
      details: { state: "stopped" },
      summary: "SESSION_INTERRUPTED",
    }),
  ]);
  await expect(repository.recoverInterruptedSessions(
    Date.parse("2026-07-30T00:10:00.000Z"),
  )).resolves.toBe(0);
});
```

The same file must assert that `created`, `running`, and `awaiting_approval` become stopped; terminal sessions remain byte-for-byte unchanged; session and Approval events follow ID order; recovery events share the stored round and one timestamp; an earlier `now` rolls back every candidate; and the repository recovery dependency object contains no Provider, Policy, or tool.

- [ ] **Step 3: Run tests to record RED**

Run:

```powershell
npm test -- --run packages/persistence/src/session-lifecycle.test.ts
```

Expected: FAIL because clear/recovery behavior is absent.

- [ ] **Step 4: Implement cascade clear**

Use one immediate transaction:

```ts
const clearSessionTransaction = database.transaction((sessionId: string) => {
  deleteSession.run(sessionId);
});

async function clearSession(sessionId: string): Promise<void> {
  assertOpen();
  assertIdentifier(sessionId);
  clearSessionTransaction.immediate(sessionId);
}
```

Do not manually delete children in a different order; the declared cascades are the contract. Missing session is success.

- [ ] **Step 5: Implement deterministic restart recovery**

Inside one immediate transaction:

1. validate `now` is a safe Date millisecond value;
2. select nonterminal sessions ordered by ID;
3. reject if `nowIso < updated_at`;
4. for each session, select only its pending approvals ordered by ID;
5. append/update each approval as expired with summary `APPROVAL_EXPIRED_ON_RESTART`;
6. append state stopped with summary `SESSION_INTERRUPTED`;
7. use the existing session round and the same `nowIso`;
8. return the number of stopped sessions.

Call internal event append helpers without nesting a second transaction. No patch, path, Provider, Policy, or tool object is available to this function.

- [ ] **Step 6: Run GREEN checks**

Run:

```powershell
npm test -- --run packages/persistence/src/session-lifecycle.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add packages/persistence/src/session-lifecycle.test.ts packages/persistence/src/session-repository.ts
git commit -m "feat: clear and recover persisted sessions"
```

---

### Task 8: Prove Core integration and on-disk secret safety

**Files:**
- Create: `packages/persistence/src/core-integration.test.ts`
- Modify: `packages/persistence/src/schema.test.ts`
- Modify: `packages/persistence/src/session-repository.test.ts`

- [ ] **Step 1: Write the real-repository Core integration test**

Create a repository on a controlled temporary file before starting Core. The file-backed connection lets the test inspect normalized tables after `repository.close()` without adding a production inspection API:

```ts
const repository = createSessionRepository(databasePath);
await repository.createSession({
  id: session.id,
  taskKind: session.taskKind,
  state: "created",
  round: 0,
  workspaceId: session.workspaceId,
  providerId: session.providerId,
  verificationCommandId: session.verificationCommandId,
  createdAt: "2026-07-30T00:00:00.000Z",
});

const controller = createAgentSessionController({
  provider,
  policy: askForPatchPolicy,
  tools: fake.tools,
  eventSink: repository,
  now: sequenceTimes(),
  createId: sequenceIds(),
});
```

Run a deterministic failed verification → patch proposal → approval → successful verification repair flow. Assert the exact ordered event kinds are:

```ts
[
  "verification",
  "state",
  "action",
  "policy",
  "state",
  "approval",
  "approval",
  "tool_result",
  "verification",
  "state",
]
```

Also assert the two Approval statuses are `pending` then `approved`, the tool kind is `apply_approved_patch`, both verification details are complete, and the Approval `actionId` equals the proposal Action `actionId`. Load and retain the public timeline, close the repository, then open the same temp file read-only directly with `better-sqlite3` inside the test. Assert serialized timeline and explicit `SELECT` results from every normalized table contain neither the raw patch nor sentinels from task summary, Provider response, fake tool output, or verification summary. Wrap both repository and read-only inspection handles in `try/finally` so a failed assertion cannot leave the temp database locked, then let the temp-path helper remove the database and all sidecars after every handle is closed.

Add two missing-`createSession` cases without changing Core startup semantics:

- a `feature_implementation` session fails on its first state append with the stable Core EventSink failure terminal and zero Provider, Policy, or tool calls;
- a `test_repair` session performs exactly its existing initial controlled verification, then fails on the first verification append with zero Provider calls and no later tool action.

- [ ] **Step 2: Write file-byte sentinel tests**

For each public text ingress, use a unique `sk-proj-...` sentinel. Close the repository and scan binary buffers:

```ts
for (const candidate of [
  databasePath,
  `${databasePath}-journal`,
  `${databasePath}-wal`,
  `${databasePath}-shm`,
]) {
  if (existsSync(candidate)) {
    const bytes = await readFile(candidate);
    for (const sentinel of sentinels) {
      expect(bytes.includes(Buffer.from(sentinel, "utf8"))).toBe(false);
    }
    expect(bytes.includes(Buffer.from(deletedMarker, "utf8"))).toBe(false);
  }
}
```

The `deletedMarker` is a unique non-secret memory or event summary that is first verified as stored, then removed by `clearSession`, then checked after `close`.

Seed a file DB in WAL mode with a separate connection; reopen through the repository and assert it switches to DELETE and leaves no live WAL/SHM after close, or returns only fixed `PERSISTENCE_FAILED`.

- [ ] **Step 3: Run the integration verification**

Run:

```powershell
npm test -- --run packages/persistence/src/core-integration.test.ts packages/persistence/src/schema.test.ts packages/persistence/src/session-repository.test.ts
```

Expected: PASS if Tasks 1–7 fully satisfy the specification. This is a new cross-component verification layer, not a pretext for inventing an extra production API or a repository preflight port in Core.

- [ ] **Step 4: Handle any discovered defect with a focused RED reproduction**

If Step 3 fails, first determine whether the test assumption contradicts the approved spec. For a real defect, add the smallest owning-unit regression test that fails for the same reason, run it alone to record RED, fix only that owning module, run its GREEN command, and commit the fix before returning to this integration test. Do not persist raw patch data or add a pending-patch table. If Step 3 passes, make no production change in this step.

- [ ] **Step 5: Run Task 9 GREEN suite**

Run:

```powershell
npm test -- --run packages/contracts/src/events.test.ts packages/core/src/in-memory-event-sink.test.ts packages/core/src/agent-loop.test.ts packages/core/src/approval-resume.test.ts packages/core/src/feature-flow.test.ts packages/persistence/src/redaction.test.ts packages/persistence/src/schema.test.ts packages/persistence/src/session-repository.test.ts packages/persistence/src/session-lifecycle.test.ts packages/persistence/src/core-integration.test.ts
npm run typecheck
npm run lint
```

Expected: all selected tests PASS; typecheck and lint exit 0.

- [ ] **Step 6: Commit**

```powershell
git add packages/persistence/src/core-integration.test.ts packages/persistence/src/schema.test.ts packages/persistence/src/session-repository.test.ts
git commit -m "test: prove redacted persistence integration"
```

---

### Task 9: Review, verify, and record completion evidence

**Files:**
- Modify: `PLAN.md`
- Modify: `AGENT_LOG.md`
- Review: all changes since the Task 9 plan baseline

- [ ] **Step 1: Run a specification coverage review**

Dispatch or perform an independent review against:

- `SPEC.md` sections 4.6, 5, 7, 8.4, 9, and acceptance criterion 6;
- `docs/superpowers/specs/2026-07-30-task9-redacted-persistence-design.md`;
- every Task 9 test and production diff.

Require an explicit `COMPLIANT` or a list of Critical/Important/Minor gaps. Fix every Critical/Important item with a new RED test before implementation. Re-run the relevant GREEN checks after each fix.

- [ ] **Step 2: Run an independent code-quality/security review**

Review:

- strict detail unions and no generic payload escape;
- actionId → Approval FK binding;
- PRAGMA verification and schema bootstrap;
- prepared statements and transaction rollback;
- round/time/order invariants;
- secret patterns, Unicode normalization, and redact-before-truncate;
- no public native cause/path/SQL/input leakage;
- cascade isolation, secure delete, and recovery idempotency;
- raw patch absence and Task 8 approval/write invariants.

The reviewer must inspect the final diff and tests, not only summarize commits.

- [ ] **Step 3: Run full final verification**

Run from the Task 9 implementation worktree:

```powershell
npm test
npm run typecheck
npm run lint
npm run build
git diff --check docs-task9-persistence-design...HEAD
git status --short --branch
```

Expected:

- all test files pass with only the pre-existing explicitly skipped tests;
- typecheck, lint, build, and diff check exit 0;
- the implementation worktree is clean before Step 4; after Step 4 and before the evidence commit, only the intentional `PLAN.md` and `AGENT_LOG.md` edits may remain;
- no process started by the tests remains running.

- [ ] **Step 4: Update project evidence**

Replace the Task 9 “design approved / plan awaiting review” status block in `PLAN.md` with:

```md
### Task 9: [x] Completed 2026-07-30 — Persist structured redacted session history

- **Design:** `docs/superpowers/specs/2026-07-30-task9-redacted-persistence-design.md`
- **Implementation plan:** `docs/superpowers/plans/2026-07-30-task9-redacted-persistence.md`
- **Delivered scope:** strict structured events; hardened SQLite sessions, actions, approvals, verification runs, memory, ordered timeline, secure clear and interrupted-session recovery; no raw patch or API Key persistence.
- **Evidence:** list the actual commit IDs, RED commands/results, final test count, typecheck/lint/build/diff results, and independent review conclusions.
```

Append one dated Task 9 entry to `AGENT_LOG.md` containing only actual observed commands and results. Do not claim push, PR, merge, or CI state unless independently verified.

- [ ] **Step 5: Verify evidence-only diff**

Run:

```powershell
git diff --check
git diff -- PLAN.md AGENT_LOG.md
```

Expected: no whitespace errors and all counts/commit IDs match Git and command output.

- [ ] **Step 6: Commit completion evidence**

```powershell
git add PLAN.md AGENT_LOG.md
git commit -m "docs: record Task 9 completion"
```

- [ ] **Step 7: Verify the final commit and clean tree**

Run:

```powershell
git show --check --stat --oneline HEAD
git status --short --branch
```

Expected: the evidence commit is valid and the implementation worktree is clean.

## Execution constraints

- Start execution from a new isolated `feat/task9-persistence` worktree based on the approved plan commit; do not implement on the documentation branch.
- Tasks 1–7 begin with the listed failing test and an observed RED result before their production change. Task 8 is a test-only cross-component verification; any defect it discovers starts a separate focused RED → GREEN fix before production code changes.
- Preserve unrelated user changes and never rewrite or discard an existing branch.
- Use no real Provider, network, Credential Manager, user repository, or arbitrary shell in tests.
- If a test starts a process, record its PID and ensure it exits; Task 9 should not require a long-lived service.
- Do not push, open a PR, or merge until the user explicitly authorizes the relevant external GitHub action.
