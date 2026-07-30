import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "../../contracts/src/index.js";
import { InMemoryEventSink } from "./in-memory-event-sink.js";

describe("InMemoryEventSink", () => {
  it("retains an immutable structured action detail", async () => {
    const sink = new InMemoryEventSink();
    const event: HarnessEvent = {
      sessionId: "session-1",
      round: 1,
      kind: "action",
      summary: "read_file",
      occurredAt: "2026-07-30T00:00:00.000Z",
      details: { actionId: "action-1", actionKind: "read_file" },
    };

    await sink.append(event);
    const stored = sink.events[0];

    expect(stored).toEqual(event);
    expect(stored?.details).not.toBe(event.details);
    expect(Object.isFrozen(stored?.details)).toBe(true);
  });

  it("returns detached immutable event snapshots with no details alias", async () => {
    const sink = new InMemoryEventSink();
    const details = {
      approvalId: "approval-1",
      actionId: "action-1",
      patchHash: "a".repeat(64),
      baseHash: "b".repeat(64),
      status: "pending" as const,
      createdAt: 1,
      expiresAt: 2,
    };
    const event: HarnessEvent = {
      sessionId: "session-1",
      round: 1,
      kind: "approval",
      summary: "APPROVAL_PENDING",
      occurredAt: "2026-07-29T00:00:00.000Z",
      details,
    };

    await sink.append(event);
    details.actionId = "mutated";

    const first = sink.events;
    const second = sink.events;
    expect(first[0]?.details).toMatchObject({ actionId: "action-1" });
    expect(first[0]?.details).not.toBe(details);
    expect(second[0]?.details).not.toBe(first[0]?.details);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(Object.isFrozen(first[0]?.details)).toBe(true);
  });
});
