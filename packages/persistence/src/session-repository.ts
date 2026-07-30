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

type SessionRow = Readonly<{
  id: string;
  task_kind: TaskKind;
  state: SessionState;
  round: number;
  workspace_id: string;
  provider_id: string;
  verification_command_id: string;
  created_at: string;
  updated_at: string;
}>;

function assertIdentifier(value: string): void {
  if (
    typeof value !== "string" ||
    !IDENTIFIER.test(value) ||
    KNOWN_KEY_FRAGMENT.test(value)
  ) {
    throw persistenceError("INVALID_PERSISTENCE_INPUT");
  }
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

function duplicateSessionConstraint(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  try {
    const codeDescriptor = Object.getOwnPropertyDescriptor(error, "code");
    const messageDescriptor = Object.getOwnPropertyDescriptor(error, "message");
    if (
      codeDescriptor === undefined ||
      !("value" in codeDescriptor) ||
      messageDescriptor === undefined ||
      !("value" in messageDescriptor)
    ) {
      return false;
    }
    return (
      (codeDescriptor.value === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
        codeDescriptor.value === "SQLITE_CONSTRAINT_UNIQUE") &&
      messageDescriptor.value === "UNIQUE constraint failed: sessions.id"
    );
  } catch {
    return false;
  }
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
      try {
        insertSession.run({
          id: validated.id,
          taskKind: validated.taskKind,
          state: validated.state,
          round: validated.round,
          workspaceId: validated.workspaceId,
          providerId: validated.providerId,
          verificationCommandId: validated.verificationCommandId,
          createdAt: validated.createdAt,
          updatedAt: validated.createdAt,
        });
      } catch (error) {
        if (duplicateSessionConstraint(error)) {
          throw persistenceError("DUPLICATE_RECORD");
        }
        throw persistenceError("PERSISTENCE_FAILED");
      }
    }

    async function loadSession(
      sessionId: string,
    ): Promise<PersistedSession | undefined> {
      assertOpen();
      assertIdentifier(sessionId);
      try {
        const row = selectSession.get(sessionId) as SessionRow | undefined;
        if (row === undefined) {
          return undefined;
        }
        return Object.freeze({
          id: row.id,
          taskKind: row.task_kind,
          state: row.state,
          round: row.round,
          workspaceId: row.workspace_id,
          providerId: row.provider_id,
          verificationCommandId: row.verification_command_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
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
