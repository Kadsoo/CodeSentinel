import {
  createId as createContractId,
  type EventSink,
  type HarnessEvent,
  type SessionState,
  type TaskKind,
} from "../../contracts/src/index.js";
import type {
  AgentSession,
  AgentSessionController,
  AgentSessionResult,
  ResolvePendingPatchInput,
  StopProbe,
} from "../../core/src/index.js";
import type {
  CreatePersistedSessionInput,
  PersistedSession,
  SessionReadLimit,
  SessionRepository,
} from "../../persistence/src/index.js";
import type { CredentialStore } from "../../providers/src/index.js";
import { createWorkspaceRuntime, type WorkspaceRuntime } from "./runtime.js";
import { createWorkspaceConfigLoader, type LoadedWorkspace, type WorkspaceConfigLoader } from "./workspace-config.js";
import { hostError, HostError } from "./errors.js";
import type { ProfileStore } from "./profile-store.js";

const MAX_SESSION_TEXT_CHARACTERS = 4_096;
const MAX_SESSION_IDENTIFIER_CHARACTERS = 128;
const MAX_LIST_LIMIT = 500;

export type CreateLocalSessionInput = Readonly<{
  workspacePath: string;
  taskKind: TaskKind;
  verificationCommandId: string;
  taskSummary: string;
  acceptanceCriteria?: string;
}>;

export type CreatedLocalSession = Readonly<{
  sessionId: string;
  state: "created";
}>;

export type SessionRuntimeFactory = (
  input: Readonly<{
    workspace: LoadedWorkspace;
    verificationCommandId: string;
  }>,
  dependencies: Readonly<{
    shouldStop: StopProbe;
  }>,
) => Promise<WorkspaceRuntime>;

export type SessionServiceDependencies = Readonly<{
  repository: SessionRepository;
  workspaceLoader?: WorkspaceConfigLoader;
  profileStore?: ProfileStore;
  credentialStore?: CredentialStore;
  now?: () => number;
  createId?: () => string;
  runtimeFactory?: SessionRuntimeFactory;
}>;

export interface SessionService {
  create(input: CreateLocalSessionInput): Promise<CreatedLocalSession>;
  get(sessionId: string): Promise<PersistedSession | undefined>;
  list(limit: number): Promise<readonly PersistedSession[]>;
  timeline(sessionId: string, limit: number): Promise<readonly HarnessEvent[]>;
  resolveApproval(input: ResolvePendingPatchInput): Promise<void>;
  stop(input: Readonly<{ sessionId: string }>): Promise<"accepted" | "already_stopped">;
  recover(): Promise<number>;
}

type RuntimeRecord = {
  readonly id: string;
  readonly controller: AgentSessionController;
  readonly session: AgentSession;
  state: SessionState;
  round: number;
  stopRequested: boolean;
  operation: "approval" | undefined;
};

type SessionServiceState = {
  active: RuntimeRecord | undefined;
};

export function createSessionService(
  dependencies: SessionServiceDependencies,
): SessionService {
  const repository = validateRepository(dependencies.repository);
  const workspaceLoader = dependencies.workspaceLoader ?? createWorkspaceConfigLoader();
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.createId ?? createContractId;
  const state: SessionServiceState = { active: undefined };
  const runExclusive = createMutex();
  const runtimeFactory = dependencies.runtimeFactory ?? createDefaultRuntimeFactory(dependencies, repository, now, createId);

  async function create(input: CreateLocalSessionInput): Promise<CreatedLocalSession> {
    return runExclusive(async () => {
      const request = validateCreateInput(input);
      await recoverLocked();
      if (hasActiveSession(state.active)) {
        throw hostError("SESSION_ACTIVE");
      }
      if (await hasPersistedActiveSession(repository)) {
        throw hostError("SESSION_ACTIVE");
      }

      const workspace = await loadWorkspace(workspaceLoader, request.workspacePath);
      const id = readIdentifier(createId());
      const shouldStop: StopProbe = (sessionId) =>
        state.active?.id === sessionId && state.active.stopRequested;
      const runtime = await createRuntime(runtimeFactory, workspace, request.verificationCommandId, shouldStop);
      const createdAt = readTimestamp(now());
      const persisted: CreatePersistedSessionInput = Object.freeze({
        id,
        taskKind: request.taskKind,
        state: "created",
        round: 0,
        workspaceId: runtime.workspaceId,
        providerId: runtime.profile.id,
        verificationCommandId: request.verificationCommandId,
        createdAt: new Date(createdAt).toISOString(),
      });

      // The durable row is written before the in-memory controller is started.
      await persistCreated(repository, persisted);

      const session: AgentSession = Object.freeze({
        id,
        taskKind: request.taskKind,
        state: "created",
        round: 0,
        workspaceId: runtime.workspaceId,
        providerId: runtime.profile.id,
        verificationCommandId: request.verificationCommandId,
        taskSummary: request.taskSummary,
        ...(request.acceptanceCriteria === undefined
          ? {}
          : { acceptanceCriteria: request.acceptanceCriteria }),
      });
      const record: RuntimeRecord = {
        id,
        controller: runtime.controller,
        session,
        state: "created",
        round: 0,
        stopRequested: false,
        operation: undefined,
      };
      state.active = record;

      launch(record);
      return Object.freeze({ sessionId: id, state: "created" as const });
    });
  }

  async function get(sessionId: string): Promise<PersistedSession | undefined> {
    const id = readIdentifier(sessionId);
    try {
      return await repository.loadSession(id);
    } catch {
      throw hostError("STATE_UNAVAILABLE");
    }
  }

  async function list(limit: number): Promise<readonly PersistedSession[]> {
    const input = readLimit(limit);
    try {
      return await repository.listSessions(input);
    } catch {
      throw hostError("STATE_UNAVAILABLE");
    }
  }

  async function timeline(sessionId: string, limit: number): Promise<readonly HarnessEvent[]> {
    const id = readIdentifier(sessionId);
    const input = readLimit(limit);
    try {
      return await repository.loadTimeline(id, input);
    } catch {
      throw hostError("STATE_UNAVAILABLE");
    }
  }

  async function resolveApproval(input: ResolvePendingPatchInput): Promise<void> {
    const request = validateApprovalInput(input);
    let record: RuntimeRecord;
    await runExclusive(async () => {
      const active = state.active;
      if (active === undefined || active.id !== request.sessionId || active.state !== "awaiting_approval") {
        throw hostError("SESSION_NOT_ACTIVE");
      }
      if (active.operation !== undefined) {
        throw hostError("SESSION_NOT_ACTIVE");
      }
      active.operation = "approval";
      record = active;
    });

    let result: AgentSessionResult;
    try {
      result = await record!.controller.resolvePendingPatch(request);
    } catch (error) {
      if (isCoreApprovalError(error)) {
        await clearOperation(record!);
        throw hostError("APPROVAL_NOT_FOUND");
      }
      await finishOperation(record!, undefined);
      throw hostError("STATE_UNAVAILABLE");
    }
    await finishOperation(record!, result);
  }

  async function stop(
    input: Readonly<{ sessionId: string }>,
  ): Promise<"accepted" | "already_stopped"> {
    const id = readIdentifier(input?.sessionId);
    return runExclusive(async () => {
      const active = state.active;
      if (active !== undefined && active.id === id) {
        if (active.stopRequested) {
          return "already_stopped";
        }
        active.stopRequested = true;
        if (active.state === "awaiting_approval" && active.operation === undefined) {
          await appendStoppedEvent(repository, active.id, active.round, now);
          active.state = "stopped";
          state.active = undefined;
        }
        return "accepted";
      }

      const persisted = await loadSession(repository, id);
      if (persisted === undefined) {
        throw hostError("SESSION_NOT_FOUND");
      }
      if (persisted.state === "stopped" || isTerminal(persisted.state)) {
        return "already_stopped";
      }
      throw hostError("SESSION_NOT_ACTIVE");
    });
  }

  async function recover(): Promise<number> {
    return runExclusive(recoverLocked);
  }

  async function recoverLocked(): Promise<number> {
    if (hasActiveSession(state.active)) {
      return 0;
    }
    const epoch = readTimestamp(now());
    try {
      return await repository.recoverInterruptedSessions(epoch);
    } catch {
      throw hostError("STATE_UNAVAILABLE");
    }
  }

  function launch(record: RuntimeRecord): void {
    let running: Promise<AgentSessionResult>;
    try {
      running = Promise.resolve(
        record.controller.runAgentSession({ session: record.session }),
      );
    } catch {
      void failRuntime(record);
      return;
    }
    void running.then(
      (result) => finishOperation(record, result),
      () => failRuntime(record),
    );
  }

  async function finishOperation(
    record: RuntimeRecord,
    result: AgentSessionResult | undefined,
  ): Promise<void> {
    await runExclusive(async () => {
      if (state.active !== record) {
        return;
      }
      record.operation = undefined;
      if (result !== undefined) {
        record.state = result.session.state;
        record.round = result.session.round;
      }
      if (result === undefined || isTerminal(record.state)) {
        state.active = undefined;
      }
    });
  }

  async function failRuntime(record: RuntimeRecord): Promise<void> {
    await runExclusive(async () => {
      if (state.active !== record) {
        return;
      }
      record.operation = undefined;
      try {
        await appendStoppedOrFailedEvent(repository, record, now);
      } catch {
        // A failed background runtime must never surface an unhandled rejection.
      }
      state.active = undefined;
    });
  }

  async function clearOperation(record: RuntimeRecord): Promise<void> {
    await runExclusive(async () => {
      if (state.active === record) {
        record.operation = undefined;
      }
    });
  }

  return Object.freeze({ create, get, list, timeline, resolveApproval, stop, recover });
}

function createDefaultRuntimeFactory(
  dependencies: SessionServiceDependencies,
  repository: SessionRepository,
  now: () => number,
  createId: () => string,
): SessionRuntimeFactory {
  if (dependencies.profileStore === undefined || dependencies.credentialStore === undefined) {
    return async () => {
      throw hostError("STATE_UNAVAILABLE");
    };
  }
  return (input, runtimeDependencies) =>
    createWorkspaceRuntime(input, {
      profileStore: dependencies.profileStore!,
      credentialStore: dependencies.credentialStore!,
      repository,
      now,
      createId,
      shouldStop: runtimeDependencies.shouldStop,
    });
}

function validateRepository(repository: SessionRepository): SessionRepository {
  if (
    typeof repository !== "object" ||
    repository === null ||
    typeof repository.createSession !== "function" ||
    typeof repository.loadSession !== "function" ||
    typeof repository.listSessions !== "function" ||
    typeof repository.loadTimeline !== "function" ||
    typeof repository.recoverInterruptedSessions !== "function" ||
    typeof repository.append !== "function"
  ) {
    throw hostError("STATE_UNAVAILABLE");
  }
  return repository;
}

function validateCreateInput(input: CreateLocalSessionInput): CreateLocalSessionInput {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.workspacePath !== "string" ||
    input.workspacePath.trim().length === 0 ||
    input.workspacePath.includes("\u0000") ||
    (input.taskKind !== "test_repair" && input.taskKind !== "feature_implementation") ||
    !isSafeText(input.verificationCommandId, MAX_SESSION_IDENTIFIER_CHARACTERS) ||
    !isSafeText(input.taskSummary, MAX_SESSION_TEXT_CHARACTERS) ||
    (input.acceptanceCriteria !== undefined &&
      !isSafeText(input.acceptanceCriteria, MAX_SESSION_TEXT_CHARACTERS)) ||
    (input.taskKind === "feature_implementation" && input.acceptanceCriteria === undefined)
  ) {
    throw hostError("CONFIG_INVALID");
  }
  return Object.freeze({
    workspacePath: input.workspacePath,
    taskKind: input.taskKind,
    verificationCommandId: input.verificationCommandId,
    taskSummary: input.taskSummary,
    ...(input.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: input.acceptanceCriteria }),
  });
}

function validateApprovalInput(input: ResolvePendingPatchInput): ResolvePendingPatchInput {
  if (
    typeof input !== "object" ||
    input === null ||
    !isSafeText(input.sessionId, MAX_SESSION_IDENTIFIER_CHARACTERS) ||
    !isSafeText(input.approvalId, MAX_SESSION_IDENTIFIER_CHARACTERS) ||
    (input.decision !== "approve" && input.decision !== "reject")
  ) {
    throw hostError("APPROVAL_NOT_FOUND");
  }
  return Object.freeze({
    sessionId: input.sessionId,
    approvalId: input.approvalId,
    decision: input.decision,
  });
}

function readIdentifier(value: unknown): string {
  if (!isSafeText(value, MAX_SESSION_IDENTIFIER_CHARACTERS)) {
    throw hostError("SESSION_NOT_FOUND");
  }
  return value;
}

function readLimit(value: unknown): SessionReadLimit {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw hostError("CONFIG_INVALID");
  }
  return Object.freeze({ limit: value });
}

function readTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw hostError("STATE_UNAVAILABLE");
  }
  return value;
}

function isSafeText(value: unknown, max: number): value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127 || (codePoint >= 128 && codePoint <= 159))) {
      return false;
    }
  }
  return true;
}

async function loadWorkspace(loader: WorkspaceConfigLoader, workspacePath: string): Promise<LoadedWorkspace> {
  try {
    return await loader.load({ workspacePath });
  } catch (error) {
    if (error instanceof HostError) {
      throw error;
    }
    throw hostError("WORKSPACE_INVALID");
  }
}

async function createRuntime(
  factory: SessionRuntimeFactory,
  workspace: LoadedWorkspace,
  verificationCommandId: string,
  shouldStop: StopProbe,
): Promise<WorkspaceRuntime> {
  try {
    const runtime = await factory({ workspace, verificationCommandId }, { shouldStop });
    if (
      typeof runtime !== "object" ||
      runtime === null ||
      typeof runtime.workspaceId !== "string" ||
      typeof runtime.profile?.id !== "string" ||
      typeof runtime.controller?.runAgentSession !== "function" ||
      typeof runtime.controller?.resolvePendingPatch !== "function"
    ) {
      throw hostError("STATE_UNAVAILABLE");
    }
    return runtime;
  } catch (error) {
    if (error instanceof HostError) {
      throw error;
    }
    throw hostError("STATE_UNAVAILABLE");
  }
}

async function persistCreated(
  repository: SessionRepository,
  input: CreatePersistedSessionInput,
): Promise<void> {
  try {
    await repository.createSession(input);
  } catch {
    throw hostError("STATE_UNAVAILABLE");
  }
}

async function loadSession(repository: SessionRepository, id: string): Promise<PersistedSession | undefined> {
  try {
    return await repository.loadSession(id);
  } catch {
    throw hostError("STATE_UNAVAILABLE");
  }
}

async function hasPersistedActiveSession(repository: SessionRepository): Promise<boolean> {
  try {
    const sessions = await repository.listSessions({ limit: MAX_LIST_LIMIT });
    return sessions.some((session) => !isTerminal(session.state));
  } catch {
    throw hostError("STATE_UNAVAILABLE");
  }
}

async function appendStoppedEvent(
  repository: EventSink,
  sessionId: string,
  round: number,
  now: () => number,
): Promise<void> {
  const timestamp = readTimestamp(now());
  await repository.append(Object.freeze({
    sessionId,
    round,
    kind: "state",
    summary: "STOP_REQUESTED",
    occurredAt: new Date(timestamp).toISOString(),
    details: Object.freeze({ state: "stopped" }),
  }));
}

async function appendStoppedOrFailedEvent(
  repository: EventSink,
  record: RuntimeRecord,
  now: () => number,
): Promise<void> {
  const timestamp = readTimestamp(now());
  await repository.append(Object.freeze({
    sessionId: record.id,
    round: record.round,
    kind: "state",
    summary: "RUNTIME_FAILED",
    occurredAt: new Date(timestamp).toISOString(),
    details: Object.freeze({ state: "failed" }),
  }));
}

function hasActiveSession(record: RuntimeRecord | undefined): boolean {
  return record !== undefined && !isTerminal(record.state);
}

function isTerminal(state: SessionState): boolean {
  return state === "completed" || state === "blocked" || state === "failed" || state === "stopped";
}

function isCoreApprovalError(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error.code === "APPROVAL_NOT_FOUND" || error.code === "APPROVAL_ALREADY_RESOLVED");
}

function createMutex(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail = Promise.resolve();
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
}
