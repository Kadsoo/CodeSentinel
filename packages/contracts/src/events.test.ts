import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  HarnessApprovalStatus,
  HarnessEvent,
  HarnessEventPayload,
  HarnessToolKind,
  HarnessVerificationStatus,
} from "./index.js";

describe("HarnessEvent", () => {
  it("exposes strict structured event variants and payloads", () => {
    const event: HarnessEvent = {
      sessionId: "session-1",
      round: 1,
      kind: "verification",
      summary: "verification failed",
      occurredAt: "2026-07-30T00:00:00.000Z",
      details: {
        commandId: "test",
        exitCode: 1,
        durationMs: 4,
        status: "completed",
        timedOut: false,
      },
    };
    const payload: HarnessEventPayload = {
      kind: "verification",
      summary: event.summary,
      details: event.details,
    };

    expect(payload).toEqual({
      kind: "verification",
      summary: "verification failed",
      details: {
        commandId: "test",
        exitCode: 1,
        durationMs: 4,
        status: "completed",
        timedOut: false,
      },
    });
    expectTypeOf<HarnessVerificationStatus>().toEqualTypeOf<
      "completed" | "timed_out" | "spawn_failed" | "output_limit"
    >();
    expectTypeOf<HarnessApprovalStatus>().toEqualTypeOf<
      "pending" | "approved" | "rejected" | "expired"
    >();
    expectTypeOf<HarnessToolKind>().toEqualTypeOf<
      "list_files" | "read_file" | "search_text" | "apply_approved_patch"
    >();
  });

  it("rejects undeclared detail keys at compile time", () => {
    const actionDetails: Extract<HarnessEvent, { kind: "action" }>["details"] = {
      actionId: "action-1",
      actionKind: "propose_patch",
      // @ts-expect-error patch content is not an action audit detail
      patch: "@@ forged",
    };
    const policyDetails: Extract<HarnessEvent, { kind: "policy" }>["details"] = {
      decision: "allow",
      // @ts-expect-error provider data is not a policy audit detail
      provider: "provider-1",
    };
    const toolDetails: Extract<HarnessEvent, { kind: "tool_result" }>["details"] = {
      toolKind: "read_file",
      // @ts-expect-error tool output is not a tool-result audit detail
      output: "secret output",
    };
    const verificationDetails: Extract<HarnessEvent, { kind: "verification" }>["details"] = {
      commandId: "test",
      exitCode: 1,
      durationMs: 4,
      status: "completed",
      timedOut: false,
      // @ts-expect-error filesystem paths are not verification audit details
      path: "src/private.ts",
    };
    const stateDetails: Extract<HarnessEvent, { kind: "state" }>["details"] = {
      state: "running",
      // @ts-expect-error arbitrary fields are not state audit details
      arbitrary: "extra",
    };

    expect([
      actionDetails,
      policyDetails,
      toolDetails,
      verificationDetails,
      stateDetails,
    ]).toHaveLength(5);
  });
});
