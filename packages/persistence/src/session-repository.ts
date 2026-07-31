import type {
  HarnessEvent,
  HarnessToolKind,
  PolicyDecision,
  SessionState,
  TaskKind,
} from "../../contracts/src/index.js";
import { isProxy } from "node:util/types";
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
  SessionReadLimit,
  SessionRepository,
} from "./types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const KNOWN_KEY_FRAGMENT =
  /(?:sk-|sk_|pk_|rk_|ghp_)[A-Za-z0-9_-]{12,}/iu;
const SHA_256 = /^[0-9a-f]{64}$/u;
const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000;
const APPROVAL_EXPIRED_ON_RESTART = "APPROVAL_EXPIRED_ON_RESTART";
const SESSION_INTERRUPTED = "SESSION_INTERRUPTED";
const MAX_SESSION_READ_LIMIT = 500;
const DEFAULT_SESSION_READ_LIMIT = MAX_SESSION_READ_LIMIT;

const EVENT_KEYS = Object.freeze([
  "sessionId",
  "round",
  "kind",
  "summary",
  "occurredAt",
  "details",
] as const);

const APPEND_ACTION_INPUT_KEYS = Object.freeze([
  "sessionId",
  "round",
  "occurredAt",
  "actionId",
  "actionKind",
  "inputSummary",
] as const);

const SAVE_APPROVAL_INPUT_KEYS = Object.freeze([
  "sessionId",
  "round",
  "occurredAt",
  "summary",
  "details",
] as const);

const APPEND_VERIFICATION_INPUT_KEYS = SAVE_APPROVAL_INPUT_KEYS;

const SAVE_SESSION_MEMORY_INPUT_KEYS = Object.freeze([
  "sessionId",
  "summary",
  "updatedAt",
] as const);

const SESSION_READ_LIMIT_KEYS = Object.freeze(["limit"] as const);

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
  inputSummary: string;
  policyDecision: PolicyDecision | null;
  resultSummary: string | null;
}>;

type ApprovalRecord = Readonly<{
  approvalId: string;
  sessionId: string;
  actionId: string;
  patchHash: string;
  baseHash: string;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
}>;

type VerificationRecord = Readonly<{
  eventId: number;
  sessionId: string;
  round: number;
  commandId: string;
  exitCode: number | null;
  durationMs: number;
  status: VerificationStatus;
  timedOut: boolean;
  summary: string;
}>;

type RecoveryTime = Readonly<{
  epoch: number;
  iso: string;
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

function canonicalEpoch(value: string): number | undefined {
  const canonical = canonicalIso(value);
  return canonical === undefined ? undefined : Date.parse(canonical);
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
    isProxy(value) ||
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
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < -MAX_DATE_TIMESTAMP ||
    value > MAX_DATE_TIMESTAMP
  ) {
    throw persistenceError("INVALID_PERSISTENCE_INPUT");
  }
}

function validatedRecoveryTime(value: unknown): RecoveryTime {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < -MAX_DATE_TIMESTAMP ||
    value > MAX_DATE_TIMESTAMP
  ) {
    throw persistenceError("INVALID_PERSISTENCE_INPUT");
  }
  try {
    const iso = new Date(value).toISOString();
    if (Date.parse(iso) !== value) {
      throw persistenceError("INVALID_PERSISTENCE_INPUT");
    }
    return Object.freeze({ epoch: value, iso });
  } catch {
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

function actionEventFromInput(input: AppendActionInput): HarnessEvent {
  try {
    const snapshot = readOwnDataObject(
      input,
      APPEND_ACTION_INPUT_KEYS,
    );
    return {
      sessionId: snapshot.sessionId as string,
      round: snapshot.round as number,
      occurredAt: snapshot.occurredAt as string,
      kind: "action",
      summary: snapshot.inputSummary as string,
      details: {
        actionId: snapshot.actionId as string,
        actionKind: snapshot.actionKind as ActionKind,
      },
    };
  } catch {
    throw persistenceError("INVALID_PERSISTENCE_INPUT");
  }
}

function approvalEventFromInput(input: SaveApprovalInput): HarnessEvent {
  try {
    const snapshot = readOwnDataObject(input, SAVE_APPROVAL_INPUT_KEYS);
    return {
      sessionId: snapshot.sessionId as string,
      round: snapshot.round as number,
      occurredAt: snapshot.occurredAt as string,
      kind: "approval",
      summary: snapshot.summary as string,
      details: snapshot.details as Extract<
        HarnessEvent,
        { kind: "approval" }
      >["details"],
    };
  } catch {
    throw persistenceError("INVALID_PERSISTENCE_INPUT");
  }
}

function verificationEventFromInput(
  input: AppendVerificationInput,
): HarnessEvent {
  try {
    const snapshot = readOwnDataObject(
      input,
      APPEND_VERIFICATION_INPUT_KEYS,
    );
    return {
      sessionId: snapshot.sessionId as string,
      round: snapshot.round as number,
      occurredAt: snapshot.occurredAt as string,
      kind: "verification",
      summary: snapshot.summary as string,
      details: snapshot.details as Extract<
        HarnessEvent,
        { kind: "verification" }
      >["details"],
    };
  } catch {
    throw persistenceError("INVALID_PERSISTENCE_INPUT");
  }
}

function validatedSessionMemoryInput(
  input: SaveSessionMemoryInput,
): PersistedSessionMemory {
  try {
    const snapshot = readOwnDataObject(
      input,
      SAVE_SESSION_MEMORY_INPUT_KEYS,
    );
    assertIdentifier(snapshot.sessionId);
    assertCanonicalIso(snapshot.updatedAt);
    if (typeof snapshot.summary !== "string") {
      throw persistenceError("INVALID_PERSISTENCE_INPUT");
    }
    return Object.freeze({
      sessionId: snapshot.sessionId,
      summary: redactText(snapshot.summary),
      updatedAt: snapshot.updatedAt,
    });
  } catch {
    throw persistenceError("INVALID_PERSISTENCE_INPUT");
  }
}

function validatedSessionReadLimit(input: unknown): number {
  try {
    const limit = readOwnDataObject(input, SESSION_READ_LIMIT_KEYS).limit;
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_SESSION_READ_LIMIT
    ) {
      throw persistenceError("INVALID_PERSISTENCE_INPUT");
    }
    return limit;
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
  const createdTimestamp =
    typeof createdAt === "string" ? canonicalEpoch(createdAt) : undefined;
  const updatedTimestamp =
    typeof updatedAt === "string" ? canonicalEpoch(updatedAt) : undefined;

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

function mapListedSessionRow(value: unknown): PersistedSession {
  try {
    if (typeof value !== "object" || value === null) {
      throw persistenceError("PERSISTENCE_FAILED");
    }
    const id = (value as Readonly<Record<string, unknown>>).id;
    assertIdentifier(id);
    return mapSessionRow(value, id);
  } catch {
    throw persistenceError("PERSISTENCE_FAILED");
  }
}

function mapSessionMemoryRow(
  value: unknown,
  expectedSessionId: string,
): PersistedSessionMemory {
  try {
    if (typeof value !== "object" || value === null) {
      throw persistenceError("PERSISTENCE_FAILED");
    }
    const row = value as Readonly<Record<string, unknown>>;
    const sessionId = row.session_id;
    const summary = row.summary;
    const updatedAt = row.updated_at;
    assertIdentifier(sessionId);
    assertRedactedStoredSummary(summary);
    assertCanonicalIso(updatedAt);
    if (sessionId !== expectedSessionId) {
      throw persistenceError("PERSISTENCE_FAILED");
    }
    return Object.freeze({ sessionId, summary, updatedAt });
  } catch {
    throw persistenceError("PERSISTENCE_FAILED");
  }
}

function sessionMemoriesEqual(
  actual: PersistedSessionMemory,
  expected: PersistedSessionMemory,
): boolean {
  return (
    actual.sessionId === expected.sessionId &&
    actual.summary === expected.summary &&
    actual.updatedAt === expected.updatedAt
  );
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
      inputSummary,
      policyDecision,
      resultSummary,
    });
  } catch {
    throw persistenceError("PERSISTENCE_FAILED");
  }
}

function mapApprovalRecordRow(value: unknown): ApprovalRecord {
  try {
    if (typeof value !== "object" || value === null) {
      throw persistenceError("PERSISTENCE_FAILED");
    }
    const row = value as Readonly<Record<string, unknown>>;
    const approvalId = row.id;
    const sessionId = row.session_id;
    const actionId = row.action_id;
    const patchHash = row.patch_hash;
    const baseHash = row.base_hash;
    const status = row.status;
    const createdAt = row.created_at;
    const expiresAt = row.expires_at;
    assertIdentifier(approvalId);
    assertIdentifier(sessionId);
    assertIdentifier(actionId);
    if (
      typeof patchHash !== "string" ||
      !SHA_256.test(patchHash) ||
      typeof baseHash !== "string" ||
      !SHA_256.test(baseHash) ||
      !isApprovalStatus(status)
    ) {
      throw persistenceError("PERSISTENCE_FAILED");
    }
    assertApprovalTimestamp(createdAt);
    assertApprovalTimestamp(expiresAt);
    if (expiresAt <= createdAt) {
      throw persistenceError("PERSISTENCE_FAILED");
    }
    return Object.freeze({
      approvalId,
      sessionId,
      actionId,
      patchHash,
      baseHash,
      status,
      createdAt,
      expiresAt,
    });
  } catch {
    throw persistenceError("PERSISTENCE_FAILED");
  }
}

function mapVerificationRecordRow(value: unknown): VerificationRecord {
  try {
    if (typeof value !== "object" || value === null) {
      throw persistenceError("PERSISTENCE_FAILED");
    }
    const row = value as Readonly<Record<string, unknown>>;
    const eventId = row.event_id;
    const sessionId = row.session_id;
    const round = row.round;
    const commandId = row.command_id;
    const exitCode = row.exit_code;
    const durationMs = row.duration_ms;
    const status = row.status;
    const timedOut = row.timed_out;
    const summary = row.summary;
    if (
      typeof eventId !== "number" ||
      !Number.isSafeInteger(eventId) ||
      eventId < 1
    ) {
      throw persistenceError("PERSISTENCE_FAILED");
    }
    assertIdentifier(sessionId);
    assertRound(round);
    assertIdentifier(commandId);
    if (
      (exitCode !== null &&
        (typeof exitCode !== "number" ||
          !Number.isSafeInteger(exitCode))) ||
      !isVerificationStatus(status) ||
      (timedOut !== 0 && timedOut !== 1)
    ) {
      throw persistenceError("PERSISTENCE_FAILED");
    }
    assertSafeNonNegativeInteger(durationMs);
    assertRedactedStoredSummary(summary);
    if (
      (status !== "completed" && exitCode !== null) ||
      (timedOut === 1) !== (status === "timed_out")
    ) {
      throw persistenceError("PERSISTENCE_FAILED");
    }
    return Object.freeze({
      eventId,
      sessionId,
      round,
      commandId,
      exitCode,
      durationMs,
      status,
      timedOut: timedOut === 1,
      summary,
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
  const eventTimestamp = canonicalEpoch(event.occurredAt);
  const sessionTimestamp = canonicalEpoch(session.updatedAt);
  if (eventTimestamp === undefined || sessionTimestamp === undefined) {
    throw persistenceError("PERSISTENCE_FAILED");
  }
  if (eventTimestamp < sessionTimestamp) {
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

function storedCount(value: unknown): number {
  if (typeof value !== "object" || value === null) {
    throw persistenceError("PERSISTENCE_FAILED");
  }
  const count = (value as Readonly<Record<string, unknown>>).count;
  if (
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 0
  ) {
    throw persistenceError("PERSISTENCE_FAILED");
  }
  return count;
}

function eventsEqual(actual: HarnessEvent, expected: HarnessEvent): boolean {
  if (
    actual.sessionId !== expected.sessionId ||
    actual.round !== expected.round ||
    actual.kind !== expected.kind ||
    actual.summary !== expected.summary ||
    actual.occurredAt !== expected.occurredAt
  ) {
    return false;
  }
  switch (expected.kind) {
    case "action":
      return (
        actual.kind === "action" &&
        actual.details.actionId === expected.details.actionId &&
        actual.details.actionKind === expected.details.actionKind
      );
    case "policy":
      return (
        actual.kind === "policy" &&
        actual.details.decision === expected.details.decision
      );
    case "tool_result":
      return (
        actual.kind === "tool_result" &&
        actual.details.toolKind === expected.details.toolKind
      );
    case "verification":
      return (
        actual.kind === "verification" &&
        actual.details.commandId === expected.details.commandId &&
        actual.details.exitCode === expected.details.exitCode &&
        actual.details.durationMs === expected.details.durationMs &&
        actual.details.status === expected.details.status &&
        actual.details.timedOut === expected.details.timedOut
      );
    case "state":
      return (
        actual.kind === "state" &&
        actual.details.state === expected.details.state
      );
    case "approval":
      return (
        actual.kind === "approval" &&
        actual.details.approvalId === expected.details.approvalId &&
        actual.details.actionId === expected.details.actionId &&
        actual.details.patchHash === expected.details.patchHash &&
        actual.details.baseHash === expected.details.baseHash &&
        actual.details.status === expected.details.status &&
        actual.details.createdAt === expected.details.createdAt &&
        actual.details.expiresAt === expected.details.expiresAt
      );
  }
}

function storedRowsEqual(
  actual: readonly unknown[],
  expected: readonly unknown[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((actualRow, index) => {
      const expectedRow = expected[index];
      if (
        typeof actualRow !== "object" ||
        actualRow === null ||
        typeof expectedRow !== "object" ||
        expectedRow === null
      ) {
        return false;
      }
      const actualKeys = Reflect.ownKeys(actualRow);
      const expectedKeys = Reflect.ownKeys(expectedRow);
      return (
        actualKeys.length === expectedKeys.length &&
        actualKeys.every((key) => {
          if (!expectedKeys.includes(key)) {
            return false;
          }
          const actualDescriptor = Object.getOwnPropertyDescriptor(
            actualRow,
            key,
          );
          const expectedDescriptor = Object.getOwnPropertyDescriptor(
            expectedRow,
            key,
          );
          return (
            actualDescriptor !== undefined &&
            "value" in actualDescriptor &&
            expectedDescriptor !== undefined &&
            "value" in expectedDescriptor &&
            Object.is(actualDescriptor.value, expectedDescriptor.value)
          );
        })
      );
    })
  );
}

function sessionsEqual(
  actual: PersistedSession,
  expected: PersistedSession,
): boolean {
  return (
    actual.id === expected.id &&
    actual.taskKind === expected.taskKind &&
    actual.state === expected.state &&
    actual.round === expected.round &&
    actual.workspaceId === expected.workspaceId &&
    actual.providerId === expected.providerId &&
    actual.verificationCommandId === expected.verificationCommandId &&
    actual.createdAt === expected.createdAt &&
    actual.updatedAt === expected.updatedAt
  );
}

function actionRecordsEqual(
  actual: ActionRecord,
  expected: ActionRecord,
): boolean {
  return (
    actual.actionId === expected.actionId &&
    actual.actionKind === expected.actionKind &&
    actual.inputSummary === expected.inputSummary &&
    actual.policyDecision === expected.policyDecision &&
    actual.resultSummary === expected.resultSummary
  );
}

function approvalRecordsEqual(
  actual: ApprovalRecord,
  expected: ApprovalRecord,
): boolean {
  return (
    actual.approvalId === expected.approvalId &&
    actual.sessionId === expected.sessionId &&
    actual.actionId === expected.actionId &&
    actual.patchHash === expected.patchHash &&
    actual.baseHash === expected.baseHash &&
    actual.status === expected.status &&
    actual.createdAt === expected.createdAt &&
    actual.expiresAt === expected.expiresAt
  );
}

function verificationRecordsEqual(
  actual: VerificationRecord,
  expected: VerificationRecord,
): boolean {
  return (
    actual.eventId === expected.eventId &&
    actual.sessionId === expected.sessionId &&
    actual.round === expected.round &&
    actual.commandId === expected.commandId &&
    actual.exitCode === expected.exitCode &&
    actual.durationMs === expected.durationMs &&
    actual.status === expected.status &&
    actual.timedOut === expected.timedOut &&
    actual.summary === expected.summary
  );
}

function approvalRecordFromEvent(
  event: Extract<HarnessEvent, { kind: "approval" }>,
): ApprovalRecord {
  return Object.freeze({
    approvalId: event.details.approvalId,
    sessionId: event.sessionId,
    actionId: event.details.actionId,
    patchHash: event.details.patchHash,
    baseHash: event.details.baseHash,
    status: event.details.status,
    createdAt: event.details.createdAt,
    expiresAt: event.details.expiresAt,
  });
}

function approvalMetadataEqual(
  approval: ApprovalRecord,
  event: Extract<HarnessEvent, { kind: "approval" }>,
): boolean {
  return (
    approval.approvalId === event.details.approvalId &&
    approval.sessionId === event.sessionId &&
    approval.actionId === event.details.actionId &&
    approval.patchHash === event.details.patchHash &&
    approval.baseHash === event.details.baseHash &&
    approval.createdAt === event.details.createdAt &&
    approval.expiresAt === event.details.expiresAt
  );
}

function validateRecoveryApprovalExpiration(
  event: HarnessEvent,
  session: PersistedSession,
  approval: ApprovalRecord,
): asserts event is Extract<HarnessEvent, { kind: "approval" }> {
  const eventTimestamp = canonicalEpoch(event.occurredAt);
  const sessionTimestamp = canonicalEpoch(session.updatedAt);
  if (
    event.kind !== "approval" ||
    event.summary !== APPROVAL_EXPIRED_ON_RESTART ||
    event.details.status !== "expired" ||
    event.sessionId !== session.id ||
    event.round !== session.round ||
    TERMINAL_STATES.has(session.state) ||
    approval.status !== "pending" ||
    approval.sessionId !== session.id ||
    !approvalMetadataEqual(approval, event) ||
    eventTimestamp === undefined ||
    sessionTimestamp === undefined ||
    eventTimestamp < sessionTimestamp
  ) {
    throw persistenceError("PERSISTENCE_FAILED");
  }
}

function expectedSessionAfterEvent(
  session: PersistedSession,
  event: HarnessEvent,
): PersistedSession {
  return Object.freeze({
    ...session,
    state: event.kind === "state" ? event.details.state : session.state,
    round: event.kind === "action" ? event.round : session.round,
    updatedAt: event.occurredAt,
  });
}

function expectedActionAfterEvent(
  actionBefore: ActionRecord | undefined,
  event: HarnessEvent,
): ActionRecord | undefined {
  switch (event.kind) {
    case "action":
      return Object.freeze({
        actionId: event.details.actionId,
        actionKind: event.details.actionKind,
        inputSummary: event.summary,
        policyDecision: null,
        resultSummary: null,
      });
    case "policy":
      if (actionBefore === undefined) {
        throw persistenceError("PERSISTENCE_FAILED");
      }
      return Object.freeze({
        ...actionBefore,
        policyDecision: event.details.decision,
      });
    case "tool_result":
      if (actionBefore === undefined) {
        throw persistenceError("PERSISTENCE_FAILED");
      }
      return Object.freeze({
        ...actionBefore,
        resultSummary: event.summary,
      });
    case "verification":
      return event.round === 0 || actionBefore === undefined
        ? actionBefore
        : Object.freeze({
            ...actionBefore,
            resultSummary: event.summary,
          });
    case "approval":
    case "state":
      return actionBefore;
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
    const selectSchemaFingerprint = database.prepare(`
      SELECT type, name, tbl_name, rootpage, sql
      FROM sqlite_schema
      ORDER BY type ASC, name ASC
    `);
    const expectedSchemaFingerprint = selectSchemaFingerprint.all();
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
    const selectSessions = database.prepare(`
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
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `);
    const selectInterruptedSessions = database.prepare(`
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
      WHERE state IN ('created', 'running', 'awaiting_approval')
      ORDER BY id ASC
    `);
    const deleteSession = database.prepare(`
      DELETE FROM sessions
      WHERE id = ?
    `);
    const selectTargetRowCounts = database.prepare(`
      SELECT
        (SELECT count(*) FROM sessions WHERE id = ?) AS sessions,
        (SELECT count(*) FROM timeline_events WHERE session_id = ?) AS timeline_events,
        (SELECT count(*) FROM action_records WHERE session_id = ?) AS action_records,
        (SELECT count(*) FROM approvals WHERE session_id = ?) AS approvals,
        (SELECT count(*) FROM verification_runs WHERE session_id = ?) AS verification_runs,
        (SELECT count(*) FROM session_memory WHERE session_id = ?) AS session_memory
    `);
    const selectSessionMemory = database.prepare(`
      SELECT
        session_id,
        summary,
        updated_at
      FROM session_memory
      WHERE session_id = ?
    `);
    const upsertSessionMemory = database.prepare(`
      INSERT INTO session_memory (
        session_id,
        summary,
        updated_at
      ) VALUES (
        @sessionId,
        @summary,
        @updatedAt
      )
      ON CONFLICT(session_id) DO UPDATE SET
        summary = excluded.summary,
        updated_at = excluded.updated_at
    `);
    const selectActionId = database.prepare(`
      SELECT action_id
      FROM action_records
      WHERE action_id = ?
    `);
    const selectRecoveryActionById = database.prepare(`
      SELECT
        action_id,
        event_id,
        session_id,
        round,
        action_kind,
        input_summary,
        policy_decision,
        result_summary
      FROM action_records
      WHERE action_id = ?
    `);
    const selectRecoveryActionOriginIds = database.prepare(`
      SELECT event_id
      FROM timeline_events
      WHERE
        kind = 'action'
        AND (
          (session_id = ? AND round = ?)
          OR action_id = ?
        )
      ORDER BY event_id
    `);
    const selectRecoveryHigherRoundActions = database.prepare(`
      SELECT
        action_id,
        event_id,
        session_id,
        round,
        action_kind,
        input_summary,
        policy_decision,
        result_summary
      FROM action_records
      WHERE session_id = ? AND round > ?
      ORDER BY round, event_id
    `);
    const selectRecoveryApprovalOriginIds = database.prepare(`
      SELECT event_id
      FROM timeline_events
      WHERE approval_id = ?
      ORDER BY event_id
    `);
    const selectRecoveryPolicyEventIds = database.prepare(`
      SELECT event_id
      FROM timeline_events
      WHERE session_id = ? AND round = ? AND kind = 'policy'
      ORDER BY event_id
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
    const selectApprovalById = database.prepare(`
      SELECT
        id,
        session_id,
        action_id,
        patch_hash,
        base_hash,
        status,
        created_at,
        expires_at
      FROM approvals
      WHERE id = ?
    `);
    const selectApprovalForAction = database.prepare(`
      SELECT
        id,
        session_id,
        action_id,
        patch_hash,
        base_hash,
        status,
        created_at,
        expires_at
      FROM approvals
      WHERE action_id = ?
    `);
    const selectPendingApprovalsForSession = database.prepare(`
      SELECT
        id,
        session_id,
        action_id,
        patch_hash,
        base_hash,
        status,
        created_at,
        expires_at
      FROM approvals
      WHERE session_id = ? AND status = 'pending'
      ORDER BY id ASC
    `);
    const selectApprovedApproval = database.prepare(`
      SELECT
        id,
        session_id,
        action_id,
        patch_hash,
        base_hash,
        status,
        created_at,
        expires_at
      FROM approvals
      WHERE
        session_id = ?
        AND action_id = ?
        AND status = 'approved'
      LIMIT 1
    `);
    const selectEarlierAppliedPatch = database.prepare(`
      SELECT event_id
      FROM timeline_events
      WHERE
        session_id = ?
        AND round = ?
        AND kind = 'tool_result'
        AND tool_kind = 'apply_approved_patch'
        AND event_id < ?
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
    const insertApproval = database.prepare(`
      INSERT INTO approvals (
        id,
        session_id,
        action_id,
        patch_hash,
        base_hash,
        status,
        created_at,
        expires_at
      ) VALUES (
        @approvalId,
        @sessionId,
        @actionId,
        @patchHash,
        @baseHash,
        @status,
        @createdAt,
        @expiresAt
      )
    `);
    const updateApprovalStatus = database.prepare(`
      UPDATE approvals
      SET status = @status
      WHERE id = @approvalId AND action_id = @actionId AND status = 'pending'
    `);
    const insertVerificationRun = database.prepare(`
      INSERT INTO verification_runs (
        event_id,
        session_id,
        round,
        command_id,
        exit_code,
        duration_ms,
        status,
        timed_out,
        summary
      ) VALUES (
        @eventId,
        @sessionId,
        @round,
        @commandId,
        @exitCode,
        @durationMs,
        @status,
        @timedOut,
        @summary
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
    const overwriteActionResult = database.prepare(`
      UPDATE action_records
      SET result_summary = @resultSummary
      WHERE session_id = @sessionId AND round = @round
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
    const selectLimitedTimeline = database.prepare(`
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
      FROM (
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
        ORDER BY event_id DESC
        LIMIT ?
      )
      ORDER BY event_id ASC
    `);
    const selectTimelineByEventId = database.prepare(`
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
      WHERE event_id = ?
    `);
    const selectGlobalTimelineCount = database.prepare(`
      SELECT count(*) AS count
      FROM timeline_events
    `);
    const selectSessionTimelineCount = database.prepare(`
      SELECT count(*) AS count
      FROM timeline_events
      WHERE session_id = ?
    `);
    const selectApprovalCount = database.prepare(`
      SELECT count(*) AS count
      FROM approvals
    `);
    const selectSessionApprovalCount = database.prepare(`
      SELECT count(*) AS count
      FROM approvals
      WHERE session_id = ?
    `);
    const selectVerificationCount = database.prepare(`
      SELECT count(*) AS count
      FROM verification_runs
    `);
    const selectSessionVerificationCount = database.prepare(`
      SELECT count(*) AS count
      FROM verification_runs
      WHERE session_id = ?
    `);
    const selectMemoryCount = database.prepare(`
      SELECT count(*) AS count
      FROM session_memory
    `);
    const selectSessionMemoryCount = database.prepare(`
      SELECT count(*) AS count
      FROM session_memory
      WHERE session_id = ?
    `);
    const selectVerificationByEventId = database.prepare(`
      SELECT
        event_id,
        session_id,
        round,
        command_id,
        exit_code,
        duration_ms,
        status,
        timed_out,
        summary
      FROM verification_runs
      WHERE event_id = ?
    `);
    function approvedApproval(
      sessionId: string,
      actionId: string,
    ): ApprovalRecord | undefined {
      const row = selectApprovedApproval.get(sessionId, actionId);
      if (row === undefined) {
        return undefined;
      }
      const approval = mapApprovalRecordRow(row);
      if (
        approval.sessionId !== sessionId ||
        approval.actionId !== actionId ||
        approval.status !== "approved"
      ) {
        throw persistenceError("PERSISTENCE_FAILED");
      }
      return approval;
    }

    function hasEarlierAppliedPatch(
      sessionId: string,
      round: number,
      beforeEventId: number,
    ): boolean {
      const row = selectEarlierAppliedPatch.get(
        sessionId,
        round,
        beforeEventId,
      );
      if (row === undefined) {
        return false;
      }
      if (typeof row !== "object" || row === null) {
        throw persistenceError("PERSISTENCE_FAILED");
      }
      const eventId = (row as Readonly<Record<string, unknown>>).event_id;
      if (
        typeof eventId !== "number" ||
        !Number.isSafeInteger(eventId) ||
        eventId < 1 ||
        eventId >= beforeEventId
      ) {
        throw persistenceError("PERSISTENCE_FAILED");
      }
      return true;
    }

    function assertLifecycleSchemaIntegrity(): void {
      let actual: readonly unknown[];
      try {
        actual = selectSchemaFingerprint.all();
      } catch {
        throw persistenceError("PERSISTENCE_FAILED");
      }
      if (!storedRowsEqual(actual, expectedSchemaFingerprint)) {
        throw persistenceError("PERSISTENCE_FAILED");
      }
    }

    function recoveryActionBinding(
      session: PersistedSession,
      value: unknown,
    ): Readonly<{
      action: ActionRecord;
      round: number;
      eventId: number;
      event: Extract<HarnessEvent, { kind: "action" }>;
    }> {
      try {
        if (typeof value !== "object" || value === null) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        const stored = value as Readonly<Record<string, unknown>>;
        const round = stored.round;
        const eventId = stored.event_id;
        if (
          typeof round !== "number" ||
          !Number.isInteger(round) ||
          round < 1 ||
          round > session.round ||
          typeof eventId !== "number" ||
          !Number.isSafeInteger(eventId) ||
          eventId < 1
        ) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        const action = mapActionRecordRow(
          value,
          session.id,
          round,
        );
        const originRows = selectRecoveryActionOriginIds.all(
          session.id,
          round,
          action.actionId,
        );
        if (originRows.length !== 1) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        const originRow = originRows[0];
        if (typeof originRow !== "object" || originRow === null) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        const originEventId = (
          originRow as Readonly<Record<string, unknown>>
        ).event_id;
        if (originEventId !== eventId) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        const event = mapTimelineRow(
          selectTimelineByEventId.get(eventId),
          session.id,
        );
        if (
          event.kind !== "action" ||
          event.round !== round ||
          event.summary !== action.inputSummary ||
          event.details.actionId !== action.actionId ||
          event.details.actionKind !== action.actionKind
        ) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        return Object.freeze({ action, round, eventId, event });
      } catch {
        throw persistenceError("PERSISTENCE_FAILED");
      }
    }

    function assertRecoveryApprovalBinding(
      session: PersistedSession,
      approval: ApprovalRecord,
    ): void {
      try {
        const row = selectRecoveryActionById.get(approval.actionId);
        const {
          action,
          round: actionRound,
          eventId: actionEventId,
          event: actionEvent,
        } = recoveryActionBinding(
          session,
          row,
        );
        if (
          action.actionId !== approval.actionId ||
          action.actionKind !== "propose_patch" ||
          action.policyDecision !== "ask" ||
          action.resultSummary !== null
        ) {
          throw persistenceError("PERSISTENCE_FAILED");
        }

        const policyRows = selectRecoveryPolicyEventIds.all(
          session.id,
          actionRound,
        );
        if (policyRows.length !== 1) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        const policyRow = policyRows[0];
        if (typeof policyRow !== "object" || policyRow === null) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        const policyEventId = (
          policyRow as Readonly<Record<string, unknown>>
        ).event_id;
        if (
          typeof policyEventId !== "number" ||
          !Number.isSafeInteger(policyEventId) ||
          policyEventId < 1
        ) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        const policyEvent = mapTimelineRow(
          selectTimelineByEventId.get(policyEventId),
          session.id,
        );
        if (
          policyEvent.kind !== "policy" ||
          policyEvent.round !== actionRound ||
          policyEvent.details.decision !== "ask"
        ) {
          throw persistenceError("PERSISTENCE_FAILED");
        }

        const origins = selectRecoveryApprovalOriginIds.all(
          approval.approvalId,
        );
        if (origins.length !== 1) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        const origin = origins[0];
        if (typeof origin !== "object" || origin === null) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        const originEventId = (
          origin as Readonly<Record<string, unknown>>
        ).event_id;
        if (
          typeof originEventId !== "number" ||
          !Number.isSafeInteger(originEventId) ||
          originEventId < 1
        ) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        const originEvent = mapTimelineRow(
          selectTimelineByEventId.get(originEventId),
          session.id,
        );
        if (
          originEvent.kind !== "approval" ||
          originEvent.round !== actionRound ||
          originEvent.details.approvalId !== approval.approvalId ||
          originEvent.details.actionId !== approval.actionId ||
          originEvent.details.patchHash !== approval.patchHash ||
          originEvent.details.baseHash !== approval.baseHash ||
          originEvent.details.status !== "pending" ||
          originEvent.details.createdAt !== approval.createdAt ||
          originEvent.details.expiresAt !== approval.expiresAt ||
          actionEventId >= policyEventId ||
          policyEventId >= originEventId
        ) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        const actionEpoch = canonicalEpoch(actionEvent.occurredAt);
        const policyEpoch = canonicalEpoch(policyEvent.occurredAt);
        const originEpoch = canonicalEpoch(originEvent.occurredAt);
        if (
          actionEpoch === undefined ||
          policyEpoch === undefined ||
          originEpoch === undefined ||
          actionEpoch > policyEpoch ||
          policyEpoch > originEpoch
        ) {
          throw persistenceError("PERSISTENCE_FAILED");
        }

        const higherActionRows = selectRecoveryHigherRoundActions.all(
          session.id,
          actionRound,
        );
        if (
          higherActionRows.length !== session.round - actionRound
        ) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        for (const [index, higherActionRow] of higherActionRows.entries()) {
          const higherAction = recoveryActionBinding(
            session,
            higherActionRow,
          );
          const higherActionEpoch = canonicalEpoch(
            higherAction.event.occurredAt,
          );
          if (
            higherAction.round !== actionRound + index + 1 ||
            originEventId >= higherAction.eventId ||
            higherActionEpoch === undefined ||
            originEpoch > higherActionEpoch
          ) {
            throw persistenceError("PERSISTENCE_FAILED");
          }
        }
      } catch {
        throw persistenceError("PERSISTENCE_FAILED");
      }
    }

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
    const saveSessionMemoryTransaction = database.transaction(
      (input: PersistedSessionMemory): void => {
        const sessionRow = selectSession.get(input.sessionId);
        if (sessionRow === undefined) {
          throw persistenceError("SESSION_NOT_FOUND");
        }
        let sessionBefore: PersistedSession;
        try {
          sessionBefore = mapSessionRow(sessionRow, input.sessionId);
        } catch {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        const existingRow = selectSessionMemory.get(input.sessionId);
        const existing =
          existingRow === undefined
            ? undefined
            : mapSessionMemoryRow(existingRow, input.sessionId);
        const inputTimestamp = canonicalEpoch(input.updatedAt);
        const existingTimestamp =
          existing === undefined
            ? undefined
            : canonicalEpoch(existing.updatedAt);
        if (
          inputTimestamp === undefined ||
          (existing !== undefined && existingTimestamp === undefined)
        ) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        if (
          existingTimestamp !== undefined &&
          inputTimestamp < existingTimestamp
        ) {
          throw persistenceError("INVALID_EVENT_SEQUENCE");
        }

        const globalCountBefore = storedCount(selectMemoryCount.get());
        const sessionCountBefore = storedCount(
          selectSessionMemoryCount.get(input.sessionId),
        );
        const globalTimelineCountBefore = storedCount(
          selectGlobalTimelineCount.get(),
        );
        const sessionTimelineCountBefore = storedCount(
          selectSessionTimelineCount.get(input.sessionId),
        );
        const timelineRowsBefore = selectTimeline.all(input.sessionId);
        const timelineBefore = timelineRowsBefore
          .map((row) => mapTimelineRow(row, input.sessionId));
        if (
          sessionCountBefore !== (existing === undefined ? 0 : 1) ||
          timelineBefore.length !== sessionTimelineCountBefore
        ) {
          throw persistenceError("PERSISTENCE_FAILED");
        }

        const changes = upsertSessionMemory.run(input).changes;
        if (changes !== 1) {
          throw persistenceError("PERSISTENCE_FAILED");
        }

        const persistedRow = selectSessionMemory.get(input.sessionId);
        if (persistedRow === undefined) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        const persisted = mapSessionMemoryRow(
          persistedRow,
          input.sessionId,
        );
        if (!sessionMemoriesEqual(persisted, input)) {
          throw persistenceError("PERSISTENCE_FAILED");
        }

        const globalCountAfter = storedCount(selectMemoryCount.get());
        const sessionCountAfter = storedCount(
          selectSessionMemoryCount.get(input.sessionId),
        );
        const expectedDelta = existing === undefined ? 1 : 0;
        if (
          globalCountAfter !== globalCountBefore + expectedDelta ||
          sessionCountAfter !== 1
        ) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        const sessionAfterRow = selectSession.get(input.sessionId);
        if (sessionAfterRow === undefined) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        let sessionAfter: PersistedSession;
        try {
          sessionAfter = mapSessionRow(
            sessionAfterRow,
            input.sessionId,
          );
        } catch {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        const timelineRowsAfter = selectTimeline.all(input.sessionId);
        const timelineAfter = timelineRowsAfter
          .map((row) => mapTimelineRow(row, input.sessionId));
        if (
          !sessionsEqual(sessionAfter, sessionBefore) ||
          timelineAfter.length !== sessionTimelineCountBefore ||
          !storedRowsEqual(timelineRowsAfter, timelineRowsBefore) ||
          storedCount(selectGlobalTimelineCount.get()) !==
            globalTimelineCountBefore ||
          storedCount(selectSessionTimelineCount.get(input.sessionId)) !==
            sessionTimelineCountBefore
        ) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
      },
    );
    function appendEventWithinTransaction(
      event: HarnessEvent,
      recoveryApproval?: ApprovalRecord,
    ): void {
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
      if (
        event.kind === "action" &&
        selectActionId.get(event.details.actionId) !== undefined
      ) {
        throw persistenceError("DUPLICATE_RECORD");
      }
      if (recoveryApproval === undefined) {
        validateEventSequence(event, session);
      } else {
        validateRecoveryApprovalExpiration(
          event,
          session,
          recoveryApproval,
        );
      }

      const actionRowBefore = selectActionForRound.get(
        event.sessionId,
        event.round,
      );
      const actionBefore =
        actionRowBefore === undefined
          ? undefined
          : mapActionRecordRow(
              actionRowBefore,
              event.sessionId,
              event.round,
            );
      const action = actionBefore;
      if (
        recoveryApproval === undefined &&
        action === undefined &&
        (event.kind === "policy" ||
          event.kind === "tool_result" ||
          event.kind === "approval" ||
          (event.kind === "verification" && event.round > 0))
      ) {
        throw persistenceError("INVALID_EVENT_SEQUENCE");
      }

      if (event.kind === "tool_result") {
        if (action === undefined) {
          throw persistenceError("INVALID_EVENT_SEQUENCE");
        }
        if (event.details.toolKind === "apply_approved_patch") {
          if (
            action.actionKind !== "propose_patch" ||
            action.policyDecision !== "ask" ||
            approvedApproval(event.sessionId, action.actionId) === undefined
          ) {
            throw persistenceError("INVALID_EVENT_SEQUENCE");
          }
        } else if (
          action.actionKind !== event.details.toolKind ||
          action.policyDecision !== "allow"
        ) {
          throw persistenceError("INVALID_EVENT_SEQUENCE");
        }
      } else if (event.kind === "approval") {
        const approvalByIdRow = selectApprovalById.get(
          event.details.approvalId,
        );
        const approvalById =
          approvalByIdRow === undefined
            ? undefined
            : mapApprovalRecordRow(approvalByIdRow);
        if (recoveryApproval !== undefined) {
          if (
            approvalById === undefined ||
            approvalById.status !== "pending" ||
            !approvalRecordsEqual(approvalById, recoveryApproval) ||
            !approvalMetadataEqual(approvalById, event)
          ) {
            throw persistenceError("PERSISTENCE_FAILED");
          }
        } else {
          if (action === undefined) {
            throw persistenceError("INVALID_EVENT_SEQUENCE");
          }
          if (
            action.actionId !== event.details.actionId ||
            action.actionKind !== "propose_patch" ||
            action.policyDecision !== "ask"
          ) {
            throw persistenceError("INVALID_EVENT_SEQUENCE");
          }
          const approvalForActionRow = selectApprovalForAction.get(
            action.actionId,
          );
          const approvalForAction =
            approvalForActionRow === undefined
              ? undefined
              : mapApprovalRecordRow(approvalForActionRow);

          if (event.details.status === "pending") {
            if (
              approvalForAction !== undefined &&
              approvalForAction.status !== "pending"
            ) {
              throw persistenceError("INVALID_EVENT_SEQUENCE");
            }
            if (approvalById !== undefined || approvalForAction !== undefined) {
              throw persistenceError("DUPLICATE_RECORD");
            }
          } else {
            if (
              approvalById === undefined ||
              approvalForAction === undefined ||
              approvalById.approvalId !== approvalForAction.approvalId ||
              !approvalMetadataEqual(approvalById, event)
            ) {
              throw persistenceError("INVALID_EVENT_SEQUENCE");
            }
            if (approvalById.status === event.details.status) {
              throw persistenceError("DUPLICATE_RECORD");
            }
            if (approvalById.status !== "pending") {
              throw persistenceError("INVALID_EVENT_SEQUENCE");
            }
          }
        }
      } else if (event.kind === "verification" && event.round > 0) {
        if (action === undefined) {
          throw persistenceError("INVALID_EVENT_SEQUENCE");
        }
        if (
          (session.state === "running" &&
            (session.taskKind !== "test_repair" ||
              action.actionKind !== "run_verification" ||
              action.policyDecision !== "allow")) ||
          (session.state === "awaiting_approval" &&
            (action.actionKind !== "propose_patch" ||
              action.policyDecision !== "ask" ||
              approvedApproval(event.sessionId, action.actionId) ===
                undefined))
        ) {
          throw persistenceError("INVALID_EVENT_SEQUENCE");
        }
      }

      const expectedSession = expectedSessionAfterEvent(session, event);
      const expectedAction = expectedActionAfterEvent(actionBefore, event);
      const globalTimelineCountBefore = storedCount(
        selectGlobalTimelineCount.get(),
      );
      const sessionTimelineCountBefore = storedCount(
        selectSessionTimelineCount.get(event.sessionId),
      );
      const approvalCountBefore = storedCount(selectApprovalCount.get());
      const sessionApprovalCountBefore = storedCount(
        selectSessionApprovalCount.get(event.sessionId),
      );
      const verificationCountBefore = storedCount(
        selectVerificationCount.get(),
      );
      const sessionVerificationCountBefore = storedCount(
        selectSessionVerificationCount.get(event.sessionId),
      );
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
        case "approval": {
          const details = approvalRecordFromEvent(event);
          const changes =
            event.details.status === "pending"
              ? insertApproval.run(details).changes
              : updateApprovalStatus.run({
                  approvalId: event.details.approvalId,
                  actionId: event.details.actionId,
                  status: event.details.status,
                }).changes;
          if (changes !== 1) {
            throw persistenceError("PERSISTENCE_FAILED");
          }
          break;
        }
        case "verification": {
          if (
            event.round > 0 &&
            session.state === "awaiting_approval" &&
            !hasEarlierAppliedPatch(
              event.sessionId,
              event.round,
              eventId,
            )
          ) {
            throw persistenceError("INVALID_EVENT_SEQUENCE");
          }
          const verificationChanges = insertVerificationRun.run({
            eventId,
            sessionId: event.sessionId,
            round: event.round,
            commandId: event.details.commandId,
            exitCode: event.details.exitCode,
            durationMs: event.details.durationMs,
            status: event.details.status,
            timedOut: event.details.timedOut ? 1 : 0,
            summary: event.summary,
          }).changes;
          if (verificationChanges !== 1) {
            throw persistenceError("PERSISTENCE_FAILED");
          }
          if (event.round > 0) {
            const actionChanges = overwriteActionResult.run({
              resultSummary: event.summary,
              sessionId: event.sessionId,
              round: event.round,
            }).changes;
            if (actionChanges !== 1) {
              throw persistenceError("PERSISTENCE_FAILED");
            }
          }
          break;
        }
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

      const globalTimelineCountAfter = storedCount(
        selectGlobalTimelineCount.get(),
      );
      const sessionTimelineCountAfter = storedCount(
        selectSessionTimelineCount.get(event.sessionId),
      );
      if (
        globalTimelineCountAfter !== globalTimelineCountBefore + 1 ||
        sessionTimelineCountAfter !== sessionTimelineCountBefore + 1
      ) {
        throw persistenceError("PERSISTENCE_FAILED");
      }
      const approvalCountAfter = storedCount(selectApprovalCount.get());
      const sessionApprovalCountAfter = storedCount(
        selectSessionApprovalCount.get(event.sessionId),
      );
      const expectedApprovalDelta =
        event.kind === "approval" &&
        event.details.status === "pending"
          ? 1
          : 0;
      if (
        approvalCountAfter !== approvalCountBefore + expectedApprovalDelta ||
        sessionApprovalCountAfter !==
          sessionApprovalCountBefore + expectedApprovalDelta
      ) {
        throw persistenceError("PERSISTENCE_FAILED");
      }
      const verificationCountAfter = storedCount(
        selectVerificationCount.get(),
      );
      const sessionVerificationCountAfter = storedCount(
        selectSessionVerificationCount.get(event.sessionId),
      );
      const expectedVerificationDelta =
        event.kind === "verification" ? 1 : 0;
      if (
        verificationCountAfter !==
          verificationCountBefore + expectedVerificationDelta ||
        sessionVerificationCountAfter !==
          sessionVerificationCountBefore + expectedVerificationDelta
      ) {
        throw persistenceError("PERSISTENCE_FAILED");
      }

      const persistedEventRow = selectTimelineByEventId.get(eventId);
      if (persistedEventRow === undefined) {
        throw persistenceError("PERSISTENCE_FAILED");
      }
      const persistedEvent = mapTimelineRow(
        persistedEventRow,
        event.sessionId,
      );
      if (!eventsEqual(persistedEvent, event)) {
        throw persistenceError("PERSISTENCE_FAILED");
      }

      const persistedSessionRow = selectSession.get(event.sessionId);
      if (persistedSessionRow === undefined) {
        throw persistenceError("PERSISTENCE_FAILED");
      }
      let persistedSession: PersistedSession;
      try {
        persistedSession = mapSessionRow(
          persistedSessionRow,
          event.sessionId,
        );
      } catch {
        throw persistenceError("PERSISTENCE_FAILED");
      }
      if (!sessionsEqual(persistedSession, expectedSession)) {
        throw persistenceError("PERSISTENCE_FAILED");
      }

      const persistedActionRow = selectActionForRound.get(
        event.sessionId,
        event.round,
      );
      if (expectedAction === undefined) {
        if (persistedActionRow !== undefined) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
      } else {
        if (persistedActionRow === undefined) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        const persistedAction = mapActionRecordRow(
          persistedActionRow,
          event.sessionId,
          event.round,
        );
        if (!actionRecordsEqual(persistedAction, expectedAction)) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
      }

      if (event.kind === "approval") {
        const persistedApprovalRow = selectApprovalById.get(
          event.details.approvalId,
        );
        if (persistedApprovalRow === undefined) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        const persistedApproval = mapApprovalRecordRow(
          persistedApprovalRow,
        );
        if (
          !approvalRecordsEqual(
            persistedApproval,
            approvalRecordFromEvent(event),
          )
        ) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
      } else if (event.kind === "verification") {
        const persistedVerificationRow =
          selectVerificationByEventId.get(eventId);
        if (persistedVerificationRow === undefined) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        const persistedVerification = mapVerificationRecordRow(
          persistedVerificationRow,
        );
        const expectedVerification = Object.freeze({
          eventId,
          sessionId: event.sessionId,
          round: event.round,
          commandId: event.details.commandId,
          exitCode: event.details.exitCode,
          durationMs: event.details.durationMs,
          status: event.details.status,
          timedOut: event.details.timedOut,
          summary: event.summary,
        });
        if (
          !verificationRecordsEqual(
            persistedVerification,
            expectedVerification,
          )
        ) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
      }
    }
    const appendTransaction = database.transaction(
      (event: HarnessEvent): void => {
        appendEventWithinTransaction(event);
      },
    );
    const clearSessionTransaction = database.transaction(
      (sessionId: string): void => {
        assertLifecycleSchemaIntegrity();
        const changes = deleteSession.run(sessionId).changes;
        if (changes !== 0 && changes !== 1) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        const row = selectTargetRowCounts.get(
          sessionId,
          sessionId,
          sessionId,
          sessionId,
          sessionId,
          sessionId,
        );
        if (typeof row !== "object" || row === null) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
        const counts = row as Readonly<Record<string, unknown>>;
        if (
          counts.sessions !== 0 ||
          counts.timeline_events !== 0 ||
          counts.action_records !== 0 ||
          counts.approvals !== 0 ||
          counts.verification_runs !== 0 ||
          counts.session_memory !== 0
        ) {
          throw persistenceError("PERSISTENCE_FAILED");
        }
      },
    );
    const recoverInterruptedSessionsTransaction = database.transaction(
      (now: RecoveryTime): number => {
        assertLifecycleSchemaIntegrity();
        const candidates = selectInterruptedSessions.all().map((row) => {
          if (typeof row !== "object" || row === null) {
            throw persistenceError("PERSISTENCE_FAILED");
          }
          const id = (row as Readonly<Record<string, unknown>>).id;
          if (typeof id !== "string") {
            throw persistenceError("PERSISTENCE_FAILED");
          }
          try {
            return mapSessionRow(row, id);
          } catch {
            throw persistenceError("PERSISTENCE_FAILED");
          }
        });

        for (const session of candidates) {
          const updatedAt = canonicalEpoch(session.updatedAt);
          if (updatedAt === undefined) {
            throw persistenceError("PERSISTENCE_FAILED");
          }
          if (now.epoch < updatedAt) {
            throw persistenceError("INVALID_PERSISTENCE_INPUT");
          }
        }

        const recoveryEntries = candidates.map((session) => {
          const approvals = selectPendingApprovalsForSession
            .all(session.id)
            .map((row) => mapApprovalRecordRow(row));
          for (const approval of approvals) {
            if (
              approval.sessionId !== session.id ||
              approval.status !== "pending"
            ) {
              throw persistenceError("PERSISTENCE_FAILED");
            }
            assertRecoveryApprovalBinding(session, approval);
          }
          return Object.freeze({
            session,
            approvals: Object.freeze(approvals),
          });
        });

        for (const { session, approvals } of recoveryEntries) {
          for (const approval of approvals) {
            const event = validateAndRedactEvent({
              sessionId: session.id,
              round: session.round,
              kind: "approval",
              summary: APPROVAL_EXPIRED_ON_RESTART,
              occurredAt: now.iso,
              details: {
                approvalId: approval.approvalId,
                actionId: approval.actionId,
                patchHash: approval.patchHash,
                baseHash: approval.baseHash,
                status: "expired",
                createdAt: approval.createdAt,
                expiresAt: approval.expiresAt,
              },
            });
            appendEventWithinTransaction(event, approval);
          }
          const event = validateAndRedactEvent({
            sessionId: session.id,
            round: session.round,
            kind: "state",
            summary: SESSION_INTERRUPTED,
            occurredAt: now.iso,
            details: { state: "stopped" },
          });
          appendEventWithinTransaction(event);
        }
        return candidates.length;
      },
    );
    let closed = false;
    let mutationInProgress = false;

    function assertOpen(): void {
      if (closed) {
        throw persistenceError("REPOSITORY_CLOSED");
      }
    }

    function beginMutation(): void {
      if (mutationInProgress) {
        throw persistenceError("INVALID_PERSISTENCE_INPUT");
      }
      mutationInProgress = true;
    }

    function endMutation(): void {
      mutationInProgress = false;
    }

    function appendInputWhileMutating(event: HarnessEvent): void {
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

    async function createSession(
      input: CreatePersistedSessionInput,
    ): Promise<void> {
      assertOpen();
      beginMutation();
      try {
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
      } finally {
        endMutation();
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

    async function listSessions(
      input: SessionReadLimit,
    ): Promise<readonly PersistedSession[]> {
      assertOpen();
      const limit = validatedSessionReadLimit(input);
      try {
        return Object.freeze(
          selectSessions.all(limit).map(mapListedSessionRow),
        );
      } catch {
        throw persistenceError("PERSISTENCE_FAILED");
      }
    }

    async function append(event: HarnessEvent): Promise<void> {
      assertOpen();
      beginMutation();
      try {
        appendInputWhileMutating(event);
      } finally {
        endMutation();
      }
    }

    async function appendAction(input: AppendActionInput): Promise<void> {
      assertOpen();
      beginMutation();
      try {
        appendInputWhileMutating(actionEventFromInput(input));
      } finally {
        endMutation();
      }
    }

    async function saveApproval(input: SaveApprovalInput): Promise<void> {
      assertOpen();
      beginMutation();
      try {
        appendInputWhileMutating(approvalEventFromInput(input));
      } finally {
        endMutation();
      }
    }

    async function appendVerification(
      input: AppendVerificationInput,
    ): Promise<void> {
      assertOpen();
      beginMutation();
      try {
        appendInputWhileMutating(verificationEventFromInput(input));
      } finally {
        endMutation();
      }
    }

    async function saveSessionMemory(
      input: SaveSessionMemoryInput,
    ): Promise<void> {
      assertOpen();
      beginMutation();
      try {
        const validated = validatedSessionMemoryInput(input);
        try {
          saveSessionMemoryTransaction.immediate(validated);
        } catch (error) {
          if (isPersistenceError(error)) {
            throw error;
          }
          throw persistenceError("PERSISTENCE_FAILED");
        }
      } finally {
        endMutation();
      }
    }

    async function loadSessionMemory(
      sessionId: string,
    ): Promise<PersistedSessionMemory | undefined> {
      assertOpen();
      assertIdentifier(sessionId);
      try {
        if (selectSessionId.get(sessionId) === undefined) {
          return undefined;
        }
        const row = selectSessionMemory.get(sessionId);
        return row === undefined
          ? undefined
          : mapSessionMemoryRow(row, sessionId);
      } catch {
        throw persistenceError("PERSISTENCE_FAILED");
      }
    }

    async function loadTimeline(
      sessionId: string,
      input?: SessionReadLimit,
    ): Promise<readonly HarnessEvent[]> {
      assertOpen();
      assertIdentifier(sessionId);
      const limit =
        input === undefined
          ? DEFAULT_SESSION_READ_LIMIT
          : validatedSessionReadLimit(input);
      try {
        const rows = selectLimitedTimeline.all(sessionId, limit);
        return Object.freeze(
          rows.map((row) => mapTimelineRow(row, sessionId)),
        );
      } catch {
        throw persistenceError("PERSISTENCE_FAILED");
      }
    }

    async function recoverInterruptedSessions(now: number): Promise<number> {
      assertOpen();
      beginMutation();
      try {
        const validated = validatedRecoveryTime(now);
        try {
          return recoverInterruptedSessionsTransaction.immediate(validated);
        } catch (error) {
          if (isPersistenceError(error)) {
            throw error;
          }
          throw persistenceError("PERSISTENCE_FAILED");
        }
      } finally {
        endMutation();
      }
    }

    async function clearSession(sessionId: string): Promise<void> {
      assertOpen();
      beginMutation();
      try {
        assertIdentifier(sessionId);
        try {
          clearSessionTransaction.immediate(sessionId);
        } catch (error) {
          if (isPersistenceError(error)) {
            throw error;
          }
          throw persistenceError("PERSISTENCE_FAILED");
        }
      } finally {
        endMutation();
      }
    }

    function close(): void {
      if (closed) {
        return;
      }
      if (mutationInProgress) {
        throw persistenceError("INVALID_PERSISTENCE_INPUT");
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
      listSessions,
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
