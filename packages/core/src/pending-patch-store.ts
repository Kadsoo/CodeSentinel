import { createHash } from "node:crypto";
import type { Action } from "../../contracts/src/index.js";
import { createPendingApproval, type Approval } from "../../policy/src/index.js";
import { CodeSentinelCoreError } from "./errors.js";
import type { PendingPatchView } from "./types.js";

export const PENDING_PATCH_TTL_MS = 15 * 60 * 1_000;
const MAX_CONSUMED_TOMBSTONES = 128;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

type ProposedPatch = Extract<Action, { kind: "propose_patch" }>;

type PendingPatchRecord = Readonly<{
  action: ProposedPatch;
  approval: Approval;
}>;

export type ClaimedPendingPatch = Readonly<{
  action: ProposedPatch;
  approval: Approval;
}>;

export class PendingPatchStore {
  readonly #records = new Map<string, Map<string, PendingPatchRecord>>();
  readonly #consumed = new Map<string, Set<string>>();
  readonly #consumedOrder: Array<Readonly<{ sessionId: string; approvalId: string }>> = [];

  create(input: Readonly<{
    sessionId: string;
    action: ProposedPatch;
    actionId: string;
    approvalId: string;
    now: number;
  }>): PendingPatchView {
    if (!isValidPendingPatchCreatedAt(input.now)) {
      throw new CodeSentinelCoreError("TOOL_FAILED");
    }
    const action = copyAction(input.action);
    const patchHash = createHash("sha256").update(action.patch, "utf8").digest("hex");
    const approval = createPendingApproval(
      patchHash,
      action.baseHash,
      input.now + PENDING_PATCH_TTL_MS,
      {
        id: input.approvalId,
        actionId: input.actionId,
        createdAt: input.now,
      },
    );
    let sessionRecords = this.#records.get(input.sessionId);
    if (sessionRecords === undefined) {
      sessionRecords = new Map<string, PendingPatchRecord>();
      this.#records.set(input.sessionId, sessionRecords);
    }
    sessionRecords.set(approval.id, Object.freeze({ action, approval }));
    return toView(action, approval.id);
  }

  getView(sessionId: string, approvalId: string): PendingPatchView | undefined {
    const record = this.#records.get(sessionId)?.get(approvalId);
    return record === undefined ? undefined : toView(record.action, record.approval.id);
  }

  discard(sessionId: string, approvalId: string): void {
    const sessionRecords = this.#records.get(sessionId);
    if (sessionRecords === undefined) {
      return;
    }
    sessionRecords.delete(approvalId);
    if (sessionRecords.size === 0) {
      this.#records.delete(sessionId);
    }
  }

  claim(sessionId: string, approvalId: string): ClaimedPendingPatch {
    const sessionRecords = this.#records.get(sessionId);
    const record = sessionRecords?.get(approvalId);
    if (sessionRecords === undefined || record === undefined) {
      throw new CodeSentinelCoreError(
        this.#consumed.get(sessionId)?.has(approvalId) === true
          ? "APPROVAL_ALREADY_RESOLVED"
          : "APPROVAL_NOT_FOUND",
      );
    }

    sessionRecords.delete(approvalId);
    if (sessionRecords.size === 0) {
      this.#records.delete(sessionId);
    }
    this.recordConsumption(sessionId, approvalId);
    return Object.freeze({
      action: copyAction(record.action),
      approval: copyApproval(record.approval),
    });
  }

  private recordConsumption(sessionId: string, approvalId: string): void {
    let approvals = this.#consumed.get(sessionId);
    if (approvals === undefined) {
      approvals = new Set<string>();
      this.#consumed.set(sessionId, approvals);
    }
    if (approvals.has(approvalId)) {
      return;
    }

    approvals.add(approvalId);
    this.#consumedOrder.push(Object.freeze({ sessionId, approvalId }));
    while (this.#consumedOrder.length > MAX_CONSUMED_TOMBSTONES) {
      const oldest = this.#consumedOrder.shift();
      if (oldest === undefined) {
        return;
      }
      const oldestApprovals = this.#consumed.get(oldest.sessionId);
      oldestApprovals?.delete(oldest.approvalId);
      if (oldestApprovals?.size === 0) {
        this.#consumed.delete(oldest.sessionId);
      }
    }
  }
}

function copyAction(action: ProposedPatch): ProposedPatch {
  return Object.freeze({
    kind: "propose_patch",
    path: action.path,
    baseHash: action.baseHash,
    patch: action.patch,
    reason: action.reason,
    stage: action.stage,
  });
}

function toView(action: ProposedPatch, approvalId: string): PendingPatchView {
  return Object.freeze({
    approvalId,
    stage: action.stage,
    path: action.path,
    patch: action.patch,
    reason: action.reason,
  });
}

function copyApproval(approval: Approval): Approval {
  return Object.freeze({
    id: approval.id,
    actionId: approval.actionId,
    patchHash: approval.patchHash,
    baseHash: approval.baseHash,
    status: approval.status,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
  });
}

function isValidPendingPatchCreatedAt(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= -MAX_DATE_TIMESTAMP_MS &&
    value <= MAX_DATE_TIMESTAMP_MS - PENDING_PATCH_TTL_MS
  );
}
