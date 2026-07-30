import type { EventSink, HarnessEvent } from "../../contracts/src/index.js";

export class InMemoryEventSink implements EventSink {
  readonly #events: HarnessEvent[] = [];

  async append(event: HarnessEvent): Promise<void> {
    this.#events.push(copyEvent(event));
  }

  get events(): readonly HarnessEvent[] {
    return Object.freeze(this.#events.map(copyEvent));
  }
}

function copyEvent(event: HarnessEvent): HarnessEvent {
  const base = {
    sessionId: event.sessionId,
    round: event.round,
    summary: event.summary,
    occurredAt: event.occurredAt,
  };
  switch (event.kind) {
    case "action":
      return Object.freeze({
        ...base,
        kind: "action",
        details: Object.freeze({
          actionId: event.details.actionId,
          actionKind: event.details.actionKind,
        }),
      });
    case "policy":
      return Object.freeze({
        ...base,
        kind: "policy",
        details: Object.freeze({ decision: event.details.decision }),
      });
    case "tool_result":
      return Object.freeze({
        ...base,
        kind: "tool_result",
        details: Object.freeze({ toolKind: event.details.toolKind }),
      });
    case "verification":
      return Object.freeze({
        ...base,
        kind: "verification",
        details: Object.freeze({
          commandId: event.details.commandId,
          exitCode: event.details.exitCode,
          durationMs: event.details.durationMs,
          status: event.details.status,
          timedOut: event.details.timedOut,
        }),
      });
    case "state":
      return Object.freeze({
        ...base,
        kind: "state",
        details: Object.freeze({ state: event.details.state }),
      });
    case "approval":
      return Object.freeze({
        ...base,
        kind: "approval",
        details: Object.freeze({
          approvalId: event.details.approvalId,
          actionId: event.details.actionId,
          patchHash: event.details.patchHash,
          baseHash: event.details.baseHash,
          status: event.details.status,
          createdAt: event.details.createdAt,
          expiresAt: event.details.expiresAt,
        }),
      });
  }
}
