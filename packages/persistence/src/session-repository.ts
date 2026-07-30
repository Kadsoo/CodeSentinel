import type { HarnessEvent, SessionState, TaskKind } from "../../contracts/src/index.js";
import { persistenceError } from "./errors.js";
import { openSessionDatabase } from "./schema.js";
import type {
  AppendActionInput,
  AppendVerificationInput,
  CreatePersistedSessionInput,
  PersistedSession,
  PersistedSessionMemory,
  SaveApprovalInput,
  SaveSessionMemoryInput,
  SessionRepository,
} from "./types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const KNOWN_KEY_FRAGMENT =
  /(?:sk-|sk_|pk_|rk_|ghp_)[A-Za-z0-9_-]{12,}/iu;

function assertIdentifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !IDENTIFIER.test(value) ||
    KNOWN_KEY_FRAGMENT.test(value)
  ) {
    throw persistenceError("INVALID_PERSISTENCE_INPUT");
  }
}

function isTaskKind(value: unknown): value is TaskKind {
  return value === "test_repair" || value === "feature_implementation";
}

function isSessionState(value: unknown): value is SessionState {
  return (
    value === "created" ||
    value === "running" ||
    value === "awaiting_approval" ||
    value === "completed" ||
    value === "blocked" ||
    value === "failed" ||
    value === "stopped"
  );
}

function canonicalIso(value: string): string | undefined {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  const canonical = new Date(timestamp).toISOString();
  return canonical === value ? canonical : undefined;
}

function validatedCreateSessionInput(
  input: CreatePersistedSessionInput,
): CreatePersistedSessionInput {
  try {
    if (typeof input !== "object" || input === null) {
      throw persistenceError("INVALID_PERSISTENCE_INPUT");
    }
    const snapshot: CreatePersistedSessionInput = {
      id: input.id,
      taskKind: input.taskKind,
      state: input.state,
      round: input.round,
      workspaceId: input.workspaceId,
      providerId: input.providerId,
      verificationCommandId: input.verificationCommandId,
      createdAt: input.createdAt,
    };
    assertIdentifier(snapshot.id);
    assertIdentifier(snapshot.workspaceId);
    assertIdentifier(snapshot.providerId);
    assertIdentifier(snapshot.verificationCommandId);
    if (
      (snapshot.taskKind !== "test_repair" &&
        snapshot.taskKind !== "feature_implementation") ||
      snapshot.state !== "created" ||
      snapshot.round !== 0 ||
      canonicalIso(snapshot.createdAt) === undefined
    ) {
      throw persistenceError("INVALID_PERSISTENCE_INPUT");
    }
    return Object.freeze(snapshot);
  } catch {
    throw persistenceError("INVALID_PERSISTENCE_INPUT");
  }
}

function mapSessionRow(value: unknown, expectedId: string): PersistedSession {
  if (typeof value !== "object" || value === null) {
    throw persistenceError("PERSISTENCE_FAILED");
  }
  const row = value as Readonly<Record<string, unknown>>;
  const id = row.id;
  const taskKind = row.task_kind;
  const state = row.state;
  const round = row.round;
  const workspaceId = row.workspace_id;
  const providerId = row.provider_id;
  const verificationCommandId = row.verification_command_id;
  const createdAt = row.created_at;
  const updatedAt = row.updated_at;

  assertIdentifier(id);
  assertIdentifier(workspaceId);
  assertIdentifier(providerId);
  assertIdentifier(verificationCommandId);
  if (
    id !== expectedId ||
    !isTaskKind(taskKind) ||
    !isSessionState(state) ||
    typeof round !== "number" ||
    !Number.isInteger(round) ||
    round < 0 ||
    round > 3 ||
    typeof createdAt !== "string" ||
    canonicalIso(createdAt) === undefined ||
    typeof updatedAt !== "string" ||
    canonicalIso(updatedAt) === undefined
  ) {
    throw persistenceError("PERSISTENCE_FAILED");
  }

  return Object.freeze({
    id,
    taskKind,
    state,
    round,
    workspaceId,
    providerId,
    verificationCommandId,
    createdAt,
    updatedAt,
  });
}

function closeBestEffort(database: ReturnType<typeof openSessionDatabase>): void {
  try {
    database.close();
  } catch {
    // Never expose a native close error.
  }
}

export function createSessionRepository(databasePath: string): SessionRepository {
  const database = openSessionDatabase(databasePath);
  try {
    const insertSession = database.prepare(`
      INSERT INTO sessions (
        id,
        task_kind,
        state,
        round,
        workspace_id,
        provider_id,
        verification_command_id,
        created_at,
        updated_at
      ) VALUES (
        @id,
        @taskKind,
        @state,
        @round,
        @workspaceId,
        @providerId,
        @verificationCommandId,
        @createdAt,
        @updatedAt
      )
      ON CONFLICT(id) DO NOTHING
    `);
    const selectSession = database.prepare(`
      SELECT
        id,
        task_kind,
        state,
        round,
        workspace_id,
        provider_id,
        verification_command_id,
        created_at,
        updated_at
      FROM sessions
      WHERE id = ?
    `);
    let closed = false;

    function assertOpen(): void {
      if (closed) {
        throw persistenceError("REPOSITORY_CLOSED");
      }
    }

    async function createSession(
      input: CreatePersistedSessionInput,
    ): Promise<void> {
      assertOpen();
      const validated = validatedCreateSessionInput(input);
      let changes: number;
      try {
        changes = insertSession.run({
          id: validated.id,
          taskKind: validated.taskKind,
          state: validated.state,
          round: validated.round,
          workspaceId: validated.workspaceId,
          providerId: validated.providerId,
          verificationCommandId: validated.verificationCommandId,
          createdAt: validated.createdAt,
          updatedAt: validated.createdAt,
        }).changes;
      } catch {
        throw persistenceError("PERSISTENCE_FAILED");
      }
      if (changes === 0) {
        throw persistenceError("DUPLICATE_RECORD");
      }
      if (changes !== 1) {
        throw persistenceError("PERSISTENCE_FAILED");
      }
    }

    async function loadSession(
      sessionId: string,
    ): Promise<PersistedSession | undefined> {
      assertOpen();
      assertIdentifier(sessionId);
      try {
        const row = selectSession.get(sessionId);
        if (row === undefined) {
          return undefined;
        }
        return mapSessionRow(row, sessionId);
      } catch {
        throw persistenceError("PERSISTENCE_FAILED");
      }
    }

    async function append(event: HarnessEvent): Promise<void> {
      assertOpen();
      void event;
      throw persistenceError("PERSISTENCE_FAILED");
    }

    async function appendAction(input: AppendActionInput): Promise<void> {
      assertOpen();
      void input;
      throw persistenceError("PERSISTENCE_FAILED");
    }

    async function saveApproval(input: SaveApprovalInput): Promise<void> {
      assertOpen();
      void input;
      throw persistenceError("PERSISTENCE_FAILED");
    }

    async function appendVerification(
      input: AppendVerificationInput,
    ): Promise<void> {
      assertOpen();
      void input;
      throw persistenceError("PERSISTENCE_FAILED");
    }

    async function saveSessionMemory(
      input: SaveSessionMemoryInput,
    ): Promise<void> {
      assertOpen();
      void input;
      throw persistenceError("PERSISTENCE_FAILED");
    }

    async function loadSessionMemory(
      sessionId: string,
    ): Promise<PersistedSessionMemory | undefined> {
      assertOpen();
      void sessionId;
      throw persistenceError("PERSISTENCE_FAILED");
    }

    async function loadTimeline(
      sessionId: string,
    ): Promise<readonly HarnessEvent[]> {
      assertOpen();
      void sessionId;
      throw persistenceError("PERSISTENCE_FAILED");
    }

    async function recoverInterruptedSessions(now: number): Promise<number> {
      assertOpen();
      void now;
      throw persistenceError("PERSISTENCE_FAILED");
    }

    async function clearSession(sessionId: string): Promise<void> {
      assertOpen();
      void sessionId;
      throw persistenceError("PERSISTENCE_FAILED");
    }

    function close(): void {
      if (closed) {
        return;
      }
      closed = true;
      try {
        database.close();
      } catch {
        throw persistenceError("PERSISTENCE_FAILED");
      }
    }

    return Object.freeze({
      createSession,
      loadSession,
      append,
      appendAction,
      saveApproval,
      appendVerification,
      saveSessionMemory,
      loadSessionMemory,
      loadTimeline,
      recoverInterruptedSessions,
      clearSession,
      close,
    });
  } catch {
    closeBestEffort(database);
    throw persistenceError("PERSISTENCE_FAILED");
  }
}
