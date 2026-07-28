export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

const UNBOUND_APPROVAL_ID = "unbound-approval";
const UNBOUND_ACTION_ID = "unbound-action";

export type Approval = Readonly<{
  id: string;
  actionId: string;
  patchHash: string;
  baseHash: string;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
}>;

export type ApprovalMetadata = Readonly<{
  id?: string;
  actionId?: string;
  createdAt?: number;
}>;

export function createPendingApproval(
  patchHash: string,
  baseHash: string,
  expiresAt: number,
  metadata: ApprovalMetadata = {},
): Approval {
  return createApproval({
    id: metadata.id ?? UNBOUND_APPROVAL_ID,
    actionId: metadata.actionId ?? UNBOUND_ACTION_ID,
    patchHash,
    baseHash,
    status: "pending",
    createdAt: metadata.createdAt ?? 0,
    expiresAt,
  });
}

export function approvePatch(
  approval: Approval,
  currentBaseHash: string,
  now: number,
): Approval {
  if (approval.status !== "pending") {
    return copyApproval(approval);
  }

  return isStale(approval, currentBaseHash, now)
    ? copyApproval(approval, "expired")
    : copyApproval(approval, "approved");
}

/**
 * @deprecated Without a current base hash, rejection must fail closed as expired.
 * Use the three-argument overload to create a rejected approval.
 */
export function rejectPatch(approval: Approval, now: number): Approval;
export function rejectPatch(approval: Approval, currentBaseHash: string, now: number): Approval;
export function rejectPatch(
  approval: Approval,
  currentBaseHashOrNow: string | number,
  maybeNow?: number,
): Approval {
  if (approval.status !== "pending") {
    return copyApproval(approval);
  }

  if (typeof currentBaseHashOrNow !== "string") {
    return copyApproval(approval, "expired");
  }

  return isStale(approval, currentBaseHashOrNow, maybeNow)
    ? copyApproval(approval, "expired")
    : copyApproval(approval, "rejected");
}

export function expireApproval(approval: Approval, now: number): Approval {
  return approval.status === "pending" && isExpired(approval, now)
    ? copyApproval(approval, "expired")
    : copyApproval(approval);
}

function isStale(approval: Approval, currentBaseHash: string, now: number | undefined): boolean {
  return currentBaseHash !== approval.baseHash || isExpired(approval, now);
}

function isExpired(approval: Approval, now: number | undefined): boolean {
  if (typeof now !== "number" || !Number.isFinite(now)) {
    return true;
  }

  return (
    !Number.isFinite(approval.createdAt) ||
    !Number.isFinite(approval.expiresAt) ||
    approval.createdAt > approval.expiresAt ||
    now < approval.createdAt ||
    now >= approval.expiresAt
  );
}

function copyApproval(approval: Approval, status: ApprovalStatus = approval.status): Approval {
  return createApproval({
    id: approval.id,
    actionId: approval.actionId,
    patchHash: approval.patchHash,
    baseHash: approval.baseHash,
    status,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
  });
}

function createApproval(approval: Approval): Approval {
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
