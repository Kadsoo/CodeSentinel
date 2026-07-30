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
});
