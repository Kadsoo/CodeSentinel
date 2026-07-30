import Database from "better-sqlite3";
import {
  PERSISTENCE_SCHEMA_VERSION,
  SQLITE_BUSY_TIMEOUT_MS,
} from "./constants.js";
import {
  CodeSentinelPersistenceError,
  persistenceError,
} from "./errors.js";

const CREATE_SESSIONS_SQL = `
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
);`;

const CREATE_TIMELINE_EVENTS_SQL = `
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
);`;

const CREATE_ACTION_RECORDS_SQL = `
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
);`;

const CREATE_APPROVALS_SQL = `
CREATE TABLE approvals (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  action_id TEXT NOT NULL UNIQUE REFERENCES action_records(action_id) ON DELETE CASCADE,
  patch_hash TEXT NOT NULL CHECK(length(patch_hash) = 64 AND patch_hash NOT GLOB '*[^0-9a-f]*'),
  base_hash TEXT NOT NULL CHECK(length(base_hash) = 64 AND base_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at)
);`;

const CREATE_VERIFICATION_RUNS_SQL = `
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
);`;

const CREATE_SESSION_MEMORY_SQL = `
CREATE TABLE session_memory (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  summary TEXT NOT NULL CHECK(length(summary) <= 4096),
  updated_at TEXT NOT NULL
);`;

const CREATE_TIMELINE_INDEX_SQL =
  "CREATE INDEX idx_timeline_session_event ON timeline_events(session_id, event_id);";

const CREATE_APPROVAL_INDEX_SQL =
  "CREATE INDEX idx_approvals_session_status ON approvals(session_id, status);";

const CREATE_VERIFICATION_INDEX_SQL =
  "CREATE INDEX idx_verification_session_event ON verification_runs(session_id, event_id);";

const APPROVAL_TRIGGER_SQL = `
CREATE TRIGGER approval_status_forward
BEFORE UPDATE OF status ON approvals
WHEN NOT (
  OLD.status = 'pending'
  AND NEW.status IN ('approved', 'rejected', 'expired')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid approval transition');
END;`;

const SCHEMA_SQL = [
  CREATE_SESSIONS_SQL,
  CREATE_TIMELINE_EVENTS_SQL,
  CREATE_ACTION_RECORDS_SQL,
  CREATE_APPROVALS_SQL,
  CREATE_VERIFICATION_RUNS_SQL,
  CREATE_SESSION_MEMORY_SQL,
  CREATE_TIMELINE_INDEX_SQL,
  CREATE_APPROVAL_INDEX_SQL,
  CREATE_VERIFICATION_INDEX_SQL,
  APPROVAL_TRIGGER_SQL,
].join("\n\n");

type BootstrapState = "initialize" | "validate";

function normalizeSchemaSql(value: string | undefined): string {
  return (value ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/;$/u, "")
    .toLowerCase();
}

function normalizeSchemaSqlPreservingLiterals(
  value: string | undefined,
): string {
  const input = (value ?? "").trim();
  let normalized = "";
  let insideLiteral = false;
  let pendingWhitespace = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? "";
    if (insideLiteral) {
      normalized += character;
      if (character === "'") {
        if (input[index + 1] === "'") {
          normalized += "'";
          index += 1;
        } else {
          insideLiteral = false;
        }
      }
      continue;
    }

    if (character === "'") {
      if (pendingWhitespace && normalized.length > 0) {
        normalized += " ";
      }
      pendingWhitespace = false;
      insideLiteral = true;
      normalized += character;
      continue;
    }
    if (/\s/u.test(character)) {
      pendingWhitespace = true;
      continue;
    }
    if (pendingWhitespace && normalized.length > 0) {
      normalized += " ";
    }
    pendingWhitespace = false;
    normalized += character.toLowerCase();
  }

  return normalized.trim().replace(/;$/u, "");
}

function readBootstrapState(database: Database.Database): BootstrapState {
  const version = Number(database.pragma("user_version", { simple: true }));
  const userObjects = database
    .prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE name NOT GLOB 'sqlite_*' AND type IN ('table', 'index', 'trigger', 'view')
    `)
    .all();
  if (version === 0 && userObjects.length === 0) return "initialize";
  if (version === PERSISTENCE_SCHEMA_VERSION) return "validate";
  throw persistenceError("UNSUPPORTED_SCHEMA_VERSION");
}

function initializeSchema(database: Database.Database): void {
  database
    .transaction(() => {
      database.exec(SCHEMA_SQL);
      database.pragma(`user_version = ${PERSISTENCE_SCHEMA_VERSION}`);
    })
    .immediate();
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
  const rows = database
    .prepare(`
      SELECT name, sql FROM sqlite_schema
      WHERE name NOT GLOB 'sqlite_*' AND type IN ('table', 'index', 'trigger', 'view')
      ORDER BY type, name
    `)
    .all() as Array<{ name: string; sql?: string }>;
  if (rows.length !== expectedSqlByName.size) {
    throw persistenceError("UNSUPPORTED_SCHEMA_VERSION");
  }
  for (const row of rows) {
    const expected = expectedSqlByName.get(row.name);
    if (
      expected === undefined ||
      normalizeSchemaSql(row.sql) !== normalizeSchemaSql(expected) ||
      normalizeSchemaSqlPreservingLiterals(row.sql) !==
        normalizeSchemaSqlPreservingLiterals(expected)
    ) {
      throw persistenceError("UNSUPPORTED_SCHEMA_VERSION");
    }
  }

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
    if (
      actual.map(({ name }) => name).join("\u0000") !==
      expected.join("\u0000")
    ) {
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
    if (
      actualParents.join("\u0000") !==
      [...expectedParents].sort().join("\u0000")
    ) {
      throw persistenceError("UNSUPPORTED_SCHEMA_VERSION");
    }
  }
}

function assertPragmas(
  database: Database.Database,
  journal: "memory" | "delete",
): void {
  const actualJournal = String(
    database.pragma("journal_mode", { simple: true }),
  ).toLowerCase();
  const foreignKeys = Number(
    database.pragma("foreign_keys", { simple: true }),
  );
  const secureDelete = Number(
    database.pragma("secure_delete", { simple: true }),
  );
  const busyTimeout = Number(
    database.pragma("busy_timeout", { simple: true }),
  );
  if (
    actualJournal !== journal ||
    foreignKeys !== 1 ||
    secureDelete !== 1 ||
    busyTimeout !== SQLITE_BUSY_TIMEOUT_MS
  ) {
    throw persistenceError("PERSISTENCE_FAILED");
  }
}

function isPersistenceError(
  error: unknown,
): error is CodeSentinelPersistenceError {
  try {
    return error instanceof CodeSentinelPersistenceError;
  } catch {
    return false;
  }
}

export function openSessionDatabase(databasePath: string): Database.Database {
  let database: Database.Database | undefined;
  try {
    database = new Database(databasePath);
    const bootstrap = readBootstrapState(database);
    const expectedJournal = databasePath === ":memory:" ? "memory" : "delete";
    const journal = String(
      database.pragma("journal_mode = DELETE", { simple: true }),
    ).toLowerCase();
    if (journal !== expectedJournal) {
      throw persistenceError("PERSISTENCE_FAILED");
    }

    database.pragma("foreign_keys = ON");
    database.pragma("secure_delete = ON");
    database.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    assertPragmas(database, expectedJournal);
    if (bootstrap === "initialize") {
      initializeSchema(database);
    } else {
      assertVersionOneSchema(database);
    }
    return database;
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Closing is best-effort; never expose the native close error.
    }
    if (isPersistenceError(error)) {
      throw error;
    }
    throw persistenceError("PERSISTENCE_FAILED");
  }
}
