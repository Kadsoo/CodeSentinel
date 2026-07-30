import type { Action, PolicyDecision, SessionState } from "./action.js";

export type HarnessVerificationStatus =
  | "completed"
  | "timed_out"
  | "spawn_failed"
  | "output_limit";
export type HarnessApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type HarnessToolKind =
  | "list_files"
  | "read_file"
  | "search_text"
  | "apply_approved_patch";

export type EventBase = Readonly<{
  sessionId: string;
  round: number;
  summary: string;
  occurredAt: string;
}>;

export type HarnessEvent =
  | (EventBase &
      Readonly<{
        kind: "action";
        details: Readonly<{ actionId: string; actionKind: Action["kind"] }>;
      }>)
  | (EventBase &
      Readonly<{
        kind: "policy";
        details: Readonly<{ decision: PolicyDecision }>;
      }>)
  | (EventBase &
      Readonly<{
        kind: "tool_result";
        details: Readonly<{ toolKind: HarnessToolKind }>;
      }>)
  | (EventBase &
      Readonly<{
        kind: "verification";
        details: Readonly<{
          commandId: string;
          exitCode: number | null;
          durationMs: number;
          status: HarnessVerificationStatus;
          timedOut: boolean;
        }>;
      }>)
  | (EventBase &
      Readonly<{
        kind: "state";
        details: Readonly<{ state: SessionState }>;
      }>)
  | (EventBase &
      Readonly<{
        kind: "approval";
        details: Readonly<{
          approvalId: string;
          actionId: string;
          patchHash: string;
          baseHash: string;
          status: HarnessApprovalStatus;
          createdAt: number;
          expiresAt: number;
        }>;
      }>);

type WithoutEventEnvelope<T> = T extends HarnessEvent
  ? Omit<T, "sessionId" | "round" | "occurredAt">
  : never;

export type HarnessEventPayload = WithoutEventEnvelope<HarnessEvent>;

export interface EventSink {
  append(event: HarnessEvent): Promise<void>;
}
