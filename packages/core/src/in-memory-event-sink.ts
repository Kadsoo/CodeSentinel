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
  return Object.freeze({
    sessionId: event.sessionId,
    round: event.round,
    kind: event.kind,
    summary: event.summary,
    occurredAt: event.occurredAt,
  });
}
