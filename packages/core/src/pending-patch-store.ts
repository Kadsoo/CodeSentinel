import { createHash } from "node:crypto";
import type { Action } from "../../contracts/src/index.js";
import { createPendingApproval, type Approval } from "../../policy/src/index.js";
import type { PendingPatchView } from "./types.js";

const PENDING_PATCH_TTL_MS = 15 * 60 * 1_000;

type ProposedPatch = Extract<Action, { kind: "propose_patch" }>;

type PendingPatchRecord = Readonly<{
  action: ProposedPatch;
  approval: Approval;
  consumed: boolean;
}>;

export class PendingPatchStore {
  readonly #records = new Map<string, Map<string, PendingPatchRecord>>();

  create(input: Readonly<{
    sessionId: string;
    action: ProposedPatch;
    actionId: string;
    approvalId: string;
    now: number;
  }>): PendingPatchView {
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
    sessionRecords.set(approval.id, Object.freeze({ action, approval, consumed: false }));
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
