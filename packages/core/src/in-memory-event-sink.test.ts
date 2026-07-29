import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "../../contracts/src/index.js";
import { InMemoryEventSink } from "./in-memory-event-sink.js";

describe("InMemoryEventSink", () => {
  it("returns immutable event snapshots", async () => {
    const sink = new InMemoryEventSink();
    const event: HarnessEvent = {
      sessionId: "session-1",
      round: 0,
      kind: "approval",
      summary: "APPROVAL_PENDING",
      occurredAt: "2026-07-29T00:00:00.000Z",
    };

    await sink.append(event);
    event.summary = "mutated";

    const events = sink.events;
    expect(events).toEqual([{ ...event, summary: "APPROVAL_PENDING" }]);
    expect(Object.isFrozen(events)).toBe(true);
    expect(Object.isFrozen(events[0])).toBe(true);
  });
});
