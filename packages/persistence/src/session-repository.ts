import type {
  HarnessEvent,
  HarnessToolKind,
  PolicyDecision,
  SessionState,
  TaskKind,
} from "../../contracts/src/index.js";
import {
  MAX_PERSISTED_SUMMARY_CHARACTERS,
} from "./constants.js";
import {
  CodeSentinelPersistenceError,
  persistenceError,
} from "./errors.js";
import { redactText } from "./redaction.js";
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
const SHA_256 = /^[0-9a-f]{64}$/u;
const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000;

const EVENT_KEYS = Object.freeze([
  "sessionId",
  "round",
  "kind",
  "summary",
  "occurredAt",
  "details",
] as const);

const TERMINAL_STATES = new Set<SessionState>([
  "completed",
  "blocked",
  "failed",
  "stopped",
]);

const ALLOWED_STATE_TRANSITIONS: Readonly<
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

type CreateSessionTransactionResult = "inserted" | "duplicate";
type ActionKind = Extract<
  HarnessEvent,
  { kind: "action" }
>["details"]["actionKind"];
type VerificationStatus = Extract<
  HarnessEvent,
  { kind: "verification" }
>["details"]["status"];
type ApprovalStatus = Extract<
  HarnessEvent,
  { kind: "approval" }
>["details"]["status"];

type ActionRecord = Readonly<{
  actionId: string;
  actionKind: ActionKind;
  policyDecision: PolicyDecision | null;
  resultSummary: string | null;
}>;

type TimelineInsertParameters = Readonly<{
  sessionId: string;
  round: number;
  kind: HarnessEvent["kind"];
  summary: string;
  occurredAt: string;
  actionId: string | null;
  actionKind: ActionKind | null;
  policyDecision: PolicyDecision | null;
  toolKind: HarnessToolKind | null;
  commandId: string | null;
  exitCode: number | null;
  durationMs: number | null;
  verificationStatus: VerificationStatus | null;
  timedOut: number | null;
  sessionState: SessionState | null;
  approvalId: string | null;
  approvalActionId: string | null;
  patchHash: string | null;
  baseHash: string | null;
  approvalStatus: ApprovalStatus | null;
  approvalCreatedAt: number | null;
  approvalExpiresAt: number | null;
}>;

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

function isActionKind(value: unknown): value is ActionKind {
  return (
    value === "list_files" ||
    value === "read_file" ||
    value === "search_text" ||
    value === "propose_patch" ||
    value === "apply_approved_patch" ||
    value === "run_verification" ||
    value === "finish"
  );
}

function isPolicyDecision(value: unknown): value is PolicyDecision {
  return value === "allow" || value === "ask" || value === "deny";
}

function isToolKind(value: unknown): value is HarnessToolKind {
  return (
    value === "list_files" ||
    value === "read_file" ||
    value === "search_text" ||
    value === "apply_approved_patch"
  );
}

function isVerificationStatus(value: unknown): value is VerificationStatus {
  return (
    value === "completed" ||
    value === "timed_out" ||
    value === "spawn_failed" ||
    value === "output_limit"
  );
}

function isApprovalStatus(value: unknown): value is ApprovalStatus {
  return (
    value === "pending" ||
    value === "approved" ||
    value === "rejected" ||
    value === "expired"
  );
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

function isEventKind(value: unknown): value is HarnessEvent["kind"] {
  return (
    value === "action" ||
    value === "policy" ||
    value === "tool_result" ||
    value === "verification" ||
    value === "state" ||
    value === "approval"
  );
}

function canonicalIso(value: string): string | undefined {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  const canonical = new Date(timestamp).toISOString();
  return canonical === value ? canonical : undefined;
}

function unreachable(value: never): never {
  void value;
  throw persistenceError("INVALID_PERSISTENCE_INPUT");
}

function readOwnDataObject<const Key extends string>(
  value: unknown,
  expectedKeys: readonly Key[],
): Readonly<Record<Key, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw persistenceError("INVALID_PERSISTENCE_INPUT");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some((key) => typeof key !== "string") ||
    expectedKeys.some((expected) => !ownKeys.includes(expected))
  ) {
    throw persistenceError("INVALID_PERSISTENCE_INPUT");
  }

  const copied = Object.create(null) as Record<Key, unknown>;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw persistenceError("INVALID_PERSISTENCE_INPUT");
    }
    copied[key] = descriptor.value;
  }
  return copied;
}

function assertRound(value: unknown): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 3
  ) {
    throw persistenceError("INVALID_PERSISTENCE_INPUT");
  }
}

function assertSafeNonNegativeInteger(
  value: unknown,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw persistenceError("INVALID_PERSISTENCE_INPUT");
  }
}

function assertApprovalTimestamp(value: unknown): asserts value is number {
  assertSafeNonNegativeInteger(value);
  if (value > MAX_DATE_TIMESTAMP) {
    throw persistenceError("INVALID_PERSISTENCE_INPUT");
  }
}

function assertCanonicalIso(value: unknown): asserts value is string {
  if (typeof value !== "string" || canonicalIso(value) === undefined) {
    throw persistenceError("INVALID_PERSISTENCE_INPUT");
  }
}

function assertRedactedStoredSummary(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > MAX_PERSISTED_SUMMARY_CHARACTERS ||
    redactText(value) !== value
  ) {
    throw persistenceError("PERSISTENCE_FAILED");
  }
}

function validateAndRedactEvent(input: HarnessEvent): HarnessEvent {
  try {
    const event = readOwnDataObject(input, EVENT_KEYS);
    assertIdentifier(event.sessionId);
    assertRound(event.round);
    assertCanonicalIso(event.occurredAt);
    if (!isEventKind(event.kind)) {
      throw persistenceError("INVALID_PERSISTENCE_INPUT");
    }
    if (typeof event.summary !== "string") {
      throw persistenceError("INVALID_PERSISTENCE_INPUT");
    }
    const summary = redactText(event.summary);
    const base = {
      sessionId: event.sessionId,
      round: event.round,
      summary,
      occurredAt: event.occurredAt,
    };

    switch (event.kind) {
      case "action": {
        const details = readOwnDataObject(event.details, [
          "actionId",
          "actionKind",
        ]);
        assertIdentifier(details.actionId);
        if (!isActionKind(details.actionKind)) {
          throw persistenceError("INVALID_PERSISTENCE_INPUT");
        }
        return Object.freeze({
          ...base,
          kind: "action",
          details: Object.freeze({
            actionId: details.actionId,
            actionKind: details.actionKind,
          }),
        });
      }
      case "policy": {
        const details = readOwnDataObject(event.details, ["decision"]);
        if (!isPolicyDecision(details.decision)) {
          throw persistenceError("INVALID_PERSISTENCE_INPUT");
        }
        return Object.freeze({
          ...base,
          kind: "policy",
          details: Object.freeze({ decision: details.decision }),
        });
      }
      case "tool_result": {
        const details = readOwnDataObject(event.details, ["toolKind"]);
        if (!isToolKind(details.toolKind)) {
          throw persistenceError("INVALID_PERSISTENCE_INPUT");
        }
        return Object.freeze({
          ...base,
          kind: "tool_result",
          details: Object.freeze({ toolKind: details.toolKind }),
        });
      }
      case "verification": {
        const details = readOwnDataObject(event.details, [
          "commandId",
          "exitCode",
          "durationMs",
          "status",
          "timedOut",
        ]);
        assertIdentifier(details.commandId);
        if (
          (details.exitCode !== null &&
            (typeof details.exitCode !== "number" ||
              !Number.isSafeInteger(details.exitCode))) ||
          !isVerificationStatus(details.status) ||
          typeof details.timedOut !== "boolean"
        ) {
          throw persistenceError("INVALID_PERSISTENCE_INPUT");
        }
        assertSafeNonNegativeInteger(details.durationMs);
        if (
          details.timedOut !== (details.status === "timed_out") ||
          (details.status !== "completed" && details.exitCode !== null)
        ) {
          throw persistenceError("INVALID_PERSISTENCE_INPUT");
        }
        return Object.freeze({
          ...base,
          kind: "verification",
          details: Object.freeze({
            commandId: details.commandId,
            exitCode: details.exitCode,
            durationMs: details.durationMs,
            status: details.status,
            timedOut: details.timedOut,
          }),
        });
      }
      case "state": {
        const details = readOwnDataObject(event.details, ["state"]);
        if (!isSessionState(details.state)) {
          throw persistenceError("INVALID_PERSISTENCE_INPUT");
        }
        return Object.freeze({
          ...base,
          kind: "state",
          details: Object.freeze({ state: details.state }),
        });
      }
      case "approval": {
        const details = readOwnDataObject(event.details, [
          "approvalId",
          "actionId",
          "patchHash",
          "baseHash",
          "status",
          "createdAt",
          "expiresAt",
        ]);
        assertIdentifier(details.approvalId);
        assertIdentifier(details.actionId);
        if (
          typeof details.patchHash !== "string" ||
          !SHA_256.test(details.patchHash) ||
          typeof details.baseHash !== "string" ||
          !SHA_256.test(details.baseHash) ||
          !isApprovalStatus(details.status)
        ) {
          throw persistenceError("INVALID_PERSISTENCE_INPUT");
        }
        assertApprovalTimestamp(details.createdAt);
        assertApprovalTimestamp(details.expiresAt);
        if (details.expiresAt <= details.createdAt) {
          throw persistenceError("INVALID_PERSISTENCE_INPUT");
        }
        return Object.freeze({
          ...base,
          kind: "approval",
          details: Object.freeze({
            approvalId: details.approvalId,
            actionId: details.actionId,
            patchHash: details.patchHash,
            baseHash: details.baseHash,
            status: details.status,
            createdAt: details.createdAt,
            expiresAt: details.expiresAt,
          }),
        });
      }
      default:
        return unreachable(event.kind);
    }
  } catch {
    throw persistenceError("INVALID_PERSISTENCE_INPUT");
  }
}

function timelineInsertParameters(event: HarnessEvent): TimelineInsertParameters {
  const common = {
    sessionId: event.sessionId,
    round: event.round,
    kind: event.kind,
    summary: event.summary,
    occurredAt: event.occurredAt,
    actionId: null,
    actionKind: null,
    policyDecision: null,
    toolKind: null,
    commandId: null,
    exitCode: null,
    durationMs: null,
    verificationStatus: null,
    timedOut: null,
    sessionState: null,
    approvalId: null,
    approvalActionId: null,
    patchHash: null,
    baseHash: null,
    approvalStatus: null,
    approvalCreatedAt: null,
    approvalExpiresAt: null,
  } satisfies TimelineInsertParameters;

  switch (event.kind) {
    case "action":
      return {
        ...common,
        actionId: event.details.actionId,
        actionKind: event.details.actionKind,
      };
    case "policy":
      return { ...common, policyDecision: event.details.decision };
    case "tool_result":
      return { ...common, toolKind: event.details.toolKind };
    case "verification":
      return {
        ...common,
        commandId: event.details.commandId,
        exitCode: event.details.exitCode,
        durationMs: event.details.durationMs,
        verificationStatus: event.details.status,
        timedOut: event.details.timedOut ? 1 : 0,
      };
    case "state":
      return { ...common, sessionState: event.details.state };
    case "approval":
      return {
        ...common,
        approvalId: event.details.approvalId,
        approvalActionId: event.details.actionId,
        patchHash: event.details.patchHash,
        baseHash: event.details.baseHash,
        approvalStatus: event.details.status,
        approvalCreatedAt: event.details.createdAt,
        approvalExpiresAt: event.details.expiresAt,
      };
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
  const canonicalCreatedAt =
    typeof createdAt === "string" ? canonicalIso(createdAt) : undefined;
  const canonicalUpdatedAt =
    typeof updatedAt === "string" ? canonicalIso(updatedAt) : undefined;
  const createdTimestamp =
    canonicalCreatedAt === undefined
      ? undefined
      : Date.parse(canonicalCreatedAt);
  const updatedTimestamp =
    canonicalUpdatedAt === undefined
      ? undefined
      : Date.parse(canonicalUpdatedAt);

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
    createdTimestamp === undefined ||
    typeof updatedAt !== "string" ||
    updatedTimestamp === undefined ||
    updatedTimestamp < createdTimestamp ||
    (state === "created" && round !== 0) ||
    (state === "awaiting_approval" && round === 0)
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

function mapActionRecordRow(
  value: unknown,
  expectedSessionId: string,
  expectedRound: number,
): ActionRecord {
  try {
    if (typeof value !== "object" || value === null) {
      throw persistenceError("PERSISTENCE_FAILED");
    }
    const row = value as Readonly<Record<string, unknown>>;
    const actionId = row.action_id;
    const sessionId = row.session_id;
    const round = row.round;
    const actionKind = row.action_kind;
    const inputSummary = row.input_summary;
    const policyDecision = row.policy_decision;
    const resultSummary = row.result_summary;
    assertIdentifier(actionId);
    assertIdentifier(sessionId);
    assertRedactedStoredSummary(inputSummary);
    if (
      sessionId !== expectedSessionId ||
      round !== expectedRound ||
      !isActionKind(actionKind) ||
      (policyDecision !== null && !isPolicyDecision(policyDecision)) ||
      (resultSummary !== null &&
        (typeof resultSummary !== "string" ||
          resultSummary.length > MAX_PERSISTED_SUMMARY_CHARACTERS ||
          redactText(resultSummary) !== resultSummary))
    ) {
      throw persistenceError("PERSISTENCE_FAILED");
    }
    return Object.freeze({
      actionId,
      actionKind,
      policyDecision,
      resultSummary,
    });
  } catch {
    throw persistenceError("PERSISTENCE_FAILED");
  }
}

const TIMELINE_TYPE_COLUMNS = Object.freeze([
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
] as const);

function assertUnusedTimelineColumnsAreNull(
  row: Readonly<Record<string, unknown>>,
  used: ReadonlySet<(typeof TIMELINE_TYPE_COLUMNS)[number]>,
): void {
  for (const column of TIMELINE_TYPE_COLUMNS) {
    if (!used.has(column) && row[column] !== null) {
      throw persistenceError("PERSISTENCE_FAILED");
    }
  }
}

function mapTimelineRow(
  value: unknown,
  expectedSessionId: string,
): HarnessEvent {
  try {
    if (typeof value !== "object" || value === null) {
      throw persistenceError("PERSISTENCE_FAILED");
    }
    const row = value as Readonly<Record<string, unknown>>;
    const eventId = row.event_id;
    const sessionId = row.session_id;
    const round = row.round;
    const kind = row.kind;
    const summary = row.summary;
    const occurredAt = row.occurred_at;
    if (
      typeof eventId !== "number" ||
      !Number.isSafeInteger(eventId) ||
      eventId < 1
    ) {
      throw persistenceError("PERSISTENCE_FAILED");
    }
    assertIdentifier(sessionId);
    assertRound(round);
    assertRedactedStoredSummary(summary);
    assertCanonicalIso(occurredAt);
    if (sessionId !== expectedSessionId || !isEventKind(kind)) {
      throw persistenceError("PERSISTENCE_FAILED");
    }

    let event: HarnessEvent;
    switch (kind) {
      case "action": {
        assertUnusedTimelineColumnsAreNull(
          row,
          new Set(["action_id", "action_kind"]),
        );
        event = {
          sessionId,
          round,
          kind,
          summary,
          occurredAt,
          details: {
            actionId: row.action_id as string,
            actionKind: row.action_kind as ActionKind,
          },
        };
        break;
      }
      case "policy": {
        assertUnusedTimelineColumnsAreNull(
          row,
          new Set(["policy_decision"]),
        );
        event = {
          sessionId,
          round,
          kind,
          summary,
          occurredAt,
          details: { decision: row.policy_decision as PolicyDecision },
        };
        break;
      }
      case "tool_result": {
        assertUnusedTimelineColumnsAreNull(row, new Set(["tool_kind"]));
        event = {
          sessionId,
          round,
          kind,
          summary,
          occurredAt,
          details: { toolKind: row.tool_kind as HarnessToolKind },
        };
        break;
      }
      case "verification": {
        assertUnusedTimelineColumnsAreNull(
          row,
          new Set([
            "command_id",
            "exit_code",
            "duration_ms",
            "verification_status",
            "timed_out",
          ]),
        );
        if (row.timed_out !== 0 && row.timed_out !== 1) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        event = {
          sessionId,
          round,
          kind,
          summary,
          occurredAt,
          details: {
            commandId: row.command_id as string,
            exitCode: row.exit_code as number | null,
            durationMs: row.duration_ms as number,
            status: row.verification_status as VerificationStatus,
            timedOut: row.timed_out === 1,
          },
        };
        break;
      }
      case "state": {
        assertUnusedTimelineColumnsAreNull(row, new Set(["session_state"]));
        event = {
          sessionId,
          round,
          kind,
          summary,
          occurredAt,
          details: { state: row.session_state as SessionState },
        };
        break;
      }
      case "approval": {
        assertUnusedTimelineColumnsAreNull(
          row,
          new Set([
            "approval_id",
            "approval_action_id",
            "patch_hash",
            "base_hash",
            "approval_status",
            "approval_created_at",
            "approval_expires_at",
          ]),
        );
        event = {
          sessionId,
          round,
          kind,
          summary,
          occurredAt,
          details: {
            approvalId: row.approval_id as string,
            actionId: row.approval_action_id as string,
            patchHash: row.patch_hash as string,
            baseHash: row.base_hash as string,
            status: row.approval_status as ApprovalStatus,
            createdAt: row.approval_created_at as number,
            expiresAt: row.approval_expires_at as number,
          },
        };
        break;
      }
      default:
        return unreachable(kind);
    }
    return validateAndRedactEvent(event);
  } catch {
    throw persistenceError("PERSISTENCE_FAILED");
  }
}

function allowedStateTransition(
  current: SessionState,
  target: SessionState,
): boolean {
  switch (current) {
    case "created":
      return ALLOWED_STATE_TRANSITIONS.created.has(target);
    case "running":
      return ALLOWED_STATE_TRANSITIONS.running.has(target);
    case "awaiting_approval":
      return ALLOWED_STATE_TRANSITIONS.awaiting_approval.has(target);
    case "completed":
    case "blocked":
    case "failed":
    case "stopped":
      return false;
  }
}

function validateEventSequence(
  event: HarnessEvent,
  session: PersistedSession,
): void {
  if (TERMINAL_STATES.has(session.state)) {
    throw persistenceError("INVALID_EVENT_SEQUENCE");
  }
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

  switch (event.kind) {
    case "action":
    case "policy":
      if (session.state !== "running") {
        throw persistenceError("INVALID_EVENT_SEQUENCE");
      }
      return;
    case "tool_result":
      if (
        (event.details.toolKind === "apply_approved_patch" &&
          session.state !== "awaiting_approval") ||
        (event.details.toolKind !== "apply_approved_patch" &&
          session.state !== "running")
      ) {
        throw persistenceError("INVALID_EVENT_SEQUENCE");
      }
      return;
    case "approval":
      if (session.state !== "awaiting_approval") {
        throw persistenceError("INVALID_EVENT_SEQUENCE");
      }
      return;
    case "verification":
      if (
        event.details.commandId !== session.verificationCommandId ||
        (event.round === 0 &&
          (session.state !== "created" ||
            session.taskKind !== "test_repair")) ||
        (event.round > 0 &&
          session.state !== "running" &&
          session.state !== "awaiting_approval")
      ) {
        throw persistenceError("INVALID_EVENT_SEQUENCE");
      }
      return;
    case "state":
      if (
        !allowedStateTransition(session.state, event.details.state) ||
        (event.details.state === "running" && session.round >= 3) ||
        (event.details.state === "awaiting_approval" && session.round === 0)
      ) {
        throw persistenceError("INVALID_EVENT_SEQUENCE");
      }
      return;
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
      ON CONFLICT(id) DO NOTHING
    `);
    const selectSessionId = database.prepare(`
      SELECT id
      FROM sessions
      WHERE id = ?
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
    const selectActionId = database.prepare(`
      SELECT action_id
      FROM action_records
      WHERE action_id = ?
    `);
    const selectActionForRound = database.prepare(`
      SELECT
        action_id,
        session_id,
        round,
        action_kind,
        input_summary,
        policy_decision,
        result_summary
      FROM action_records
      WHERE session_id = ? AND round = ?
    `);
    const selectApprovedApproval = database.prepare(`
      SELECT event_id
      FROM timeline_events
      WHERE
        session_id = ?
        AND round = ?
        AND kind = 'approval'
        AND approval_action_id = ?
        AND approval_status = 'approved'
      ORDER BY event_id DESC
      LIMIT 1
    `);
    const insertTimelineEvent = database.prepare(`
      INSERT INTO timeline_events (
        session_id,
        round,
        kind,
        summary,
        occurred_at,
        action_id,
        action_kind,
        policy_decision,
        tool_kind,
        command_id,
        exit_code,
        duration_ms,
        verification_status,
        timed_out,
        session_state,
        approval_id,
        approval_action_id,
        patch_hash,
        base_hash,
        approval_status,
        approval_created_at,
        approval_expires_at
      ) VALUES (
        @sessionId,
        @round,
        @kind,
        @summary,
        @occurredAt,
        @actionId,
        @actionKind,
        @policyDecision,
        @toolKind,
        @commandId,
        @exitCode,
        @durationMs,
        @verificationStatus,
        @timedOut,
        @sessionState,
        @approvalId,
        @approvalActionId,
        @patchHash,
        @baseHash,
        @approvalStatus,
        @approvalCreatedAt,
        @approvalExpiresAt
      )
    `);
    const insertActionRecord = database.prepare(`
      INSERT INTO action_records (
        action_id,
        event_id,
        session_id,
        round,
        action_kind,
        input_summary,
        policy_decision,
        result_summary
      ) VALUES (
        @actionId,
        @eventId,
        @sessionId,
        @round,
        @actionKind,
        @inputSummary,
        NULL,
        NULL
      )
    `);
    const updateActionPolicy = database.prepare(`
      UPDATE action_records
      SET policy_decision = @decision
      WHERE
        session_id = @sessionId
        AND round = @round
        AND policy_decision IS NULL
    `);
    const updateActionResult = database.prepare(`
      UPDATE action_records
      SET result_summary = @resultSummary
      WHERE
        session_id = @sessionId
        AND round = @round
        AND result_summary IS NULL
    `);
    const updateSessionState = database.prepare(`
      UPDATE sessions
      SET state = @state
      WHERE id = @sessionId AND state = @previousState
    `);
    const advanceSessionRound = database.prepare(`
      UPDATE sessions
      SET round = @round, updated_at = @occurredAt
      WHERE id = @sessionId AND round = @previousRound
    `);
    const updateSessionTimestamp = database.prepare(`
      UPDATE sessions
      SET updated_at = @occurredAt
      WHERE id = @sessionId
    `);
    const selectTimeline = database.prepare(`
      SELECT
        event_id,
        session_id,
        round,
        kind,
        summary,
        occurred_at,
        action_id,
        action_kind,
        policy_decision,
        tool_kind,
        command_id,
        exit_code,
        duration_ms,
        verification_status,
        timed_out,
        session_state,
        approval_id,
        approval_action_id,
        patch_hash,
        base_hash,
        approval_status,
        approval_created_at,
        approval_expires_at
      FROM timeline_events
      WHERE session_id = ?
      ORDER BY event_id ASC
    `);
    const createSessionTransaction = database.transaction(
      (
        input: CreatePersistedSessionInput,
      ): CreateSessionTransactionResult => {
        if (selectSessionId.get(input.id) !== undefined) {
          return "duplicate";
        }
        const changes = insertSession.run({
          id: input.id,
          taskKind: input.taskKind,
          state: input.state,
          round: input.round,
          workspaceId: input.workspaceId,
          providerId: input.providerId,
          verificationCommandId: input.verificationCommandId,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        }).changes;
        if (changes !== 1) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        const persisted = mapSessionRow(
          selectSession.get(input.id),
          input.id,
        );
        if (
          persisted.id !== input.id ||
          persisted.taskKind !== input.taskKind ||
          persisted.state !== input.state ||
          persisted.round !== input.round ||
          persisted.workspaceId !== input.workspaceId ||
          persisted.providerId !== input.providerId ||
          persisted.verificationCommandId !== input.verificationCommandId ||
          persisted.createdAt !== input.createdAt ||
          persisted.updatedAt !== input.createdAt
        ) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        return "inserted";
      },
    );
    const appendTransaction = database.transaction((event: HarnessEvent): void => {
      const sessionRow = selectSession.get(event.sessionId);
      if (sessionRow === undefined) {
        throw persistenceError("SESSION_NOT_FOUND");
      }
      let session: PersistedSession;
      try {
        session = mapSessionRow(sessionRow, event.sessionId);
      } catch {
        throw persistenceError("PERSISTENCE_FAILED");
      }
      validateEventSequence(event, session);

      let action: ActionRecord | undefined;
      if (
        event.kind === "policy" ||
        event.kind === "tool_result" ||
        (event.kind === "verification" && event.round > 0)
      ) {
        const actionRow = selectActionForRound.get(
          event.sessionId,
          event.round,
        );
        if (actionRow === undefined) {
          throw persistenceError("INVALID_EVENT_SEQUENCE");
        }
        action = mapActionRecordRow(
          actionRow,
          event.sessionId,
          event.round,
        );
      }

      if (event.kind === "action") {
        if (selectActionId.get(event.details.actionId) !== undefined) {
          throw persistenceError("DUPLICATE_RECORD");
        }
      } else if (event.kind === "tool_result") {
        if (action === undefined) {
          throw persistenceError("INVALID_EVENT_SEQUENCE");
        }
        if (event.details.toolKind === "apply_approved_patch") {
          if (
            action.actionKind !== "propose_patch" ||
            action.policyDecision !== "ask" ||
            selectApprovedApproval.get(
              event.sessionId,
              event.round,
              action.actionId,
            ) === undefined
          ) {
            throw persistenceError("INVALID_EVENT_SEQUENCE");
          }
        } else if (
          action.actionKind !== event.details.toolKind ||
          action.policyDecision !== "allow"
        ) {
          throw persistenceError("INVALID_EVENT_SEQUENCE");
        }
      } else if (event.kind === "verification" && event.round > 0) {
        if (action === undefined) {
          throw persistenceError("INVALID_EVENT_SEQUENCE");
        }
        if (
          (session.state === "running" &&
            (action.actionKind !== "run_verification" ||
              action.policyDecision !== "allow")) ||
          (session.state === "awaiting_approval" &&
            (action.actionKind !== "propose_patch" ||
              action.policyDecision !== "ask" ||
              action.resultSummary === null))
        ) {
          throw persistenceError("INVALID_EVENT_SEQUENCE");
        }
      }

      const timelineResult = insertTimelineEvent.run(
        timelineInsertParameters(event),
      );
      if (
        timelineResult.changes !== 1 ||
        typeof timelineResult.lastInsertRowid !== "bigint" &&
          typeof timelineResult.lastInsertRowid !== "number"
      ) {
        throw persistenceError("PERSISTENCE_FAILED");
      }
      const eventId = Number(timelineResult.lastInsertRowid);
      if (!Number.isSafeInteger(eventId) || eventId < 1) {
        throw persistenceError("PERSISTENCE_FAILED");
      }

      switch (event.kind) {
        case "action": {
          const changes = insertActionRecord.run({
            actionId: event.details.actionId,
            eventId,
            sessionId: event.sessionId,
            round: event.round,
            actionKind: event.details.actionKind,
            inputSummary: event.summary,
          }).changes;
          if (changes !== 1) {
            throw persistenceError("PERSISTENCE_FAILED");
          }
          break;
        }
        case "policy": {
          const changes = updateActionPolicy.run({
            decision: event.details.decision,
            sessionId: event.sessionId,
            round: event.round,
          }).changes;
          if (changes !== 1) {
            throw persistenceError("INVALID_EVENT_SEQUENCE");
          }
          break;
        }
        case "tool_result": {
          const changes = updateActionResult.run({
            resultSummary: event.summary,
            sessionId: event.sessionId,
            round: event.round,
          }).changes;
          if (changes !== 1) {
            throw persistenceError("INVALID_EVENT_SEQUENCE");
          }
          break;
        }
        case "state": {
          const changes = updateSessionState.run({
            state: event.details.state,
            sessionId: event.sessionId,
            previousState: session.state,
          }).changes;
          if (changes !== 1) {
            throw persistenceError("PERSISTENCE_FAILED");
          }
          break;
        }
        case "approval":
        case "verification":
          break;
      }

      if (event.kind === "action") {
        const changes = advanceSessionRound.run({
          round: event.round,
          occurredAt: event.occurredAt,
          sessionId: event.sessionId,
          previousRound: session.round,
        }).changes;
        if (changes !== 1) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
      } else {
        const changes = updateSessionTimestamp.run({
          occurredAt: event.occurredAt,
          sessionId: event.sessionId,
        }).changes;
        if (changes !== 1) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
      }
    });
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
      let result: CreateSessionTransactionResult;
      try {
        result = createSessionTransaction.immediate(validated);
      } catch {
        throw persistenceError("PERSISTENCE_FAILED");
      }
      if (result === "duplicate") {
        throw persistenceError("DUPLICATE_RECORD");
      }
      if (result !== "inserted") {
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
      const validated = validateAndRedactEvent(event);
      try {
        appendTransaction.immediate(validated);
      } catch (error) {
        if (isPersistenceError(error)) {
          throw error;
        }
        throw persistenceError("PERSISTENCE_FAILED");
      }
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
      assertIdentifier(sessionId);
      try {
        const rows = selectTimeline.all(sessionId);
        return Object.freeze(
          rows.map((row) => mapTimelineRow(row, sessionId)),
        );
      } catch {
        throw persistenceError("PERSISTENCE_FAILED");
      }
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
