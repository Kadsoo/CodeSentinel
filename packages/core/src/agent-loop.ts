import { ActionSchema, type Action, type HarnessEvent } from "../../contracts/src/index.js";
import {
  approvePatch,
  rejectPatch,
  type GuardrailDecision,
} from "../../policy/src/index.js";
import { MAX_PATCH_BYTES } from "../../tools/src/index.js";
import { buildProviderRequest, sanitizeProviderFeedback, type ProviderFeedback } from "./context.js";
import { CodeSentinelCoreError } from "./errors.js";
import { PENDING_PATCH_TTL_MS, PendingPatchStore } from "./pending-patch-store.js";
import type {
  AgentLoopDependencies,
  AgentSession,
  AgentSessionController,
  AgentSessionResult,
  AgentStage,
  PendingPatchView,
  ResolvePendingPatchInput,
  SessionPhase,
  StartSessionInput,
} from "./types.js";

type SessionRecord = {
  session: AgentSession;
  phase: SessionPhase;
  feedback: ProviderFeedback[];
  events: HarnessEvent[];
  pendingApprovalId?: string;
};

type SafePolicyDecision = Readonly<{
  decision: "allow" | "ask" | "deny";
  reason: string;
}>;

type VerificationObservation = Readonly<{
  commandId: string;
  exitCode: number | null;
  status: "completed" | "timed_out" | "spawn_failed" | "output_limit";
  summary: string;
}>;

const POLICY_REASONS = new Set([
  "SENSITIVE_PATH",
  "OUTSIDE_WORKSPACE",
  "UNKNOWN_COMMAND",
  "PATCH_REQUIRES_APPROVAL",
  "ALLOWED",
]);
const MAX_LIST_RESULT_ENTRIES = 500;
const MAX_SEARCH_RESULT_MATCHES = 100;
const MAX_TOOL_FEEDBACK_ITEMS = 20;
const MAX_TOOL_FEEDBACK_FIELD_CHARACTERS = 240;
const MAX_PENDING_SESSIONS = 32;
const MAX_SESSION_IDENTIFIER_CHARACTERS = 128;
const MAX_SESSION_TEXT_CHARACTERS = 4_096;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;
const utf8Encoder = new TextEncoder();

export function createAgentSessionController(
  dependencies: AgentLoopDependencies,
): AgentSessionController {
  const sessions = new Map<string, SessionRecord>();
  const pendingPatches = new PendingPatchStore();

  async function runAgentSession(input: StartSessionInput): Promise<AgentSessionResult> {
    const session = validateStartSession(input);
    if (session === undefined || sessions.has(session.id)) {
      return invalidSessionResult();
    }

    const record: SessionRecord = {
      session,
      phase: session.taskKind === "test_repair" ? "repair" : "awaiting_test_patch",
      feedback: [],
      events: [],
    };
    sessions.set(session.id, record);

    if (session.taskKind === "test_repair") {
      return runInitialRepairVerification(record);
    }

    setState(record, "running");
    if (!(await appendEvent(record, "state", "RUNNING"))) {
      return eventSinkFailure(record);
    }
    return runProviderFeedbackCycles(record);
  }

  async function resolvePendingPatch(
    input: ResolvePendingPatchInput,
  ): Promise<AgentSessionResult> {
    if (!isResolveInput(input)) {
      throw new CodeSentinelCoreError("APPROVAL_NOT_FOUND");
    }

    const claimed = pendingPatches.claim(input.sessionId, input.approvalId);
    const record = sessions.get(input.sessionId);
    if (
      record === undefined ||
      record.session.state !== "awaiting_approval" ||
      record.pendingApprovalId !== input.approvalId
    ) {
      throw new CodeSentinelCoreError("APPROVAL_NOT_FOUND");
    }
    record.pendingApprovalId = undefined;

    let currentBaseHash: string;
    try {
      currentBaseHash = await dependencies.tools.getCurrentBaseHash(claimed.action.path);
    } catch {
      return terminal(record, "failed", "TOOL_FAILED");
    }
    if (!isSha256Hash(currentBaseHash)) {
      return terminal(record, "failed", "TOOL_FAILED");
    }

    let now: number;
    try {
      now = dependencies.now();
    } catch {
      return terminalWithoutEvent(record, "failed", "TOOL_FAILED");
    }
    if (!isSafeDateTimestamp(now)) {
      return terminalWithoutEvent(record, "failed", "TOOL_FAILED");
    }

    const approval =
      input.decision === "approve"
        ? approvePatch(claimed.approval, currentBaseHash, now)
        : rejectPatch(claimed.approval, currentBaseHash, now);
    if (approval.status === "expired") {
      const summary =
        currentBaseHash === claimed.approval.baseHash
          ? "APPROVAL_EXPIRED"
          : "APPROVAL_BASE_CHANGED";
      return stopResolvedApproval(record, summary);
    }
    if (approval.status === "rejected") {
      return stopResolvedApproval(record, "APPROVAL_REJECTED");
    }
    if (approval.status !== "approved") {
      return terminal(record, "failed", "TOOL_FAILED");
    }

    if (!(await appendEvent(record, "approval", "APPROVAL_APPROVED"))) {
      return eventSinkFailure(record);
    }

    try {
      await dependencies.tools.applyApprovedPatch({
        path: claimed.action.path,
        patch: claimed.action.patch,
        approval,
      });
    } catch {
      return terminal(record, "failed", "TOOL_FAILED");
    }
    if (!(await appendEvent(record, "tool_result", "PATCH_APPLIED"))) {
      return eventSinkFailure(record);
    }

    return verifyApprovedPatch(record);
  }

  async function stopResolvedApproval(
    record: SessionRecord,
    summary: "APPROVAL_REJECTED" | "APPROVAL_EXPIRED" | "APPROVAL_BASE_CHANGED",
  ): Promise<AgentSessionResult> {
    if (!(await appendEvent(record, "approval", summary))) {
      return eventSinkFailure(record);
    }
    return terminal(record, "stopped", summary);
  }

  async function verifyApprovedPatch(record: SessionRecord): Promise<AgentSessionResult> {
    let value: unknown;
    try {
      value = await dependencies.tools.runVerification({
        kind: "run_verification",
        commandId: record.session.verificationCommandId,
      });
    } catch {
      return terminal(record, "failed", "TOOL_FAILED");
    }

    const verification = readVerification(value, record.session.verificationCommandId);
    const summary = verification === undefined ? "TOOL_FAILED" : verification.summary;
    if (!(await appendEvent(record, "verification", summary))) {
      return eventSinkFailure(record);
    }
    if (
      verification === undefined ||
      verification.status !== "completed" ||
      verification.exitCode === null
    ) {
      return terminal(record, "failed", "TOOL_FAILED");
    }

    if (record.session.taskKind === "feature_implementation") {
      return verifyApprovedFeaturePatch(record, verification);
    }
    if (verification.exitCode === 0) {
      return terminal(record, "completed", "VERIFICATION_PASSED");
    }

    return resumeAfterFailedVerification(record, verification.summary);
  }

  async function verifyApprovedFeaturePatch(
    record: SessionRecord,
    verification: VerificationObservation,
  ): Promise<AgentSessionResult> {
    if (record.phase === "awaiting_test_patch") {
      if (verification.exitCode === 0) {
        return terminal(record, "blocked", "FEATURE_TEST_DID_NOT_FAIL");
      }
      record.phase = "awaiting_implementation_patch";
      return resumeAfterFailedVerification(record, verification.summary);
    }

    if (record.phase === "awaiting_implementation_patch") {
      if (verification.exitCode === 0) {
        return terminal(record, "completed", "VERIFICATION_PASSED");
      }
      return resumeAfterFailedVerification(record, verification.summary);
    }

    return terminal(record, "failed", "TOOL_FAILED");
  }

  async function resumeAfterFailedVerification(
    record: SessionRecord,
    summary: string,
  ): Promise<AgentSessionResult> {
    record.feedback.push(Object.freeze({ kind: "verification", summary }));
    if (record.session.round >= 3) {
      return terminal(record, "failed", "ROUND_LIMIT_REACHED");
    }

    setState(record, "running");
    if (!(await appendEvent(record, "state", "RUNNING"))) {
      return eventSinkFailure(record);
    }
    return runProviderFeedbackCycles(record);
  }

  async function runInitialRepairVerification(record: SessionRecord): Promise<AgentSessionResult> {
    let value: unknown;
    try {
      value = await dependencies.tools.runVerification({
        kind: "run_verification",
        commandId: record.session.verificationCommandId,
      });
    } catch {
      return terminal(record, "failed", "TOOL_FAILED");
    }

    const verification = readVerification(value, record.session.verificationCommandId);
    const summary = verification === undefined ? "TOOL_FAILED" : verification.summary;
    if (!(await appendEvent(record, "verification", summary))) {
      return eventSinkFailure(record);
    }
    if (verification === undefined || verification.status !== "completed") {
      return terminal(record, "failed", "TOOL_FAILED");
    }
    if (verification.exitCode === 0) {
      return terminal(record, "stopped", "NOT_REPRODUCIBLE");
    }
    if (verification.exitCode === null) {
      return terminal(record, "failed", "TOOL_FAILED");
    }

    record.feedback.push(Object.freeze({ kind: "verification", summary: verification.summary }));
    setState(record, "running");
    if (!(await appendEvent(record, "state", "RUNNING"))) {
      return eventSinkFailure(record);
    }
    return runProviderFeedbackCycles(record);
  }

  async function runProviderFeedbackCycles(record: SessionRecord): Promise<AgentSessionResult> {
    while (record.session.state === "running" && record.session.round < 3) {
      const expectedStage = expectedPatchStage(record.phase);
      if (expectedStage === undefined) {
        return terminal(record, "failed", "TOOL_FAILED");
      }
      let response: unknown;
      try {
        response = await dependencies.provider.complete(
          buildProviderRequest({
            taskSummary: record.session.taskSummary,
            phase: record.phase,
            expectedPatchStage: expectedStage,
            verificationCommandId: record.session.verificationCommandId,
            feedback: record.feedback,
          }),
        );
      } catch {
        return terminal(record, "failed", "PROVIDER_FAILED");
      }

      let parsed: ReturnType<typeof ActionSchema.safeParse>;
      try {
        parsed = ActionSchema.safeParse(response);
      } catch {
        return terminal(record, "failed", "INVALID_ACTION");
      }
      if (!parsed.success) {
        return terminal(record, "failed", "INVALID_ACTION");
      }

      incrementRound(record);
      const action = parsed.data;
      if (!(await appendEvent(record, "action", action.kind))) {
        return eventSinkFailure(record);
      }
      if (action.kind === "propose_patch" && action.stage !== expectedStage) {
        return terminal(record, "blocked", "FEATURE_STAGE_INVALID");
      }

      const policy = evaluatePolicy(action);
      if (!(await appendEvent(record, "policy", policy.reason))) {
        return eventSinkFailure(record);
      }
      if (policy.decision === "deny") {
        return terminal(record, "blocked", "POLICY_DENIED");
      }
      if (policy.decision === "ask") {
        if (action.kind !== "propose_patch") {
          return terminal(record, "blocked", "POLICY_DENIED");
        }
        return createPendingPatch(record, action);
      }
      if (action.kind === "propose_patch" || action.kind === "apply_approved_patch") {
        return terminal(record, "blocked", "POLICY_DENIED");
      }
      if (action.kind === "finish") {
        return finishFromModel(record, action);
      }
      const dispatched = await dispatchAction(record, action);
      if (dispatched !== undefined) {
        return dispatched;
      }
    }

    return terminal(record, "failed", "ROUND_LIMIT_REACHED");
  }

  function evaluatePolicy(action: Action): SafePolicyDecision {
    try {
      const evaluated = dependencies.policy.evaluate(action);
      if (!isGuardrailDecision(evaluated)) {
        return Object.freeze({ decision: "deny", reason: "POLICY_DENIED" });
      }
      if (action.kind === "apply_approved_patch") {
        return Object.freeze({ decision: "deny", reason: "PATCH_REQUIRES_APPROVAL" });
      }
      return Object.freeze({ decision: evaluated.decision, reason: evaluated.reason });
    } catch {
      return Object.freeze({ decision: "deny", reason: "POLICY_DENIED" });
    }
  }

  async function createPendingPatch(
    record: SessionRecord,
    action: Extract<Action, { kind: "propose_patch" }>,
  ): Promise<AgentSessionResult> {
    if (!isPatchWithinByteLimit(action.patch)) {
      return terminal(record, "failed", "PATCH_TOO_LARGE");
    }
    if (pendingSessionCount() >= MAX_PENDING_SESSIONS) {
      return terminal(record, "failed", "PENDING_CAPACITY_REACHED");
    }

    let view: PendingPatchView;
    try {
      const actionId = dependencies.createId();
      const approvalId = dependencies.createId();
      const now = dependencies.now();
      if (!isSafeDateTimestamp(now)) {
        return terminalWithoutEvent(record, "failed", "TOOL_FAILED");
      }
      if (!isValidPendingPatchTimestamp(now)) {
        return terminal(record, "failed", "TOOL_FAILED");
      }
      view = pendingPatches.create({
        sessionId: record.session.id,
        action,
        actionId,
        approvalId,
        now,
      });
      record.pendingApprovalId = view.approvalId;
    } catch {
      return terminal(record, "failed", "TOOL_FAILED");
    }

    setState(record, "awaiting_approval");
    if (!(await appendEvent(record, "state", "AWAITING_APPROVAL"))) {
      pendingPatches.discard(record.session.id, view.approvalId);
      record.pendingApprovalId = undefined;
      return eventSinkFailure(record);
    }
    if (!(await appendEvent(record, "approval", "APPROVAL_PENDING"))) {
      pendingPatches.discard(record.session.id, view.approvalId);
      record.pendingApprovalId = undefined;
      return eventSinkFailure(record);
    }

    return snapshot(record, "APPROVAL_PENDING", view);
  }

  async function dispatchAction(record: SessionRecord, action: Exclude<Action, {
    kind: "finish" | "propose_patch" | "apply_approved_patch";
  }>): Promise<AgentSessionResult | undefined> {
    if (action.kind === "run_verification") {
      if (action.commandId !== record.session.verificationCommandId) {
        return terminal(record, "blocked", "POLICY_DENIED");
      }
      if (record.session.taskKind === "feature_implementation") {
        return terminal(record, "blocked", "FEATURE_STAGE_INVALID");
      }
      let value: unknown;
      try {
        value = await dependencies.tools.runVerification(action);
      } catch {
        return terminal(record, "failed", "TOOL_FAILED");
      }
      const verification = readVerification(value, action.commandId);
      const summary = verification === undefined ? "TOOL_FAILED" : verification.summary;
      if (!(await appendEvent(record, "verification", summary))) {
        return eventSinkFailure(record);
      }
      if (verification === undefined || verification.status !== "completed") {
        return terminal(record, "failed", "TOOL_FAILED");
      }
      if (verification.exitCode === 0) {
        return terminal(record, "completed", "VERIFIED");
      }
      if (verification.exitCode === null) {
        return terminal(record, "failed", "TOOL_FAILED");
      }
      record.feedback.push(Object.freeze({ kind: "verification", summary: verification.summary }));
    } else {
      let feedbackSummary: string | undefined;
      try {
        switch (action.kind) {
          case "list_files": {
            feedbackSummary = summarizeListFiles(await dependencies.tools.listFiles(action));
            break;
          }
          case "read_file": {
            feedbackSummary = summarizeReadFile(await dependencies.tools.readFile(action));
            break;
          }
          case "search_text": {
            feedbackSummary = summarizeSearchText(await dependencies.tools.searchText(action));
            break;
          }
        }
      } catch {
        return terminal(record, "failed", "TOOL_FAILED");
      }
      if (feedbackSummary === undefined) {
        return terminal(record, "failed", "TOOL_FAILED");
      }
      if (!(await appendEvent(record, "tool_result", action.kind))) {
        return eventSinkFailure(record);
      }
      record.feedback.push(Object.freeze({ kind: "tool_result", summary: feedbackSummary }));
    }

    if (record.session.round >= 3) {
      return terminal(record, "failed", "ROUND_LIMIT_REACHED");
    }
    return undefined;
  }

  async function finishFromModel(
    record: SessionRecord,
    action: Extract<Action, { kind: "finish" }>,
  ): Promise<AgentSessionResult> {
    switch (action.outcome) {
      case "completed":
      case "not_reproducible":
        return terminal(record, "blocked", "VERIFICATION_REQUIRED");
      case "needs_human":
        return terminal(record, "blocked", "NEEDS_HUMAN");
      case "blocked":
        return terminal(record, "blocked", "BLOCKED");
      case "failed":
        return terminal(record, "failed", "MODEL_FAILED");
    }
  }

  async function terminal(
    record: SessionRecord,
    state: AgentSession["state"],
    summary: string,
  ): Promise<AgentSessionResult> {
    setState(record, state);
    if (!(await appendEvent(record, "state", summary))) {
      return eventSinkFailure(record);
    }
    const result = snapshot(record, summary);
    releaseTerminalRecord(record);
    return result;
  }

  function terminalWithoutEvent(
    record: SessionRecord,
    state: AgentSession["state"],
    summary: string,
  ): AgentSessionResult {
    setState(record, state);
    const result = snapshot(record, summary);
    releaseTerminalRecord(record);
    return result;
  }

  function eventSinkFailure(record: SessionRecord): AgentSessionResult {
    setState(record, "failed");
    const result = snapshot(record, "EVENT_SINK_FAILED");
    releaseTerminalRecord(record);
    return result;
  }

  function pendingSessionCount(): number {
    let count = 0;
    for (const record of sessions.values()) {
      if (record.session.state === "awaiting_approval" && record.pendingApprovalId !== undefined) {
        count += 1;
      }
    }
    return count;
  }

  function releaseTerminalRecord(record: SessionRecord): void {
    if (
      record.pendingApprovalId === undefined &&
      record.session.state !== "created" &&
      record.session.state !== "running" &&
      sessions.get(record.session.id) === record
    ) {
      sessions.delete(record.session.id);
    }
  }

  async function appendEvent(
    record: SessionRecord,
    kind: HarnessEvent["kind"],
    summary: string,
  ): Promise<boolean> {
    let event: HarnessEvent;
    try {
      event = Object.freeze({
        sessionId: record.session.id,
        round: record.session.round,
        kind,
        summary,
        occurredAt: new Date(dependencies.now()).toISOString(),
      });
      await dependencies.eventSink.append(event);
    } catch {
      return false;
    }
    record.events.push(event);
    return true;
  }

  return Object.freeze({ runAgentSession, resolvePendingPatch });
}

function validateStartSession(input: unknown): AgentSession | undefined {
  try {
    const inputRecord = asRecord(input);
    const candidate = inputRecord === undefined ? undefined : ownValue(inputRecord, "session");
    const session = asRecord(candidate);
    if (session === undefined) {
      return undefined;
    }
    const id = requiredText(session, "id", MAX_SESSION_IDENTIFIER_CHARACTERS);
    const taskKind = ownValue(session, "taskKind");
    const state = ownValue(session, "state");
    const round = ownValue(session, "round");
    const workspaceId = requiredText(session, "workspaceId", MAX_SESSION_IDENTIFIER_CHARACTERS);
    const providerId = requiredText(session, "providerId", MAX_SESSION_IDENTIFIER_CHARACTERS);
    const verificationCommandId = requiredText(
      session,
      "verificationCommandId",
      MAX_SESSION_IDENTIFIER_CHARACTERS,
    );
    const taskSummary = requiredText(session, "taskSummary", MAX_SESSION_TEXT_CHARACTERS);
    const acceptance = ownValue(session, "acceptanceCriteria");
    const validAcceptance =
      acceptance === undefined ||
      (typeof acceptance === "string" &&
        isSafeSessionText(acceptance, MAX_SESSION_TEXT_CHARACTERS));

    if (
      id === undefined ||
      workspaceId === undefined ||
      providerId === undefined ||
      verificationCommandId === undefined ||
      taskSummary === undefined ||
      (taskKind !== "test_repair" && taskKind !== "feature_implementation") ||
      state !== "created" ||
      typeof round !== "number" ||
      !Number.isInteger(round) ||
      round < 0 ||
      round > 3 ||
      !validAcceptance ||
      (taskKind === "feature_implementation" &&
        (typeof acceptance !== "string" || acceptance.trim().length === 0))
    ) {
      return undefined;
    }

    return freezeSession({
      id,
      taskKind,
      state,
      round,
      workspaceId,
      providerId,
      verificationCommandId,
      taskSummary,
      acceptanceCriteria: typeof acceptance === "string" ? acceptance : undefined,
    });
  } catch {
    return undefined;
  }
}

function requiredText(
  record: Record<string, unknown>,
  key: string,
  maximum: number,
): string | undefined {
  const value = ownValue(record, key);
  return typeof value === "string" && value.trim().length > 0 && isSafeSessionText(value, maximum)
    ? value
    : undefined;
}

function isSafeSessionText(value: string, maximum: number): boolean {
  if (value.length > maximum) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 31 || codePoint === 127 || (codePoint >= 128 && codePoint <= 159))
    ) {
      return false;
    }
  }
  return true;
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function freezeSession(session: AgentSession): AgentSession {
  const copied = {
    id: session.id,
    taskKind: session.taskKind,
    state: session.state,
    round: session.round,
    workspaceId: session.workspaceId,
    providerId: session.providerId,
    verificationCommandId: session.verificationCommandId,
    taskSummary: session.taskSummary,
    ...(session.acceptanceCriteria === undefined
      ? {}
      : { acceptanceCriteria: session.acceptanceCriteria }),
  };
  return Object.freeze(copied);
}

function setState(record: SessionRecord, state: AgentSession["state"]): void {
  record.session = freezeSession({ ...record.session, state });
}

function incrementRound(record: SessionRecord): void {
  record.session = freezeSession({ ...record.session, round: record.session.round + 1 });
}

function expectedPatchStage(phase: SessionPhase): AgentStage | undefined {
  switch (phase) {
    case "repair":
      return "repair";
    case "awaiting_test_patch":
      return "test";
    case "awaiting_implementation_patch":
      return "implementation";
    case "awaiting_red":
    case "awaiting_green":
      return undefined;
  }
}

function isGuardrailDecision(value: unknown): value is GuardrailDecision {
  const decisionRecord = asRecord(value);
  if (decisionRecord === undefined) {
    return false;
  }
  const decision = ownValue(decisionRecord, "decision");
  const reason = ownValue(decisionRecord, "reason");
  return (
    (decision === "allow" || decision === "ask" || decision === "deny") &&
    typeof reason === "string" &&
    POLICY_REASONS.has(reason)
  );
}

function readVerification(value: unknown, commandId: string): VerificationObservation | undefined {
  try {
    const result = asRecord(value);
    if (result === undefined) {
      return undefined;
    }
    const reportedCommandId = ownValue(result, "commandId");
    const exitCode = ownValue(result, "exitCode");
    const status = ownValue(result, "status");
    const timedOut = ownValue(result, "timedOut");
    const summary = ownValue(result, "summary");
    if (
      reportedCommandId !== commandId ||
      (typeof exitCode !== "number" && exitCode !== null) ||
      (typeof exitCode === "number" && !Number.isInteger(exitCode)) ||
      !isConsistentVerificationStatus(status, timedOut) ||
      typeof summary !== "string"
    ) {
      return undefined;
    }
    const sanitized = sanitizeProviderFeedback(summary);
    return Object.freeze({
      commandId: reportedCommandId,
      exitCode,
      status,
      summary: sanitized.length === 0 ? "VERIFICATION_RESULT" : sanitized,
    });
  } catch {
    return undefined;
  }
}

function summarizeListFiles(value: unknown): string | undefined {
  try {
    const result = asRecord(value);
    const entries = result === undefined ? undefined : ownValue(result, "entries");
    const truncated = result === undefined ? undefined : ownValue(result, "truncated");
    if (
      !Array.isArray(entries) ||
      entries.length > MAX_LIST_RESULT_ENTRIES ||
      typeof truncated !== "boolean"
    ) {
      return undefined;
    }

    const summaryEntries: string[] = [];
    let rawByteCount = 0;
    for (const entry of entries) {
      const item = asRecord(entry);
      const kind = item === undefined ? undefined : ownValue(item, "kind");
      const path = item === undefined ? undefined : ownValue(item, "path");
      if ((kind !== "file" && kind !== "directory") || typeof path !== "string") {
        return undefined;
      }
      const nextRawByteCount = addRawToolFeedbackBytes(rawByteCount, path);
      if (nextRawByteCount === undefined) {
        return undefined;
      }
      rawByteCount = nextRawByteCount;
      if (summaryEntries.length < MAX_TOOL_FEEDBACK_ITEMS) {
        summaryEntries.push(`${kind}: ${safeToolFeedbackField(path)}`);
      }
    }

    return summarizeToolItems("list_files", summaryEntries, entries.length, truncated);
  } catch {
    return undefined;
  }
}

function summarizeReadFile(value: unknown): string | undefined {
  if (typeof value !== "string" || utf8ByteLengthWithin(value, MAX_PATCH_BYTES) === undefined) {
    return undefined;
  }
  return sanitizeProviderFeedback(`read_file: ${value}`);
}

function summarizeSearchText(value: unknown): string | undefined {
  try {
    const result = asRecord(value);
    const matches = result === undefined ? undefined : ownValue(result, "matches");
    const truncated = result === undefined ? undefined : ownValue(result, "truncated");
    if (
      !Array.isArray(matches) ||
      matches.length > MAX_SEARCH_RESULT_MATCHES ||
      typeof truncated !== "boolean"
    ) {
      return undefined;
    }

    const summaryMatches: string[] = [];
    let rawByteCount = 0;
    for (const match of matches) {
      const item = asRecord(match);
      const path = item === undefined ? undefined : ownValue(item, "path");
      const line = item === undefined ? undefined : ownValue(item, "line");
      const snippet = item === undefined ? undefined : ownValue(item, "snippet");
      if (
        typeof path !== "string" ||
        typeof snippet !== "string" ||
        typeof line !== "number" ||
        !Number.isSafeInteger(line) ||
        line <= 0
      ) {
        return undefined;
      }
      const afterPath = addRawToolFeedbackBytes(rawByteCount, path);
      const afterSnippet =
        afterPath === undefined ? undefined : addRawToolFeedbackBytes(afterPath, snippet);
      if (afterSnippet === undefined) {
        return undefined;
      }
      rawByteCount = afterSnippet;
      if (summaryMatches.length < MAX_TOOL_FEEDBACK_ITEMS) {
        summaryMatches.push(
          `${safeToolFeedbackField(path)}:${line}: ${safeToolFeedbackField(snippet)}`,
        );
      }
    }

    return summarizeToolItems("search_text", summaryMatches, matches.length, truncated);
  } catch {
    return undefined;
  }
}

function summarizeToolItems(
  kind: "list_files" | "search_text",
  items: readonly string[],
  totalCount: number,
  truncated: boolean,
): string {
  const omitted = totalCount - items.length;
  const suffix = [
    truncated ? "truncated" : undefined,
    omitted > 0 ? `${omitted} additional results omitted` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(", ");
  const content = items.length === 0 ? "(empty)" : items.join("; ");
  return sanitizeProviderFeedback(`${kind}: ${content}${suffix.length === 0 ? "" : ` (${suffix})`}`);
}

function safeToolFeedbackField(value: string): string {
  return sanitizeProviderFeedback(value, MAX_TOOL_FEEDBACK_FIELD_CHARACTERS);
}

function isConsistentVerificationStatus(
  status: unknown,
  timedOut: unknown,
): status is VerificationObservation["status"] {
  return (
    (status === "completed" && timedOut === false) ||
    (status === "timed_out" && timedOut === true) ||
    ((status === "spawn_failed" || status === "output_limit") && timedOut === false)
  );
}

function addRawToolFeedbackBytes(total: number, value: string): number | undefined {
  const byteLength = utf8ByteLengthWithin(value, MAX_PATCH_BYTES - total);
  if (byteLength === undefined) {
    return undefined;
  }
  return total + byteLength;
}

function utf8ByteLengthWithin(value: string, maximum: number): number | undefined {
  if (maximum < 0 || value.length > maximum) {
    return undefined;
  }
  const byteLength = utf8Encoder.encode(value).byteLength;
  return byteLength <= maximum ? byteLength : undefined;
}

function isPatchWithinByteLimit(patch: string): boolean {
  return utf8ByteLengthWithin(patch, MAX_PATCH_BYTES) !== undefined;
}

function isSha256Hash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isSafeDateTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Math.abs(value) <= MAX_DATE_TIMESTAMP_MS
  );
}

function isValidPendingPatchTimestamp(value: number): boolean {
  return value <= MAX_DATE_TIMESTAMP_MS - PENDING_PATCH_TTL_MS;
}

function isResolveInput(value: unknown): value is ResolvePendingPatchInput {
  try {
    const input = asRecord(value);
    const keys = input === undefined ? [] : Reflect.ownKeys(input);
    return (
      input !== undefined &&
      (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null) &&
      keys.length === 3 &&
      keys.every(
        (key) =>
          typeof key === "string" &&
          (key === "sessionId" || key === "approvalId" || key === "decision"),
      ) &&
      requiredText(input, "sessionId", MAX_SESSION_IDENTIFIER_CHARACTERS) !== undefined &&
      requiredText(input, "approvalId", MAX_SESSION_IDENTIFIER_CHARACTERS) !== undefined &&
      (ownValue(input, "decision") === "approve" || ownValue(input, "decision") === "reject")
    );
  } catch {
    return false;
  }
}

function invalidSessionResult(): AgentSessionResult {
  return snapshot(
    {
      session: freezeSession({
        id: "invalid-session",
        taskKind: "test_repair",
        state: "failed",
        round: 0,
        workspaceId: "invalid-workspace",
        providerId: "invalid-provider",
        verificationCommandId: "invalid-command",
        taskSummary: "Invalid session input",
      }),
      events: [],
    },
    "INVALID_SESSION_INPUT",
  );
}

function snapshot(
  record: Pick<SessionRecord, "session" | "events">,
  finalSummary?: string,
  pendingPatch?: PendingPatchView,
): AgentSessionResult {
  const result: {
    session: AgentSession;
    events: readonly Readonly<HarnessEvent>[];
    finalSummary?: string;
    pendingPatch?: PendingPatchView;
  } = {
    session: freezeSession(record.session),
    events: Object.freeze(record.events.map(copyEvent)),
  };
  if (finalSummary !== undefined) {
    result.finalSummary = finalSummary;
  }
  if (pendingPatch !== undefined) {
    result.pendingPatch = copyPendingPatch(pendingPatch);
  }
  return Object.freeze(result);
}

function copyEvent(event: HarnessEvent): HarnessEvent {
  return Object.freeze({
    sessionId: event.sessionId,
    round: event.round,
    kind: event.kind,
    summary: event.summary,
    occurredAt: event.occurredAt,
  });
}

function copyPendingPatch(view: PendingPatchView): PendingPatchView {
  return Object.freeze({
    approvalId: view.approvalId,
    stage: view.stage,
    path: view.path,
    patch: view.patch,
    reason: view.reason,
  });
}
