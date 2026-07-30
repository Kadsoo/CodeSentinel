import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
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
  MAX_PERSISTED_TEXT_INPUT_CHARACTERS,
  type CreatePersistedSessionInput,
  type SessionRepository,
} from "./index.js";

const SESSION_ID = "session-1";
const ACTION_ID = "action-1";
const HASH = "a".repeat(64);
const SENTINEL = "must-not-leak-sentinel";

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
): Promise<void> {
  await createRunningSession(repository);
  await repository.append(actionEvent(1, at(1), "propose_patch"));
  await repository.append(policyEvent(1, at(2), "ask"));
  await repository.append(stateEvent(1, at(3), "awaiting_approval"));
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

  it("maps every event variant without prematurely normalizing approvals or verifications", async () => {
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

      const normalizedCounts = inspectDatabase(databasePath, (database) => ({
        approvals: (
          database.prepare("SELECT count(*) AS count FROM approvals").get() as {
            count: number;
          }
        ).count,
        verifications: (
          database
            .prepare("SELECT count(*) AS count FROM verification_runs")
            .get() as { count: number }
        ).count,
      }));
      expect(normalizedCounts).toEqual({ approvals: 0, verifications: 0 });
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
      await repository.append(
        approvalEvent(1, at(4), {
          actionId: "another-action",
          status: "approved",
        }),
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
      "invalid approval hash",
      () => approvalEvent(0, at(1), { patchHash: SENTINEL }),
    ],
    [
      "invalid approval times",
      () => approvalEvent(0, at(1), { createdAt: 2, expiresAt: 2 }),
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
});
