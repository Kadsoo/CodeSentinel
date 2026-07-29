import { vi } from "vitest";
import type { Action, VerificationCommand } from "../../contracts/src/index.js";
import type { BoundPolicy } from "../../policy/src/index.js";
import type {
  ApplyApprovedPatchResult,
  VerificationResult,
} from "../../tools/src/index.js";
import { CodeSentinelCoreError } from "./errors.js";
import type { ToolDispatcher } from "./tool-dispatcher.js";
import type { AgentSession } from "./types.js";

export const testCommand: VerificationCommand = {
  id: "test",
  launcher: "node_npm_cli",
  args: ["test"],
  timeoutMs: 1_000,
  maxOutputBytes: 1_024,
};

export const failedVerification: VerificationResult = Object.freeze({
  commandId: "test",
  exitCode: 1,
  durationMs: 4,
  timedOut: false,
  status: "completed",
  summary: "expected 2, received 1",
});

export const passingVerification: VerificationResult = Object.freeze({
  ...failedVerification,
  exitCode: 0,
  summary: "verification passed",
});

export const allowPolicy: BoundPolicy = Object.freeze({
  evaluate: () => Object.freeze({ decision: "allow", reason: "ALLOWED" }),
});

export const askForPatchPolicy: BoundPolicy = Object.freeze({
  evaluate: (action: Action) =>
    Object.freeze(
      action.kind === "propose_patch"
        ? { decision: "ask", reason: "PATCH_REQUIRES_APPROVAL" }
        : { decision: "allow", reason: "ALLOWED" },
    ),
});

export const fixedNow = (): number => Date.parse("2026-07-29T00:00:00.000Z");

export function sequenceIds(): () => string {
  let next = 0;
  return (): string => `id-${++next}`;
}

export type FakeToolOverrides = Readonly<{
  listFiles?: ToolDispatcher["listFiles"];
  readFile?: ToolDispatcher["readFile"];
  searchText?: ToolDispatcher["searchText"];
  verification?: VerificationResult;
  runVerification?: ToolDispatcher["runVerification"];
  currentBaseHash?: string;
  applyApprovedPatch?: ToolDispatcher["applyApprovedPatch"];
}>;

export function fakeTools(overrides: FakeToolOverrides = {}): {
  tools: ToolDispatcher;
  applyApprovedPatch: ReturnType<typeof vi.fn<ToolDispatcher["applyApprovedPatch"]>>;
  getCurrentBaseHash: ReturnType<typeof vi.fn<ToolDispatcher["getCurrentBaseHash"]>>;
  listFiles: ReturnType<typeof vi.fn<ToolDispatcher["listFiles"]>>;
  readFile: ReturnType<typeof vi.fn<ToolDispatcher["readFile"]>>;
  runVerification: ReturnType<typeof vi.fn<ToolDispatcher["runVerification"]>>;
  searchText: ReturnType<typeof vi.fn<ToolDispatcher["searchText"]>>;
} {
  const unsupported = async (): Promise<never> => {
    throw new CodeSentinelCoreError("UNSUPPORTED_TOOL");
  };
  const listFiles = vi.fn<ToolDispatcher["listFiles"]>(overrides.listFiles ?? unsupported);
  const readFile = vi.fn<ToolDispatcher["readFile"]>(overrides.readFile ?? unsupported);
  const searchText = vi.fn<ToolDispatcher["searchText"]>(overrides.searchText ?? unsupported);
  const runVerification = vi.fn<ToolDispatcher["runVerification"]>(
    overrides.runVerification ?? (async () => overrides.verification ?? failedVerification),
  );
  const getCurrentBaseHash = vi.fn<ToolDispatcher["getCurrentBaseHash"]>(
    async () => overrides.currentBaseHash ?? "a".repeat(64),
  );
  const applyApprovedPatch = vi.fn<ToolDispatcher["applyApprovedPatch"]>(
    overrides.applyApprovedPatch ??
      (async (input): Promise<ApplyApprovedPatchResult> =>
        Object.freeze({ path: input.path, hash: "b".repeat(64) })),
  );

  const tools: ToolDispatcher = Object.freeze({
    listFiles,
    readFile,
    searchText,
    runVerification,
    getCurrentBaseHash,
    applyApprovedPatch,
  });

  return {
    tools,
    applyApprovedPatch,
    getCurrentBaseHash,
    listFiles,
    readFile,
    runVerification,
    searchText,
  };
}

export function createdRepairSession(): AgentSession {
  return Object.freeze({
    id: "repair-session-1",
    taskKind: "test_repair",
    state: "created",
    round: 0,
    workspaceId: "workspace-1",
    providerId: "provider-1",
    verificationCommandId: "test",
    taskSummary: "Repair the selected test",
  });
}

export function createdFeatureSession(): AgentSession {
  return Object.freeze({
    id: "feature-session-1",
    taskKind: "feature_implementation",
    state: "created",
    round: 0,
    workspaceId: "workspace-1",
    providerId: "provider-1",
    verificationCommandId: "test",
    taskSummary: "Implement the selected feature",
    acceptanceCriteria: "The selected feature is implemented and verification passes.",
  });
}
