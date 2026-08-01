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
  type CreatePersistedSessionInput,
  type SessionRepository,
} from "./index.js";

const HASH = "a".repeat(64);
const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000;
const MIN_DATE_TIMESTAMP = -MAX_DATE_TIMESTAMP;
const SENTINEL = "lifecycle-must-not-leak";
const APPROVAL_EXPIRED_ON_RESTART = "APPROVAL_EXPIRED_ON_RESTART";

type ErrorCode =
  | "INVALID_PERSISTENCE_INPUT"
  | "PERSISTENCE_FAILED";

type ApprovalDetails = Extract<
  HarnessEvent,
  { kind: "approval" }
>["details"];

function at(second: number): string {
  return new Date(Date.UTC(2026, 6, 30, 0, 0, second)).toISOString();
}

function validSession(
  id: string,
  overrides: Partial<CreatePersistedSessionInput> = {},
): CreatePersistedSessionInput {
  return {
    id,
    taskKind: "test_repair",
    state: "created",
    round: 0,
    workspaceId: `workspace-${id}`,
    providerId: "provider-1",
    verificationCommandId: "test-command",
    createdAt: at(0),
    ...overrides,
  };
}

function stateEvent(
  sessionId: string,
  round: number,
  occurredAt: string,
  state: SessionState,
  summary: string = state,
): Extract<HarnessEvent, { kind: "state" }> {
  return {
    sessionId,
    round,
    kind: "state",
    summary,
    occurredAt,
    details: { state },
  };
}

function actionEvent(
  sessionId: string,
  round: number,
  occurredAt: string,
  actionId: string,
  actionKind: "propose_patch" | "run_verification" = "propose_patch",
): Extract<HarnessEvent, { kind: "action" }> {
  return {
    sessionId,
    round,
    kind: "action",
    summary: actionKind,
    occurredAt,
    details: { actionId, actionKind },
  };
}

function policyEvent(
  sessionId: string,
  round: number,
  occurredAt: string,
  decision: "allow" | "ask",
): Extract<HarnessEvent, { kind: "policy" }> {
  return {
    sessionId,
    round,
    kind: "policy",
    summary: decision,
    occurredAt,
    details: { decision },
  };
}

function approvalEvent(
  sessionId: string,
  round: number,
  occurredAt: string,
  actionId: string,
  approvalId: string,
  overrides: Partial<ApprovalDetails> = {},
): Extract<HarnessEvent, { kind: "approval" }> {
  return {
    sessionId,
    round,
    kind: "approval",
    summary: "approval",
    occurredAt,
    details: {
      approvalId,
      actionId,
      patchHash: HASH,
      baseHash: HASH,
      status: "pending",
      createdAt: round * 100,
      expiresAt: round * 100 + 50,
      ...overrides,
    },
  };
}

function appliedPatchEvent(
  sessionId: string,
  round: number,
  occurredAt: string,
): Extract<HarnessEvent, { kind: "tool_result" }> {
  return {
    sessionId,
    round,
    kind: "tool_result",
    summary: "patch applied",
    occurredAt,
    details: { toolKind: "apply_approved_patch" },
  };
}

function verificationEvent(
  sessionId: string,
  round: number,
  occurredAt: string,
): Extract<HarnessEvent, { kind: "verification" }> {
  return {
    sessionId,
    round,
    kind: "verification",
    summary: "verification completed",
    occurredAt,
    details: {
      commandId: "test-command",
      exitCode: 0,
      durationMs: 10,
      status: "completed",
      timedOut: false,
    },
  };
}

async function createRunningSession(
  repository: SessionRepository,
  sessionId: string,
  createdAt = at(0),
): Promise<void> {
  await repository.createSession(validSession(sessionId, { createdAt }));
  await repository.append(
    stateEvent(sessionId, 0, createdAt, "running"),
  );
}

async function appendPendingApproval(
  repository: SessionRepository,
  input: Readonly<{
    sessionId: string;
    round: number;
    actionId: string;
    approvalId: string;
    startSecond: number;
  }>,
): Promise<void> {
  await repository.append(
    actionEvent(
      input.sessionId,
      input.round,
      at(input.startSecond),
      input.actionId,
    ),
  );
  await repository.append(
    policyEvent(
      input.sessionId,
      input.round,
      at(input.startSecond + 1),
      "ask",
    ),
  );
  await repository.append(
    stateEvent(
      input.sessionId,
      input.round,
      at(input.startSecond + 2),
      "awaiting_approval",
    ),
  );
  await repository.append(
    approvalEvent(
      input.sessionId,
      input.round,
      at(input.startSecond + 3),
      input.actionId,
      input.approvalId,
    ),
  );
}

async function createRichSession(
  repository: SessionRepository,
  sessionId: string,
  suffix: string,
): Promise<void> {
  const actionId = `action-${suffix}`;
  const approvalId = `approval-${suffix}`;
  await createRunningSession(repository, sessionId);
  await appendPendingApproval(repository, {
    sessionId,
    round: 1,
    actionId,
    approvalId,
    startSecond: 1,
  });
  await repository.append(
    approvalEvent(sessionId, 1, at(5), actionId, approvalId, {
      status: "approved",
    }),
  );
  await repository.append(appliedPatchEvent(sessionId, 1, at(6)));
  await repository.append(verificationEvent(sessionId, 1, at(7)));
  await repository.saveSessionMemory({
    sessionId,
    summary: `memory-${suffix}`,
    updatedAt: at(8),
  });
}

async function withFileRepository<T>(
  callback: (
    repository: SessionRepository,
    databasePath: string,
  ) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "codesentinel-lifecycle-"));
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

function sessionRowCounts(
  databasePath: string,
  sessionId: string,
): Readonly<Record<string, number>> {
  return inspectDatabase(databasePath, (database) => {
    const tables = [
      "sessions",
      "timeline_events",
      "action_records",
      "approvals",
      "verification_runs",
      "session_memory",
    ] as const;
    return Object.fromEntries(
      tables.map((table) => {
        const column = table === "sessions" ? "id" : "session_id";
        const row = database
          .prepare(
            `SELECT count(*) AS count FROM ${table} WHERE ${column} = ?`,
          )
          .get(sessionId) as { count: number };
        return [table, row.count];
      }),
    );
  });
}

function encodedSessionSnapshot(
  databasePath: string,
  sessionId: string,
): string {
  return inspectDatabase(databasePath, (database) => {
    const snapshot = {
      session: database
        .prepare("SELECT * FROM sessions WHERE id = ?")
        .all(sessionId),
      timeline: database
        .prepare(
          "SELECT * FROM timeline_events WHERE session_id = ? ORDER BY event_id",
        )
        .all(sessionId),
      actions: database
        .prepare(
          "SELECT * FROM action_records WHERE session_id = ? ORDER BY action_id",
        )
        .all(sessionId),
      approvals: database
        .prepare(
          "SELECT * FROM approvals WHERE session_id = ? ORDER BY id",
        )
        .all(sessionId),
      verifications: database
        .prepare(
          "SELECT * FROM verification_runs WHERE session_id = ? ORDER BY run_id",
        )
        .all(sessionId),
      memory: database
        .prepare("SELECT * FROM session_memory WHERE session_id = ?")
        .all(sessionId),
    };
    return Buffer.from(JSON.stringify(snapshot)).toString("hex");
  });
}

function encodedBusinessSnapshot(databasePath: string): string {
  return inspectDatabase(databasePath, (database) => {
    const snapshot = {
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
      memory: database
        .prepare("SELECT * FROM session_memory ORDER BY session_id")
        .all(),
      sequence: database
        .prepare("SELECT * FROM sqlite_sequence ORDER BY name")
        .all(),
    };
    return Buffer.from(JSON.stringify(snapshot)).toString("hex");
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

async function expectRejected(
  promise: Promise<unknown>,
  code: ErrorCode,
): Promise<unknown> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CodeSentinelPersistenceError);
  expect(caught).toMatchObject({
    name: "CodeSentinelPersistenceError",
    message: code,
    code,
  });
  return caught;
}

describe("session lifecycle persistence", () => {
  it("declares the eight exact parent cascades used by clearSession", async () => {
    await withFileRepository(async (_repository, databasePath) => {
      const actual = inspectDatabase(databasePath, (database) =>
        [
          "timeline_events",
          "action_records",
          "approvals",
          "verification_runs",
          "session_memory",
        ].flatMap((child) =>
          (
            database.pragma(`foreign_key_list(${child})`) as Array<{
              from: string;
              table: string;
              to: string;
              on_delete: string;
            }>
          ).map(({ from, table, to, on_delete }) => ({
            child,
            from,
            table,
            to,
            on_delete,
          })),
        ),
      );
      actual.sort((left, right) =>
        `${left.child}:${left.from}`.localeCompare(
          `${right.child}:${right.from}`,
        ),
      );

      expect(actual).toEqual([
        {
          child: "action_records",
          from: "event_id",
          table: "timeline_events",
          to: "event_id",
          on_delete: "CASCADE",
        },
        {
          child: "action_records",
          from: "session_id",
          table: "sessions",
          to: "id",
          on_delete: "CASCADE",
        },
        {
          child: "approvals",
          from: "action_id",
          table: "action_records",
          to: "action_id",
          on_delete: "CASCADE",
        },
        {
          child: "approvals",
          from: "session_id",
          table: "sessions",
          to: "id",
          on_delete: "CASCADE",
        },
        {
          child: "session_memory",
          from: "session_id",
          table: "sessions",
          to: "id",
          on_delete: "CASCADE",
        },
        {
          child: "timeline_events",
          from: "session_id",
          table: "sessions",
          to: "id",
          on_delete: "CASCADE",
        },
        {
          child: "verification_runs",
          from: "event_id",
          table: "timeline_events",
          to: "event_id",
          on_delete: "CASCADE",
        },
        {
          child: "verification_runs",
          from: "session_id",
          table: "sessions",
          to: "id",
          on_delete: "CASCADE",
        },
      ]);
    });
  });

  it("clears all six target tables by cascade while preserving another session and sequences", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createRichSession(repository, "session-clear", "clear");
      await createRichSession(repository, "session-keep", "keep");
      expect(
        Object.values(sessionRowCounts(databasePath, "session-clear")).every(
          (count) => count > 0,
        ),
      ).toBe(true);
      const survivorBefore = encodedSessionSnapshot(
        databasePath,
        "session-keep",
      );
      const sequenceBefore = inspectDatabase(databasePath, (database) =>
        database
          .prepare("SELECT * FROM sqlite_sequence ORDER BY name")
          .all(),
      );

      await repository.clearSession("session-clear");

      expect(sessionRowCounts(databasePath, "session-clear")).toEqual({
        sessions: 0,
        timeline_events: 0,
        action_records: 0,
        approvals: 0,
        verification_runs: 0,
        session_memory: 0,
      });
      await expect(
        repository.loadSession("session-clear"),
      ).resolves.toBeUndefined();
      await expect(repository.loadTimeline("session-clear")).resolves.toEqual(
        [],
      );
      await expect(
        repository.loadSessionMemory("session-clear"),
      ).resolves.toBeUndefined();
      expect(encodedSessionSnapshot(databasePath, "session-keep")).toBe(
        survivorBefore,
      );
      expect(
        inspectDatabase(databasePath, (database) =>
          database
            .prepare("SELECT * FROM sqlite_sequence ORDER BY name")
            .all(),
        ),
      ).toEqual(sequenceBefore);

      await expect(
        repository.clearSession("session-clear"),
      ).resolves.toBeUndefined();
      expect(encodedSessionSnapshot(databasePath, "session-keep")).toBe(
        survivorBefore,
      );
    });
  });

  it("rejects invalid clear IDs without coercion, traps, writes, or leaked input", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createRichSession(repository, "session-keep", "keep");
      const before = encodedBusinessSnapshot(databasePath);
      let trapCalls = 0;
      const invalid = new Proxy(
        { secret: SENTINEL },
        {
          get(): never {
            trapCalls += 1;
            throw new Error(SENTINEL);
          },
        },
      );

      const error = await expectRejected(
        repository.clearSession(
          invalid as unknown as string,
        ),
        "INVALID_PERSISTENCE_INPUT",
      );
      expect(trapCalls).toBe(0);
      expect(visibleErrorText(error)).not.toContain(SENTINEL);
      expect(encodedBusinessSnapshot(databasePath)).toBe(before);
      for (const sessionId of [
        "",
        "contains a space",
        "sk-abcdefghijkl",
      ]) {
        await expectRejected(
          repository.clearSession(sessionId),
          "INVALID_PERSISTENCE_INPUT",
        );
        expect(encodedBusinessSnapshot(databasePath)).toBe(before);
      }
      await expect(
        repository.clearSession("missing-session"),
      ).resolves.toBeUndefined();
    });
  });

  it("rolls back a failed parent delete and exposes only PERSISTENCE_FAILED", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createRichSession(repository, "session-clear", "clear");
      await createRichSession(repository, "session-keep", "keep");
      const before = encodedBusinessSnapshot(databasePath);
      inspectDatabase(databasePath, (database) => {
        database.exec(`
          CREATE TRIGGER fail_session_clear
          BEFORE DELETE ON sessions
          WHEN OLD.id = 'session-clear'
          BEGIN
            SELECT RAISE(ABORT, '${SENTINEL}');
          END
        `);
      });

      const error = await expectRejected(
        repository.clearSession("session-clear"),
        "PERSISTENCE_FAILED",
      );

      expect(visibleErrorText(error)).not.toContain(SENTINEL);
      expect(encodedBusinessSnapshot(databasePath)).toBe(before);
    });
  });

  it("rolls back clear when a trigger silently deletes another session", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createRichSession(repository, "session-clear", "clear");
      await createRichSession(repository, "session-keep", "keep");
      const before = encodedBusinessSnapshot(databasePath);
      inspectDatabase(databasePath, (database) => {
        database.exec(`
          CREATE TRIGGER silently_delete_survivor
          BEFORE DELETE ON sessions
          WHEN OLD.id = 'session-clear'
          BEGIN
            DELETE FROM sessions WHERE id = 'session-keep';
          END
        `);
      });

      await expectRejected(
        repository.clearSession("session-clear"),
        "PERSISTENCE_FAILED",
      );

      expect(encodedBusinessSnapshot(databasePath)).toBe(before);
      expect(
        Object.values(sessionRowCounts(databasePath, "session-clear")).every(
          (count) => count > 0,
        ),
      ).toBe(true);
      expect(
        Object.values(sessionRowCounts(databasePath, "session-keep")).every(
          (count) => count > 0,
        ),
      ).toBe(true);
    });
  });

  it("stops created, running, and awaiting sessions while leaving all four terminal states unchanged", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await repository.createSession(validSession("created-session"));
      await createRunningSession(repository, "running-session");
      await createRunningSession(repository, "awaiting-session");
      await appendPendingApproval(repository, {
        sessionId: "awaiting-session",
        round: 1,
        actionId: "action-awaiting",
        approvalId: "approval-awaiting",
        startSecond: 1,
      });

      for (const state of [
        "completed",
        "blocked",
        "failed",
        "stopped",
      ] as const) {
        const sessionId = `${state}-session`;
        await repository.createSession(validSession(sessionId));
        if (state === "completed" || state === "blocked") {
          await repository.append(
            stateEvent(sessionId, 0, at(0), "running"),
          );
          await repository.append(
            stateEvent(sessionId, 0, at(1), state),
          );
        } else {
          await repository.append(
            stateEvent(sessionId, 0, at(1), state),
          );
        }
        await repository.saveSessionMemory({
          sessionId,
          summary: `memory-${state}`,
          updatedAt: at(2),
        });
      }
      const terminalBefore = Object.fromEntries(
        ["completed", "blocked", "failed", "stopped"].map((state) => [
          state,
          encodedSessionSnapshot(databasePath, `${state}-session`),
        ]),
      );

      await expect(
        repository.recoverInterruptedSessions(Date.parse(at(10))),
      ).resolves.toBe(3);

      for (const sessionId of [
        "created-session",
        "running-session",
        "awaiting-session",
      ]) {
        await expect(repository.loadSession(sessionId)).resolves.toMatchObject({
          state: "stopped",
          updatedAt: at(10),
        });
        const timeline = await repository.loadTimeline(sessionId);
        expect(timeline.at(-1)).toEqual(
          stateEvent(
            sessionId,
            (await repository.loadSession(sessionId))?.round ?? -1,
            at(10),
            "stopped",
            "SESSION_INTERRUPTED",
          ),
        );
      }
      expect(
        inspectDatabase(databasePath, (database) =>
          database
            .prepare("SELECT status FROM approvals WHERE id = ?")
            .get("approval-awaiting"),
        ),
      ).toEqual({ status: "expired" });
      for (const state of [
        "completed",
        "blocked",
        "failed",
        "stopped",
      ]) {
        expect(
          encodedSessionSnapshot(databasePath, `${state}-session`),
          state,
        ).toBe(terminalBefore[state]);
      }
    });
  });

  it("expires old-round pending approvals by approval ID and sessions by session ID", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await repository.createSession(validSession("session-a"));
      await createRunningSession(repository, "session-b");
      await appendPendingApproval(repository, {
        sessionId: "session-b",
        round: 1,
        actionId: "action-old",
        approvalId: "approval-z",
        startSecond: 1,
      });
      await repository.append(
        stateEvent("session-b", 1, at(5), "running"),
      );
      await appendPendingApproval(repository, {
        sessionId: "session-b",
        round: 2,
        actionId: "action-current",
        approvalId: "approval-a",
        startSecond: 6,
      });
      await repository.append(
        stateEvent("session-b", 2, at(10), "running"),
      );
      const lastEventBefore = inspectDatabase(databasePath, (database) =>
        (
          database
            .prepare("SELECT max(event_id) AS event_id FROM timeline_events")
            .get() as { event_id: number }
        ).event_id,
      );

      await expect(
        repository.recoverInterruptedSessions(Date.parse(at(20))),
      ).resolves.toBe(2);

      const recoveryRows = inspectDatabase(databasePath, (database) =>
        database
          .prepare(`
            SELECT
              session_id,
              round,
              kind,
              summary,
              approval_id,
              approval_status,
              session_state,
              occurred_at
            FROM timeline_events
            WHERE event_id > ?
            ORDER BY event_id
          `)
          .all(lastEventBefore),
      );
      expect(recoveryRows).toEqual([
        {
          session_id: "session-a",
          round: 0,
          kind: "state",
          summary: "SESSION_INTERRUPTED",
          approval_id: null,
          approval_status: null,
          session_state: "stopped",
          occurred_at: at(20),
        },
        {
          session_id: "session-b",
          round: 2,
          kind: "approval",
          summary: "APPROVAL_EXPIRED_ON_RESTART",
          approval_id: "approval-a",
          approval_status: "expired",
          session_state: null,
          occurred_at: at(20),
        },
        {
          session_id: "session-b",
          round: 2,
          kind: "approval",
          summary: "APPROVAL_EXPIRED_ON_RESTART",
          approval_id: "approval-z",
          approval_status: "expired",
          session_state: null,
          occurred_at: at(20),
        },
        {
          session_id: "session-b",
          round: 2,
          kind: "state",
          summary: "SESSION_INTERRUPTED",
          approval_id: null,
          approval_status: null,
          session_state: "stopped",
          occurred_at: at(20),
        },
      ]);
      expect(
        inspectDatabase(databasePath, (database) =>
          database
            .prepare("SELECT id, status FROM approvals ORDER BY id")
            .all(),
        ),
      ).toEqual([
        { id: "approval-a", status: "expired" },
        { id: "approval-z", status: "expired" },
      ]);
      expect(
        (await repository.loadTimeline("session-b"))
          .filter(
            (event): event is Extract<
              HarnessEvent,
              { kind: "approval" }
            > =>
              event.kind === "approval" &&
              event.summary === APPROVAL_EXPIRED_ON_RESTART,
          )
          .map(({ round, details }) => ({ round, details })),
      ).toEqual([
        {
          round: 2,
          details: {
            approvalId: "approval-a",
            actionId: "action-current",
            patchHash: HASH,
            baseHash: HASH,
            status: "expired",
            createdAt: 200,
            expiresAt: 250,
          },
        },
        {
          round: 2,
          details: {
            approvalId: "approval-z",
            actionId: "action-old",
            patchHash: HASH,
            baseHash: HASH,
            status: "expired",
            createdAt: 100,
            expiresAt: 150,
          },
        },
      ]);
    });
  });

  it("rejects a pending approval whose normalized action belongs to another session", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createRunningSession(repository, "session-action-owner");
      await appendPendingApproval(repository, {
        sessionId: "session-action-owner",
        round: 1,
        actionId: "action-owned",
        approvalId: "approval-corrupt",
        startSecond: 1,
      });
      await repository.createSession(validSession("session-wrong-owner"));
      inspectDatabase(databasePath, (database) => {
        database.pragma("foreign_keys = ON");
        expect(
          database
            .prepare(
              "UPDATE approvals SET session_id = ? WHERE id = ?",
            )
            .run("session-wrong-owner", "approval-corrupt").changes,
        ).toBe(1);
      });
      const before = encodedBusinessSnapshot(databasePath);

      await expectRejected(
        repository.recoverInterruptedSessions(Date.parse(at(20))),
        "PERSISTENCE_FAILED",
      );

      expect(encodedBusinessSnapshot(databasePath)).toBe(before);
      expect(
        inspectDatabase(databasePath, (database) =>
          database
            .prepare(
              "SELECT session_id, action_id, status FROM approvals WHERE id = ?",
            )
            .get("approval-corrupt"),
        ),
      ).toEqual({
        session_id: "session-wrong-owner",
        action_id: "action-owned",
        status: "pending",
      });
    });
  });

  it("rejects a pending approval rebound to another legal action in the same session", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createRunningSession(repository, "session-rebound");
      await appendPendingApproval(repository, {
        sessionId: "session-rebound",
        round: 1,
        actionId: "action-original",
        approvalId: "approval-rebound",
        startSecond: 1,
      });
      await repository.append(
        stateEvent("session-rebound", 1, at(5), "running"),
      );
      await repository.append(
        actionEvent(
          "session-rebound",
          2,
          at(6),
          "action-replacement",
        ),
      );
      await repository.append(
        policyEvent("session-rebound", 2, at(7), "ask"),
      );
      inspectDatabase(databasePath, (database) => {
        database.pragma("foreign_keys = ON");
        expect(
          database
            .prepare(
              "UPDATE approvals SET action_id = ? WHERE id = ?",
            )
            .run("action-replacement", "approval-rebound").changes,
        ).toBe(1);
      });
      const before = encodedBusinessSnapshot(databasePath);

      await expectRejected(
        repository.recoverInterruptedSessions(Date.parse(at(20))),
        "PERSISTENCE_FAILED",
      );

      expect(encodedBusinessSnapshot(databasePath)).toBe(before);
      expect(
        inspectDatabase(databasePath, (database) =>
          database
            .prepare(
              "SELECT session_id, action_id, status FROM approvals WHERE id = ?",
            )
            .get("approval-rebound"),
        ),
      ).toEqual({
        session_id: "session-rebound",
        action_id: "action-replacement",
        status: "pending",
      });
    });
  });

  it("rejects a pending approval whose origin is rebound to a later legal action", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createRunningSession(repository, "session-causal-rebound");
      await appendPendingApproval(repository, {
        sessionId: "session-causal-rebound",
        round: 1,
        actionId: "action-causal-original",
        approvalId: "approval-causal-rebound",
        startSecond: 1,
      });
      await repository.append(
        stateEvent("session-causal-rebound", 1, at(5), "running"),
      );
      await repository.append(
        actionEvent(
          "session-causal-rebound",
          2,
          at(6),
          "action-causal-replacement",
        ),
      );
      await repository.append(
        policyEvent("session-causal-rebound", 2, at(7), "ask"),
      );
      inspectDatabase(databasePath, (database) => {
        database.pragma("foreign_keys = ON");
        expect(
          database
            .prepare(
              "UPDATE approvals SET action_id = ? WHERE id = ?",
            )
            .run(
              "action-causal-replacement",
              "approval-causal-rebound",
            ).changes,
        ).toBe(1);
        expect(
          database
            .prepare(`
              UPDATE timeline_events
              SET round = ?, approval_action_id = ?
              WHERE approval_id = ? AND approval_status = 'pending'
            `)
            .run(
              2,
              "action-causal-replacement",
              "approval-causal-rebound",
            ).changes,
        ).toBe(1);
      });
      const before = encodedBusinessSnapshot(databasePath);

      await expectRejected(
        repository.recoverInterruptedSessions(Date.parse(at(20))),
        "PERSISTENCE_FAILED",
      );

      expect(encodedBusinessSnapshot(databasePath)).toBe(before);
    });
  });

  it("rejects a pending approval rebound across a later-round action", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createRunningSession(repository, "session-earlier-rebound");
      await repository.append(
        actionEvent(
          "session-earlier-rebound",
          1,
          at(1),
          "action-earlier",
        ),
      );
      await repository.append(
        policyEvent("session-earlier-rebound", 1, at(2), "ask"),
      );
      await repository.append(
        stateEvent(
          "session-earlier-rebound",
          1,
          at(3),
          "awaiting_approval",
        ),
      );
      await repository.append(
        stateEvent("session-earlier-rebound", 1, at(4), "running"),
      );
      await appendPendingApproval(repository, {
        sessionId: "session-earlier-rebound",
        round: 2,
        actionId: "action-later",
        approvalId: "approval-earlier-rebound",
        startSecond: 5,
      });
      inspectDatabase(databasePath, (database) => {
        database.pragma("foreign_keys = ON");
        expect(
          database
            .prepare(
              "UPDATE approvals SET action_id = ? WHERE id = ?",
            )
            .run("action-earlier", "approval-earlier-rebound").changes,
        ).toBe(1);
        expect(
          database
            .prepare(`
              UPDATE timeline_events
              SET round = ?, approval_action_id = ?
              WHERE approval_id = ? AND approval_status = 'pending'
            `)
            .run(1, "action-earlier", "approval-earlier-rebound").changes,
        ).toBe(1);
      });
      const before = encodedBusinessSnapshot(databasePath);

      await expectRejected(
        repository.recoverInterruptedSessions(Date.parse(at(20))),
        "PERSISTENCE_FAILED",
      );

      expect(encodedBusinessSnapshot(databasePath)).toBe(before);
    });
  });

  it("rejects a pending approval whose origin timestamp predates its action", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createRunningSession(repository, "session-causal-time");
      await appendPendingApproval(repository, {
        sessionId: "session-causal-time",
        round: 1,
        actionId: "action-causal-time",
        approvalId: "approval-causal-time",
        startSecond: 1,
      });
      inspectDatabase(databasePath, (database) => {
        expect(
          database
            .prepare(`
              UPDATE timeline_events
              SET occurred_at = ?
              WHERE approval_id = ? AND approval_status = 'pending'
            `)
            .run(at(0), "approval-causal-time").changes,
        ).toBe(1);
      });
      const before = encodedBusinessSnapshot(databasePath);

      await expectRejected(
        repository.recoverInterruptedSessions(Date.parse(at(20))),
        "PERSISTENCE_FAILED",
      );

      expect(encodedBusinessSnapshot(databasePath)).toBe(before);
    });
  });

  it("rejects a pending approval with duplicate ask policy origins", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createRunningSession(repository, "session-policy-duplicate");
      await appendPendingApproval(repository, {
        sessionId: "session-policy-duplicate",
        round: 1,
        actionId: "action-policy-duplicate",
        approvalId: "approval-policy-duplicate",
        startSecond: 1,
      });
      inspectDatabase(databasePath, (database) => {
        expect(
          database
            .prepare(`
              INSERT INTO timeline_events (
                session_id,
                round,
                kind,
                summary,
                occurred_at,
                policy_decision
              ) VALUES (?, ?, 'policy', ?, ?, 'ask')
            `)
            .run(
              "session-policy-duplicate",
              1,
              "duplicate ask",
              at(5),
            ).changes,
        ).toBe(1);
      });
      const before = encodedBusinessSnapshot(databasePath);

      await expectRejected(
        repository.recoverInterruptedSessions(Date.parse(at(20))),
        "PERSISTENCE_FAILED",
      );

      expect(encodedBusinessSnapshot(databasePath)).toBe(before);
    });
  });

  it("rejects a pending approval whose action record and action timeline disagree", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createRunningSession(repository, "session-action-disagrees");
      await appendPendingApproval(repository, {
        sessionId: "session-action-disagrees",
        round: 1,
        actionId: "action-disagrees",
        approvalId: "approval-action-disagrees",
        startSecond: 1,
      });
      inspectDatabase(databasePath, (database) => {
        expect(
          database
            .prepare(`
              UPDATE timeline_events
              SET summary = ?
              WHERE action_id = ? AND kind = 'action'
            `)
            .run("tampered action", "action-disagrees").changes,
        ).toBe(1);
      });
      const before = encodedBusinessSnapshot(databasePath);

      await expectRejected(
        repository.recoverInterruptedSessions(Date.parse(at(20))),
        "PERSISTENCE_FAILED",
      );

      expect(encodedBusinessSnapshot(databasePath)).toBe(before);
    });
  });

  it("rejects a pending approval with an ambiguous action timeline", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createRunningSession(repository, "session-action-ambiguous");
      await appendPendingApproval(repository, {
        sessionId: "session-action-ambiguous",
        round: 1,
        actionId: "action-ambiguous",
        approvalId: "approval-action-ambiguous",
        startSecond: 1,
      });
      inspectDatabase(databasePath, (database) => {
        expect(
          database
            .prepare(`
              INSERT INTO timeline_events (
                session_id,
                round,
                kind,
                summary,
                occurred_at,
                action_id,
                action_kind
              ) VALUES (?, ?, 'action', ?, ?, ?, 'propose_patch')
            `)
            .run(
              "session-action-ambiguous",
              1,
              "propose_patch",
              at(5),
              "action-ambiguous",
            ).changes,
        ).toBe(1);
      });
      const before = encodedBusinessSnapshot(databasePath);

      await expectRejected(
        repository.recoverInterruptedSessions(Date.parse(at(20))),
        "PERSISTENCE_FAILED",
      );

      expect(encodedBusinessSnapshot(databasePath)).toBe(before);
    });
  });

  it("leaves terminal sessions with pending approvals and memory byte-for-byte unchanged", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createRunningSession(repository, "terminal-pending");
      await appendPendingApproval(repository, {
        sessionId: "terminal-pending",
        round: 1,
        actionId: "action-pending",
        approvalId: "approval-pending",
        startSecond: 1,
      });
      await repository.append(
        stateEvent("terminal-pending", 1, at(5), "stopped"),
      );
      await repository.saveSessionMemory({
        sessionId: "terminal-pending",
        summary: "terminal memory",
        updatedAt: at(6),
      });
      const before = encodedSessionSnapshot(
        databasePath,
        "terminal-pending",
      );

      await expect(
        repository.recoverInterruptedSessions(Date.parse(at(20))),
      ).resolves.toBe(0);

      expect(encodedSessionSnapshot(databasePath, "terminal-pending")).toBe(
        before,
      );
      expect(
        inspectDatabase(databasePath, (database) =>
          database
            .prepare("SELECT status FROM approvals WHERE id = ?")
            .get("approval-pending"),
        ),
      ).toEqual({ status: "pending" });
    });
  });

  it("is explicit and idempotent across close and reopen", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await createRunningSession(repository, "session-reopen");
      await appendPendingApproval(repository, {
        sessionId: "session-reopen",
        round: 1,
        actionId: "action-reopen",
        approvalId: "approval-reopen",
        startSecond: 1,
      });
      repository.close();

      const reopened = createSessionRepository(databasePath);
      try {
        await expect(
          reopened.loadSession("session-reopen"),
        ).resolves.toMatchObject({ state: "awaiting_approval" });
        expect(
          (
            await reopened.loadTimeline("session-reopen")
          ).filter(({ summary }) =>
            summary === "SESSION_INTERRUPTED" ||
            summary === "APPROVAL_EXPIRED_ON_RESTART"
          ),
        ).toEqual([]);

        await expect(
          reopened.recoverInterruptedSessions(Date.parse(at(20))),
        ).resolves.toBe(1);
        const timelineAfterFirst =
          await reopened.loadTimeline("session-reopen");
        await expect(
          reopened.recoverInterruptedSessions(Date.parse(at(20))),
        ).resolves.toBe(0);
        expect(await reopened.loadTimeline("session-reopen")).toEqual(
          timelineAfterFirst,
        );
      } finally {
        reopened.close();
      }
    });
  });

  it("preflights every candidate and rolls all sessions back when now is earlier", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await repository.createSession(validSession("session-a"));
      await createRunningSession(repository, "session-b");
      await repository.append(
        actionEvent(
          "session-b",
          1,
          at(5),
          "action-b",
          "run_verification",
        ),
      );
      const before = encodedBusinessSnapshot(databasePath);

      await expectRejected(
        repository.recoverInterruptedSessions(Date.parse(at(3))),
        "INVALID_PERSISTENCE_INPUT",
      );

      expect(encodedBusinessSnapshot(databasePath)).toBe(before);
    });
  });

  it("accepts an equal timestamp and the full extended Date boundary", async () => {
    await withFileRepository(async (repository) => {
      await repository.createSession(
        validSession("minimum-session", {
          createdAt: "-271821-04-20T00:00:00.000Z",
        }),
      );
      await expect(
        repository.recoverInterruptedSessions(MIN_DATE_TIMESTAMP),
      ).resolves.toBe(1);
      await expect(
        repository.loadSession("minimum-session"),
      ).resolves.toMatchObject({
        state: "stopped",
        updatedAt: "-271821-04-20T00:00:00.000Z",
      });

      await repository.createSession(
        validSession("equal-session", { createdAt: at(5) }),
      );
      await repository.createSession(
        validSession("extended-session", {
          createdAt: "+275760-09-13T00:00:00.000Z",
        }),
      );

      await expect(
        repository.recoverInterruptedSessions(MAX_DATE_TIMESTAMP),
      ).resolves.toBe(2);

      await expect(
        repository.loadSession("extended-session"),
      ).resolves.toMatchObject({
        state: "stopped",
        updatedAt: "+275760-09-13T00:00:00.000Z",
      });
      const equalTimeline = await repository.loadTimeline("equal-session");
      expect(equalTimeline.at(-1)?.occurredAt).toBe(
        "+275760-09-13T00:00:00.000Z",
      );
    });
  });

  it.each([
    ["fraction", 1.5],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["above Date range", MAX_DATE_TIMESTAMP + 1],
    ["below Date range", -MAX_DATE_TIMESTAMP - 1],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["string", "0"],
  ] as const)("rejects invalid recovery now: %s", async (_label, now) => {
    await withFileRepository(async (repository, databasePath) => {
      await repository.createSession(validSession("session-invalid-now"));
      const before = encodedBusinessSnapshot(databasePath);

      await expectRejected(
        repository.recoverInterruptedSessions(now as number),
        "INVALID_PERSISTENCE_INPUT",
      );

      expect(encodedBusinessSnapshot(databasePath)).toBe(before);
    });
  });

  it("rejects a recovery Proxy without traps, coercion, reentry, or leakage", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await repository.createSession(validSession("session-proxy"));
      const before = encodedBusinessSnapshot(databasePath);
      let trapCalls = 0;
      let innerMutation: Promise<void> | undefined;
      const now = new Proxy(
        {},
        {
          get(): never {
            trapCalls += 1;
            innerMutation = repository.clearSession("session-proxy");
            void innerMutation.catch(() => undefined);
            throw new Error(SENTINEL);
          },
        },
      );

      const error = await expectRejected(
        repository.recoverInterruptedSessions(
          now as unknown as number,
        ),
        "INVALID_PERSISTENCE_INPUT",
      );

      expect(trapCalls).toBe(0);
      expect(innerMutation).toBeUndefined();
      expect(visibleErrorText(error)).not.toContain(SENTINEL);
      expect(encodedBusinessSnapshot(databasePath)).toBe(before);
      await expect(
        repository.recoverInterruptedSessions(Date.parse(at(1))),
      ).resolves.toBe(1);
    });
  });

  it("rolls back every earlier session when the second session fails and hides the native error", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await repository.createSession(validSession("session-a"));
      await createRunningSession(repository, "session-b");
      await appendPendingApproval(repository, {
        sessionId: "session-b",
        round: 1,
        actionId: "action-b",
        approvalId: "approval-b",
        startSecond: 1,
      });
      const before = encodedBusinessSnapshot(databasePath);
      inspectDatabase(databasePath, (database) => {
        database.exec(`
          CREATE TRIGGER fail_second_recovery_session
          BEFORE UPDATE OF state ON sessions
          WHEN OLD.id = 'session-b'
          BEGIN
            SELECT RAISE(ABORT, '${SENTINEL}');
          END
        `);
      });

      const error = await expectRejected(
        repository.recoverInterruptedSessions(Date.parse(at(20))),
        "PERSISTENCE_FAILED",
      );

      expect(visibleErrorText(error)).not.toContain(SENTINEL);
      expect(encodedBusinessSnapshot(databasePath)).toBe(before);
      await expect(repository.loadSession("session-a")).resolves.toMatchObject({
        state: "created",
      });
      await expect(repository.loadSession("session-b")).resolves.toMatchObject({
        state: "awaiting_approval",
      });
    });
  });

  it("rolls back recovery when a trigger silently mutates a terminal session", async () => {
    await withFileRepository(async (repository, databasePath) => {
      await repository.createSession(validSession("session-candidate"));
      await createRichSession(repository, "session-terminal", "terminal");
      await repository.append(
        stateEvent("session-terminal", 1, at(8), "completed"),
      );
      const before = encodedBusinessSnapshot(databasePath);
      const terminalBefore = encodedSessionSnapshot(
        databasePath,
        "session-terminal",
      );
      inspectDatabase(databasePath, (database) => {
        database.exec(`
          CREATE TRIGGER silently_mutate_terminal
          AFTER INSERT ON timeline_events
          WHEN NEW.summary = 'SESSION_INTERRUPTED'
          BEGIN
            UPDATE sessions
            SET workspace_id = 'silently-mutated'
            WHERE id = 'session-terminal';
          END
        `);
      });

      await expectRejected(
        repository.recoverInterruptedSessions(Date.parse(at(20))),
        "PERSISTENCE_FAILED",
      );

      expect(encodedBusinessSnapshot(databasePath)).toBe(before);
      expect(
        encodedSessionSnapshot(databasePath, "session-terminal"),
      ).toBe(terminalBefore);
      await expect(
        repository.loadSession("session-candidate"),
      ).resolves.toMatchObject({ state: "created", updatedAt: at(0) });
    });
  });
});
