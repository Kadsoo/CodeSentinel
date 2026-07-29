import { describe, expect, it, vi } from "vitest";
import type { EventSink, HarnessEvent } from "../../contracts/src/index.js";
import { ScriptedMockProvider } from "../../providers/src/index.js";
import { CodeSentinelToolError } from "../../tools/src/index.js";
import { createAgentSessionController } from "./agent-loop.js";
import { InMemoryEventSink } from "./in-memory-event-sink.js";
import { PendingPatchStore } from "./pending-patch-store.js";
import {
  askForPatchPolicy,
  createdRepairSession,
  failedVerification,
  fakeTools,
  fixedNow,
  passingVerification,
  sequenceIds,
} from "./test-support.js";
import type { ToolDispatcher } from "./tool-dispatcher.js";

const originalPatch = "@@ -1 +1 @@\n-export const add = () => 0;\n+export const add = () => 2;";

function createControllerThatProposesPatch(
  overrides: Parameters<typeof fakeTools>[0] = {},
) {
  let verificationCalls = 0;
  const fake = fakeTools({
    currentBaseHash: "a".repeat(64),
    runVerification: async () => {
      verificationCalls += 1;
      return verificationCalls === 1 ? failedVerification : passingVerification;
    },
    ...overrides,
  });
  const provider = new ScriptedMockProvider([
    {
      kind: "propose_patch",
      stage: "repair",
      path: "src/math.ts",
      baseHash: "a".repeat(64),
      patch: originalPatch,
      reason: "Fix incorrect addition",
    },
  ]);
  const eventSink = new InMemoryEventSink();
  return {
    fake,
    provider,
    eventSink,
    controller: createAgentSessionController({
      provider,
      policy: askForPatchPolicy,
      tools: fake.tools,
      eventSink,
      now: fixedNow,
      createId: sequenceIds(),
    }),
  };
}

describe("AgentSessionController trusted approval resume", () => {
  it("fails before retaining a patch whose fifteen-minute expiry exceeds the Date range", async () => {
    const applyApprovedPatch = vi.fn<ToolDispatcher["applyApprovedPatch"]>();
    const fake = fakeTools({ verification: failedVerification, applyApprovedPatch });
    const provider = new ScriptedMockProvider([
      {
        kind: "propose_patch",
        stage: "repair",
        path: "src/math.ts",
        baseHash: "a".repeat(64),
        patch: originalPatch,
        reason: "Fix incorrect addition",
      },
    ]);
    const controller = createAgentSessionController({
      provider,
      policy: askForPatchPolicy,
      tools: fake.tools,
      eventSink: new InMemoryEventSink(),
      now: () => 8_640_000_000_000_000,
      createId: sequenceIds(),
    });

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("TOOL_FAILED");
    expect(result.pendingPatch).toBeUndefined();
    expect(applyApprovedPatch).not.toHaveBeenCalled();
    expect(provider.requests).toHaveLength(1);
  });

  it("returns a frozen pending view without applying an unapproved patch", async () => {
    const applyApprovedPatch = vi.fn<ToolDispatcher["applyApprovedPatch"]>();
    const { controller } = createControllerThatProposesPatch({ applyApprovedPatch });

    const pending = await controller.runAgentSession({ session: createdRepairSession() });

    expect(pending.session.state).toBe("awaiting_approval");
    expect(pending.pendingPatch).toMatchObject({
      stage: "repair",
      path: "src/math.ts",
      patch: originalPatch,
    });
    expect(Object.isFrozen(pending.pendingPatch)).toBe(true);
    expect(applyApprovedPatch).not.toHaveBeenCalled();
  });

  it("uses only the stored patch, applies it once, and verifies afterward", async () => {
    const applyApprovedPatch = vi.fn<ToolDispatcher["applyApprovedPatch"]>(
      async (input) => Object.freeze({ path: input.path, hash: "b".repeat(64) }),
    );
    const { controller, eventSink } = createControllerThatProposesPatch({ applyApprovedPatch });

    const pending = await controller.runAgentSession({ session: createdRepairSession() });
    const result = await controller.resolvePendingPatch({
      sessionId: pending.session.id,
      approvalId: pending.pendingPatch?.approvalId ?? "",
      decision: "approve",
    });

    expect(applyApprovedPatch).toHaveBeenCalledOnce();
    expect(applyApprovedPatch.mock.calls[0]?.[0]).toMatchObject({
      path: "src/math.ts",
      patch: originalPatch,
    });
    expect(result.session.state).toBe("completed");
    expect(result.finalSummary).toBe("VERIFICATION_PASSED");
    expect(eventSink.events.map((event) => event.kind)).toEqual([
      "verification",
      "state",
      "action",
      "policy",
      "state",
      "approval",
      "approval",
      "tool_result",
      "verification",
      "state",
    ]);
  });

  it("stops a rejection and consumes the approval so it cannot be replayed", async () => {
    const applyApprovedPatch = vi.fn<ToolDispatcher["applyApprovedPatch"]>();
    const { controller } = createControllerThatProposesPatch({ applyApprovedPatch });
    const pending = await controller.runAgentSession({ session: createdRepairSession() });
    const input = {
      sessionId: pending.session.id,
      approvalId: pending.pendingPatch?.approvalId ?? "",
      decision: "reject" as const,
    };

    const result = await controller.resolvePendingPatch(input);

    expect(result.session.state).toBe("stopped");
    expect(result.finalSummary).toBe("APPROVAL_REJECTED");
    await expect(controller.resolvePendingPatch({ ...input, decision: "approve" })).rejects.toMatchObject({
      code: "APPROVAL_ALREADY_RESOLVED",
    });
    expect(applyApprovedPatch).not.toHaveBeenCalled();
  });

  it("stops without writing when the stored base hash has changed", async () => {
    const applyApprovedPatch = vi.fn<ToolDispatcher["applyApprovedPatch"]>();
    const { controller } = createControllerThatProposesPatch({
      applyApprovedPatch,
      currentBaseHash: "b".repeat(64),
    });
    const pending = await controller.runAgentSession({ session: createdRepairSession() });

    const result = await controller.resolvePendingPatch({
      sessionId: pending.session.id,
      approvalId: pending.pendingPatch?.approvalId ?? "",
      decision: "approve",
    });

    expect(result.session.state).toBe("stopped");
    expect(result.finalSummary).toBe("APPROVAL_BASE_CHANGED");
    expect(applyApprovedPatch).not.toHaveBeenCalled();
  });

  it("rejects malformed or extra resolver fields without consuming the pending patch", async () => {
    const applyApprovedPatch = vi.fn<ToolDispatcher["applyApprovedPatch"]>(
      async (input) => Object.freeze({ path: input.path, hash: "b".repeat(64) }),
    );
    const { controller } = createControllerThatProposesPatch({ applyApprovedPatch });
    const pending = await controller.runAgentSession({ session: createdRepairSession() });
    const validInput = {
      sessionId: pending.session.id,
      approvalId: pending.pendingPatch?.approvalId ?? "",
      decision: "approve" as const,
    };

    await expect(
      controller.resolvePendingPatch({
        ...validInput,
        path: "src/forged.ts",
        patch: "@@ -1 +1 @@\n-before\n+forged",
        baseHash: "c".repeat(64),
        actionId: "forged-action",
      } as unknown as Parameters<typeof controller.resolvePendingPatch>[0]),
    ).rejects.toMatchObject({ code: "APPROVAL_NOT_FOUND" });
    await expect(
      controller.resolvePendingPatch({
        ...validInput,
        sessionId: `${validInput.sessionId}\u0000`,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_NOT_FOUND" });
    expect(applyApprovedPatch).not.toHaveBeenCalled();

    const result = await controller.resolvePendingPatch(validInput);
    expect(result.finalSummary).toBe("VERIFICATION_PASSED");
    expect(applyApprovedPatch).toHaveBeenCalledOnce();
  });

  it.each([
    ["NaN", Number.NaN],
    ["a finite timestamp outside the Date range", 8_640_000_000_000_001],
  ] as const)("fails closed with TOOL_FAILED when the injected clock becomes %s", async (_name, untrustedNow) => {
    let now = fixedNow();
    const applyApprovedPatch = vi.fn<ToolDispatcher["applyApprovedPatch"]>();
    const fake = fakeTools({
      currentBaseHash: "a".repeat(64),
      runVerification: async () => failedVerification,
      applyApprovedPatch,
    });
    const provider = new ScriptedMockProvider([
      {
        kind: "propose_patch",
        stage: "repair",
        path: "src/math.ts",
        baseHash: "a".repeat(64),
        patch: originalPatch,
        reason: "Fix incorrect addition",
      },
    ]);
    const controller = createAgentSessionController({
      provider,
      policy: askForPatchPolicy,
      tools: fake.tools,
      eventSink: new InMemoryEventSink(),
      now: () => now,
      createId: sequenceIds(),
    });
    const pending = await controller.runAgentSession({ session: createdRepairSession() });
    now = untrustedNow;
    const input = {
      sessionId: pending.session.id,
      approvalId: pending.pendingPatch?.approvalId ?? "",
      decision: "approve" as const,
    };

    const result = await controller.resolvePendingPatch(input);

    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("TOOL_FAILED");
    expect(applyApprovedPatch).not.toHaveBeenCalled();
    await expect(controller.resolvePendingPatch(input)).rejects.toMatchObject({
      code: "APPROVAL_ALREADY_RESOLVED",
    });
  });

  it("does not consume or write a pending patch for a wrong session or approval ID", async () => {
    const applyApprovedPatch = vi.fn<ToolDispatcher["applyApprovedPatch"]>(
      async (input) => Object.freeze({ path: input.path, hash: "b".repeat(64) }),
    );
    const { controller } = createControllerThatProposesPatch({ applyApprovedPatch });
    const pending = await controller.runAgentSession({ session: createdRepairSession() });
    const approvalId = pending.pendingPatch?.approvalId ?? "";

    await expect(
      controller.resolvePendingPatch({
        sessionId: "other-session",
        approvalId,
        decision: "approve",
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_NOT_FOUND" });
    await expect(
      controller.resolvePendingPatch({
        sessionId: pending.session.id,
        approvalId: "other-approval",
        decision: "approve",
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_NOT_FOUND" });
    expect(applyApprovedPatch).not.toHaveBeenCalled();

    const result = await controller.resolvePendingPatch({
      sessionId: pending.session.id,
      approvalId,
      decision: "approve",
    });
    expect(result.finalSummary).toBe("VERIFICATION_PASSED");
    expect(applyApprovedPatch).toHaveBeenCalledOnce();
  });

  it("expires a pending patch after fifteen minutes without writing it", async () => {
    let now = fixedNow();
    const applyApprovedPatch = vi.fn<ToolDispatcher["applyApprovedPatch"]>();
    const fake = fakeTools({
      currentBaseHash: "a".repeat(64),
      runVerification: async () => failedVerification,
      applyApprovedPatch,
    });
    const provider = new ScriptedMockProvider([
      {
        kind: "propose_patch",
        stage: "repair",
        path: "src/math.ts",
        baseHash: "a".repeat(64),
        patch: originalPatch,
        reason: "Fix incorrect addition",
      },
    ]);
    const eventSink = new InMemoryEventSink();
    const controller = createAgentSessionController({
      provider,
      policy: askForPatchPolicy,
      tools: fake.tools,
      eventSink,
      now: () => now,
      createId: sequenceIds(),
    });
    const pending = await controller.runAgentSession({ session: createdRepairSession() });
    now += 15 * 60 * 1_000;

    const result = await controller.resolvePendingPatch({
      sessionId: pending.session.id,
      approvalId: pending.pendingPatch?.approvalId ?? "",
      decision: "approve",
    });

    expect(result.session.state).toBe("stopped");
    expect(result.finalSummary).toBe("APPROVAL_EXPIRED");
    expect(applyApprovedPatch).not.toHaveBeenCalled();
    expect(eventSink.events.map((event) => event.summary)).toContain("APPROVAL_EXPIRED");
  });

  it.each([
    ["hash tool throws", async (): Promise<string> => {
      throw new Error("hash-tool-secret");
    }],
    ["hash tool returns a non-hash", async (): Promise<string> => "not-a-hash"],
  ] as const)("fails closed after %s and consumes the record", async (_name, getCurrentBaseHash) => {
    const applyApprovedPatch = vi.fn<ToolDispatcher["applyApprovedPatch"]>();
    const { controller, fake, provider } = createControllerThatProposesPatch({ applyApprovedPatch });
    fake.getCurrentBaseHash.mockImplementation(getCurrentBaseHash);
    const pending = await controller.runAgentSession({ session: createdRepairSession() });
    const input = {
      sessionId: pending.session.id,
      approvalId: pending.pendingPatch?.approvalId ?? "",
      decision: "approve" as const,
    };

    const result = await controller.resolvePendingPatch(input);

    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("TOOL_FAILED");
    expect(applyApprovedPatch).not.toHaveBeenCalled();
    expect(provider.requests).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("hash-tool-secret");
    await expect(controller.resolvePendingPatch(input)).rejects.toMatchObject({
      code: "APPROVAL_ALREADY_RESOLVED",
    });
  });

  it("does not write if the approved audit event cannot be persisted", async () => {
    const events: HarnessEvent[] = [];
    const append = vi.fn<EventSink["append"]>(async (event) => {
      if (event.kind === "approval" && event.summary === "APPROVAL_APPROVED") {
        throw new Error("approval-event-secret");
      }
      events.push(Object.freeze({ ...event }));
    });
    const eventSink: EventSink = Object.freeze({ append });
    const applyApprovedPatch = vi.fn<ToolDispatcher["applyApprovedPatch"]>();
    const fake = fakeTools({
      currentBaseHash: "a".repeat(64),
      runVerification: async () => failedVerification,
      applyApprovedPatch,
    });
    const provider = new ScriptedMockProvider([
      {
        kind: "propose_patch",
        stage: "repair",
        path: "src/math.ts",
        baseHash: "a".repeat(64),
        patch: originalPatch,
        reason: "Fix incorrect addition",
      },
    ]);
    const controller = createAgentSessionController({
      provider,
      policy: askForPatchPolicy,
      tools: fake.tools,
      eventSink,
      now: fixedNow,
      createId: sequenceIds(),
    });
    const pending = await controller.runAgentSession({ session: createdRepairSession() });
    const input = {
      sessionId: pending.session.id,
      approvalId: pending.pendingPatch?.approvalId ?? "",
      decision: "approve" as const,
    };

    const result = await controller.resolvePendingPatch(input);

    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("EVENT_SINK_FAILED");
    expect(events.map((event) => event.summary)).toContain("APPROVAL_PENDING");
    expect(events.map((event) => event.summary)).not.toContain("APPROVAL_APPROVED");
    expect(applyApprovedPatch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("approval-event-secret");
    await expect(controller.resolvePendingPatch(input)).rejects.toMatchObject({
      code: "APPROVAL_ALREADY_RESOLVED",
    });
  });

  it.each([
    ["BASE_HASH_MISMATCH", () => new CodeSentinelToolError("BASE_HASH_MISMATCH")],
    ["PATCH_HASH_MISMATCH", () => new CodeSentinelToolError("PATCH_HASH_MISMATCH")],
    ["PATCH_NOT_APPLICABLE", () => new CodeSentinelToolError("PATCH_NOT_APPLICABLE")],
    ["unexpected error", () => new Error("apply-tool-secret")],
  ] as const)(
    "fails closed and permanently consumes the claim when apply returns %s",
    async (_name, createError) => {
      const applyApprovedPatch = vi.fn<ToolDispatcher["applyApprovedPatch"]>(async () => {
        throw createError();
      });
      const { controller, provider } = createControllerThatProposesPatch({ applyApprovedPatch });
      const pending = await controller.runAgentSession({ session: createdRepairSession() });
      const input = {
        sessionId: pending.session.id,
        approvalId: pending.pendingPatch?.approvalId ?? "",
        decision: "approve" as const,
      };

      const result = await controller.resolvePendingPatch(input);

      expect(result.session.state).toBe("failed");
      expect(result.finalSummary).toBe("TOOL_FAILED");
      expect(applyApprovedPatch).toHaveBeenCalledOnce();
      expect(provider.requests).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("apply-tool-secret");
      await expect(controller.resolvePendingPatch(input)).rejects.toMatchObject({
        code: "APPROVAL_ALREADY_RESOLVED",
      });
    },
  );

  it("atomically lets only one concurrent approval claim reach the write tool", async () => {
    const applyApprovedPatch = vi.fn<ToolDispatcher["applyApprovedPatch"]>(
      async (input) => Object.freeze({ path: input.path, hash: "b".repeat(64) }),
    );
    const { controller, fake } = createControllerThatProposesPatch({ applyApprovedPatch });
    const pending = await controller.runAgentSession({ session: createdRepairSession() });
    let releaseHash: ((hash: string) => void) | undefined;
    const delayedHash = new Promise<string>((resolve) => {
      releaseHash = resolve;
    });
    fake.getCurrentBaseHash.mockImplementation(async () => delayedHash);
    const input = {
      sessionId: pending.session.id,
      approvalId: pending.pendingPatch?.approvalId ?? "",
      decision: "approve" as const,
    };

    const first = controller.resolvePendingPatch(input);
    await vi.waitFor(() => expect(fake.getCurrentBaseHash).toHaveBeenCalledOnce());
    await expect(controller.resolvePendingPatch(input)).rejects.toMatchObject({
      code: "APPROVAL_ALREADY_RESOLVED",
    });
    releaseHash?.("a".repeat(64));

    const result = await first;
    expect(result.finalSummary).toBe("VERIFICATION_PASSED");
    expect(applyApprovedPatch).toHaveBeenCalledOnce();
  });

  it("feeds a redacted failed post-approval verification into the next provider decision", async () => {
    const verificationSecret = "post-approval-secret";
    let verificationCalls = 0;
    const provider = new ScriptedMockProvider([
      {
        kind: "propose_patch",
        stage: "repair",
        path: "src/math.ts",
        baseHash: "a".repeat(64),
        patch: originalPatch,
        reason: "Fix incorrect addition",
      },
      { kind: "finish", outcome: "needs_human", summary: "Review the new failure" },
    ]);
    const applyApprovedPatch = vi.fn<ToolDispatcher["applyApprovedPatch"]>(
      async (input) => Object.freeze({ path: input.path, hash: "b".repeat(64) }),
    );
    const fake = fakeTools({
      currentBaseHash: "a".repeat(64),
      applyApprovedPatch,
      runVerification: async () => {
        verificationCalls += 1;
        return verificationCalls === 1
          ? failedVerification
          : {
              ...failedVerification,
              summary: `post approval verification failed token=${verificationSecret}`,
            };
      },
    });
    const controller = createAgentSessionController({
      provider,
      policy: askForPatchPolicy,
      tools: fake.tools,
      eventSink: new InMemoryEventSink(),
      now: fixedNow,
      createId: sequenceIds(),
    });
    const pending = await controller.runAgentSession({ session: createdRepairSession() });

    const result = await controller.resolvePendingPatch({
      sessionId: pending.session.id,
      approvalId: pending.pendingPatch?.approvalId ?? "",
      decision: "approve",
    });

    expect(result.session.state).toBe("blocked");
    expect(result.finalSummary).toBe("NEEDS_HUMAN");
    expect(provider.requests).toHaveLength(2);
    const nextRequest = provider.requests[1]?.messages.at(-1)?.content ?? "";
    expect(nextRequest).toContain("post approval verification failed");
    expect(nextRequest).not.toContain(verificationSecret);
    expect(JSON.stringify(result)).not.toContain(verificationSecret);
    expect(applyApprovedPatch).toHaveBeenCalledOnce();
  });

  it("does not request a fourth provider decision after a third-round approved patch fails verification", async () => {
    const provider = new ScriptedMockProvider([
      {
        kind: "propose_patch",
        stage: "repair",
        path: "src/math.ts",
        baseHash: "a".repeat(64),
        patch: originalPatch,
        reason: "Fix incorrect addition",
      },
    ]);
    const applyApprovedPatch = vi.fn<ToolDispatcher["applyApprovedPatch"]>(
      async (input) => Object.freeze({ path: input.path, hash: "b".repeat(64) }),
    );
    const fake = fakeTools({
      currentBaseHash: "a".repeat(64),
      applyApprovedPatch,
      runVerification: async () => failedVerification,
    });
    const controller = createAgentSessionController({
      provider,
      policy: askForPatchPolicy,
      tools: fake.tools,
      eventSink: new InMemoryEventSink(),
      now: fixedNow,
      createId: sequenceIds(),
    });
    const pending = await controller.runAgentSession({
      session: { ...createdRepairSession(), id: "third-round-session", round: 2 },
    });

    const result = await controller.resolvePendingPatch({
      sessionId: pending.session.id,
      approvalId: pending.pendingPatch?.approvalId ?? "",
      decision: "approve",
    });

    expect(result.session.round).toBe(3);
    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("ROUND_LIMIT_REACHED");
    expect(provider.requests).toHaveLength(1);
    expect(applyApprovedPatch).toHaveBeenCalledOnce();
  });

  it("bounds consumed replay tombstones without retaining an unbounded replay set", () => {
    const store = new PendingPatchStore();
    const action = {
      kind: "propose_patch" as const,
      stage: "repair" as const,
      path: "src/math.ts",
      baseHash: "a".repeat(64),
      patch: originalPatch,
      reason: "Fix incorrect addition",
    };

    for (let index = 0; index <= 128; index += 1) {
      const approvalId = `approval-${index}`;
      store.create({
        sessionId: `session-${index}`,
        action,
        actionId: `action-${index}`,
        approvalId,
        now: fixedNow(),
      });
      store.claim(`session-${index}`, approvalId);
    }

    expect(() => store.claim("session-0", "approval-0")).toThrow("APPROVAL_NOT_FOUND");
    expect(() => store.claim("session-128", "approval-128")).toThrow(
      "APPROVAL_ALREADY_RESOLVED",
    );
  });
});
