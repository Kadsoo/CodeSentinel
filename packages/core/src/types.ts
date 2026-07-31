import type { EventSink, HarnessEvent, SessionState, TaskKind } from "../../contracts/src/index.js";
import type { BoundPolicy } from "../../policy/src/index.js";
import type { Provider } from "../../providers/src/index.js";
import type { ToolDispatcher } from "./tool-dispatcher.js";

export type AgentStage = "repair" | "test" | "implementation";

export type SessionPhase =
  | "repair"
  | "awaiting_test_patch"
  | "awaiting_red"
  | "awaiting_implementation_patch"
  | "awaiting_green";

export type AgentSession = Readonly<{
  id: string;
  taskKind: TaskKind;
  state: SessionState;
  round: number;
  workspaceId: string;
  providerId: string;
  verificationCommandId: string;
  taskSummary: string;
  acceptanceCriteria?: string;
}>;

export type PendingPatchView = Readonly<{
  approvalId: string;
  stage: AgentStage;
  path: string;
  patch: string;
  reason: string;
}>;

export type StartSessionInput = Readonly<{
  session: AgentSession;
}>;

export type ResolvePendingPatchInput = Readonly<{
  sessionId: string;
  approvalId: string;
  decision: "approve" | "reject";
}>;

export type AgentSessionResult = Readonly<{
  session: AgentSession;
  events: readonly Readonly<HarnessEvent>[];
  finalSummary?: string;
  pendingPatch?: PendingPatchView;
}>;

export type StopProbe = (sessionId: string) => boolean;

export type AgentLoopDependencies = Readonly<{
  provider: Provider;
  policy: BoundPolicy;
  tools: ToolDispatcher;
  eventSink: EventSink;
  now: () => number;
  createId: () => string;
  shouldStop?: StopProbe;
}>;

export interface AgentSessionController {
  runAgentSession(input: StartSessionInput): Promise<AgentSessionResult>;
  resolvePendingPatch(input: ResolvePendingPatchInput): Promise<AgentSessionResult>;
}
