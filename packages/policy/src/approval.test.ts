import { describe, expect, it } from "vitest";
import {
  approvePatch,
  createPendingApproval,
  expireApproval,
  rejectPatch,
} from "./approval.js";

const metadata = {
  id: "approval-1",
  actionId: "action-1",
  createdAt: 100,
};

function pendingApproval(expiresAt = 1_000) {
  return createPendingApproval("patch-a", "base-a", expiresAt, metadata);
}

describe("approval state machine", () => {
  it("expires approval when the current base hash changes", () => {
    const approval = createPendingApproval("patch-a", "base-a", 1_000);

    expect(approvePatch(approval, "base-b", 500)).toMatchObject({ status: "expired" });
  });

  it("approves only the matching patch and base hash", () => {
    const approval = createPendingApproval("patch-a", "base-a", 1_000);

    expect(approvePatch(approval, "base-a", 500)).toMatchObject({ status: "approved" });
  });

  it("uses an inclusive expiry boundary for pending approvals", () => {
    expect(approvePatch(pendingApproval(), "base-a", 999)).toMatchObject({ status: "approved" });
    expect(approvePatch(pendingApproval(), "base-a", 1_000)).toMatchObject({ status: "expired" });
    expect(rejectPatch(pendingApproval(), "base-a", 1_000)).toMatchObject({ status: "expired" });
  });

  it("expires before its explicit creation time", () => {
    const approval = createPendingApproval("patch-a", "base-a", 2_000, {
      ...metadata,
      createdAt: 1_000,
    });

    expect(approvePatch(approval, "base-a", 999)).toMatchObject({ status: "expired" });
    expect(rejectPatch(approval, "base-a", 999)).toMatchObject({ status: "expired" });
  });

  it("expires instead of rejecting a stale pending approval", () => {
    expect(rejectPatch(pendingApproval(), "base-b", 500)).toMatchObject({ status: "expired" });
  });

  it("fails closed when rejection has no current base hash", () => {
    expect(rejectPatch(pendingApproval(), 500)).toMatchObject({ status: "expired" });
  });

  it("never approves when a timestamp is non-finite", () => {
    for (const now of [Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
      expect(approvePatch(pendingApproval(), "base-a", now)).toMatchObject({ status: "expired" });
    }

    expect(
      approvePatch(createPendingApproval("patch-a", "base-a", Number.POSITIVE_INFINITY), "base-a", 500),
    ).toMatchObject({ status: "expired" });
  });

  it("never approves a rejected approval", () => {
    const rejected = rejectPatch(pendingApproval(), "base-a", 500);

    expect(rejected).toMatchObject({ status: "rejected" });
    expect(approvePatch(rejected, "base-a", 500)).toEqual(rejected);
    expect(rejectPatch(rejected, "base-a", 500)).toEqual(rejected);
    expect(expireApproval(rejected, 1_000)).toEqual(rejected);
  });

  it("never approves an expired approval", () => {
    const expired = expireApproval(pendingApproval(), 1_000);

    expect(expired).toMatchObject({ status: "expired" });
    expect(approvePatch(expired, "base-a", 500)).toEqual(expired);
    expect(rejectPatch(expired, "base-a", 500)).toEqual(expired);
    expect(expireApproval(expired, 1_000)).toEqual(expired);
  });

  it("keeps approved approvals terminal", () => {
    const approved = approvePatch(pendingApproval(), "base-a", 500);

    expect(approved).toMatchObject({ status: "approved" });
    expect(approvePatch(approved, "base-b", 1_000)).toEqual(approved);
    expect(rejectPatch(approved, "base-b", 1_000)).toEqual(approved);
    expect(expireApproval(approved, 1_000)).toEqual(approved);
  });

  it("binds metadata and identity to the approval record", () => {
    const approval = pendingApproval();

    expect(approval).toEqual({
      id: "approval-1",
      actionId: "action-1",
      patchHash: "patch-a",
      baseHash: "base-a",
      status: "pending",
      createdAt: 100,
      expiresAt: 1_000,
    });
    expect(approvePatch(approval, "base-a", 500)).toMatchObject({
      id: "approval-1",
      actionId: "action-1",
      createdAt: 100,
      expiresAt: 1_000,
    });
  });

  it("uses deterministic unbound metadata for three-argument compatibility", () => {
    const first = createPendingApproval("patch-a", "base-a", 1_000);
    const second = createPendingApproval("patch-a", "base-a", 1_000);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      id: "unbound-approval",
      actionId: "unbound-action",
      createdAt: 0,
      status: "pending",
    });
  });

  it("returns frozen records without freezing or mutating the input", () => {
    const input = {
      id: "approval-input",
      actionId: "action-input",
      patchHash: "patch-a",
      baseHash: "base-a",
      status: "pending" as const,
      createdAt: 100,
      expiresAt: 1_000,
    };
    const original = { ...input };

    const updated = approvePatch(input, "base-a", 500);

    expect(input).toEqual(original);
    expect(Object.isFrozen(input)).toBe(false);
    expect(updated).not.toBe(input);
    expect(Object.isFrozen(updated)).toBe(true);
    expect(Object.isFrozen(pendingApproval())).toBe(true);
  });

  it("preserves the original patch and base bindings in every transition", () => {
    const approval = pendingApproval();
    const transitions = [
      approvePatch(approval, "base-a", 500),
      approvePatch(approval, "base-b", 500),
      rejectPatch(approval, "base-a", 500),
      expireApproval(approval, 1_000),
    ];

    for (const transition of transitions) {
      expect(transition).toMatchObject({ patchHash: "patch-a", baseHash: "base-a" });
    }
  });
});
