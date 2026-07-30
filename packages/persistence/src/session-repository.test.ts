import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  HarnessEvent,
  SessionState,
} from "../../contracts/src/index.js";
import {
  CodeSentinelPersistenceError,
  createSessionRepository,
  MAX_PERSISTED_SUMMARY_CHARACTERS,
  MAX_PERSISTED_TEXT_INPUT_CHARACTERS,
  type AppendActionInput,
  type AppendVerificationInput,
  type CreatePersistedSessionInput,
  type SaveApprovalInput,
  type SaveSessionMemoryInput,
  type SessionRepository,
} from "./index.js";
import { PendingPatchStore } from "../../core/src/pending-patch-store.js";

const SESSION_ID = "session-1";
const ACTION_ID = "action-1";
const HASH = "a".repeat(64);
const SENTINEL = "must-not-leak-sentinel";
const MIN_DATE_TIMESTAMP = -8_640_000_000_000_000;

type ErrorCode =
  | "INVALID_PERSISTENCE_INPUT"
  | "SESSION_NOT_FOUND"
  | "INVALID_EVENT_SEQUENCE"
  | "DUPLICATE_RECORD"
  | "PERSISTENCE_FAILED";

type ActionKind = Extract<
  HarnessEvent,
  { kind: "action" }
>["details"]["actionKind"];
type ToolKind = Extract<
  HarnessEvent,
  { kind: "tool_result" }
>["details"]["toolKind"];
type PolicyDecision = Extract<
  HarnessEvent,
  { kind: "policy" }
>["details"]["decision"];
type VerificationDetails = Extract<
  HarnessEvent,
  { kind: "verification" }
>["details"];
type ApprovalDetails = Extract<
  HarnessEvent,
  { kind: "approval" }
>["details"];

function at(second: number): string {
  return new Date(Date.UTC(2026, 6, 30, 0, 0, second)).toISOString();
}

function validSession(
  overrides: Partial<CreatePersistedSessionInput> = {},
): CreatePersistedSessionInput {
  return {
    id: SESSION_ID,
    taskKind: "test_repair",
    state: "created",
    round: 0,
    workspaceId: "workspace-1",
    providerId: "provider-1",
    verificationCommandId: "test-command",
    createdAt: at(0),
    ...overrides,
  };
}

function eventBase(
  round: number,
  occurredAt: string,
  summary: string,
  sessionId = SESSION_ID,
): Readonly<{
  sessionId: string;
  round: number;
  summary: string;
  occurredAt: string;
}> {
  return { sessionId, round, summary, occurredAt };
}

function actionEvent(
  round: number,
  occurredAt: string,
  actionKind: ActionKind = "read_file",
  actionId = ACTION_ID,
  summary: string = actionKind,
  sessionId = SESSION_ID,
): Extract<HarnessEvent, { kind: "action" }> {
  return {
    ...eventBase(round, occurredAt, summary, sessionId),
    kind: "action",
    details: { actionId, actionKind },
  };
}

function policyEvent(
  round: number,
  occurredAt: string,
  decision: PolicyDecision = "allow",
  summary: string = decision,
  sessionId = SESSION_ID,
): Extract<HarnessEvent, { kind: "policy" }> {
  return {
    ...eventBase(round, occurredAt, summary, sessionId),
    kind: "policy",
    details: { decision },
  };
}

function toolEvent(
  round: number,
  occurredAt: string,
  toolKind: ToolKind = "read_file",
  summary: string = toolKind,
  sessionId = SESSION_ID,
): Extract<HarnessEvent, { kind: "tool_result" }> {
  return {
    ...eventBase(round, occurredAt, summary, sessionId),
    kind: "tool_result",
    details: { toolKind },
  };
}

function stateEvent(
  round: number,
  occurredAt: string,
  state: SessionState = "running",
  summary: string = state,
  sessionId = SESSION_ID,
): Extract<HarnessEvent, { kind: "state" }> {
  return {
    ...eventBase(round, occurredAt, summary, sessionId),
    kind: "state",
    details: { state },
  };
}

function verificationEvent(
  round: number,
  occurredAt: string,
  overrides: Partial<VerificationDetails> = {},
  sessionId = SESSION_ID,
): Extract<HarnessEvent, { kind: "verification" }> {
  return {
    ...eventBase(round, occurredAt, "verification failed", sessionId),
    kind: "verification",
    details: {
      commandId: "test-command",
      exitCode: 1,
      durationMs: 10,
      status: "completed",
      timedOut: false,
      ...overrides,
    },
  };
}

function approvalEvent(
  round: number,
  occurredAt: string,
  overrides: Partial<ApprovalDetails> = {},
  sessionId = SESSION_ID,
): Extract<HarnessEvent, { kind: "approval" }> {
  return {
    ...eventBase(round, occurredAt, "approval", sessionId),
    kind: "approval",
    details: {
      approvalId: "approval-1",
      actionId: ACTION_ID,
      patchHash: HASH,
      baseHash: HASH,
      status: "pending",
      createdAt: 1,
      expiresAt: 2,
      ...overrides,
    },
  };
}

function appendActionInput(
  overrides: Partial<AppendActionInput> = {},
): AppendActionInput {
  return {
    sessionId: SESSION_ID,
    round: 1,
    occurredAt: at(1),
    actionId: ACTION_ID,
    actionKind: "finish",
    inputSummary: "finish",
    ...overrides,
  };
}

function saveApprovalInput(
  overrides: Partial<SaveApprovalInput> = {},
): SaveApprovalInput {
  const event = approvalEvent(1, at(4));
  return {
    sessionId: event.sessionId,
    round: event.round,
    occurredAt: event.occurredAt,
    summary: event.summary,
    details: event.details,
    ...overrides,
  };
}

function appendVerificationInput(
  overrides: Partial<AppendVerificationInput> = {},
): AppendVerificationInput {
  const event = verificationEvent(0, at(1));
  return {
    sessionId: event.sessionId,
    round: event.round,
    occurredAt: event.occurredAt,
    summary: event.summary,
    details: event.details,
    ...overrides,
  };
}

function saveMemoryInput(
  overrides: Partial<SaveSessionMemoryInput> = {},
): SaveSessionMemoryInput {
  return {
    sessionId: SESSION_ID,
    summary: "remembered context",
    updatedAt: at(1),
    ...overrides,
  };
}

function expectPersistenceError(error: unknown, code: ErrorCode): void {
  expect(error).toBeInstanceOf(CodeSentinelPersistenceError);
  expect(error).toMatchObject({
    name: "CodeSentinelPersistenceError",
    message: code,
    code,
  });
}

function visibleErrorText(error: unknown): string {
  const fragments = [String(error)];
  try {
    fragments.push(JSON.stringify(error));
  } catch {
    fragments.push("unserializable-error");
  }
  if (typeof error === "object" && error !== null) {
    for (const key of Reflect.ownKeys(error)) {
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      if (descriptor !== undefined && "value" in descriptor) {
        fragments.push(String(descriptor.value));
      }
    }
  }
  return fragments.join("\n");
}

async function rejectedError(promise: Promise<unknown>): Promise<unknown> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  return caught;
}

async function expectRejected(
  promise: Promise<unknown>,
  code: ErrorCode,
): Promise<unknown> {
  const error = await rejectedError(promise);
  expectPersistenceError(error, code);
  return error;
}

async function withRepository<T>(
  callback: (repository: SessionRepository) => Promise<T>,
): Promise<T> {
  const repository = createSessionRepository(":memory:");
  try {
    return await callback(repository);
  } finally {
    repository.close();
  }
}

async function withFileRepository<T>(
  callback: (
    repository: SessionRepository,
    databasePath: string,
  ) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "codesentinel-repository-"));
  const databasePath = join(directory, "sessions.sqlite");
  const repository = createSessionRepository(databasePath);
  try {
    return await callback(repository, databasePath);
  } finally {
    repository.close();
    await rm(directory, { force: true, recursive: true });
  }
}

function inspectDatabase<T>(
  databasePath: string,
  callback: (database: Database.Database) => T,
): T {
  const database = new Database(databasePath);
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

function businessSnapshot(databasePath: string): Readonly<{
  sessions: readonly unknown[];
  timeline: readonly unknown[];
  actions: readonly unknown[];
  approvals: readonly unknown[];
  verifications: readonly unknown[];
}> {
  return inspectDatabase(databasePath, (database) => ({
    sessions: database.prepare("SELECT * FROM sessions ORDER BY id").all(),
    timeline: database
      .prepare("SELECT * FROM timeline_events ORDER BY event_id")
      .all(),
    actions: database
      .prepare("SELECT * FROM action_records ORDER BY action_id")
      .all(),
    approvals: database.prepare("SELECT * FROM approvals ORDER BY id").all(),
    verifications: database
      .prepare("SELECT * FROM verification_runs ORDER BY run_id")
      .all(),
  }));
}

async function createRunningSession(
  repository: SessionRepository,
  overrides: Partial<CreatePersistedSessionInput> = {},
): Promise<void> {
  const session = validSession(overrides);
  await repository.createSession(session);
  await repository.append(stateEvent(0, at(0), "running", "running", session.id));
}

async function createAwaitingApprovalSession(
  repository: SessionRepository,
  overrides: Partial<CreatePersistedSessionInput> = {},
): Promise<void> {
  await createRunningSession(repository, overrides);
  await repository.append(actionEvent(1, at(1), "propose_patch"));
  await repository.append(policyEvent(1, at(2), "ask"));
  await repository.append(stateEvent(1, at(3), "awaiting_approval"));
}

async function createApprovedAppliedPatchSession(
  repository: SessionRepository,
  overrides: Partial<CreatePersistedSessionInput> = {},
): Promise<void> {
  await createAwaitingApprovalSession(repository, overrides);
  await repository.append(approvalEvent(1, at(4)));
  await repository.append(
    approvalEvent(1, at(5), { status: "approved" }),
  );
  await repository.append(
    toolEvent(1, at(6), "apply_approved_patch", "patch applied"),
  );
}

async function putSessionInState(
  repository: SessionRepository,
  state: "created" | "running" | "awaiting_approval",
): Promise<Readonly<{ round: number; nextSecond: number }>> {
  switch (state) {
    case "created":
      await repository.createSession(validSession());
      return { round: 0, nextSecond: 1 };
    case "running":
      await createRunningSession(repository);
      return { round: 0, nextSecond: 1 };
    case "awaiting_approval":
      await createAwaitingApprovalSession(repository);
      return { round: 1, nextSecond: 4 };
  }
}

function terminalProbe(
  kind: HarnessEvent["kind"],
  round: number,
  occurredAt: string,
): HarnessEvent {
  switch (kind) {
    case "action":
      return actionEvent(round + 1, occurredAt);
    case "policy":
      return policyEvent(round, occurredAt);
    case "tool_result":
      return toolEvent(round, occurredAt);
    case "verification":
      return verificationEvent(round, occurredAt);
    case "state":
      return stateEvent(round, occurredAt, "failed");
    case "approval":
      return approvalEvent(round, occurredAt);
  }
}

async function terminateSession(
  repository: SessionRepository,
  state: "completed" | "blocked" | "failed" | "stopped",
): Promise<Readonly<{ round: number; nextSecond: number }>> {
  await repository.createSession(validSession());
  if (state === "failed" || state === "stopped") {
    await repository.append(stateEvent(0, at(1), state));
    return { round: 0, nextSecond: 2 };
  }
  await repository.append(stateEvent(0, at(1), "running"));
  await repository.append(stateEvent(0, at(2), state));
  return { round: 0, nextSecond: 3 };
}

async function appendValidBrowsePrefix(
  repository: SessionRepository,
): Promise<void> {
  await createRunningSession(repository);
  await repository.append(actionEvent(1, at(1)));
  await repository.append(policyEvent(1, at(2)));
}

describe("session event persistence", () => {
  it("persists one ordered action-policy-tool-state timeline including the initial state", async () => {
    await withRepository(async (repository) => {
      await createRunningSession(repository);
      await repository.append(
        actionEvent(1, at(1), "read_file", "a1", "read input"),
      );
      await repository.append(policyEvent(1, at(2), "allow", "allowed"));
      await repository.append(
        toolEvent(1, at(3), "read_file", "read result"),
      );
      await repository.append(stateEvent(1, at(4), "running", "continue"));

      const timeline = await repository.loadTimeline(SESSION_ID);
      expect(timeline).toEqual([
        stateEvent(0, at(0), "running", "running"),
        actionEvent(1, at(1), "read_file", "a1", "read input"),
        policyEvent(1, at(2), "allow", "allowed"),
        toolEvent(1, at(3), "read_file", "read result"),
        stateEvent(1, at(4), "running", "continue"),
      ]);
      for (const event of timeline) {
        expect(Object.isFrozen(event)).toBe(true);
        expect(Object.isFrozen(event.details)).toBe(true);
      }
      await expect(repository.loadSession(SESSION_ID)).resolves.toMatchObject({
        round: 1,
        state: "running",
        updatedAt: at(4),
      });
    });
  });

  it("allows deterministic events with the same canonical timestamp", async () => {
    await withRepository(async (repository) => {
      await createRunningSession(repository);
      await repository.append(actionEvent(1, at(0)));
      await repository.append(policyEvent(1, at(0)));
      await repository.append(toolEvent(1, at(0)));

      expect(await repository.loadTimeline(SESSION_ID)).toHaveLength(4);
      await expect(repository.loadSession(SESSION_ID)).resolves.toMatchObject({
        round: 1,
        updatedAt: at(0),
      });
    });
  });

  it("rejects an earlier four-digit-year event after an extended-year session timestamp", async () => {
    await withRepository(async (repository) => {
      const createdAt = "+010000-01-01T00:00:00.000Z";
      await repository.createSession(validSession({ createdAt }));
      const sessionBefore = await repository.loadSession(SESSION_ID);

      await expectRejected(
        repository.append(
          stateEvent(
            0,
            "9999-12-31T23:59:59.999Z",
            "running",
          ),
        ),
        "INVALID_EVENT_SEQUENCE",
      );
      expect(await repository.loadTimeline(SESSION_ID)).toEqual([]);
      expect(await repository.loadSession(SESSION_ID)).toEqual(sessionBefore);
    });
  });

  it("maps every event variant and persists normalized approvals and verifications", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createAwaitingApprovalSession(repository);
      await repository.append(approvalEvent(1, at(4)));
      await repository.append(
        approvalEvent(1, at(5), { status: "approved" }),
      );
      await repository.append(
        toolEvent(1, at(6), "apply_approved_patch", "patch applied"),
      );
      await repository.append(verificationEvent(1, at(7)));
      await repository.append(stateEvent(1, at(8), "completed"));

      const timeline = await repository.loadTimeline(SESSION_ID);
      expect(timeline.map(({ kind }) => kind)).toEqual([
        "state",
        "action",
        "policy",
        "state",
        "approval",
        "approval",
        "tool_result",
        "verification",
        "state",
      ]);
      expect(timeline.slice(4)).toEqual([
        approvalEvent(1, at(4)),
        approvalEvent(1, at(5), { status: "approved" }),
        toolEvent(1, at(6), "apply_approved_patch", "patch applied"),
        verificationEvent(1, at(7)),
        stateEvent(1, at(8), "completed"),
      ]);
      for (const event of timeline) {
        expect(Object.isFrozen(event)).toBe(true);
        expect(Object.isFrozen(event.details)).toBe(true);
      }

      const normalized = inspectDatabase(databasePath, (database) => ({
        approval: database.prepare("SELECT * FROM approvals").get(),
        verification: database
          .prepare(`
            SELECT
              session_id,
              round,
              command_id,
              exit_code,
              duration_ms,
              status,
              timed_out,
              summary
            FROM verification_runs
          `)
          .get(),
        action: database
          .prepare("SELECT result_summary FROM action_records WHERE action_id = ?")
          .get(ACTION_ID),
      }));
      expect(normalized).toEqual({
        approval: {
          id: "approval-1",
          session_id: SESSION_ID,
          action_id: ACTION_ID,
          patch_hash: HASH,
          base_hash: HASH,
          status: "approved",
          created_at: 1,
          expires_at: 2,
        },
        verification: {
          session_id: SESSION_ID,
          round: 1,
          command_id: "test-command",
          exit_code: 1,
          duration_ms: 10,
          status: "completed",
          timed_out: 0,
          summary: "verification failed",
        },
        action: { result_summary: "verification failed" },
      });
    });
  });

  it.each([
    ["same round", 0],
    ["jumped round", 2],
  ])("rejects an action in the %s", async (_label, round) => {
    await withRepository(async (repository) => {
      await createRunningSession(repository);

      await expectRejected(
        repository.append(actionEvent(round, at(1))),
        "INVALID_EVENT_SEQUENCE",
      );
      expect(await repository.loadTimeline(SESSION_ID)).toHaveLength(1);
    });
  });

  it("rejects a second action in one round", async () => {
    await withRepository(async (repository) => {
      await createRunningSession(repository);
      await repository.append(actionEvent(1, at(1)));

      await expectRejected(
        repository.append(actionEvent(1, at(2), "read_file", "action-2")),
        "INVALID_EVENT_SEQUENCE",
      );
      expect(await repository.loadTimeline(SESSION_ID)).toHaveLength(2);
    });
  });

  it("rejects a non-action event that advances the round", async () => {
    await withRepository(async (repository) => {
      await createRunningSession(repository);

      await expectRejected(
        repository.append(stateEvent(1, at(1))),
        "INVALID_EVENT_SEQUENCE",
      );
      expect(await repository.loadTimeline(SESSION_ID)).toHaveLength(1);
    });
  });

  it.each([
    ["policy", policyEvent(0, at(1))],
    ["tool result", toolEvent(0, at(1))],
  ])("rejects %s before an action", async (_label, event) => {
    await withRepository(async (repository) => {
      await createRunningSession(repository);

      await expectRejected(
        repository.append(event),
        "INVALID_EVENT_SEQUENCE",
      );
      expect(await repository.loadTimeline(SESSION_ID)).toHaveLength(1);
    });
  });

  it("rejects a tool result before policy", async () => {
    await withRepository(async (repository) => {
      await createRunningSession(repository);
      await repository.append(actionEvent(1, at(1)));

      await expectRejected(
        repository.append(toolEvent(1, at(2))),
        "INVALID_EVENT_SEQUENCE",
      );
      expect(await repository.loadTimeline(SESSION_ID)).toHaveLength(2);
    });
  });

  it("rejects a second policy for the same action", async () => {
    await withRepository(async (repository) => {
      await createRunningSession(repository);
      await repository.append(actionEvent(1, at(1)));
      await repository.append(policyEvent(1, at(2)));

      await expectRejected(
        repository.append(policyEvent(1, at(3))),
        "INVALID_EVENT_SEQUENCE",
      );
      expect(await repository.loadTimeline(SESSION_ID)).toHaveLength(3);
    });
  });

  it("rejects an event whose occurredAt decreases", async () => {
    await withRepository(async (repository) => {
      await createRunningSession(repository);
      await repository.append(actionEvent(1, at(2)));

      await expectRejected(
        repository.append(policyEvent(1, at(1))),
        "INVALID_EVENT_SEQUENCE",
      );
      expect(await repository.loadTimeline(SESSION_ID)).toHaveLength(2);
    });
  });

  it("rejects an action while the session is created", async () => {
    await withRepository(async (repository) => {
      await repository.createSession(validSession());

      await expectRejected(
        repository.append(actionEvent(1, at(1))),
        "INVALID_EVENT_SEQUENCE",
      );
      expect(await repository.loadTimeline(SESSION_ID)).toEqual([]);
    });
  });

  it("rejects created to completed", async () => {
    await withRepository(async (repository) => {
      await repository.createSession(validSession());

      await expectRejected(
        repository.append(stateEvent(0, at(1), "completed")),
        "INVALID_EVENT_SEQUENCE",
      );
      expect(await repository.loadTimeline(SESSION_ID)).toEqual([]);
    });
  });

  it.each(["completed", "blocked", "failed", "stopped"] as const)(
    "rejects every event kind after terminal state %s",
    async (terminalState) => {
      for (const kind of [
        "action",
        "policy",
        "tool_result",
        "verification",
        "state",
        "approval",
      ] as const) {
        await withRepository(async (repository) => {
          const { round, nextSecond } = await terminateSession(
            repository,
            terminalState,
          );
          const before = await repository.loadTimeline(SESSION_ID);

          await expectRejected(
            repository.append(terminalProbe(kind, round, at(nextSecond))),
            "INVALID_EVENT_SEQUENCE",
          );
          expect(
            await repository.loadTimeline(SESSION_ID),
            `${terminalState}/${kind}`,
          ).toEqual(before);
        });
      }
    },
  );

  it("rejects round-zero verification for feature implementation", async () => {
    await withRepository(async (repository) => {
      await repository.createSession(
        validSession({ taskKind: "feature_implementation" }),
      );

      await expectRejected(
        repository.append(verificationEvent(0, at(1))),
        "INVALID_EVENT_SEQUENCE",
      );
      expect(await repository.loadTimeline(SESSION_ID)).toEqual([]);
    });
  });

  it("rejects any transition to running at round three", async () => {
    await withRepository(async (repository) => {
      await createRunningSession(repository);
      for (let round = 1; round <= 3; round += 1) {
        await repository.append(
          actionEvent(round, at(round * 2 - 1), "finish", `action-${round}`),
        );
        if (round < 3) {
          await repository.append(
            stateEvent(round, at(round * 2), "running"),
          );
        }
      }
      const before = await repository.loadTimeline(SESSION_ID);

      await expectRejected(
        repository.append(stateEvent(3, at(7), "running")),
        "INVALID_EVENT_SEQUENCE",
      );
      expect(await repository.loadTimeline(SESSION_ID)).toEqual(before);
    });
  });

  it("rejects a browse result whose kind differs from its action", async () => {
    await withRepository(async (repository) => {
      await appendValidBrowsePrefix(repository);

      await expectRejected(
        repository.append(toolEvent(1, at(3), "search_text")),
        "INVALID_EVENT_SEQUENCE",
      );
      expect(await repository.loadTimeline(SESSION_ID)).toHaveLength(3);
    });
  });

  it.each(["ask", "deny"] as const)(
    "rejects a browse result after policy %s",
    async (decision) => {
      await withRepository(async (repository) => {
        await createRunningSession(repository);
        await repository.append(actionEvent(1, at(1)));
        await repository.append(policyEvent(1, at(2), decision));

        await expectRejected(
          repository.append(toolEvent(1, at(3))),
          "INVALID_EVENT_SEQUENCE",
        );
        expect(await repository.loadTimeline(SESSION_ID)).toHaveLength(3);
      });
    },
  );

  it("requires an approved same-round propose-patch action before applied-patch result", async () => {
    await withRepository(async (repository) => {
      await createAwaitingApprovalSession(repository);

      await expectRejected(
        repository.append(toolEvent(1, at(4), "apply_approved_patch")),
        "INVALID_EVENT_SEQUENCE",
      );
      await repository.append(approvalEvent(1, at(4)));
      await expectRejected(
        repository.append(toolEvent(1, at(5), "apply_approved_patch")),
        "INVALID_EVENT_SEQUENCE",
      );
      await repository.append(
        approvalEvent(1, at(5), { status: "approved" }),
      );
      await repository.append(
        toolEvent(1, at(6), "apply_approved_patch"),
      );

      expect(await repository.loadTimeline(SESSION_ID)).toHaveLength(7);
    });
  });

  it("rejects applied-patch result when the approved approval names another action", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createAwaitingApprovalSession(repository);
      await expectRejected(
        repository.append(
          approvalEvent(1, at(4), {
            actionId: "another-action",
          }),
        ),
        "INVALID_EVENT_SEQUENCE",
      );
      const timelineBefore = await repository.loadTimeline(SESSION_ID);

      await expectRejected(
        repository.append(
          toolEvent(1, at(5), "apply_approved_patch"),
        ),
        "INVALID_EVENT_SEQUENCE",
      );
      expect(await repository.loadTimeline(SESSION_ID)).toEqual(
        timelineBefore,
      );
      const action = inspectDatabase(databasePath, (database) =>
        database
          .prepare(`
            SELECT result_summary
            FROM action_records
            WHERE action_id = ?
          `)
          .get(ACTION_ID),
      );
      expect(action).toEqual({ result_summary: null });
    });
  });

  it("persists a pending approval only for the same propose-patch action after ask", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createAwaitingApprovalSession(repository);
      const event = approvalEvent(1, at(4), {
        patchHash: "b".repeat(64),
        baseHash: "c".repeat(64),
        createdAt: 100,
        expiresAt: 200,
      });

      await repository.append(event);

      expect((await repository.loadTimeline(SESSION_ID)).at(-1)).toEqual(event);
      expect(
        inspectDatabase(databasePath, (database) =>
          database.prepare("SELECT * FROM approvals").get(),
        ),
      ).toEqual({
        id: "approval-1",
        session_id: SESSION_ID,
        action_id: ACTION_ID,
        patch_hash: "b".repeat(64),
        base_hash: "c".repeat(64),
        status: "pending",
        created_at: 100,
        expires_at: 200,
      });
    });
  });

  it("persists negative approval timestamps produced by PendingPatchStore", async () => {
    await withFileRepository(async (repository, databasePath) => {
      const registration = new PendingPatchStore().create({
        sessionId: SESSION_ID,
        action: {
          kind: "propose_patch",
          path: "src/example.ts",
          baseHash: HASH,
          patch: "patch",
          reason: "repair",
          stage: "test",
        },
        actionId: ACTION_ID,
        approvalId: "approval-1",
        now: -1_000,
      });
      await createAwaitingApprovalSession(repository);

      await repository.append(
        approvalEvent(1, at(4), {
          approvalId: registration.approval.id,
          actionId: registration.approval.actionId,
          patchHash: registration.approval.patchHash,
          baseHash: registration.approval.baseHash,
          status: registration.approval.status,
          createdAt: registration.approval.createdAt,
          expiresAt: registration.approval.expiresAt,
        }),
      );

      expect(
        inspectDatabase(databasePath, (database) =>
          database
            .prepare("SELECT created_at, expires_at FROM approvals")
            .get(),
        ),
      ).toEqual({
        created_at: registration.approval.createdAt,
        expires_at: registration.approval.expiresAt,
      });
    });
  });

  it("accepts the Date millisecond lower bound for approval metadata", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createAwaitingApprovalSession(repository);

      await repository.append(
        approvalEvent(1, at(4), {
          createdAt: MIN_DATE_TIMESTAMP,
          expiresAt: MIN_DATE_TIMESTAMP + 1,
        }),
      );

      expect(
        inspectDatabase(databasePath, (database) =>
          database
            .prepare("SELECT created_at, expires_at FROM approvals")
            .get(),
        ),
      ).toEqual({
        created_at: MIN_DATE_TIMESTAMP,
        expires_at: MIN_DATE_TIMESTAMP + 1,
      });
    });
  });

  it.each([
    [
      "wrong action id",
      async (repository: SessionRepository) => {
        await createAwaitingApprovalSession(repository);
      },
      { actionId: "wrong-action" },
    ],
    [
      "non-propose action",
      async (repository: SessionRepository) => {
        await createRunningSession(repository);
        await repository.append(actionEvent(1, at(1), "read_file"));
        await repository.append(policyEvent(1, at(2), "ask"));
        await repository.append(stateEvent(1, at(3), "awaiting_approval"));
      },
      {},
    ],
    [
      "missing policy",
      async (repository: SessionRepository) => {
        await createRunningSession(repository);
        await repository.append(actionEvent(1, at(1), "propose_patch"));
        await repository.append(stateEvent(1, at(2), "awaiting_approval"));
      },
      {},
    ],
    [
      "non-ask policy",
      async (repository: SessionRepository) => {
        await createRunningSession(repository);
        await repository.append(actionEvent(1, at(1), "propose_patch"));
        await repository.append(policyEvent(1, at(2), "allow"));
        await repository.append(stateEvent(1, at(3), "awaiting_approval"));
      },
      {},
    ],
  ] as const)(
    "rejects pending approval with %s",
    async (_label, setup, overrides) => {
      await withFileRepository(async (repository, databasePath) => {
        await setup(repository);
        const before = businessSnapshot(databasePath);

        await expectRejected(
          repository.append(
            approvalEvent(
              (await repository.loadSession(SESSION_ID))?.round ?? 1,
              at(4),
              overrides,
            ),
          ),
          "INVALID_EVENT_SEQUENCE",
        );
        expect(businessSnapshot(databasePath)).toEqual(before);
      });
    },
  );

  it("classifies pending approval replay and a second approval id as duplicate records", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createAwaitingApprovalSession(repository);
      const pending = approvalEvent(1, at(4));
      await repository.append(pending);
      const before = businessSnapshot(databasePath);

      await expectRejected(
        repository.append({ ...pending, occurredAt: at(5) }),
        "DUPLICATE_RECORD",
      );
      await expectRejected(
        repository.append(
          approvalEvent(1, at(5), { approvalId: "approval-2" }),
        ),
        "DUPLICATE_RECORD",
      );
      expect(businessSnapshot(databasePath)).toEqual(before);
    });
  });

  it.each(["approved", "rejected", "expired"] as const)(
    "transitions pending approval to %s with immutable metadata",
    async (status) => {
      await withFileRepository(async (repository, databasePath) => {
        await createAwaitingApprovalSession(repository);
        await repository.append(approvalEvent(1, at(4)));
        const terminal = approvalEvent(1, at(5), { status });

        await repository.append(terminal);

        expect((await repository.loadTimeline(SESSION_ID)).at(-1)).toEqual(
          terminal,
        );
        expect(
          inspectDatabase(databasePath, (database) =>
            database
              .prepare("SELECT status FROM approvals WHERE id = ?")
              .get("approval-1"),
          ),
        ).toEqual({ status });
      });
    },
  );

  it("rejects invalid approval transitions and metadata changes without partial writes", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createAwaitingApprovalSession(repository);
      await repository.append(approvalEvent(1, at(4)));
      await repository.append(
        approvalEvent(1, at(5), { status: "approved" }),
      );
      const before = businessSnapshot(databasePath);

      await expectRejected(
        repository.append(
          approvalEvent(1, at(6), { status: "approved" }),
        ),
        "DUPLICATE_RECORD",
      );
      for (const details of [
        { status: "pending" as const },
        { status: "rejected" as const },
        { status: "approved" as const, patchHash: "b".repeat(64) },
        { status: "approved" as const, actionId: "wrong-action" },
        { status: "approved" as const, createdAt: 0 },
        { status: "approved" as const, expiresAt: 3 },
      ]) {
        await expectRejected(
          repository.append(approvalEvent(1, at(6), details)),
          "INVALID_EVENT_SEQUENCE",
        );
      }
      expect(businessSnapshot(databasePath)).toEqual(before);
    });
  });

  it("rejects a terminal approval without an existing pending row", async () => {
    await withRepository(async (repository) => {
      await createAwaitingApprovalSession(repository);
      await expectRejected(
        repository.append(
          approvalEvent(1, at(4), { status: "approved" }),
        ),
        "INVALID_EVENT_SEQUENCE",
      );
    });
  });

  const allowedTransitions: Readonly<
    Record<
      "created" | "running" | "awaiting_approval",
      ReadonlySet<SessionState>
    >
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

  for (const current of [
    "created",
    "running",
    "awaiting_approval",
  ] as const) {
    for (const target of [
      "created",
      "running",
      "awaiting_approval",
      "completed",
      "blocked",
      "failed",
      "stopped",
    ] as const) {
      const expectedAllowed = allowedTransitions[current].has(target);
      it(`${expectedAllowed ? "allows" : "rejects"} state transition ${current} -> ${target}`, async () => {
        await withRepository(async (repository) => {
          const { round, nextSecond } = await putSessionInState(
            repository,
            current,
          );
          let transitionRound = round;
          let transitionSecond = nextSecond;
          if (current === "running" && target === "awaiting_approval") {
            await repository.append(
              actionEvent(1, at(1), "propose_patch"),
            );
            await repository.append(policyEvent(1, at(2), "ask"));
            transitionRound = 1;
            transitionSecond = 3;
          }
          const before = await repository.loadTimeline(SESSION_ID);
          const appended = repository.append(
            stateEvent(transitionRound, at(transitionSecond), target),
          );

          if (expectedAllowed) {
            await appended;
            await expect(
              repository.loadSession(SESSION_ID),
            ).resolves.toMatchObject({
              state: target,
              updatedAt: at(transitionSecond),
            });
            expect(await repository.loadTimeline(SESSION_ID)).toHaveLength(
              before.length + 1,
            );
          } else {
            await expectRejected(appended, "INVALID_EVENT_SEQUENCE");
            expect(await repository.loadTimeline(SESSION_ID)).toEqual(before);
          }
        });
      });
    }
  }

  it("allows a stage-invalid action to transition directly to terminal with null policy and result", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createRunningSession(repository, {
        taskKind: "feature_implementation",
      });
      await repository.append(
        actionEvent(1, at(1), "propose_patch", ACTION_ID),
      );
      await repository.append(
        stateEvent(1, at(2), "blocked", "FEATURE_STAGE_INVALID"),
      );

      const action = inspectDatabase(databasePath, (database) =>
        database
          .prepare(`
            SELECT policy_decision, result_summary
            FROM action_records
            WHERE action_id = ?
          `)
          .get(ACTION_ID),
      );
      expect(action).toEqual({
        policy_decision: null,
        result_summary: null,
      });
    });
  });

  it.each([
    ["denied action", "read_file", "deny", "blocked"],
    ["finish action", "finish", "allow", "blocked"],
  ] as const)(
    "allows %s to transition through policy directly to state with null result",
    async (_label, actionKind, decision, state) => {
      await withFileRepository(async (repository, databasePath) => {
        await createRunningSession(repository);
        await repository.append(
          actionEvent(1, at(1), actionKind, ACTION_ID),
        );
        await repository.append(policyEvent(1, at(2), decision));
        await repository.append(stateEvent(1, at(3), state));

        const action = inspectDatabase(databasePath, (database) =>
          database
            .prepare(`
              SELECT policy_decision, result_summary
              FROM action_records
              WHERE action_id = ?
            `)
            .get(ACTION_ID),
        );
        expect(action).toEqual({
          policy_decision: decision,
          result_summary: null,
        });
      });
    },
  );

  it("allows running to running after a failed verification before round three", async () => {
    await withRepository(async (repository) => {
      await repository.createSession(validSession());
      await repository.append(verificationEvent(0, at(1)));
      await repository.append(stateEvent(0, at(2), "running"));
      await repository.append(
        actionEvent(1, at(3), "run_verification", ACTION_ID),
      );
      await repository.append(policyEvent(1, at(4), "allow"));
      await repository.append(verificationEvent(1, at(5)));
      await repository.append(stateEvent(1, at(6), "running"));

      await expect(repository.loadSession(SESSION_ID)).resolves.toMatchObject({
        state: "running",
        round: 1,
        updatedAt: at(6),
      });
    });
  });

  it("rejects later verification from a feature-implementation run-verification action", async () => {
    await withRepository(async (repository) => {
      await createRunningSession(repository, {
        taskKind: "feature_implementation",
      });
      await repository.append(
        actionEvent(1, at(1), "run_verification", ACTION_ID),
      );
      await repository.append(policyEvent(1, at(2), "allow"));
      const timelineBefore = await repository.loadTimeline(SESSION_ID);
      const sessionBefore = await repository.loadSession(SESSION_ID);

      await expectRejected(
        repository.append(verificationEvent(1, at(3))),
        "INVALID_EVENT_SEQUENCE",
      );
      expect(await repository.loadTimeline(SESSION_ID)).toEqual(
        timelineBefore,
      );
      expect(await repository.loadSession(SESSION_ID)).toEqual(sessionBefore);
    });
  });

  it.each([
    ["wrong action kind", "read_file", "allow"],
    ["missing policy", "run_verification", undefined],
    ["ask policy", "run_verification", "ask"],
    ["deny policy", "run_verification", "deny"],
  ] as const)(
    "rejects test-repair running verification with %s without partial writes",
    async (_label, actionKind, decision) => {
      await withFileRepository(async (repository, databasePath) => {
        await createRunningSession(repository);
        await repository.append(
          actionEvent(1, at(1), actionKind, ACTION_ID),
        );
        if (decision !== undefined) {
          await repository.append(policyEvent(1, at(2), decision));
        }
        const timelineBefore = await repository.loadTimeline(SESSION_ID);
        const sessionBefore = await repository.loadSession(SESSION_ID);
        const normalizedBefore = inspectDatabase(
          databasePath,
          (database) => ({
            verifications: database
              .prepare("SELECT * FROM verification_runs ORDER BY run_id")
              .all(),
            action: database
              .prepare(`
                SELECT result_summary
                FROM action_records
                WHERE action_id = ?
              `)
              .get(ACTION_ID),
          }),
        );

        await expectRejected(
          repository.append(verificationEvent(1, at(3))),
          "INVALID_EVENT_SEQUENCE",
        );

        expect(await repository.loadTimeline(SESSION_ID)).toEqual(
          timelineBefore,
        );
        expect(await repository.loadSession(SESSION_ID)).toEqual(
          sessionBefore,
        );
        expect(
          inspectDatabase(databasePath, (database) => ({
            verifications: database
              .prepare("SELECT * FROM verification_runs ORDER BY run_id")
              .all(),
            action: database
              .prepare(`
                SELECT result_summary
                FROM action_records
                WHERE action_id = ?
              `)
              .get(ACTION_ID),
          })),
        ).toEqual(normalizedBefore);
      });
    },
  );

  it("returns SESSION_NOT_FOUND for append and an empty timeline for unknown load", async () => {
    await withRepository(async (repository) => {
      await expectRejected(
        repository.append(
          stateEvent(0, at(1), "running", "running", "missing-session"),
        ),
        "SESSION_NOT_FOUND",
      );
      await expect(repository.loadTimeline("missing-session")).resolves.toEqual(
        [],
      );
    });
  });

  it("persists a run-verification fact and overwrites its action result summary", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createRunningSession(repository);
      await repository.append(
        actionEvent(1, at(1), "run_verification", ACTION_ID, "verify"),
      );
      await repository.append(policyEvent(1, at(2), "allow"));
      const verification = verificationEvent(1, at(3), {
        exitCode: 0,
        durationMs: 25,
      });

      await repository.append(verification);

      expect((await repository.loadTimeline(SESSION_ID)).at(-1)).toEqual(
        verification,
      );
      expect(
        inspectDatabase(databasePath, (database) => ({
          verification: database
            .prepare(`
              SELECT
                session_id,
                round,
                command_id,
                exit_code,
                duration_ms,
                status,
                timed_out,
                summary
              FROM verification_runs
            `)
            .get(),
          action: database
            .prepare("SELECT result_summary FROM action_records WHERE action_id = ?")
            .get(ACTION_ID),
        })),
      ).toEqual({
        verification: {
          session_id: SESSION_ID,
          round: 1,
          command_id: "test-command",
          exit_code: 0,
          duration_ms: 25,
          status: "completed",
          timed_out: 0,
          summary: "verification failed",
        },
        action: { result_summary: "verification failed" },
      });
    });
  });

  it("persists round-zero initial verification for test repair without an action", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await repository.createSession(validSession());

      await repository.append(verificationEvent(0, at(1)));

      expect(
        inspectDatabase(databasePath, (database) => ({
          actions: (
            database.prepare("SELECT count(*) AS count FROM action_records").get() as {
              count: number;
            }
          ).count,
          verifications: (
            database.prepare("SELECT count(*) AS count FROM verification_runs").get() as {
              count: number;
            }
          ).count,
        })),
      ).toEqual({ actions: 0, verifications: 1 });
    });
  });

  it("requires the selected verification command id", async () => {
    await withRepository(async (repository) => {
      await repository.createSession(validSession());
      await expectRejected(
        repository.append(
          verificationEvent(0, at(1), { commandId: "other-command" }),
        ),
        "INVALID_EVENT_SEQUENCE",
      );
    });
  });

  it.each(["test_repair", "feature_implementation"] as const)(
    "allows %s awaiting-approval verification only after normalized approval and earlier applied patch facts",
    async (taskKind) => {
      await withFileRepository(async (repository, databasePath) => {
        await createApprovedAppliedPatchSession(repository, { taskKind });

        await repository.append(verificationEvent(1, at(7)));

        expect(
          inspectDatabase(databasePath, (database) =>
            database
              .prepare("SELECT count(*) AS count FROM verification_runs")
              .get(),
          ),
        ).toEqual({ count: 1 });
      });
    },
  );

  it.each([
    [
      "missing terminal approval and applied patch",
      async (repository: SessionRepository) => {
        await createAwaitingApprovalSession(repository);
      },
      undefined,
    ],
    [
      "pending approval only",
      async (repository: SessionRepository) => {
        await createAwaitingApprovalSession(repository);
        await repository.append(approvalEvent(1, at(4)));
      },
      undefined,
    ],
    [
      "approved approval without applied patch",
      async (repository: SessionRepository) => {
        await createAwaitingApprovalSession(repository);
        await repository.append(approvalEvent(1, at(4)));
        await repository.append(
          approvalEvent(1, at(5), { status: "approved" }),
        );
      },
      undefined,
    ],
    [
      "result summary without applied patch fact",
      async (repository: SessionRepository) => {
        await createAwaitingApprovalSession(repository);
        await repository.append(approvalEvent(1, at(4)));
        await repository.append(
          approvalEvent(1, at(5), { status: "approved" }),
        );
      },
      "inject-result",
    ],
    [
      "deleted normalized approval",
      async (repository: SessionRepository) => {
        await createApprovedAppliedPatchSession(repository);
      },
      "delete-approval",
    ],
  ] as const)(
    "rejects awaiting-approval verification with %s",
    async (_label, setup, corruption) => {
      await withFileRepository(async (repository, databasePath) => {
        await setup(repository);
        if (corruption === "inject-result") {
          inspectDatabase(databasePath, (database) => {
            database
              .prepare("UPDATE action_records SET result_summary = ? WHERE action_id = ?")
              .run("looks applied", ACTION_ID);
          });
        } else if (corruption === "delete-approval") {
          inspectDatabase(databasePath, (database) => {
            database.prepare("DELETE FROM approvals WHERE id = ?").run("approval-1");
          });
        }
        const before = businessSnapshot(databasePath);

        await expectRejected(
          repository.append(verificationEvent(1, at(7))),
          "INVALID_EVENT_SEQUENCE",
        );
        expect(businessSnapshot(databasePath)).toEqual(before);
      });
    },
  );

  it("redacts verification summary in timeline, normalized row, and action result", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createRunningSession(repository);
      await repository.append(
        actionEvent(1, at(1), "run_verification"),
      );
      await repository.append(policyEvent(1, at(2), "allow"));
      const secret = "sk-abcdefghijklmnopqrstuv";
      const event = {
        ...verificationEvent(1, at(3)),
        summary: `verification ${secret}`,
      };

      await repository.append(event);

      const stored = inspectDatabase(databasePath, (database) => ({
        timeline: database
          .prepare("SELECT summary FROM timeline_events WHERE kind = 'verification'")
          .get(),
        verification: database
          .prepare("SELECT summary FROM verification_runs")
          .get(),
        action: database
          .prepare("SELECT result_summary FROM action_records WHERE action_id = ?")
          .get(ACTION_ID),
      }));
      expect(stored).toEqual({
        timeline: { summary: "verification [REDACTED]" },
        verification: { summary: "verification [REDACTED]" },
        action: { result_summary: "verification [REDACTED]" },
      });
      expect(JSON.stringify(stored)).not.toContain(secret);
    });
  });

  it("allows legitimately identical verification runs", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createRunningSession(repository);
      await repository.append(
        actionEvent(1, at(1), "run_verification"),
      );
      await repository.append(policyEvent(1, at(2), "allow"));
      const verification = verificationEvent(1, at(3));

      await repository.append(verification);
      await repository.append(verification);

      expect(
        inspectDatabase(databasePath, (database) =>
          database
            .prepare("SELECT count(*) AS count FROM verification_runs")
            .get(),
        ),
      ).toEqual({ count: 2 });
      expect(await repository.loadTimeline(SESSION_ID)).toHaveLength(5);
    });
  });

  it("uses appendAction as exactly one narrow action event", async () => {
    await withRepository(async (repository) => {
      await createRunningSession(repository);
      const timelineBefore = await repository.loadTimeline(SESSION_ID);

      await repository.appendAction(appendActionInput());

      const timeline = await repository.loadTimeline(SESSION_ID);
      expect(timeline.slice(timelineBefore.length)).toEqual([
        actionEvent(1, at(1), "finish", ACTION_ID, "finish"),
      ]);
      await expect(repository.loadSession(SESSION_ID)).resolves.toMatchObject({
        round: 1,
        state: "running",
        updatedAt: at(1),
      });
    });
  });

  it("makes direct and typed approval entries exactly equivalent", async () => {
    const directTimeline = await withRepository(async (repository) => {
      await createAwaitingApprovalSession(repository);
      await repository.append(approvalEvent(1, at(4)));
      return repository.loadTimeline(SESSION_ID);
    });
    const typedTimeline = await withRepository(async (repository) => {
      await createAwaitingApprovalSession(repository);
      const before = (await repository.loadTimeline(SESSION_ID)).length;
      await repository.saveApproval(saveApprovalInput());
      const timeline = await repository.loadTimeline(SESSION_ID);
      expect(timeline).toHaveLength(before + 1);
      return timeline;
    });

    expect(typedTimeline).toEqual(directTimeline);
  });

  it("makes direct and typed verification entries exactly equivalent", async () => {
    const directTimeline = await withRepository(async (repository) => {
      await repository.createSession(validSession());
      await repository.append(verificationEvent(0, at(1)));
      return repository.loadTimeline(SESSION_ID);
    });
    const typedTimeline = await withRepository(async (repository) => {
      await repository.createSession(validSession());
      await repository.appendVerification(appendVerificationInput());
      return repository.loadTimeline(SESSION_ID);
    });

    expect(typedTimeline).toEqual(directTimeline);
    expect(typedTimeline).toHaveLength(1);
  });

  it("classifies direct then typed action replay by stable id without partial writes", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createRunningSession(repository);
      await repository.append(
        actionEvent(1, at(1), "finish", ACTION_ID, "finish"),
      );
      const before = businessSnapshot(databasePath);

      await expectRejected(
        repository.appendAction(appendActionInput()),
        "DUPLICATE_RECORD",
      );

      expect(businessSnapshot(databasePath)).toEqual(before);
    });
  });

  it("classifies typed then direct action replay by stable id without partial writes", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createRunningSession(repository);
      await repository.appendAction(appendActionInput());
      const before = businessSnapshot(databasePath);

      await expectRejected(
        repository.append(
          actionEvent(1, at(1), "finish", ACTION_ID, "finish"),
        ),
        "DUPLICATE_RECORD",
      );

      expect(businessSnapshot(databasePath)).toEqual(before);
    });
  });

  it("classifies direct then typed approval replay by stable id without partial writes", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createAwaitingApprovalSession(repository);
      await repository.append(approvalEvent(1, at(4)));
      const before = businessSnapshot(databasePath);

      await expectRejected(
        repository.saveApproval(saveApprovalInput()),
        "DUPLICATE_RECORD",
      );

      expect(businessSnapshot(databasePath)).toEqual(before);
    });
  });

  it("classifies typed then direct approval replay by stable id without partial writes", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createAwaitingApprovalSession(repository);
      await repository.saveApproval(saveApprovalInput());
      const before = businessSnapshot(databasePath);

      await expectRejected(
        repository.append(approvalEvent(1, at(4))),
        "DUPLICATE_RECORD",
      );

      expect(businessSnapshot(databasePath)).toEqual(before);
    });
  });

  it("allows two legitimately identical typed verification runs", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await repository.createSession(validSession());
      const input = appendVerificationInput();

      await repository.appendVerification(input);
      await repository.appendVerification(input);

      expect(await repository.loadTimeline(SESSION_ID)).toEqual([
        verificationEvent(0, at(1)),
        verificationEvent(0, at(1)),
      ]);
      expect(
        inspectDatabase(databasePath, (database) =>
          database
            .prepare("SELECT count(*) AS count FROM verification_runs")
            .get(),
        ),
      ).toEqual({ count: 2 });
    });
  });

  it("redacts and bounds memory without changing session or timeline state", async () => {
    await withRepository(async (repository) => {
      await createRunningSession(repository);
      const secret = "sk-proj-memory-secret-1234";
      const sessionBefore = await repository.loadSession(SESSION_ID);
      const timelineBefore = await repository.loadTimeline(SESSION_ID);

      await repository.saveSessionMemory(
        saveMemoryInput({
          summary:
            `Authorization: Bearer ${secret} ` +
            "safe ".repeat(MAX_PERSISTED_SUMMARY_CHARACTERS),
        }),
      );

      const memory = await repository.loadSessionMemory(SESSION_ID);
      expect(memory).toEqual({
        sessionId: SESSION_ID,
        summary: expect.stringContaining("[REDACTED]"),
        updatedAt: at(1),
      });
      expect(memory?.summary).toHaveLength(
        MAX_PERSISTED_SUMMARY_CHARACTERS,
      );
      expect(Object.isFrozen(memory)).toBe(true);
      expect(JSON.stringify(memory)).not.toContain(secret);
      expect(await repository.loadSession(SESSION_ID)).toEqual(
        sessionBefore,
      );
      expect(await repository.loadTimeline(SESSION_ID)).toEqual(
        timelineBefore,
      );
    });
  });

  it("returns undefined for unknown memory and rejects unknown memory writes", async () => {
    await withRepository(async (repository) => {
      await expect(
        repository.loadSessionMemory("unknown-session"),
      ).resolves.toBeUndefined();
      await expectRejected(
        repository.saveSessionMemory(
          saveMemoryInput({ sessionId: "unknown-session" }),
        ),
        "SESSION_NOT_FOUND",
      );
      await expect(
        repository.loadSessionMemory("unknown-session"),
      ).resolves.toBeUndefined();
    });
  });

  it("allows equal and newer memory timestamps but preserves memory on an older write", async () => {
    await withRepository(async (repository) => {
      await repository.createSession(validSession());
      await repository.saveSessionMemory(
        saveMemoryInput({ summary: "first", updatedAt: at(2) }),
      );
      await repository.saveSessionMemory(
        saveMemoryInput({ summary: "equal", updatedAt: at(2) }),
      );
      await expect(repository.loadSessionMemory(SESSION_ID)).resolves.toEqual({
        sessionId: SESSION_ID,
        summary: "equal",
        updatedAt: at(2),
      });

      await expectRejected(
        repository.saveSessionMemory(
          saveMemoryInput({ summary: "older", updatedAt: at(1) }),
        ),
        "INVALID_EVENT_SEQUENCE",
      );
      await expect(repository.loadSessionMemory(SESSION_ID)).resolves.toEqual({
        sessionId: SESSION_ID,
        summary: "equal",
        updatedAt: at(2),
      });

      await repository.saveSessionMemory(
        saveMemoryInput({ summary: "newer", updatedAt: at(3) }),
      );
      await expect(repository.loadSessionMemory(SESSION_ID)).resolves.toEqual({
        sessionId: SESSION_ID,
        summary: "newer",
        updatedAt: at(3),
      });
    });
  });

  it("compares four-digit and extended-year memory timestamps by numeric epoch", async () => {
    await withRepository(async (repository) => {
      await repository.createSession(validSession());
      await repository.saveSessionMemory(
        saveMemoryInput({
          summary: "extended",
          updatedAt: "+010000-01-01T00:00:00.000Z",
        }),
      );

      await expectRejected(
        repository.saveSessionMemory(
          saveMemoryInput({
            summary: "lexically-later-but-older",
            updatedAt: "9999-12-31T23:59:59.999Z",
          }),
        ),
        "INVALID_EVENT_SEQUENCE",
      );
      await expect(repository.loadSessionMemory(SESSION_ID)).resolves.toEqual({
        sessionId: SESSION_ID,
        summary: "extended",
        updatedAt: "+010000-01-01T00:00:00.000Z",
      });
    });
  });

  it.each([
    [
      "noncanonical time",
      saveMemoryInput({ updatedAt: "2026-07-30T00:00:01Z" }),
    ],
    [
      "oversized summary",
      saveMemoryInput({
        summary: "x".repeat(MAX_PERSISTED_TEXT_INPUT_CHARACTERS + 1),
      }),
    ],
    [
      "extra key",
      { ...saveMemoryInput(), extra: SENTINEL },
    ],
    [
      "non-string summary",
      { ...saveMemoryInput(), summary: 1 },
    ],
  ] as const)("rejects invalid memory input: %s", async (_label, input) => {
    await withRepository(async (repository) => {
      await repository.createSession(validSession());
      const sessionBefore = await repository.loadSession(SESSION_ID);

      await expectRejected(
        repository.saveSessionMemory(
          input as unknown as SaveSessionMemoryInput,
        ),
        "INVALID_PERSISTENCE_INPUT",
      );
      await expect(
        repository.loadSessionMemory(SESSION_ID),
      ).resolves.toBeUndefined();
      expect(await repository.loadSession(SESSION_ID)).toEqual(
        sessionBefore,
      );
    });
  });

  it("rejects typed-entry and memory Proxies without traps or reentry", async () => {
    const cases: ReadonlyArray<Readonly<{
      label: string;
      setup(repository: SessionRepository): Promise<void>;
      input(): object;
      invoke(repository: SessionRepository, input: object): Promise<void>;
    }>> = [
      {
        label: "action",
        setup: createRunningSession,
        input: appendActionInput,
        invoke: (repository, input) =>
          repository.appendAction(input as AppendActionInput),
      },
      {
        label: "approval",
        setup: createAwaitingApprovalSession,
        input: saveApprovalInput,
        invoke: (repository, input) =>
          repository.saveApproval(input as SaveApprovalInput),
      },
      {
        label: "verification",
        setup: (repository) =>
          repository.createSession(validSession()),
        input: appendVerificationInput,
        invoke: (repository, input) =>
          repository.appendVerification(input as AppendVerificationInput),
      },
      {
        label: "memory",
        setup: (repository) =>
          repository.createSession(validSession()),
        input: saveMemoryInput,
        invoke: (repository, input) =>
          repository.saveSessionMemory(input as SaveSessionMemoryInput),
      },
    ];

    for (const entry of cases) {
      await withRepository(async (repository) => {
        await entry.setup(repository);
        const sessionBefore = await repository.loadSession(SESSION_ID);
        const timelineBefore = await repository.loadTimeline(SESSION_ID);
        let trapCalls = 0;
        let innerAppend: Promise<void> | undefined;
        const input = new Proxy(entry.input(), {
          get(): never {
            trapCalls += 1;
            innerAppend = repository.append(
              stateEvent(0, at(10), "failed"),
            );
            void innerAppend.catch(() => undefined);
            throw new Error(SENTINEL);
          },
        });

        const error = await expectRejected(
          entry.invoke(repository, input),
          "INVALID_PERSISTENCE_INPUT",
        );
        expect(visibleErrorText(error), entry.label).not.toContain(SENTINEL);
        expect(trapCalls, entry.label).toBe(0);
        expect(innerAppend, entry.label).toBeUndefined();
        expect(await repository.loadSession(SESSION_ID), entry.label).toEqual(
          sessionBefore,
        );
        expect(
          await repository.loadTimeline(SESSION_ID),
          entry.label,
        ).toEqual(timelineBefore);
      });
    }
  });

  it("rejects typed-entry and memory accessors without invoking them", async () => {
    const cases: ReadonlyArray<Readonly<{
      label: string;
      field: string;
      setup(repository: SessionRepository): Promise<void>;
      input(): object;
      invoke(repository: SessionRepository, input: object): Promise<void>;
    }>> = [
      {
        label: "action",
        field: "inputSummary",
        setup: createRunningSession,
        input: appendActionInput,
        invoke: (repository, input) =>
          repository.appendAction(input as AppendActionInput),
      },
      {
        label: "approval",
        field: "summary",
        setup: createAwaitingApprovalSession,
        input: saveApprovalInput,
        invoke: (repository, input) =>
          repository.saveApproval(input as SaveApprovalInput),
      },
      {
        label: "verification",
        field: "summary",
        setup: (repository) =>
          repository.createSession(validSession()),
        input: appendVerificationInput,
        invoke: (repository, input) =>
          repository.appendVerification(input as AppendVerificationInput),
      },
      {
        label: "memory",
        field: "summary",
        setup: (repository) =>
          repository.createSession(validSession()),
        input: saveMemoryInput,
        invoke: (repository, input) =>
          repository.saveSessionMemory(input as SaveSessionMemoryInput),
      },
    ];

    for (const entry of cases) {
      await withRepository(async (repository) => {
        await entry.setup(repository);
        const sessionBefore = await repository.loadSession(SESSION_ID);
        const timelineBefore = await repository.loadTimeline(SESSION_ID);
        const input = entry.input();
        let getterCalls = 0;
        let innerAppend: Promise<void> | undefined;
        Object.defineProperty(input, entry.field, {
          enumerable: true,
          configurable: true,
          get(): never {
            getterCalls += 1;
            innerAppend = repository.append(
              stateEvent(0, at(10), "failed"),
            );
            void innerAppend.catch(() => undefined);
            throw new Error(SENTINEL);
          },
        });

        const error = await expectRejected(
          entry.invoke(repository, input),
          "INVALID_PERSISTENCE_INPUT",
        );
        expect(visibleErrorText(error), entry.label).not.toContain(SENTINEL);
        expect(getterCalls, entry.label).toBe(0);
        expect(innerAppend, entry.label).toBeUndefined();
        expect(await repository.loadSession(SESSION_ID), entry.label).toEqual(
          sessionBefore,
        );
        expect(
          await repository.loadTimeline(SESSION_ID),
          entry.label,
        ).toEqual(timelineBefore);
      });
    }
  });

  it("returns fixed PERSISTENCE_FAILED for corrupted stored memory", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await repository.createSession(validSession());
      await repository.saveSessionMemory(saveMemoryInput());
      inspectDatabase(databasePath, (database) => {
        database
          .prepare(
            "UPDATE session_memory SET summary = ? WHERE session_id = ?",
          )
          .run(`token=${SENTINEL}`, SESSION_ID);
      });

      const error = await expectRejected(
        repository.loadSessionMemory(SESSION_ID),
        "PERSISTENCE_FAILED",
      );
      expect(visibleErrorText(error)).not.toContain(SENTINEL);
    });
  });

  it("rolls back memory when an AFTER trigger makes changes=1 a false success", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await repository.createSession(validSession());
      const sessionBefore = await repository.loadSession(SESSION_ID);
      inspectDatabase(databasePath, (database) => {
        database.exec(`
          CREATE TRIGGER corrupt_memory_after_write
          AFTER INSERT ON session_memory
          BEGIN
            DELETE FROM session_memory
            WHERE session_id = NEW.session_id;
          END
        `);
      });

      await expectRejected(
        repository.saveSessionMemory(saveMemoryInput()),
        "PERSISTENCE_FAILED",
      );
      await expect(
        repository.loadSessionMemory(SESSION_ID),
      ).resolves.toBeUndefined();
      expect(await repository.loadSession(SESSION_ID)).toEqual(
        sessionBefore,
      );
      expect(await repository.loadTimeline(SESSION_ID)).toEqual([]);
    });
  });

  it("rolls back memory when an AFTER trigger mutates the owning session", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await repository.createSession(validSession());
      const sessionBefore = await repository.loadSession(SESSION_ID);
      inspectDatabase(databasePath, (database) => {
        database.exec(`
          CREATE TRIGGER corrupt_session_from_memory
          AFTER INSERT ON session_memory
          BEGIN
            UPDATE sessions
            SET updated_at = '${at(2)}'
            WHERE id = NEW.session_id;
          END
        `);
      });

      await expectRejected(
        repository.saveSessionMemory(saveMemoryInput()),
        "PERSISTENCE_FAILED",
      );
      await expect(
        repository.loadSessionMemory(SESSION_ID),
      ).resolves.toBeUndefined();
      expect(await repository.loadSession(SESSION_ID)).toEqual(
        sessionBefore,
      );
      expect(await repository.loadTimeline(SESSION_ID)).toEqual([]);
    });
  });

  it("rolls back memory when an AFTER trigger mutates existing timeline content", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createRunningSession(repository);
      const businessBefore = businessSnapshot(databasePath);
      const sessionBefore = await repository.loadSession(SESSION_ID);
      const timelineBefore = await repository.loadTimeline(SESSION_ID);
      inspectDatabase(databasePath, (database) => {
        database.exec(`
          CREATE TRIGGER corrupt_timeline_from_memory
          AFTER INSERT ON session_memory
          BEGIN
            UPDATE timeline_events
            SET summary = 'tampered timeline'
            WHERE session_id = NEW.session_id;
          END
        `);
      });

      await expectRejected(
        repository.saveSessionMemory(saveMemoryInput()),
        "PERSISTENCE_FAILED",
      );
      await expect(
        repository.loadSessionMemory(SESSION_ID),
      ).resolves.toBeUndefined();
      expect(await repository.loadSession(SESSION_ID)).toEqual(
        sessionBefore,
      );
      expect(await repository.loadTimeline(SESSION_ID)).toEqual(
        timelineBefore,
      );
      expect(businessSnapshot(databasePath)).toEqual(businessBefore);
    });
  });

  it("rolls back memory when an AFTER trigger renumbers an existing timeline row", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createRunningSession(repository);
      const businessBefore = businessSnapshot(databasePath);
      const sessionBefore = await repository.loadSession(SESSION_ID);
      const timelineBefore = await repository.loadTimeline(SESSION_ID);
      inspectDatabase(databasePath, (database) => {
        database.exec(`
          CREATE TRIGGER renumber_timeline_from_memory
          AFTER INSERT ON session_memory
          BEGIN
            UPDATE timeline_events
            SET event_id = event_id + 100
            WHERE session_id = NEW.session_id;
          END
        `);
      });

      await expectRejected(
        repository.saveSessionMemory(saveMemoryInput()),
        "PERSISTENCE_FAILED",
      );
      await expect(
        repository.loadSessionMemory(SESSION_ID),
      ).resolves.toBeUndefined();
      expect(await repository.loadSession(SESSION_ID)).toEqual(
        sessionBefore,
      );
      expect(await repository.loadTimeline(SESSION_ID)).toEqual(
        timelineBefore,
      );
      expect(businessSnapshot(databasePath)).toEqual(businessBefore);
    });
  });

  it("maps a corrupted owning session to PERSISTENCE_FAILED on memory save", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await repository.createSession(validSession());
      inspectDatabase(databasePath, (database) => {
        database
          .prepare("UPDATE sessions SET workspace_id = ? WHERE id = ?")
          .run(`workspace ${SENTINEL}`, SESSION_ID);
      });
      const businessBefore = businessSnapshot(databasePath);

      const error = await expectRejected(
        repository.saveSessionMemory(saveMemoryInput()),
        "PERSISTENCE_FAILED",
      );
      expect(visibleErrorText(error)).not.toContain(SENTINEL);
      await expect(
        repository.loadSessionMemory(SESSION_ID),
      ).resolves.toBeUndefined();
      expect(businessSnapshot(databasePath)).toEqual(businessBefore);
      expect(
        inspectDatabase(databasePath, (database) =>
          database
            .prepare("SELECT count(*) AS count FROM session_memory")
            .get(),
        ),
      ).toEqual({ count: 0 });
    });
  });

  it("rejects an oversized summary before writing", async () => {
    await withRepository(async (repository) => {
      await repository.createSession(validSession());
      const oversized = "x".repeat(MAX_PERSISTED_TEXT_INPUT_CHARACTERS + 1);

      await expectRejected(
        repository.append(stateEvent(0, at(1), "running", oversized)),
        "INVALID_PERSISTENCE_INPUT",
      );
      expect(await repository.loadTimeline(SESSION_ID)).toEqual([]);
    });
  });

  it("can read back its own truncated quoted-safe summary", async () => {
    await withRepository(async (repository) => {
      await repository.createSession(validSession());
      const summary = `"${"ordinary text ".repeat(500)}"`;

      await repository.append(
        stateEvent(0, at(1), "running", summary),
      );

      await expect(
        repository.loadTimeline(SESSION_ID),
      ).resolves.toEqual([
        stateEvent(0, at(1), "running", "[REDACTED]"),
      ]);
    });
  });

  it("redacts a secret summary before persistence and return", async () => {
    await withRepository(async (repository) => {
      await repository.createSession(validSession());
      const secret = "sk-proj-repository-secret-123456789";
      await repository.append(
        stateEvent(0, at(1), "running", `token=${secret}`),
      );

      const timeline = await repository.loadTimeline(SESSION_ID);
      expect(timeline[0]?.summary).toBe("token=[REDACTED]");
      expect(JSON.stringify(timeline)).not.toContain(secret);
    });
  });

  it("rejects runtime event and details traps without reading or leaking them", async () => {
    const attacks: ReadonlyArray<
      readonly [string, () => unknown]
    > = [
      [
        "enumerable event extra key",
        () => ({ ...stateEvent(0, at(1)), extra: SENTINEL }),
      ],
      [
        "non-enumerable event extra key",
        () => {
          const event = { ...stateEvent(0, at(1)) };
          Object.defineProperty(event, "extra", {
            value: SENTINEL,
            enumerable: false,
          });
          return event;
        },
      ],
      [
        "enumerable details extra key",
        () => ({
          ...stateEvent(0, at(1)),
          details: { state: "running", extra: SENTINEL },
        }),
      ],
      [
        "non-enumerable details extra key",
        () => {
          const details = { state: "running" };
          Object.defineProperty(details, "extra", {
            value: SENTINEL,
            enumerable: false,
          });
          return { ...stateEvent(0, at(1)), details };
        },
      ],
      [
        "event symbol key",
        () => {
          const event = { ...stateEvent(0, at(1)) };
          Object.defineProperty(event, Symbol("event-secret"), {
            value: SENTINEL,
            enumerable: false,
          });
          return event;
        },
      ],
      [
        "details symbol key",
        () => {
          const details = { state: "running" };
          Object.defineProperty(details, Symbol("details-secret"), {
            value: SENTINEL,
            enumerable: false,
          });
          return { ...stateEvent(0, at(1)), details };
        },
      ],
      [
        "event getter",
        () => {
          const event = { ...stateEvent(0, at(1)) };
          Object.defineProperty(event, "summary", {
            get(): never {
              throw new Error(SENTINEL);
            },
            enumerable: true,
          });
          return event;
        },
      ],
      [
        "details getter",
        () => {
          const details = {};
          Object.defineProperty(details, "state", {
            get(): never {
              throw new Error(SENTINEL);
            },
            enumerable: true,
          });
          return { ...stateEvent(0, at(1)), details };
        },
      ],
      [
        "null event prototype",
        () =>
          Object.assign(Object.create(null) as object, stateEvent(0, at(1)), {
            sentinel: SENTINEL,
          }),
      ],
      [
        "null details prototype",
        () => ({
          ...stateEvent(0, at(1)),
          details: Object.assign(Object.create(null) as object, {
            state: "running",
            sentinel: SENTINEL,
          }),
        }),
      ],
      [
        "custom event prototype",
        () => {
          class RuntimeEvent {
            readonly sessionId = SESSION_ID;
            readonly round = 0;
            readonly kind = "state";
            readonly summary = "running";
            readonly occurredAt = at(1);
            readonly details = { state: "running" };
            readonly sentinel = SENTINEL;
          }
          return new RuntimeEvent();
        },
      ],
      [
        "custom details prototype",
        () => {
          class RuntimeDetails {
            readonly state = "running";
            readonly sentinel = SENTINEL;
          }
          return {
            ...stateEvent(0, at(1)),
            details: new RuntimeDetails(),
          };
        },
      ],
      [
        "own-keys trap",
        () =>
          new Proxy(stateEvent(0, at(1)), {
            ownKeys(): never {
              throw new Error(SENTINEL);
            },
          }),
      ],
      [
        "descriptor trap",
        () =>
          new Proxy(stateEvent(0, at(1)), {
            getOwnPropertyDescriptor(): never {
              throw new Error(SENTINEL);
            },
          }),
      ],
    ];

    for (const [label, attack] of attacks) {
      await withRepository(async (repository) => {
        await repository.createSession(validSession());
        const error = await expectRejected(
          repository.append(attack() as HarnessEvent),
          "INVALID_PERSISTENCE_INPUT",
        );

        expect(visibleErrorText(error), label).not.toContain(SENTINEL);
        expect(await repository.loadTimeline(SESSION_ID), label).toEqual([]);
      });
    }
  });

  it.each([
    [
      "event",
      () => new Proxy(stateEvent(0, at(1)), {}),
    ],
    [
      "details",
      () => ({
        ...stateEvent(0, at(1)),
        details: new Proxy({ state: "running" as const }, {}),
      }),
    ],
  ] as const)("rejects a transparent Proxy %s without writing", async (_label, build) => {
    await withRepository(async (repository) => {
      await repository.createSession(validSession());
      const sessionBefore = await repository.loadSession(SESSION_ID);

      await expectRejected(
        repository.append(build() as HarnessEvent),
        "INVALID_PERSISTENCE_INPUT",
      );
      expect(await repository.loadTimeline(SESSION_ID)).toEqual([]);
      expect(await repository.loadSession(SESSION_ID)).toEqual(sessionBefore);
    });
  });

  it.each([
    "getPrototypeOf",
    "ownKeys",
    "getOwnPropertyDescriptor",
  ] as const)(
    "rejects a Proxy %s reentry trap before it can append",
    async (trapKind) => {
      await withRepository(async (repository) => {
        await repository.createSession(validSession());
        const sessionBefore = await repository.loadSession(SESSION_ID);
        let trapCalls = 0;
        let innerAppend: Promise<void> | undefined;
        const reenter = (): never => {
          trapCalls += 1;
          innerAppend = repository.append(stateEvent(0, at(1)));
          void innerAppend.catch(() => undefined);
          throw new Error(SENTINEL);
        };
        const handler: ProxyHandler<
          Extract<HarnessEvent, { kind: "state" }>
        > = {};
        switch (trapKind) {
          case "getPrototypeOf":
            handler.getPrototypeOf = reenter;
            break;
          case "ownKeys":
            handler.ownKeys = reenter;
            break;
          case "getOwnPropertyDescriptor":
            handler.getOwnPropertyDescriptor = reenter;
            break;
        }
        const input = new Proxy(stateEvent(0, at(2)), handler);

        const error = await expectRejected(
          repository.append(input),
          "INVALID_PERSISTENCE_INPUT",
        );
        if (innerAppend !== undefined) {
          await innerAppend.catch(() => undefined);
        }
        expect(visibleErrorText(error)).not.toContain(SENTINEL);
        expect(trapCalls).toBe(0);
        expect(await repository.loadTimeline(SESSION_ID)).toEqual([]);
        expect(await repository.loadSession(SESSION_ID)).toEqual(
          sessionBefore,
        );
      });
    },
  );

  it("blocks append reentry from createSession input validation and releases the guard", async () => {
    await withRepository(async (repository) => {
      await createRunningSession(repository);
      const timelineBefore = await repository.loadTimeline(SESSION_ID);
      const sessionBefore = await repository.loadSession(SESSION_ID);
      let innerAppend: Promise<void> | undefined;
      const reentrantInput = {
        get id(): string {
          innerAppend = repository.append(actionEvent(1, at(1)));
          void innerAppend.catch(() => undefined);
          throw new Error(SENTINEL);
        },
        taskKind: "test_repair",
        state: "created",
        round: 0,
        workspaceId: "workspace-reentrant",
        providerId: "provider-reentrant",
        verificationCommandId: "command-reentrant",
        createdAt: at(1),
      } as CreatePersistedSessionInput;

      const error = await expectRejected(
        repository.createSession(reentrantInput),
        "INVALID_PERSISTENCE_INPUT",
      );
      expect(visibleErrorText(error)).not.toContain(SENTINEL);
      expect(innerAppend).toBeDefined();
      if (innerAppend !== undefined) {
        await expectRejected(innerAppend, "INVALID_PERSISTENCE_INPUT");
      }
      expect(await repository.loadTimeline(SESSION_ID)).toEqual(
        timelineBefore,
      );
      expect(await repository.loadSession(SESSION_ID)).toEqual(sessionBefore);

      await repository.append(actionEvent(1, at(2)));
      expect(await repository.loadTimeline(SESSION_ID)).toHaveLength(
        timelineBefore.length + 1,
      );
    });
  });

  it.each([
    [
      "invalid round",
      () => ({ ...stateEvent(0, at(1)), round: 0.5 }),
    ],
    [
      "noncanonical occurredAt",
      () => ({ ...stateEvent(0, at(1)), occurredAt: "2026-07-30T00:00:01Z" }),
    ],
    [
      "unknown action kind",
      () => ({
        ...actionEvent(1, at(1)),
        details: { actionId: ACTION_ID, actionKind: "shell" },
      }),
    ],
    [
      "unknown policy decision",
      () => ({
        ...policyEvent(0, at(1)),
        details: { decision: "maybe" },
      }),
    ],
    [
      "unknown tool kind",
      () => ({
        ...toolEvent(0, at(1)),
        details: { toolKind: "shell" },
      }),
    ],
    [
      "inconsistent timeout",
      () =>
        verificationEvent(0, at(1), {
          status: "timed_out",
          timedOut: false,
        }),
    ],
    [
      "negative duration",
      () => verificationEvent(0, at(1), { durationMs: -1 }),
    ],
    [
      "unsafe duration",
      () =>
        verificationEvent(0, at(1), {
          durationMs: Number.MAX_SAFE_INTEGER + 1,
        }),
    ],
    [
      "unsafe exit code",
      () =>
        verificationEvent(0, at(1), {
          exitCode: Number.MAX_SAFE_INTEGER + 1,
        }),
    ],
    [
      "exit code for non-completed status",
      () =>
        verificationEvent(0, at(1), {
          exitCode: 1,
          status: "spawn_failed",
        }),
    ],
    [
      "timedOut true for completed status",
      () => verificationEvent(0, at(1), { timedOut: true }),
    ],
    [
      "invalid approval hash",
      () => approvalEvent(0, at(1), { patchHash: SENTINEL }),
    ],
    [
      "uppercase approval hash",
      () => approvalEvent(0, at(1), { baseHash: "A".repeat(64) }),
    ],
    [
      "invalid approval times",
      () => approvalEvent(0, at(1), { createdAt: 2, expiresAt: 2 }),
    ],
    [
      "unsafe approval time",
      () =>
        approvalEvent(0, at(1), {
          expiresAt: Number.MAX_SAFE_INTEGER + 1,
        }),
    ],
    [
      "approval time beyond Date range",
      () =>
        approvalEvent(0, at(1), {
          expiresAt: 8_640_000_000_000_001,
        }),
    ],
    [
      "approval time before Date range",
      () =>
        approvalEvent(0, at(1), {
          createdAt: MIN_DATE_TIMESTAMP - 1,
          expiresAt: 0,
        }),
    ],
  ])("rejects runtime field validation case %s", async (_label, buildEvent) => {
    await withRepository(async (repository) => {
      await repository.createSession(validSession());

      await expectRejected(
        repository.append(buildEvent() as HarnessEvent),
        "INVALID_PERSISTENCE_INPUT",
      );
      expect(await repository.loadTimeline(SESSION_ID)).toEqual([]);
    });
  });

  it("classifies a clearly duplicated action identifier without leaking SQLite errors", async () => {
    await withRepository(async (repository) => {
      await repository.createSession(validSession());
      await repository.createSession(
        validSession({
          id: "session-2",
          workspaceId: "workspace-2",
        }),
      );
      await repository.append(stateEvent(0, at(0)));
      await repository.append(
        stateEvent(0, at(0), "running", "running", "session-2"),
      );
      await repository.append(actionEvent(1, at(1)));

      await expectRejected(
        repository.append(
          actionEvent(1, at(1), "read_file", ACTION_ID, "read", "session-2"),
        ),
        "DUPLICATE_RECORD",
      );
      expect(await repository.loadTimeline("session-2")).toHaveLength(1);
    });
  });

  it.each([
    [
      "action record insert",
      async (repository: SessionRepository) => {
        await createRunningSession(repository);
      },
      `
        CREATE TRIGGER fail_derived_write
        BEFORE INSERT ON action_records
        BEGIN SELECT RAISE(ABORT, '${SENTINEL}'); END
      `,
      (repository: SessionRepository) =>
        repository.append(actionEvent(1, at(1))),
      1,
    ],
    [
      "action round update",
      async (repository: SessionRepository) => {
        await createRunningSession(repository);
      },
      `
        CREATE TRIGGER fail_derived_write
        BEFORE UPDATE OF round ON sessions
        BEGIN SELECT RAISE(ABORT, '${SENTINEL}'); END
      `,
      (repository: SessionRepository) =>
        repository.append(actionEvent(1, at(1))),
      1,
    ],
    [
      "policy action update",
      async (repository: SessionRepository) => {
        await createRunningSession(repository);
        await repository.append(actionEvent(1, at(1)));
      },
      `
        CREATE TRIGGER fail_derived_write
        BEFORE UPDATE OF policy_decision ON action_records
        BEGIN SELECT RAISE(ABORT, '${SENTINEL}'); END
      `,
      (repository: SessionRepository) =>
        repository.append(policyEvent(1, at(2))),
      2,
    ],
    [
      "tool action update",
      async (repository: SessionRepository) => {
        await appendValidBrowsePrefix(repository);
      },
      `
        CREATE TRIGGER fail_derived_write
        BEFORE UPDATE OF result_summary ON action_records
        BEGIN SELECT RAISE(ABORT, '${SENTINEL}'); END
      `,
      (repository: SessionRepository) =>
        repository.append(toolEvent(1, at(3))),
      3,
    ],
    [
      "state update",
      async (repository: SessionRepository) => {
        await repository.createSession(validSession());
      },
      `
        CREATE TRIGGER fail_derived_write
        BEFORE UPDATE OF state ON sessions
        BEGIN SELECT RAISE(ABORT, '${SENTINEL}'); END
      `,
      (repository: SessionRepository) =>
        repository.append(stateEvent(0, at(1))),
      0,
    ],
    [
      "common updated-at update",
      async (repository: SessionRepository) => {
        await createRunningSession(repository);
        await repository.append(actionEvent(1, at(1)));
      },
      `
        CREATE TRIGGER fail_derived_write
        BEFORE UPDATE OF updated_at ON sessions
        BEGIN SELECT RAISE(ABORT, '${SENTINEL}'); END
      `,
      (repository: SessionRepository) =>
        repository.append(policyEvent(1, at(2))),
      2,
    ],
  ] as const)(
    "rolls back timeline and derived mutations when %s fails",
    async (_label, setup, triggerSql, append, expectedTimelineCount) => {
      await withFileRepository(async (repository, databasePath) => {
        await setup(repository);
        const sessionBefore = await repository.loadSession(SESSION_ID);
        inspectDatabase(databasePath, (database) => database.exec(triggerSql));

        const error = await expectRejected(
          append(repository),
          "PERSISTENCE_FAILED",
        );
        expect(visibleErrorText(error)).not.toContain(SENTINEL);
        expect(await repository.loadTimeline(SESSION_ID)).toHaveLength(
          expectedTimelineCount,
        );
        expect(await repository.loadSession(SESSION_ID)).toEqual(sessionBefore);

        const rows = inspectDatabase(databasePath, (database) => ({
          timeline: (
            database
              .prepare(
                "SELECT count(*) AS count FROM timeline_events WHERE session_id = ?",
              )
              .get(SESSION_ID) as { count: number }
          ).count,
          action:
            database
              .prepare(`
                SELECT policy_decision, result_summary
                FROM action_records
                WHERE session_id = ?
              `)
              .get(SESSION_ID) ?? null,
        }));
        expect(rows.timeline).toBe(expectedTimelineCount);
        if (_label === "policy action update" || _label === "common updated-at update") {
          expect(rows.action).toEqual({
            policy_decision: null,
            result_summary: null,
          });
        }
        if (_label === "tool action update") {
          expect(rows.action).toEqual({
            policy_decision: "allow",
            result_summary: null,
          });
        }
        if (_label === "action record insert" || _label === "action round update") {
          expect(rows.action).toBeNull();
        }
      });
    },
  );

  it.each([
    [
      "approval insert",
      async (repository: SessionRepository) => {
        await createAwaitingApprovalSession(repository);
      },
      `CREATE TRIGGER task5_fail BEFORE INSERT ON approvals
       BEGIN SELECT RAISE(ABORT, '${SENTINEL}'); END`,
      (repository: SessionRepository) =>
        repository.append(approvalEvent(1, at(4))),
    ],
    [
      "approval update",
      async (repository: SessionRepository) => {
        await createAwaitingApprovalSession(repository);
        await repository.append(approvalEvent(1, at(4)));
      },
      `CREATE TRIGGER task5_fail BEFORE UPDATE OF status ON approvals
       BEGIN SELECT RAISE(ABORT, '${SENTINEL}'); END`,
      (repository: SessionRepository) =>
        repository.append(
          approvalEvent(1, at(5), { status: "approved" }),
        ),
    ],
    [
      "verification insert",
      async (repository: SessionRepository) => {
        await createRunningSession(repository);
        await repository.append(
          actionEvent(1, at(1), "run_verification"),
        );
        await repository.append(policyEvent(1, at(2), "allow"));
      },
      `CREATE TRIGGER task5_fail BEFORE INSERT ON verification_runs
       BEGIN SELECT RAISE(ABORT, '${SENTINEL}'); END`,
      (repository: SessionRepository) =>
        repository.append(verificationEvent(1, at(3))),
    ],
  ] as const)(
    "rolls back Task 5 transaction when %s fails",
    async (_label, setup, triggerSql, append) => {
      await withFileRepository(async (repository, databasePath) => {
        await setup(repository);
        const before = businessSnapshot(databasePath);
        const sessionBefore = await repository.loadSession(SESSION_ID);
        inspectDatabase(databasePath, (database) => database.exec(triggerSql));

        const error = await expectRejected(
          append(repository),
          "PERSISTENCE_FAILED",
        );

        expect(visibleErrorText(error)).not.toContain(SENTINEL);
        expect(businessSnapshot(databasePath)).toEqual(before);
        expect(await repository.loadSession(SESSION_ID)).toEqual(sessionBefore);
      });
    },
  );

  it.each([
    [
      "AFTER approval insert delete",
      async (repository: SessionRepository) => {
        await createAwaitingApprovalSession(repository);
      },
      `CREATE TRIGGER task5_corrupt AFTER INSERT ON approvals
       BEGIN DELETE FROM approvals WHERE id = NEW.id; END`,
      (repository: SessionRepository) =>
        repository.append(approvalEvent(1, at(4))),
    ],
    [
      "AFTER approval update modification",
      async (repository: SessionRepository) => {
        await createAwaitingApprovalSession(repository);
        await repository.append(approvalEvent(1, at(4)));
      },
      `CREATE TRIGGER task5_corrupt AFTER UPDATE OF status ON approvals
       BEGIN
         UPDATE approvals SET patch_hash = '${"b".repeat(64)}'
         WHERE id = NEW.id;
       END`,
      (repository: SessionRepository) =>
        repository.append(
          approvalEvent(1, at(5), { status: "approved" }),
        ),
    ],
    [
      "AFTER verification insert delete",
      async (repository: SessionRepository) => {
        await createRunningSession(repository);
        await repository.append(
          actionEvent(1, at(1), "run_verification"),
        );
        await repository.append(policyEvent(1, at(2), "allow"));
      },
      `CREATE TRIGGER task5_corrupt AFTER INSERT ON verification_runs
       BEGIN DELETE FROM verification_runs WHERE run_id = NEW.run_id; END`,
      (repository: SessionRepository) =>
        repository.append(verificationEvent(1, at(3))),
    ],
  ] as const)(
    "rolls back when %s makes changes=1 a false success",
    async (_label, setup, triggerSql, append) => {
      await withFileRepository(async (repository, databasePath) => {
        await setup(repository);
        const before = businessSnapshot(databasePath);
        inspectDatabase(databasePath, (database) => database.exec(triggerSql));

        const error = await expectRejected(
          append(repository),
          "PERSISTENCE_FAILED",
        );

        expect(visibleErrorText(error)).not.toContain(SENTINEL);
        expect(businessSnapshot(databasePath)).toEqual(before);
      });
    },
  );

  it.each([
    [
      "AFTER timeline delete",
      async (repository: SessionRepository) => {
        await repository.createSession(validSession());
      },
      `
        CREATE TRIGGER corrupt_after_write
        AFTER INSERT ON timeline_events
        BEGIN
          DELETE FROM timeline_events WHERE event_id = NEW.event_id;
        END
      `,
      (repository: SessionRepository) =>
        repository.append(stateEvent(0, at(1))),
    ],
    [
      "AFTER timeline summary modification",
      async (repository: SessionRepository) => {
        await repository.createSession(validSession());
      },
      `
        CREATE TRIGGER corrupt_after_write
        AFTER INSERT ON timeline_events
        BEGIN
          UPDATE timeline_events
          SET summary = '${SENTINEL}'
          WHERE event_id = NEW.event_id;
        END
      `,
      (repository: SessionRepository) =>
        repository.append(stateEvent(0, at(1))),
    ],
    [
      "AFTER action-record delete",
      async (repository: SessionRepository) => {
        await createRunningSession(repository);
      },
      `
        CREATE TRIGGER corrupt_after_write
        AFTER INSERT ON action_records
        BEGIN
          DELETE FROM action_records WHERE action_id = NEW.action_id;
        END
      `,
      (repository: SessionRepository) =>
        repository.append(actionEvent(1, at(1))),
    ],
    [
      "AFTER policy modification",
      async (repository: SessionRepository) => {
        await createRunningSession(repository);
        await repository.append(actionEvent(1, at(1)));
      },
      `
        CREATE TRIGGER corrupt_after_write
        AFTER UPDATE OF policy_decision ON action_records
        BEGIN
          UPDATE action_records
          SET policy_decision = 'deny'
          WHERE action_id = NEW.action_id;
        END
      `,
      (repository: SessionRepository) =>
        repository.append(policyEvent(1, at(2), "allow")),
    ],
    [
      "AFTER result modification",
      async (repository: SessionRepository) => {
        await appendValidBrowsePrefix(repository);
      },
      `
        CREATE TRIGGER corrupt_after_write
        AFTER UPDATE OF result_summary ON action_records
        BEGIN
          UPDATE action_records
          SET result_summary = '${SENTINEL}'
          WHERE action_id = NEW.action_id;
        END
      `,
      (repository: SessionRepository) =>
        repository.append(toolEvent(1, at(3))),
    ],
    [
      "AFTER session-state modification",
      async (repository: SessionRepository) => {
        await repository.createSession(validSession());
      },
      `
        CREATE TRIGGER corrupt_after_write
        AFTER UPDATE OF state ON sessions
        BEGIN
          UPDATE sessions SET state = 'failed' WHERE id = NEW.id;
        END
      `,
      (repository: SessionRepository) =>
        repository.append(stateEvent(0, at(1))),
    ],
    [
      "AFTER session-timestamp modification",
      async (repository: SessionRepository) => {
        await createRunningSession(repository);
        await repository.append(actionEvent(1, at(1)));
      },
      `
        CREATE TRIGGER corrupt_after_write
        AFTER UPDATE OF updated_at ON sessions
        BEGIN
          UPDATE sessions SET updated_at = '${at(1)}' WHERE id = NEW.id;
        END
      `,
      (repository: SessionRepository) =>
        repository.append(policyEvent(1, at(2))),
    ],
  ] as const)(
    "rolls back when %s makes changes=1 a false success",
    async (_label, setup, triggerSql, append) => {
      await withFileRepository(async (repository, databasePath) => {
        await setup(repository);
        const rawBefore = businessSnapshot(databasePath);
        const timelineBefore = await repository.loadTimeline(SESSION_ID);
        const sessionBefore = await repository.loadSession(SESSION_ID);
        inspectDatabase(databasePath, (database) => database.exec(triggerSql));

        const error = await expectRejected(
          append(repository),
          "PERSISTENCE_FAILED",
        );
        expect(visibleErrorText(error)).not.toContain(SENTINEL);
        expect(businessSnapshot(databasePath)).toEqual(rawBefore);
        expect(await repository.loadTimeline(SESSION_ID)).toEqual(
          timelineBefore,
        );
        expect(await repository.loadSession(SESSION_ID)).toEqual(
          sessionBefore,
        );
      });
    },
  );

  it("returns fixed PERSISTENCE_FAILED for a corrupted stored timeline row", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createRunningSession(repository);
      inspectDatabase(databasePath, (database) => {
        database
          .prepare(`
            UPDATE timeline_events
            SET occurred_at = ?
            WHERE session_id = ?
          `)
          .run(`2026-07-30T00:00:00.000Z-${SENTINEL}`, SESSION_ID);
      });

      const error = await expectRejected(
        repository.loadTimeline(SESSION_ID),
        "PERSISTENCE_FAILED",
      );
      expect(visibleErrorText(error)).not.toContain(SENTINEL);
    });
  });

  it("rejects a stored extended-year session whose updatedAt is numerically before createdAt", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await repository.createSession(
        validSession({ createdAt: "+010000-01-01T00:00:00.000Z" }),
      );
      inspectDatabase(databasePath, (database) => {
        database
          .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
          .run("9999-12-31T23:59:59.999Z", SESSION_ID);
      });

      await expectRejected(
        repository.loadSession(SESSION_ID),
        "PERSISTENCE_FAILED",
      );
    });
  });

  it("keeps every public text ingress secret out of file bytes and securely removes a marker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codesentinel-physical-safety-"));
    const databasePath = join(directory, "sessions.sqlite");
    const quotedSuffixes = {
      append: "append suffix,segment;2001",
      action: "action suffix,segment;2002",
      approval: "approval suffix,segment;2003",
      verification: "verification suffix,segment;2004",
      memory: "memory suffix,segment;2005",
    } as const;
    const prefixedSentinels = {
      append: "sk-proj-append-summary-sentinel-2001",
      action: "sk-proj-action-summary-sentinel-2002",
      approval: "sk-proj-approval-summary-sentinel-2003",
      verification: "sk-proj-verification-summary-sentinel-2004",
      memory: "sk-proj-memory-summary-sentinel-2005",
    } as const;
    const encodedActionPrefix = prefixedSentinels.action.replace(
      "sk-",
      "sk\\u002d",
    );
    const decodedLongToken = "A".repeat(32);
    const encodedLongToken = `${"A".repeat(31)}\\u0041`;
    const decodedKnownExtension =
      "sk-abcdefghijklZTOPSECRET-2007";
    const encodedKnownExtensionTail =
      "\\u005aTOPSECRET-2007";
    const commentBearerSentinel =
      "gap-token-2006";
    const sentinels = [
      ...Object.values(quotedSuffixes),
      ...Object.values(prefixedSentinels),
      decodedLongToken,
      decodedKnownExtension,
      commentBearerSentinel,
    ];
    const serializedSentinels = [
      encodedActionPrefix,
      encodedLongToken,
      encodedKnownExtensionTail,
    ];
    const deletedMarker =
      "deleted marker :: physical safety :: 2026-07-30 :: A9F4";
    const actionId = "physical-action-1";
    const approvalId = "physical-approval-1";
    const createdAt = Date.parse(at(4));
    const approvalDetails: ApprovalDetails = {
      approvalId,
      actionId,
      patchHash: "b".repeat(64),
      baseHash: HASH,
      status: "pending",
      createdAt,
      expiresAt: createdAt + 15 * 60 * 1_000,
    };
    let repository: SessionRepository | undefined;

    try {
      repository = createSessionRepository(databasePath);
      await repository.createSession(validSession());
      await repository.append(
        stateEvent(
          0,
          at(1),
          "running",
          `{"password":"front""${quotedSuffixes.append}",` +
            `"note":"${prefixedSentinels.append}"}`,
        ),
      );
      await repository.appendAction({
        sessionId: SESSION_ID,
        round: 1,
        occurredAt: at(2),
        actionId,
        actionKind: "propose_patch",
        inputSummary:
          `{"safe":"x\\" , \\"password\\":\\"` +
          `${quotedSuffixes.action} ${encodedActionPrefix} ` +
          `${encodedLongToken}"}`,
      });
      await repository.append(policyEvent(1, at(3), "ask"));
      await repository.append(
        stateEvent(1, at(4), "awaiting_approval"),
      );
      await repository.saveApproval({
        sessionId: SESSION_ID,
        round: 1,
        occurredAt: at(5),
        summary:
          `{"passw\\ord":"${quotedSuffixes.approval} ` +
          `${prefixedSentinels.approval}"}`,
        details: approvalDetails,
      });
      await repository.saveApproval({
        sessionId: SESSION_ID,
        round: 1,
        occurredAt: at(6),
        summary: deletedMarker,
        details: { ...approvalDetails, status: "approved" },
      });
      await repository.append(
        toolEvent(
          1,
          at(7),
          "apply_approved_patch",
          "patch applied",
        ),
      );
      await repository.appendVerification({
        sessionId: SESSION_ID,
        round: 1,
        occurredAt: at(8),
        summary:
          `Bearer/*x*/${commentBearerSentinel} ` +
          `${quotedSuffixes.verification} ` +
          prefixedSentinels.verification,
        details: {
          commandId: "test-command",
          exitCode: 0,
          durationMs: 21,
          status: "completed",
          timedOut: false,
        },
      });
      await repository.saveSessionMemory({
        sessionId: SESSION_ID,
        summary:
          `{"secret":"front ${quotedSuffixes.memory}",` +
          `"note":"${prefixedSentinels.memory}",` +
          `"tail":"sk-abcdefghijkl${encodedKnownExtensionTail}"}`,
        updatedAt: at(9),
      });

      const timeline = await repository.loadTimeline(SESSION_ID);
      const actionSummary = timeline.find(
        (event) =>
          event.kind === "action" &&
          event.details.actionId === actionId,
      )?.summary;
      const verificationSummary = timeline.find(
        (event) => event.kind === "verification",
      )?.summary;
      const decodedActionSummary =
        actionSummary === "[REDACTED]"
          ? actionSummary
          : JSON.parse(actionSummary ?? "{}").safe;
      expect.soft(decodedActionSummary).not.toContain(
        quotedSuffixes.action,
      );
      expect.soft(decodedActionSummary).not.toContain(
        prefixedSentinels.action,
      );
      expect.soft(decodedActionSummary).not.toContain(
        decodedLongToken,
      );
      expect.soft(actionSummary).toBe("[REDACTED]");
      expect.soft(verificationSummary).toBe("[REDACTED]");

      const publicValues = JSON.stringify({
        timeline,
        memory: await repository.loadSessionMemory(SESSION_ID),
      });

      repository.close();
      repository = undefined;

      for (const candidate of [
        databasePath,
        `${databasePath}-journal`,
        `${databasePath}-wal`,
        `${databasePath}-shm`,
      ]) {
        if (!existsSync(candidate)) {
          continue;
        }
        const bytes = await readFile(candidate);
        for (const sentinel of [
          ...sentinels,
          ...serializedSentinels,
        ]) {
          expect(bytes.includes(Buffer.from(sentinel, "utf8"))).toBe(false);
        }
      }
      for (const sentinel of sentinels) {
        expect(publicValues).not.toContain(sentinel);
      }
      expect(publicValues).toContain(deletedMarker);
      const storedBytes = await readFile(databasePath);
      expect(
        storedBytes.includes(Buffer.from(deletedMarker, "utf8")),
      ).toBe(true);

      repository = createSessionRepository(databasePath);
      await repository.clearSession(SESSION_ID);
      repository.close();
      repository = undefined;

      for (const candidate of [
        databasePath,
        `${databasePath}-journal`,
        `${databasePath}-wal`,
        `${databasePath}-shm`,
      ]) {
        if (!existsSync(candidate)) {
          continue;
        }
        const bytes = await readFile(candidate);
        for (const sentinel of [
          ...sentinels,
          ...serializedSentinels,
        ]) {
          expect(bytes.includes(Buffer.from(sentinel, "utf8"))).toBe(false);
        }
        expect(
          bytes.includes(Buffer.from(deletedMarker, "utf8")),
        ).toBe(false);
      }
    } finally {
      repository?.close();
      await rm(directory, { force: true, recursive: true });
    }
  });
});
