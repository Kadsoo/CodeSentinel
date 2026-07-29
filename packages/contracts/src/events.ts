export type HarnessEvent = {
  sessionId: string;
  round: number;
  kind: "action" | "policy" | "tool_result" | "verification" | "state" | "approval";
  summary: string;
  occurredAt: string;
};

export interface EventSink {
  append(event: HarnessEvent): Promise<void>;
}
