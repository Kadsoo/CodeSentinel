import type {
  EventSink,
  HarnessEvent,
  SessionState,
  TaskKind,
} from "../../contracts/src/index.js";

export type CreatePersistedSessionInput = Readonly<{
  id: string;
  taskKind: TaskKind;
  state: "created";
  round: 0;
  workspaceId: string;
  providerId: string;
  verificationCommandId: string;
  createdAt: string;
}>;

export type PersistedSession = Readonly<{
  id: string;
  taskKind: TaskKind;
  state: SessionState;
  round: number;
  workspaceId: string;
  providerId: string;
  verificationCommandId: string;
  createdAt: string;
  updatedAt: string;
}>;

export type AppendActionInput = Readonly<{
  sessionId: string;
  round: number;
  occurredAt: string;
  actionId: string;
  actionKind: Extract<HarnessEvent, { kind: "action" }>["details"]["actionKind"];
  inputSummary: string;
}>;

export type SaveApprovalInput = Readonly<{
  sessionId: string;
  round: number;
  occurredAt: string;
  summary: string;
  details: Extract<HarnessEvent, { kind: "approval" }>["details"];
}>;

export type AppendVerificationInput = Readonly<{
  sessionId: string;
  round: number;
  occurredAt: string;
  summary: string;
  details: Extract<HarnessEvent, { kind: "verification" }>["details"];
}>;

export type SaveSessionMemoryInput = Readonly<{
  sessionId: string;
  summary: string;
  updatedAt: string;
}>;

export type PersistedSessionMemory = Readonly<{
  sessionId: string;
  summary: string;
  updatedAt: string;
}>;

export interface SessionRepository extends EventSink {
  createSession(input: CreatePersistedSessionInput): Promise<void>;
  loadSession(sessionId: string): Promise<PersistedSession | undefined>;
  appendAction(input: AppendActionInput): Promise<void>;
  saveApproval(input: SaveApprovalInput): Promise<void>;
  appendVerification(input: AppendVerificationInput): Promise<void>;
  saveSessionMemory(input: SaveSessionMemoryInput): Promise<void>;
  loadSessionMemory(sessionId: string): Promise<PersistedSessionMemory | undefined>;
  loadTimeline(sessionId: string): Promise<readonly HarnessEvent[]>;
  recoverInterruptedSessions(now: number): Promise<number>;
  clearSession(sessionId: string): Promise<void>;
  close(): void;
}
