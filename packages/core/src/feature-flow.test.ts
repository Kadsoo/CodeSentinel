import { describe, expect, it, vi } from "vitest";
import { createPolicy, type BoundPolicy } from "../../policy/src/index.js";
import { ScriptedMockProvider } from "../../providers/src/index.js";
import type { VerificationResult } from "../../tools/src/index.js";
import { createAgentSessionController } from "./agent-loop.js";
import { InMemoryEventSink } from "./in-memory-event-sink.js";
import {
  askForPatchPolicy,
  createdFeatureSession,
  failedVerification,
  fakeTools,
  fixedNow,
  passingVerification,
  sequenceIds,
  testCommand,
} from "./test-support.js";

const baseHash = "a".repeat(64);

const testStageProposal = {
  kind: "propose_patch" as const,
  stage: "test" as const,
  path: "src/math.test.ts",
  baseHash,
  patch: "@@ -1 +1 @@\n-before\n+after\n",
  reason: "Add a regression test for the requested behavior",
};

const implementationStageProposal = {
  kind: "propose_patch" as const,
  stage: "implementation" as const,
  path: "src/math.ts",
  baseHash,
  patch: "@@ -1 +1 @@\n-before\n+after\n",
  reason: "Implement the requested behavior",
};

function createFeatureController(input: {
  provider: ScriptedMockProvider;
  verification: readonly VerificationResult[];
  policy?: BoundPolicy;
}) {
  const results = [...input.verification];
  const fake = fakeTools({
    runVerification: vi.fn(async () => results.shift() ?? passingVerification),
  });
  const controller = createAgentSessionController({
    provider: input.provider,
    policy: input.policy ?? askForPatchPolicy,
    tools: fake.tools,
    eventSink: new InMemoryEventSink(),
    now: fixedNow,
    createId: sequenceIds(),
  });

  return { controller, fake };
}

function createObservedPatchPolicy(): {
  policy: BoundPolicy;
  evaluate: ReturnType<typeof vi.fn<BoundPolicy["evaluate"]>>;
} {
  const evaluate = vi.fn<BoundPolicy["evaluate"]>((action) =>
    Object.freeze(
      action.kind === "propose_patch"
        ? { decision: "ask" as const, reason: "PATCH_REQUIRES_APPROVAL" as const }
        : { decision: "allow" as const, reason: "ALLOWED" as const },
    ),
  );
  return { policy: Object.freeze({ evaluate }), evaluate };
}

describe("AgentSessionController feature test-first flow", () => {
  it("requires acceptance criteria before a feature session calls the provider", async () => {
    const provider = new ScriptedMockProvider([]);
    const fake = fakeTools();
    const controller = createAgentSessionController({
      provider,
      policy: askForPatchPolicy,
      tools: fake.tools,
      eventSink: new InMemoryEventSink(),
      now: fixedNow,
      createId: sequenceIds(),
    });

    const result = await controller.runAgentSession({
      session: { ...createdFeatureSession(), acceptanceCriteria: "   " },
    });

    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("INVALID_SESSION_INPUT");
    expect(provider.requests).toEqual([]);
    expect(fake.runVerification).not.toHaveBeenCalled();
  });

  it("binds provider verification to the feature session command before stage validation", async () => {
    const unrelatedVerificationSecret = "feature-unrelated-verification-secret";
    const policy = createPolicy({
      workspaceRoot: "C:/workspace",
      config: {
        allowedPaths: ["src/**"],
        verificationCommands: [
          testCommand,
          { ...testCommand, id: "unrelated-check", args: ["run", "verify"] },
        ],
      },
    });
    const provider = new ScriptedMockProvider([
      { kind: "run_verification", commandId: "unrelated-check" },
    ]);
    const fake = fakeTools({
      runVerification: async (action) =>
        action.commandId === "unrelated-check"
          ? {
              ...passingVerification,
              commandId: "unrelated-check",
              summary: unrelatedVerificationSecret,
            }
          : failedVerification,
    });
    const controller = createAgentSessionController({
      provider,
      policy,
      tools: fake.tools,
      eventSink: new InMemoryEventSink(),
      now: fixedNow,
      createId: sequenceIds(),
    });

    expect(policy.evaluate({ kind: "run_verification", commandId: "unrelated-check" })).toEqual({
      decision: "allow",
      reason: "ALLOWED",
    });

    const result = await controller.runAgentSession({ session: createdFeatureSession() });

    expect(fake.runVerification).not.toHaveBeenCalled();
    expect(result.events).not.toContainEqual(expect.objectContaining({ kind: "verification" }));
    expect(result.events.map((event) => [event.kind, event.summary])).toEqual([
      ["state", "RUNNING"],
      ["action", "run_verification"],
      ["policy", "ALLOWED"],
      ["state", "POLICY_DENIED"],
    ]);
    expect(JSON.stringify(result)).not.toContain(unrelatedVerificationSecret);
    expect(result.session.state).toBe("blocked");
    expect(result.finalSummary).toBe("POLICY_DENIED");
  });

  it("keeps the feature stage gate after matching the selected verification command", async () => {
    const selectedVerificationSecret = "feature-selected-verification-secret";
    const policy = createPolicy({
      workspaceRoot: "C:/workspace",
      config: {
        allowedPaths: ["src/**"],
        verificationCommands: [testCommand],
      },
    });
    const provider = new ScriptedMockProvider([{ kind: "run_verification", commandId: "test" }]);
    const fake = fakeTools({
      runVerification: async () => ({
        ...passingVerification,
        summary: selectedVerificationSecret,
      }),
    });
    const controller = createAgentSessionController({
      provider,
      policy,
      tools: fake.tools,
      eventSink: new InMemoryEventSink(),
      now: fixedNow,
      createId: sequenceIds(),
    });

    expect(policy.evaluate({ kind: "run_verification", commandId: "test" })).toEqual({
      decision: "allow",
      reason: "ALLOWED",
    });

    const result = await controller.runAgentSession({ session: createdFeatureSession() });

    expect(result.session.round).toBe(1);
    expect(fake.runVerification).not.toHaveBeenCalled();
    expect(result.events).not.toContainEqual(expect.objectContaining({ kind: "verification" }));
    expect(JSON.stringify(result)).not.toContain(selectedVerificationSecret);
    expect(result.session.state).toBe("blocked");
    expect(result.finalSummary).toBe("FEATURE_STAGE_INVALID");
  });

  it("requires test proposal, RED, implementation proposal, and GREEN in order", async () => {
    const provider = new ScriptedMockProvider([
      testStageProposal,
      implementationStageProposal,
    ]);
    const { controller, fake } = createFeatureController({
      provider,
      verification: [failedVerification, passingVerification],
    });

    const pendingTest = await controller.runAgentSession({ session: createdFeatureSession() });

    expect(pendingTest.session.state).toBe("awaiting_approval");
    expect(pendingTest.pendingPatch?.stage).toBe("test");
    expect(provider.requests[0]?.messages.at(-1)?.content).toContain("Expected patch stage: test");

    const pendingImplementation = await controller.resolvePendingPatch({
      sessionId: pendingTest.session.id,
      approvalId: pendingTest.pendingPatch?.approvalId ?? "",
      decision: "approve",
    });

    expect(pendingImplementation.session.state).toBe("awaiting_approval");
    expect(pendingImplementation.pendingPatch?.stage).toBe("implementation");
    expect(provider.requests[1]?.messages.at(-1)?.content).toContain(
      "Expected patch stage: implementation",
    );

    const completed = await controller.resolvePendingPatch({
      sessionId: pendingImplementation.session.id,
      approvalId: pendingImplementation.pendingPatch?.approvalId ?? "",
      decision: "approve",
    });

    expect(completed.session.state).toBe("completed");
    expect(completed.finalSummary).toBe("VERIFICATION_PASSED");
    expect(fake.applyApprovedPatch).toHaveBeenCalledTimes(2);
    expect(fake.runVerification).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["repair", { ...testStageProposal, stage: "repair" as const }],
    ["implementation", implementationStageProposal],
  ] as const)(
    "rejects a %s proposal before the feature test patch reaches Policy or tools",
    async (_stage, action) => {
      const provider = new ScriptedMockProvider([action]);
      const observed = createObservedPatchPolicy();
      const { controller, fake } = createFeatureController({
        provider,
        verification: [],
        policy: observed.policy,
      });

      const result = await controller.runAgentSession({ session: createdFeatureSession() });

      expect(result.session.state).toBe("blocked");
      expect(result.finalSummary).toBe("FEATURE_STAGE_INVALID");
      expect(observed.evaluate).not.toHaveBeenCalled();
      expect(fake.runVerification).not.toHaveBeenCalled();
      expect(fake.applyApprovedPatch).not.toHaveBeenCalled();
    },
  );

  it("blocks an unexpectedly passing test patch before implementation is requested", async () => {
    const provider = new ScriptedMockProvider([testStageProposal]);
    const { controller, fake } = createFeatureController({
      provider,
      verification: [passingVerification],
    });
    const pendingTest = await controller.runAgentSession({ session: createdFeatureSession() });

    const result = await controller.resolvePendingPatch({
      sessionId: pendingTest.session.id,
      approvalId: pendingTest.pendingPatch?.approvalId ?? "",
      decision: "approve",
    });

    expect(result.session.state).toBe("blocked");
    expect(result.finalSummary).toBe("FEATURE_TEST_DID_NOT_FAIL");
    expect(provider.requests).toHaveLength(1);
    expect(fake.applyApprovedPatch).toHaveBeenCalledOnce();
    expect(fake.runVerification).toHaveBeenCalledOnce();
  });

  it.each([
    ["times out", { ...failedVerification, exitCode: null, status: "timed_out" as const, timedOut: true }],
    ["cannot start", { ...failedVerification, exitCode: null, status: "spawn_failed" as const, timedOut: false }],
  ] as const)("fails closed when the approved feature test patch %s", async (_name, verification) => {
    const provider = new ScriptedMockProvider([testStageProposal]);
    const { controller, fake } = createFeatureController({
      provider,
      verification: [verification],
    });
    const pendingTest = await controller.runAgentSession({ session: createdFeatureSession() });

    const result = await controller.resolvePendingPatch({
      sessionId: pendingTest.session.id,
      approvalId: pendingTest.pendingPatch?.approvalId ?? "",
      decision: "approve",
    });

    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("TOOL_FAILED");
    expect(provider.requests).toHaveLength(1);
    expect(fake.applyApprovedPatch).toHaveBeenCalledOnce();
    expect(fake.runVerification).toHaveBeenCalledOnce();
  });

  it.each([
    ["negative duration", { ...failedVerification, durationMs: -1 }],
    ["non-safe duration", { ...failedVerification, durationMs: Number.MAX_SAFE_INTEGER + 1 }],
    ["status/timedOut mismatch", { ...failedVerification, status: "timed_out" as const }],
    [
      "timed_out with an exit code",
      { ...failedVerification, exitCode: 1, status: "timed_out" as const, timedOut: true },
    ],
    [
      "spawn_failed with an exit code",
      { ...failedVerification, exitCode: 1, status: "spawn_failed" as const, timedOut: false },
    ],
    [
      "output_limit with an exit code",
      { ...failedVerification, exitCode: 1, status: "output_limit" as const, timedOut: false },
    ],
  ] as const)(
    "fails closed after an approved patch with %s without auditing the malformed verification",
    async (_name, verification) => {
      const provider = new ScriptedMockProvider([testStageProposal]);
      const { controller, fake } = createFeatureController({
        provider,
        verification: [verification],
      });
      const pending = await controller.runAgentSession({ session: createdFeatureSession() });

      const result = await controller.resolvePendingPatch({
        sessionId: pending.session.id,
        approvalId: pending.pendingPatch?.approvalId ?? "",
        decision: "approve",
      });

      expect(result.session.state).toBe("failed");
      expect(result.finalSummary).toBe("TOOL_FAILED");
      expect(result.events.some((event) => event.kind === "verification")).toBe(false);
      expect(fake.runVerification).toHaveBeenCalledOnce();
    },
  );

  it("preserves the three-provider-decision budget across feature approvals", async () => {
    const provider = new ScriptedMockProvider([
      testStageProposal,
      implementationStageProposal,
      implementationStageProposal,
    ]);
    const { controller, fake } = createFeatureController({
      provider,
      verification: [failedVerification, failedVerification, failedVerification],
    });

    const pendingTest = await controller.runAgentSession({ session: createdFeatureSession() });
    const firstImplementation = await controller.resolvePendingPatch({
      sessionId: pendingTest.session.id,
      approvalId: pendingTest.pendingPatch?.approvalId ?? "",
      decision: "approve",
    });
    const secondImplementation = await controller.resolvePendingPatch({
      sessionId: firstImplementation.session.id,
      approvalId: firstImplementation.pendingPatch?.approvalId ?? "",
      decision: "approve",
    });
    const result = await controller.resolvePendingPatch({
      sessionId: secondImplementation.session.id,
      approvalId: secondImplementation.pendingPatch?.approvalId ?? "",
      decision: "approve",
    });

    expect(result.session.round).toBe(3);
    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("ROUND_LIMIT_REACHED");
    expect(provider.requests).toHaveLength(3);
    expect(fake.applyApprovedPatch).toHaveBeenCalledTimes(3);
    expect(fake.runVerification).toHaveBeenCalledTimes(3);
  });
});
