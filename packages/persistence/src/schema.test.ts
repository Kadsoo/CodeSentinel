import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "../../contracts/src/index.js";
import {
  CodeSentinelPersistenceError,
  createSessionRepository,
  type CreatePersistedSessionInput,
} from "./index.js";
import { openSessionDatabase } from "./schema.js";

const CANONICAL_TIME = "2026-07-30T00:00:00.000Z";
const HASH = "a".repeat(64);

function validSession(
  overrides: Partial<CreatePersistedSessionInput> = {},
): CreatePersistedSessionInput {
  return {
    id: "session-1",
    taskKind: "test_repair",
    state: "created",
    round: 0,
    workspaceId: "workspace-1",
    providerId: "provider-1",
    verificationCommandId: "test-command",
    createdAt: CANONICAL_TIME,
    ...overrides,
  };
}

async function withDatabasePath<T>(
  callback: (databasePath: string) => T | Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "codesentinel-schema-"));
  const databasePath = join(directory, "sessions.sqlite");
  try {
    return await callback(databasePath);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function expectPersistenceError(
  error: unknown,
  code:
    | "INVALID_PERSISTENCE_INPUT"
    | "DUPLICATE_RECORD"
    | "UNSUPPORTED_SCHEMA_VERSION"
    | "REPOSITORY_CLOSED"
    | "PERSISTENCE_FAILED",
): void {
  expect(error).toBeInstanceOf(CodeSentinelPersistenceError);
  expect(error).toMatchObject({
    name: "CodeSentinelPersistenceError",
    message: code,
    code,
  });
}

function expectOpenFailure(
  databasePath: string,
  code: "UNSUPPORTED_SCHEMA_VERSION" | "PERSISTENCE_FAILED",
): void {
  let opened: Database.Database | undefined;
  let caught: unknown;
  try {
    opened = openSessionDatabase(databasePath);
  } catch (error) {
    caught = error;
  } finally {
    opened?.close();
  }
  expect(caught).toBeDefined();
  expectPersistenceError(caught, code);
}

function initializeAndMutateSchema(
  databasePath: string,
  mutate: (database: Database.Database) => void,
): void {
  const initialized = openSessionDatabase(databasePath);
  initialized.close();

  const database = new Database(databasePath);
  try {
    mutate(database);
  } finally {
    database.close();
  }
}

function stateEvent(): HarnessEvent {
  return {
    sessionId: "session-1",
    round: 0,
    kind: "state",
    summary: "running",
    occurredAt: CANONICAL_TIME,
    details: { state: "running" },
  };
}

describe("persistence schema bootstrap", () => {
  it("initializes a hardened version-one in-memory database", () => {
    const database = openSessionDatabase(":memory:");
    try {
      expect(database.pragma("user_version", { simple: true })).toBe(1);
      expect(database.pragma("journal_mode", { simple: true })).toBe("memory");
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(database.pragma("secure_delete", { simple: true })).toBe(1);
      expect(database.pragma("busy_timeout", { simple: true })).toBe(5_000);
    } finally {
      database.close();
    }
  });

  it("uses DELETE journal mode for a file database", async () => {
    await withDatabasePath((databasePath) => {
      const database = openSessionDatabase(databasePath);
      try {
        expect(database.pragma("journal_mode", { simple: true })).toBe("delete");
      } finally {
        database.close();
      }
    });
  });

  it("switches a pre-WAL file to DELETE or returns only fixed PERSISTENCE_FAILED", async () => {
    await withDatabasePath((databasePath) => {
      const seed = new Database(databasePath);
      try {
        seed.pragma("journal_mode = WAL");
      } finally {
        seed.close();
      }

      let database: Database.Database | undefined;
      try {
        database = openSessionDatabase(databasePath);
        expect(database.pragma("journal_mode", { simple: true })).toBe("delete");
      } catch (error) {
        expectPersistenceError(error, "PERSISTENCE_FAILED");
      } finally {
        database?.close();
      }
    });
  });

  it("creates the exact version-one object, column, and cascade fingerprints", () => {
    const database = openSessionDatabase(":memory:");
    try {
      const objects = database
        .prepare(`
          SELECT name, type
          FROM sqlite_schema
          WHERE name NOT LIKE 'sqlite_%'
            AND type IN ('table', 'index', 'trigger', 'view')
        `)
        .all() as Array<{ name: string; type: string }>;
      expect(Object.fromEntries(objects.map(({ name, type }) => [name, type]))).toEqual({
        sessions: "table",
        timeline_events: "table",
        action_records: "table",
        approvals: "table",
        verification_runs: "table",
        session_memory: "table",
        idx_timeline_session_event: "index",
        idx_approvals_session_status: "index",
        idx_verification_session_event: "index",
        approval_status_forward: "trigger",
      });

      const expectedColumns: Readonly<Record<string, readonly string[]>> = {
        sessions: [
          "id",
          "task_kind",
          "state",
          "round",
          "workspace_id",
          "provider_id",
          "verification_command_id",
          "created_at",
          "updated_at",
        ],
        timeline_events: [
          "event_id",
          "session_id",
          "round",
          "kind",
          "summary",
          "occurred_at",
          "action_id",
          "action_kind",
          "policy_decision",
          "tool_kind",
          "command_id",
          "exit_code",
          "duration_ms",
          "verification_status",
          "timed_out",
          "session_state",
          "approval_id",
          "approval_action_id",
          "patch_hash",
          "base_hash",
          "approval_status",
          "approval_created_at",
          "approval_expires_at",
        ],
        action_records: [
          "action_id",
          "event_id",
          "session_id",
          "round",
          "action_kind",
          "input_summary",
          "policy_decision",
          "result_summary",
        ],
        approvals: [
          "id",
          "session_id",
          "action_id",
          "patch_hash",
          "base_hash",
          "status",
          "created_at",
          "expires_at",
        ],
        verification_runs: [
          "run_id",
          "event_id",
          "session_id",
          "round",
          "command_id",
          "exit_code",
          "duration_ms",
          "status",
          "timed_out",
          "summary",
        ],
        session_memory: ["session_id", "summary", "updated_at"],
      };
      for (const [table, expected] of Object.entries(expectedColumns)) {
        const actual = database.pragma(`table_info(${table})`) as Array<{ name: string }>;
        expect(actual.map(({ name }) => name), table).toEqual(expected);
      }

      const expectedCascadeParents: Readonly<Record<string, readonly string[]>> = {
        timeline_events: ["sessions"],
        action_records: ["sessions", "timeline_events"],
        approvals: ["action_records", "sessions"],
        verification_runs: ["sessions", "timeline_events"],
        session_memory: ["sessions"],
      };
      for (const [table, expected] of Object.entries(expectedCascadeParents)) {
        const foreignKeys = database.pragma(`foreign_key_list(${table})`) as Array<{
          table: string;
          on_delete: string;
        }>;
        const actual = foreignKeys
          .filter(({ on_delete }) => on_delete.toUpperCase() === "CASCADE")
          .map(({ table: parent }) => parent)
          .sort();
        expect(actual, table).toEqual([...expected].sort());
      }
    } finally {
      database.close();
    }
  });

  it("rejects a version-zero nonempty database", async () => {
    await withDatabasePath((databasePath) => {
      const seed = new Database(databasePath);
      seed.exec("CREATE TABLE unexpected (id TEXT);");
      seed.close();

      expectOpenFailure(databasePath, "UNSUPPORTED_SCHEMA_VERSION");
    });
  });

  it("rejects a version-two database", async () => {
    await withDatabasePath((databasePath) => {
      const seed = new Database(databasePath);
      seed.pragma("user_version = 2");
      seed.close();

      expectOpenFailure(databasePath, "UNSUPPORTED_SCHEMA_VERSION");
    });
  });

  it("rejects a partial version-one schema", async () => {
    await withDatabasePath((databasePath) => {
      const seed = new Database(databasePath);
      seed.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY);");
      seed.pragma("user_version = 1");
      seed.close();

      expectOpenFailure(databasePath, "UNSUPPORTED_SCHEMA_VERSION");
    });
  });

  it.each([
    {
      constraint: "CHECK",
      objectName: "sessions",
      replacement: `
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          task_kind TEXT NOT NULL CHECK(task_kind IN ('test_repair', 'feature_implementation')),
          state TEXT NOT NULL CHECK(state IN (
            'created', 'running', 'awaiting_approval', 'completed', 'blocked', 'failed', 'stopped'
          )),
          round INTEGER NOT NULL CHECK(round BETWEEN 0 AND 3),
          workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 128),
          provider_id TEXT NOT NULL CHECK(length(provider_id) BETWEEN 1 AND 128),
          verification_command_id TEXT NOT NULL CHECK(
            length(verification_command_id) BETWEEN 1 AND 128
          ),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `,
    },
    {
      constraint: "UNIQUE",
      objectName: "action_records",
      replacement: `
        CREATE TABLE action_records (
          action_id TEXT PRIMARY KEY CHECK(length(action_id) BETWEEN 1 AND 128),
          event_id INTEGER NOT NULL UNIQUE
            REFERENCES timeline_events(event_id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          round INTEGER NOT NULL CHECK(round BETWEEN 1 AND 3),
          action_kind TEXT NOT NULL CHECK(action_kind IN (
            'list_files', 'read_file', 'search_text', 'propose_patch',
            'apply_approved_patch', 'run_verification', 'finish'
          )),
          input_summary TEXT NOT NULL CHECK(length(input_summary) <= 4096),
          policy_decision TEXT CHECK(policy_decision IN ('allow', 'ask', 'deny')),
          result_summary TEXT CHECK(
            result_summary IS NULL OR length(result_summary) <= 4096
          )
        );
      `,
    },
  ])(
    "rejects a version-one table with the right columns but a removed $constraint",
    async ({ objectName, replacement }) => {
      await withDatabasePath((databasePath) => {
        initializeAndMutateSchema(databasePath, (database) => {
          database.exec(`DROP TABLE ${objectName}; ${replacement}`);
        });

        expectOpenFailure(databasePath, "UNSUPPORTED_SCHEMA_VERSION");
      });
    },
  );

  it("rejects a wrong index definition", async () => {
    await withDatabasePath((databasePath) => {
      initializeAndMutateSchema(databasePath, (database) => {
        database.exec(`
          DROP INDEX idx_timeline_session_event;
          CREATE INDEX idx_timeline_session_event
          ON timeline_events(event_id, session_id);
        `);
      });

      expectOpenFailure(databasePath, "UNSUPPORTED_SCHEMA_VERSION");
    });
  });

  it.each([
    ["table", "CREATE TABLE extra_table (id TEXT)"],
    ["index", "CREATE INDEX extra_index ON sessions(id)"],
    [
      "trigger",
      "CREATE TRIGGER extra_trigger AFTER INSERT ON sessions BEGIN SELECT 1; END",
    ],
    ["view", "CREATE VIEW extra_view AS SELECT id FROM sessions"],
  ])("rejects an extra user %s", async (_kind, statement) => {
    await withDatabasePath((databasePath) => {
      initializeAndMutateSchema(databasePath, (database) => {
        database.exec(statement);
      });

      expectOpenFailure(databasePath, "UNSUPPORTED_SCHEMA_VERSION");
    });
  });

  it("maps a native open failure to a fixed error without leaking its sentinel or path", async () => {
    await withDatabasePath(async (databasePath) => {
      const sentinel = "sk-proj-native-error-sentinel-1234";
      const missingParent = join(databasePath, sentinel);
      const inaccessibleDatabasePath = join(missingParent, "sessions.sqlite");
      let caught: unknown;

      try {
        createSessionRepository(inaccessibleDatabasePath);
      } catch (error) {
        caught = error;
      }

      expectPersistenceError(caught, "PERSISTENCE_FAILED");
      const publicError = caught as CodeSentinelPersistenceError;
      expect(Object.hasOwn(publicError, "cause")).toBe(false);
      const inspection = JSON.stringify({
        message: publicError.message,
        stack: publicError.stack,
        keys: Reflect.ownKeys(publicError).map(String),
        descriptors: Object.getOwnPropertyDescriptors(publicError),
        json: JSON.stringify(publicError),
      });
      expect(inspection).not.toContain(sentinel);
      expect(inspection).not.toContain(inaccessibleDatabasePath);
      expect(inspection).not.toContain(
        JSON.stringify(inaccessibleDatabasePath).slice(1, -1),
      );
    });
  });
});

describe("session repository initialization", () => {
  it("creates and explicitly maps an immutable session", async () => {
    const repository = createSessionRepository(":memory:");
    try {
      const input = validSession();
      await repository.createSession(input);

      const persisted = await repository.loadSession(input.id);
      expect(persisted).toEqual({
        ...input,
        updatedAt: input.createdAt,
      });
      expect(Object.isFrozen(persisted)).toBe(true);
      await expect(repository.loadSession("unknown-session")).resolves.toBeUndefined();
    } finally {
      repository.close();
    }
  });

  it("returns DUPLICATE_RECORD for a duplicate session ID", async () => {
    const repository = createSessionRepository(":memory:");
    try {
      const input = validSession();
      await repository.createSession(input);

      await expect(repository.createSession(input)).rejects.toMatchObject({
        code: "DUPLICATE_RECORD",
      });
    } finally {
      repository.close();
    }
  });

  it("does not misclassify another session uniqueness constraint as a duplicate ID", async () => {
    await withDatabasePath(async (databasePath) => {
      const repository = createSessionRepository(databasePath);
      try {
        await repository.createSession(validSession());
        const external = new Database(databasePath);
        try {
          external.exec(
            "CREATE UNIQUE INDEX external_workspace_unique ON sessions(workspace_id)",
          );
        } finally {
          external.close();
        }

        await expect(
          repository.createSession(
            validSession({
              id: "session-2",
            }),
          ),
        ).rejects.toMatchObject({
          code: "PERSISTENCE_FAILED",
        });
      } finally {
        repository.close();
      }
    });
  });

  it.each([
    ["invalid session ID", { id: "session/1" }],
    ["blank workspace ID", { workspaceId: "" }],
    [
      "provider ID containing a known key fragment",
      { providerId: "provider-sk-proj-1234567890abcdef" },
    ],
    ["oversized verification command ID", { verificationCommandId: "v".repeat(129) }],
    ["invalid task kind", { taskKind: "other" }],
    ["invalid state", { state: "running" }],
    ["invalid round", { round: 1 }],
    ["invalid timestamp", { createdAt: "not-a-timestamp" }],
    ["noncanonical UTC timestamp", { createdAt: "2026-07-30T00:00:00Z" }],
  ])("returns INVALID_PERSISTENCE_INPUT for %s", async (_name, override) => {
    const repository = createSessionRepository(":memory:");
    try {
      const input = validSession(
        override as unknown as Partial<CreatePersistedSessionInput>,
      );
      await expect(repository.createSession(input)).rejects.toMatchObject({
        code: "INVALID_PERSISTENCE_INPUT",
      });
    } finally {
      repository.close();
    }
  });

  it("returns INVALID_PERSISTENCE_INPUT for an invalid load ID", async () => {
    const repository = createSessionRepository(":memory:");
    try {
      await expect(repository.loadSession("invalid/id")).rejects.toMatchObject({
        code: "INVALID_PERSISTENCE_INPUT",
      });
    } finally {
      repository.close();
    }
  });

  it("maps a throwing input accessor to a fixed error without leaking its sentinel", async () => {
    const repository = createSessionRepository(":memory:");
    try {
      const sentinel = "sk-proj-input-getter-sentinel-1234";
      const input = new Proxy(validSession(), {
        get(target, property, receiver) {
          if (property === "id") {
            throw new Error(sentinel);
          }
          return Reflect.get(target, property, receiver);
        },
      });
      let caught: unknown;

      try {
        await repository.createSession(input);
      } catch (error) {
        caught = error;
      }

      expectPersistenceError(caught, "INVALID_PERSISTENCE_INPUT");
      const publicError = caught as CodeSentinelPersistenceError;
      expect(Object.hasOwn(publicError, "cause")).toBe(false);
      const inspection = JSON.stringify({
        message: publicError.message,
        stack: publicError.stack,
        keys: Reflect.ownKeys(publicError).map(String),
        descriptors: Object.getOwnPropertyDescriptors(publicError),
        json: JSON.stringify(publicError),
      });
      expect(inspection).not.toContain(sentinel);
    } finally {
      repository.close();
    }
  });

  it("allows close to be called twice", () => {
    const repository = createSessionRepository(":memory:");
    expect(() => repository.close()).not.toThrow();
    expect(() => repository.close()).not.toThrow();
  });

  it("returns REPOSITORY_CLOSED from every post-close repository method", async () => {
    const repository = createSessionRepository(":memory:");
    repository.close();

    const calls: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
      ["createSession", () => repository.createSession(validSession())],
      ["loadSession", () => repository.loadSession("session-1")],
      ["append", () => repository.append(stateEvent())],
      [
        "appendAction",
        () =>
          repository.appendAction({
            sessionId: "session-1",
            round: 1,
            occurredAt: CANONICAL_TIME,
            actionId: "action-1",
            actionKind: "finish",
            inputSummary: "finish",
          }),
      ],
      [
        "saveApproval",
        () =>
          repository.saveApproval({
            sessionId: "session-1",
            round: 1,
            occurredAt: CANONICAL_TIME,
            summary: "pending",
            details: {
              approvalId: "approval-1",
              actionId: "action-1",
              patchHash: HASH,
              baseHash: HASH,
              status: "pending",
              createdAt: 1,
              expiresAt: 2,
            },
          }),
      ],
      [
        "appendVerification",
        () =>
          repository.appendVerification({
            sessionId: "session-1",
            round: 0,
            occurredAt: CANONICAL_TIME,
            summary: "verification",
            details: {
              commandId: "test-command",
              exitCode: 1,
              durationMs: 10,
              status: "completed",
              timedOut: false,
            },
          }),
      ],
      [
        "saveSessionMemory",
        () =>
          repository.saveSessionMemory({
            sessionId: "session-1",
            summary: "memory",
            updatedAt: CANONICAL_TIME,
          }),
      ],
      ["loadSessionMemory", () => repository.loadSessionMemory("session-1")],
      ["loadTimeline", () => repository.loadTimeline("session-1")],
      ["recoverInterruptedSessions", () => repository.recoverInterruptedSessions(0)],
      ["clearSession", () => repository.clearSession("session-1")],
    ];

    for (const [method, call] of calls) {
      await expect(call(), method).rejects.toMatchObject({
        code: "REPOSITORY_CLOSED",
      });
    }
  });
});
