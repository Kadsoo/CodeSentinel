import { describe, expect, it, vi } from "vitest";
import type { EventSink, HarnessEvent } from "../../contracts/src/index.js";
import type { BoundPolicy } from "../../policy/src/index.js";
import { ScriptedMockProvider, type Provider } from "../../providers/src/index.js";
import { MAX_PATCH_BYTES } from "../../tools/src/index.js";
import { createAgentSessionController } from "./agent-loop.js";
import { InMemoryEventSink } from "./in-memory-event-sink.js";
import {
  allowPolicy,
  askForPatchPolicy,
  createdFeatureSession,
  createdRepairSession,
  failedVerification,
  fakeTools,
  fixedNow,
  passingVerification,
  sequenceIds,
} from "./test-support.js";

function createController(
  provider: ScriptedMockProvider,
  tools: ReturnType<typeof fakeTools>["tools"],
  options: Readonly<{ policy?: BoundPolicy; eventSink?: EventSink }> = {},
) {
  return createAgentSessionController({
    provider,
    policy: options.policy ?? allowPolicy,
    tools,
    eventSink: options.eventSink ?? new InMemoryEventSink(),
    now: fixedNow,
    createId: sequenceIds(),
  });
}

function createThrowingProvider(message: string): {
  provider: Provider;
  complete: ReturnType<typeof vi.fn<Provider["complete"]>>;
} {
  const complete = vi.fn<Provider["complete"]>(async () => {
    throw new Error(message);
  });

  return { provider: { complete }, complete };
}

function createDenyPolicy(): {
  policy: BoundPolicy;
  evaluate: ReturnType<typeof vi.fn<BoundPolicy["evaluate"]>>;
} {
  const evaluate = vi.fn<BoundPolicy["evaluate"]>(() =>
    Object.freeze({ decision: "deny" as const, reason: "OUTSIDE_WORKSPACE" as const }),
  );
  return { policy: Object.freeze({ evaluate }), evaluate };
}

function createFailingEventSink(kind: HarnessEvent["kind"]): {
  eventSink: EventSink;
  append: ReturnType<typeof vi.fn<EventSink["append"]>>;
} {
  const append = vi.fn<EventSink["append"]>(async (event) => {
    if (event.kind === kind) {
      throw new Error("event-sink-secret");
    }
  });
  return { eventSink: { append }, append };
}

function repairPatch(stage: "repair" | "test" | "implementation" = "repair") {
  return {
    kind: "propose_patch" as const,
    path: "src/math.ts",
    baseHash: "a".repeat(64),
    patch: "@@ -1 +1 @@\n-before\n+after\n",
    reason: "Fix the selected failure",
    stage,
  };
}

function multibyteToolOutputOverByteLimit(): string {
  const value = "中".repeat(Math.floor(MAX_PATCH_BYTES / 3) + 1);
  expect(value.length).toBeLessThan(MAX_PATCH_BYTES);
  expect(new TextEncoder().encode(value).byteLength).toBeGreaterThan(MAX_PATCH_BYTES);
  return value;
}

describe("AgentSessionController initial reproduction and bounded feedback", () => {
  it("stops a passing initial repair verification without calling the provider", async () => {
    const provider = new ScriptedMockProvider([]);
    const fake = fakeTools({ verification: passingVerification });
    const controller = createController(provider, fake.tools);

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("stopped");
    expect(result.finalSummary).toBe("NOT_REPRODUCIBLE");
    expect(provider.requests).toEqual([]);
    expect(fake.runVerification).toHaveBeenCalledExactlyOnceWith({
      kind: "run_verification",
      commandId: "test",
    });
    expect(fake.applyApprovedPatch).not.toHaveBeenCalled();
    expect(result.events).toEqual([
      {
        sessionId: "repair-session-1",
        round: 0,
        kind: "verification",
        summary: "verification passed",
        occurredAt: "2026-07-29T00:00:00.000Z",
      },
      {
        sessionId: "repair-session-1",
        round: 0,
        kind: "state",
        summary: "NOT_REPRODUCIBLE",
        occurredAt: "2026-07-29T00:00:00.000Z",
      },
    ]);
  });

  it("fails closed on an initial completed verification with inconsistent timedOut", async () => {
    const provider = new ScriptedMockProvider([]);
    const fake = fakeTools({ verification: { ...passingVerification, timedOut: true } });
    const controller = createController(provider, fake.tools);

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("TOOL_FAILED");
    expect(provider.requests).toEqual([]);
    expect(fake.runVerification).toHaveBeenCalledTimes(1);
  });

  it("puts failed initial verification feedback into the first provider request", async () => {
    const verificationSecret = "initial-verification-secret";
    const provider = new ScriptedMockProvider([
      { kind: "finish", outcome: "needs_human", summary: "inspect the failure" },
    ]);
    const fake = fakeTools({
      verification: { ...failedVerification, summary: `expected 2, received 1 token=${verificationSecret}` },
    });
    const controller = createController(provider, fake.tools);

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(provider.requests).toHaveLength(1);
    const content = provider.requests[0]?.messages.at(-1)?.content ?? "";
    expect(content).toContain("expected 2, received 1");
    expect(content).not.toContain(verificationSecret);
    expect(JSON.stringify(result)).not.toContain(verificationSecret);
    expect(fake.runVerification).toHaveBeenCalledTimes(1);
  });

  it("stops after exactly three unsuccessful provider decisions", async () => {
    const provider = new ScriptedMockProvider([
      { kind: "run_verification", commandId: "test" },
      { kind: "run_verification", commandId: "test" },
      { kind: "run_verification", commandId: "test" },
    ]);
    const fake = fakeTools({ verification: failedVerification });
    const controller = createController(provider, fake.tools);

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.round).toBe(3);
    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("ROUND_LIMIT_REACHED");
    expect(provider.requests).toHaveLength(3);
    expect(fake.runVerification).toHaveBeenCalledTimes(4);
  });

  it("fails closed on an inconsistent timedOut loop verification without another provider request", async () => {
    let verificationCalls = 0;
    const provider = new ScriptedMockProvider([
      { kind: "run_verification", commandId: "test" },
      { kind: "finish", outcome: "needs_human", summary: "must not be requested" },
    ]);
    const fake = fakeTools({
      runVerification: async () => {
        verificationCalls += 1;
        return verificationCalls === 1
          ? failedVerification
          : { ...passingVerification, timedOut: true };
      },
    });
    const controller = createController(provider, fake.tools);

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("TOOL_FAILED");
    expect(provider.requests).toHaveLength(1);
    expect(fake.runVerification).toHaveBeenCalledTimes(2);
  });

  it("feeds bounded, redacted list entries into the next provider request", async () => {
    const secret = "list-secret-value";
    const provider = new ScriptedMockProvider([
      { kind: "list_files", path: "src", depth: 1 },
      { kind: "finish", outcome: "needs_human", summary: "stop" },
    ]);
    const fake = fakeTools({
      verification: failedVerification,
      listFiles: async () =>
        Object.freeze({
          entries: Object.freeze([
            Object.freeze({ kind: "file" as const, path: "src/public.ts" }),
            Object.freeze({ kind: "file" as const, path: `src/token=${secret}.ts` }),
          ]),
          truncated: false,
        }),
    });
    const controller = createController(provider, fake.tools);

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    const secondRequest = provider.requests[1]?.messages.at(-1)?.content ?? "";
    expect(secondRequest).toContain("src/public.ts");
    expect(secondRequest).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.events.find((event) => event.kind === "tool_result")?.summary).toBe("list_files");
  });

  it("feeds bounded, redacted file text into the next provider request", async () => {
    const secret = "read-secret-value";
    const provider = new ScriptedMockProvider([
      { kind: "read_file", path: "src/public.ts" },
      { kind: "finish", outcome: "needs_human", summary: "stop" },
    ]);
    const fake = fakeTools({
      verification: failedVerification,
      readFile: async () => `export const usefulRead = true;\ntoken=${secret}`,
    });
    const controller = createController(provider, fake.tools);

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    const secondRequest = provider.requests[1]?.messages.at(-1)?.content ?? "";
    expect(secondRequest).toContain("usefulRead");
    expect(secondRequest).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.events.find((event) => event.kind === "tool_result")?.summary).toBe("read_file");
  });

  it("feeds bounded, redacted search matches into the next provider request", async () => {
    const secret = "search-secret-value";
    const provider = new ScriptedMockProvider([
      { kind: "search_text", path: "src", query: "needle", maxResults: 1 },
      { kind: "finish", outcome: "needs_human", summary: "stop" },
    ]);
    const fake = fakeTools({
      verification: failedVerification,
      searchText: async () =>
        Object.freeze({
          matches: Object.freeze([
            Object.freeze({
              path: "src/search.ts",
              line: 4,
              snippet: `matching snippet Bearer ${secret}`,
            }),
          ]),
          truncated: false,
        }),
    });
    const controller = createController(provider, fake.tools);

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    const secondRequest = provider.requests[1]?.messages.at(-1)?.content ?? "";
    expect(secondRequest).toContain("src/search.ts");
    expect(secondRequest).toContain("matching snippet");
    expect(secondRequest).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.events.find((event) => event.kind === "tool_result")?.summary).toBe(
      "search_text",
    );
  });

  it("redacts a format-split secret from list feedback before the next provider request", async () => {
    const secret = "list-short-secret";
    const provider = new ScriptedMockProvider([
      { kind: "list_files", path: "src", depth: 1 },
      { kind: "finish", outcome: "needs_human", summary: "stop" },
    ]);
    const fake = fakeTools({
      verification: failedVerification,
      listFiles: async () =>
        Object.freeze({
          entries: Object.freeze([
            Object.freeze({ kind: "file" as const, path: `src/token\u200B=${secret}.ts` }),
          ]),
          truncated: false,
        }),
    });
    const controller = createController(provider, fake.tools);

    await controller.runAgentSession({ session: createdRepairSession() });

    const secondRequest = provider.requests[1]?.messages.at(-1)?.content ?? "";
    expect(secondRequest).toContain("[REDACTED]");
    expect(secondRequest).not.toContain(secret);
    expect(secondRequest).not.toContain("\u200B");
  });

  it("redacts a format-split secret from read feedback before the next provider request", async () => {
    const secret = "read-short-secret";
    const provider = new ScriptedMockProvider([
      { kind: "read_file", path: "src/public.ts" },
      { kind: "finish", outcome: "needs_human", summary: "stop" },
    ]);
    const fake = fakeTools({
      verification: failedVerification,
      readFile: async () => `token\u200B=${secret}`,
    });
    const controller = createController(provider, fake.tools);

    await controller.runAgentSession({ session: createdRepairSession() });

    const secondRequest = provider.requests[1]?.messages.at(-1)?.content ?? "";
    expect(secondRequest).toContain("token=[REDACTED]");
    expect(secondRequest).not.toContain(secret);
    expect(secondRequest).not.toContain("\u200B");
  });

  it("redacts a bidi-split secret from search feedback before the next provider request", async () => {
    const secret = "search-short-secret";
    const provider = new ScriptedMockProvider([
      { kind: "search_text", path: "src", query: "needle", maxResults: 1 },
      { kind: "finish", outcome: "needs_human", summary: "stop" },
    ]);
    const fake = fakeTools({
      verification: failedVerification,
      searchText: async () =>
        Object.freeze({
          matches: Object.freeze([
            Object.freeze({
              path: "src/search.ts",
              line: 1,
              snippet: `api\u202E_key=${secret}`,
            }),
          ]),
          truncated: false,
        }),
    });
    const controller = createController(provider, fake.tools);

    await controller.runAgentSession({ session: createdRepairSession() });

    const secondRequest = provider.requests[1]?.messages.at(-1)?.content ?? "";
    expect(secondRequest).toContain("api_key=[REDACTED]");
    expect(secondRequest).not.toContain(secret);
    expect(secondRequest).not.toContain("\u202E");
  });

  it("redacts a long token that crosses the read-file feedback boundary", async () => {
    const token = "x".repeat(40);
    const source = `${"p".repeat(4_077)} ${token} tail`;
    const provider = new ScriptedMockProvider([
      { kind: "read_file", path: "src/public.ts" },
      { kind: "finish", outcome: "needs_human", summary: "stop" },
    ]);
    const fake = fakeTools({ verification: failedVerification, readFile: async () => source });
    const controller = createController(provider, fake.tools);

    await controller.runAgentSession({ session: createdRepairSession() });

    const secondRequest = provider.requests[1]?.messages.at(-1)?.content ?? "";
    expect(secondRequest).not.toContain(token);
    expect(secondRequest).not.toContain(token.slice(0, 16));
  });

  it("redacts a long token that crosses a list-path feedback boundary", async () => {
    const token = "x".repeat(40);
    const path = `${"p".repeat(4_077)} ${token} tail`;
    const provider = new ScriptedMockProvider([
      { kind: "list_files", path: "src", depth: 1 },
      { kind: "finish", outcome: "needs_human", summary: "stop" },
    ]);
    const fake = fakeTools({
      verification: failedVerification,
      listFiles: async () =>
        Object.freeze({
          entries: Object.freeze([Object.freeze({ kind: "file" as const, path })]),
          truncated: false,
        }),
    });
    const controller = createController(provider, fake.tools);

    await controller.runAgentSession({ session: createdRepairSession() });

    const secondRequest = provider.requests[1]?.messages.at(-1)?.content ?? "";
    expect(secondRequest).not.toContain(token);
    expect(secondRequest).not.toContain(token.slice(0, 16));
  });

  it("redacts a long token that crosses a search-snippet feedback boundary", async () => {
    const token = "x".repeat(40);
    const snippet = `${"p".repeat(4_077)} ${token} tail`;
    const provider = new ScriptedMockProvider([
      { kind: "search_text", path: "src", query: "needle", maxResults: 1 },
      { kind: "finish", outcome: "needs_human", summary: "stop" },
    ]);
    const fake = fakeTools({
      verification: failedVerification,
      searchText: async () =>
        Object.freeze({
          matches: Object.freeze([
            Object.freeze({ path: "src/search.ts", line: 1, snippet }),
          ]),
          truncated: false,
        }),
    });
    const controller = createController(provider, fake.tools);

    await controller.runAgentSession({ session: createdRepairSession() });

    const secondRequest = provider.requests[1]?.messages.at(-1)?.content ?? "";
    expect(secondRequest).not.toContain(token);
    expect(secondRequest).not.toContain(token.slice(0, 16));
  });

  it("fails closed instead of truncating an over-limit raw tool string", async () => {
    const provider = new ScriptedMockProvider([{ kind: "read_file", path: "src/public.ts" }]);
    const fake = fakeTools({
      verification: failedVerification,
      readFile: async () => "r".repeat(1_048_577),
    });
    const controller = createController(provider, fake.tools);

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("TOOL_FAILED");
    expect(provider.requests).toHaveLength(1);
  });

  it("fails closed on a multibyte read result over the UTF-8 byte budget", async () => {
    const content = multibyteToolOutputOverByteLimit();
    const provider = new ScriptedMockProvider([
      { kind: "read_file", path: "src/public.ts" },
      { kind: "finish", outcome: "needs_human", summary: "must not be requested" },
    ]);
    const fake = fakeTools({
      verification: failedVerification,
      readFile: async () => content,
    });
    const controller = createController(provider, fake.tools);

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("TOOL_FAILED");
    expect(provider.requests).toHaveLength(1);
  });

  it("fails closed on a multibyte list path over the UTF-8 byte budget", async () => {
    const path = multibyteToolOutputOverByteLimit();
    const provider = new ScriptedMockProvider([
      { kind: "list_files", path: "src", depth: 1 },
      { kind: "finish", outcome: "needs_human", summary: "must not be requested" },
    ]);
    const fake = fakeTools({
      verification: failedVerification,
      listFiles: async () =>
        Object.freeze({
          entries: Object.freeze([
            Object.freeze({ kind: "file" as const, path }),
          ]),
          truncated: false,
        }),
    });
    const controller = createController(provider, fake.tools);

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("TOOL_FAILED");
    expect(provider.requests).toHaveLength(1);
  });

  it("fails closed on a multibyte search snippet over the UTF-8 byte budget", async () => {
    const snippet = multibyteToolOutputOverByteLimit();
    const provider = new ScriptedMockProvider([
      { kind: "search_text", path: "src", query: "needle", maxResults: 1 },
      { kind: "finish", outcome: "needs_human", summary: "must not be requested" },
    ]);
    const fake = fakeTools({
      verification: failedVerification,
      searchText: async () =>
        Object.freeze({
          matches: Object.freeze([
            Object.freeze({
              path: "src/search.ts",
              line: 1,
              snippet,
            }),
          ]),
          truncated: false,
        }),
    });
    const controller = createController(provider, fake.tools);

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("TOOL_FAILED");
    expect(provider.requests).toHaveLength(1);
  });

  it.each([
    [
      "list_files",
      { kind: "list_files", path: "src", depth: 1 },
      { listFiles: async () => ({ entries: [{ kind: "file", path: 42 }], truncated: false }) as never },
    ],
    [
      "read_file",
      { kind: "read_file", path: "src/public.ts" },
      { readFile: async () => 42 as never },
    ],
    [
      "search_text",
      { kind: "search_text", path: "src", query: "needle", maxResults: 1 },
      {
        searchText: async () =>
          ({ matches: [{ path: "src/search.ts", line: 0, snippet: "bad" }], truncated: false }) as never,
      },
    ],
  ] as const)("fails closed on malformed %s tool output", async (_name, action, overrides) => {
    const provider = new ScriptedMockProvider([action]);
    const fake = fakeTools({ verification: failedVerification, ...overrides });
    const controller = createController(provider, fake.tools);

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("TOOL_FAILED");
    expect(provider.requests).toHaveLength(1);
    expect(fake.runVerification).toHaveBeenCalledTimes(1);
  });

  it("fails closed on invalid provider output without a second tool or provider call", async () => {
    const provider = new ScriptedMockProvider([{ kind: "unknown_action" }]);
    const fake = fakeTools({ verification: failedVerification });
    const controller = createController(provider, fake.tools);

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("INVALID_ACTION");
    expect(provider.requests).toHaveLength(1);
    expect(fake.runVerification).toHaveBeenCalledTimes(1);
    expect(fake.applyApprovedPatch).not.toHaveBeenCalled();
  });

  it("fails closed when initial verification is not completed", async () => {
    const provider = new ScriptedMockProvider([]);
    const fake = fakeTools({
      verification: { ...failedVerification, status: "timed_out", timedOut: true },
    });
    const controller = createController(provider, fake.tools);

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("TOOL_FAILED");
    expect(provider.requests).toEqual([]);
    expect(fake.runVerification).toHaveBeenCalledTimes(1);
  });

  it("uses a stable summary when the provider throws and never exposes its message", async () => {
    const thrown = createThrowingProvider("provider-secret-value");
    const fake = fakeTools({ verification: failedVerification });
    const controller = createAgentSessionController({
      provider: thrown.provider,
      policy: allowPolicy,
      tools: fake.tools,
      eventSink: new InMemoryEventSink(),
      now: fixedNow,
      createId: sequenceIds(),
    });

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("PROVIDER_FAILED");
    expect(thrown.complete).toHaveBeenCalledTimes(1);
    expect(fake.runVerification).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("provider-secret-value");
  });

  it("blocks a denied action before it reaches a tool", async () => {
    const provider = new ScriptedMockProvider([{ kind: "run_verification", commandId: "test" }]);
    const fake = fakeTools({ verification: failedVerification });
    const denied = createDenyPolicy();
    const controller = createController(provider, fake.tools, { policy: denied.policy });

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("blocked");
    expect(result.finalSummary).toBe("POLICY_DENIED");
    expect(denied.evaluate).toHaveBeenCalledTimes(1);
    expect(fake.runVerification).toHaveBeenCalledTimes(1);
  });

  it("blocks a non-patch approval request before it reaches a tool", async () => {
    const provider = new ScriptedMockProvider([{ kind: "run_verification", commandId: "test" }]);
    const fake = fakeTools({ verification: failedVerification });
    const askPolicy: BoundPolicy = Object.freeze({
      evaluate: () => Object.freeze({ decision: "ask" as const, reason: "PATCH_REQUIRES_APPROVAL" as const }),
    });
    const controller = createController(provider, fake.tools, { policy: askPolicy });

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("blocked");
    expect(result.finalSummary).toBe("POLICY_DENIED");
    expect(fake.runVerification).toHaveBeenCalledTimes(1);
  });

  it("fails closed after a dispatched tool error without another provider call", async () => {
    let verificationCalls = 0;
    const provider = new ScriptedMockProvider([{ kind: "run_verification", commandId: "test" }]);
    const fake = fakeTools({
      runVerification: async () => {
        verificationCalls += 1;
        if (verificationCalls === 1) {
          return failedVerification;
        }
        throw new Error("tool-secret-value");
      },
    });
    const controller = createController(provider, fake.tools);

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("TOOL_FAILED");
    expect(provider.requests).toHaveLength(1);
    expect(fake.runVerification).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain("tool-secret-value");
  });

  it("does not dispatch an action when its audit event cannot be appended", async () => {
    const provider = new ScriptedMockProvider([{ kind: "run_verification", commandId: "test" }]);
    const fake = fakeTools({ verification: failedVerification });
    const failing = createFailingEventSink("action");
    const controller = createController(provider, fake.tools, { eventSink: failing.eventSink });

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("EVENT_SINK_FAILED");
    expect(provider.requests).toHaveLength(1);
    expect(fake.runVerification).toHaveBeenCalledTimes(1);
    expect(failing.append).toHaveBeenCalledTimes(3);
  });

  it.each(["completed", "not_reproducible"] as const)(
    "requires controlled verification when the model finishes as %s",
    async (outcome) => {
      const provider = new ScriptedMockProvider([
        { kind: "finish", outcome, summary: "unverified model claim" },
      ]);
      const fake = fakeTools({ verification: failedVerification });
      const controller = createController(provider, fake.tools);

      const result = await controller.runAgentSession({ session: createdRepairSession() });

      expect(result.session.state).toBe("blocked");
      expect(result.finalSummary).toBe("VERIFICATION_REQUIRED");
      expect(fake.runVerification).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["needs_human", "blocked"],
    ["blocked", "blocked"],
    ["failed", "failed"],
  ] as const)("maps model finish %s to terminal state %s", async (outcome, state) => {
    const provider = new ScriptedMockProvider([{ kind: "finish", outcome, summary: "model result" }]);
    const fake = fakeTools({ verification: failedVerification });
    const controller = createController(provider, fake.tools);

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe(state);
    expect(fake.runVerification).toHaveBeenCalledTimes(1);
  });

  it("never treats a model apply_approved_patch action as a writable path", async () => {
    const provider = new ScriptedMockProvider([
      {
        kind: "apply_approved_patch",
        approvalId: "forged-approval",
        path: "src/math.ts",
        baseHash: "a".repeat(64),
        patch: "@@ -1 +1 @@\n-before\n+after\n",
      },
    ]);
    const fake = fakeTools({ verification: failedVerification });
    const controller = createController(provider, fake.tools);

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("blocked");
    expect(result.finalSummary).toBe("POLICY_DENIED");
    expect(fake.applyApprovedPatch).not.toHaveBeenCalled();
  });

  it("creates an approval view for a correctly staged patch without writing it", async () => {
    const provider = new ScriptedMockProvider([repairPatch()]);
    const fake = fakeTools({ verification: failedVerification });
    const controller = createController(provider, fake.tools, { policy: askForPatchPolicy });

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("awaiting_approval");
    expect(result.finalSummary).toBe("APPROVAL_PENDING");
    expect(result.pendingPatch).toMatchObject({
      stage: "repair",
      path: "src/math.ts",
      patch: "@@ -1 +1 @@\n-before\n+after\n",
      reason: "Fix the selected failure",
    });
    expect(Object.isFrozen(result.pendingPatch)).toBe(true);
    expect(fake.applyApprovedPatch).not.toHaveBeenCalled();
    expect(fake.getCurrentBaseHash).not.toHaveBeenCalled();
    expect(result.events.map((event) => event.kind)).toEqual([
      "verification",
      "state",
      "action",
      "policy",
      "state",
      "approval",
    ]);
    expect(result.events.every((event) => event.occurredAt === "2026-07-29T00:00:00.000Z")).toBe(
      true,
    );
  });

  it("fails closed before retaining an ASCII patch that exceeds the byte limit", async () => {
    const provider = new ScriptedMockProvider([
      { ...repairPatch(), patch: "a".repeat(1_048_577) },
    ]);
    const fake = fakeTools({ verification: failedVerification });
    const controller = createController(provider, fake.tools, { policy: askForPatchPolicy });

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("PATCH_TOO_LARGE");
    expect(result.pendingPatch).toBeUndefined();
    expect(result.events.some((event) => event.kind === "approval")).toBe(false);
    expect(fake.applyApprovedPatch).not.toHaveBeenCalled();
    expect(provider.requests).toHaveLength(1);
  });

  it("fails closed before retaining a multibyte patch over the UTF-8 byte limit", async () => {
    const patch = "中".repeat(349_526);
    expect(patch.length).toBeLessThan(1_048_576);
    expect(new TextEncoder().encode(patch).byteLength).toBeGreaterThan(1_048_576);
    const provider = new ScriptedMockProvider([{ ...repairPatch(), patch }]);
    const fake = fakeTools({ verification: failedVerification });
    const controller = createController(provider, fake.tools, { policy: askForPatchPolicy });

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("PATCH_TOO_LARGE");
    expect(result.pendingPatch).toBeUndefined();
    expect(result.events.some((event) => event.kind === "approval")).toBe(false);
    expect(fake.applyApprovedPatch).not.toHaveBeenCalled();
    expect(provider.requests).toHaveLength(1);
  });

  it("fails closed at the pending capacity without evicting existing approvals", async () => {
    const provider = new ScriptedMockProvider(
      Array.from({ length: 33 }, () => repairPatch()),
    );
    const fake = fakeTools({ verification: failedVerification });
    const controller = createController(provider, fake.tools, { policy: askForPatchPolicy });
    const firstSession = { ...createdRepairSession(), id: "pending-session-1" };
    const first = await controller.runAgentSession({ session: firstSession });

    for (let index = 2; index <= 32; index += 1) {
      const result = await controller.runAgentSession({
        session: { ...createdRepairSession(), id: `pending-session-${index}` },
      });
      expect(result.session.state).toBe("awaiting_approval");
    }

    const overflow = await controller.runAgentSession({
      session: { ...createdRepairSession(), id: "pending-session-33" },
    });
    const duplicate = await controller.runAgentSession({ session: firstSession });

    expect(first.session.state).toBe("awaiting_approval");
    expect(overflow.session.state).toBe("failed");
    expect(overflow.finalSummary).toBe("PENDING_CAPACITY_REACHED");
    expect(duplicate.finalSummary).toBe("INVALID_SESSION_INPUT");
    await expect(
      controller.resolvePendingPatch({
        sessionId: firstSession.id,
        approvalId: first.pendingPatch?.approvalId ?? "missing",
        decision: "approve",
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_NOT_FOUND" });
    expect(provider.requests).toHaveLength(33);
    expect(fake.applyApprovedPatch).not.toHaveBeenCalled();
  });

  it("releases a terminal session record after its immutable result is returned", async () => {
    const provider = new ScriptedMockProvider([]);
    const fake = fakeTools({ verification: passingVerification });
    const controller = createController(provider, fake.tools);
    const session = { ...createdRepairSession(), id: "reusable-terminal-session" };

    const first = await controller.runAgentSession({ session });
    const second = await controller.runAgentSession({ session });

    expect(first.finalSummary).toBe("NOT_REPRODUCIBLE");
    expect(second.finalSummary).toBe("NOT_REPRODUCIBLE");
    expect(fake.runVerification).toHaveBeenCalledTimes(2);
  });

  it("rejects a mismatched patch stage before policy or a second tool call", async () => {
    const provider = new ScriptedMockProvider([repairPatch("test")]);
    const fake = fakeTools({ verification: failedVerification });
    const policy = createDenyPolicy();
    const controller = createController(provider, fake.tools, { policy: policy.policy });

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("blocked");
    expect(result.finalSummary).toBe("FEATURE_STAGE_INVALID");
    expect(policy.evaluate).not.toHaveBeenCalled();
    expect(fake.runVerification).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["non-created state", { ...createdRepairSession(), state: "running" }],
    ["negative round", { ...createdRepairSession(), round: -1 }],
    ["out-of-range round", { ...createdRepairSession(), round: 4 }],
    ["blank task summary", { ...createdRepairSession(), taskSummary: "  " }],
    ["blank command id", { ...createdRepairSession(), verificationCommandId: "" }],
    [
      "feature without acceptance criteria",
      { ...createdFeatureSession(), acceptanceCriteria: undefined },
    ],
  ] as const)("rejects invalid StartSessionInput: %s", async (_name, session) => {
    const provider = new ScriptedMockProvider([]);
    const fake = fakeTools({ verification: failedVerification });
    const controller = createController(provider, fake.tools);

    const result = await controller.runAgentSession({ session });

    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("INVALID_SESSION_INPUT");
    expect(provider.requests).toEqual([]);
    expect(fake.runVerification).not.toHaveBeenCalled();
    expect(fake.applyApprovedPatch).not.toHaveBeenCalled();
  });

  it.each([
    ["newline session id", { ...createdRepairSession(), id: "repair\nsession" }],
    ["NUL session id", { ...createdRepairSession(), id: "repair\u0000session" }],
    ["overlong session id", { ...createdRepairSession(), id: "s".repeat(129) }],
    ["C1 workspace id", { ...createdRepairSession(), workspaceId: "workspace\u0085id" }],
    ["overlong provider id", { ...createdRepairSession(), providerId: "p".repeat(129) }],
    ["control verification command id", { ...createdRepairSession(), verificationCommandId: "test\u0000" }],
    ["newline task summary", { ...createdRepairSession(), taskSummary: "repair\nsummary" }],
    ["overlong task summary", { ...createdRepairSession(), taskSummary: "s".repeat(4_097) }],
    [
      "control feature acceptance criteria",
      { ...createdFeatureSession(), acceptanceCriteria: "accept\u0000criteria" },
    ],
    [
      "overlong feature acceptance criteria",
      { ...createdFeatureSession(), acceptanceCriteria: "a".repeat(4_097) },
    ],
  ] as const)("rejects unsafe runtime input: %s", async (_name, session) => {
    const provider = new ScriptedMockProvider([]);
    const fake = fakeTools({ verification: failedVerification });
    const controller = createController(provider, fake.tools);

    const result = await controller.runAgentSession({ session });

    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("INVALID_SESSION_INPUT");
    expect(result.events).toEqual([]);
    expect(provider.requests).toEqual([]);
    expect(fake.runVerification).not.toHaveBeenCalled();
  });

  it("returns detached immutable snapshots and does not retain a caller session object", async () => {
    const sourceSession = { ...createdRepairSession() };
    const provider = new ScriptedMockProvider([
      { kind: "finish", outcome: "needs_human", summary: "model result" },
    ]);
    const fake = fakeTools({ verification: failedVerification });
    const controller = createController(provider, fake.tools);

    const result = await controller.runAgentSession({ session: sourceSession });
    sourceSession.taskSummary = "forged after start";

    expect(result.session.taskSummary).toBe("Repair the selected test");
    expect(Object.isFrozen(result.session)).toBe(true);
    expect(Object.isFrozen(result.events)).toBe(true);
    expect(Object.isFrozen(result.events[0])).toBe(true);
  });

  it("fails closed when Task 5 approval recovery has not yet been implemented", async () => {
    const provider = new ScriptedMockProvider([repairPatch()]);
    const fake = fakeTools({ verification: failedVerification });
    const controller = createController(provider, fake.tools, { policy: askForPatchPolicy });
    const pending = await controller.runAgentSession({ session: createdRepairSession() });

    await expect(
      controller.resolvePendingPatch({
        sessionId: pending.session.id,
        approvalId: pending.pendingPatch?.approvalId ?? "missing",
        decision: "approve",
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_NOT_FOUND" });
    expect(fake.applyApprovedPatch).not.toHaveBeenCalled();
  });
});
