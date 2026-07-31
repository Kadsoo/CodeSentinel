import { describe, expect, it, vi } from "vitest";
import type { EventSink, HarnessEvent } from "../../contracts/src/index.js";
import { createPolicy, type BoundPolicy } from "../../policy/src/index.js";
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
  testCommand,
} from "./test-support.js";

function createController(
  provider: Provider,
  tools: ReturnType<typeof fakeTools>["tools"],
  options: Readonly<{
    policy?: BoundPolicy;
    eventSink?: EventSink;
    createId?: () => string;
    now?: () => number;
    shouldStop?: (sessionId: string) => boolean;
  }> = {},
) {
  const dependencies = {
    provider,
    policy: options.policy ?? allowPolicy,
    tools,
    eventSink: options.eventSink ?? new InMemoryEventSink(),
    now: options.now ?? fixedNow,
    createId: options.createId ?? sequenceIds(),
    ...(options.shouldStop === undefined ? {} : { shouldStop: options.shouldStop }),
  };
  return createAgentSessionController(dependencies);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
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
        details: {
          commandId: "test",
          exitCode: 0,
          durationMs: 4,
          status: "completed",
          timedOut: false,
        },
      },
      {
        sessionId: "repair-session-1",
        round: 0,
        kind: "state",
        summary: "NOT_REPRODUCIBLE",
        occurredAt: "2026-07-29T00:00:00.000Z",
        details: { state: "stopped" },
      },
    ]);
  });

  it.each([
    ["negative duration", { ...passingVerification, durationMs: -1 }],
    ["non-safe duration", { ...passingVerification, durationMs: Number.MAX_SAFE_INTEGER + 1 }],
    ["status/timedOut mismatch", { ...passingVerification, timedOut: true }],
    [
      "timed_out with an exit code",
      { ...passingVerification, exitCode: 1, status: "timed_out" as const, timedOut: true },
    ],
    [
      "spawn_failed with an exit code",
      { ...passingVerification, exitCode: 1, status: "spawn_failed" as const, timedOut: false },
    ],
    [
      "output_limit with an exit code",
      { ...passingVerification, exitCode: 1, status: "output_limit" as const, timedOut: false },
    ],
  ] as const)("fails closed on an initial verification with %s without auditing it", async (
    _name,
    verification,
  ) => {
    const provider = new ScriptedMockProvider([]);
    const fake = fakeTools({ verification });
    const controller = createController(provider, fake.tools);

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("TOOL_FAILED");
    expect(provider.requests).toEqual([]);
    expect(fake.runVerification).toHaveBeenCalledTimes(1);
    expect(result.events.some((event) => event.kind === "verification")).toBe(false);
  });

  it("audits the real facts from the initial failed verification", async () => {
    const provider = new ScriptedMockProvider([
      { kind: "finish", outcome: "needs_human", summary: "inspect" },
    ]);
    const fake = fakeTools({ verification: failedVerification });
    const controller = createController(provider, fake.tools);

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.events.find((event) => event.kind === "verification")?.details).toEqual({
      commandId: "test",
      exitCode: 1,
      durationMs: 4,
      status: "completed",
      timedOut: false,
    });
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

  it("binds provider verification to the session-selected command before dispatch", async () => {
    const unrelatedVerificationSecret = "unrelated-verification-secret";
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
        action.commandId === "test"
          ? failedVerification
          : {
              ...passingVerification,
              commandId: "unrelated-check",
              summary: unrelatedVerificationSecret,
            },
    });
    const controller = createController(provider, fake.tools, { policy });

    expect(policy.evaluate({ kind: "run_verification", commandId: "unrelated-check" })).toEqual({
      decision: "allow",
      reason: "ALLOWED",
    });

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("blocked");
    expect(result.finalSummary).toBe("POLICY_DENIED");
    expect(fake.runVerification).toHaveBeenCalledExactlyOnceWith({
      kind: "run_verification",
      commandId: "test",
    });
    expect(result.events.filter((event) => event.kind === "verification")).toHaveLength(1);
    expect(result.events.map((event) => [event.kind, event.summary])).toEqual([
      ["verification", failedVerification.summary],
      ["state", "RUNNING"],
      ["action", "run_verification"],
      ["policy", "ALLOWED"],
      ["state", "POLICY_DENIED"],
    ]);
    expect(JSON.stringify(result)).not.toContain(unrelatedVerificationSecret);
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
    expect(result.events.filter((event) => event.kind === "verification")).toHaveLength(1);
  });

  it.each([
    ["throws", (): string => { throw new Error("id-secret"); }],
    ["returns a key-like value", (): string => "sk_live_12345678901234567890"],
    ["returns an out-of-grammar value", (): string => "unsafe/id"],
  ] as const)("fails closed when action ID creation %s before auditing or dispatch", async (
    _name,
    createId,
  ) => {
    const provider = new ScriptedMockProvider([
      { kind: "read_file", path: "src/public.ts" },
    ]);
    const fake = fakeTools({
      verification: failedVerification,
      readFile: async () => "must not run",
    });
    const controller = createController(provider, fake.tools, { createId });

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("failed");
    expect(result.finalSummary).toBe("TOOL_FAILED");
    expect(fake.readFile).not.toHaveBeenCalled();
    expect(result.events.some((event) => event.kind === "action")).toBe(false);
    expect(result.session.round).toBe(0);
    expect(result.events.at(-1)).toMatchObject({
      kind: "state",
      round: 0,
      details: { state: "failed" },
    });
    expect(JSON.stringify(result)).not.toContain("sk_live_12345678901234567890");
    expect(JSON.stringify(result)).not.toContain("unsafe/id");
    expect(JSON.stringify(result)).not.toContain("id-secret");
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

  it("stops after a provider response without dispatching another action", async () => {
    const providerResponse = deferred<unknown>();
    const providerStarted = deferred<void>();
    const complete = vi.fn<Provider["complete"]>(() => {
      providerStarted.resolve();
      return providerResponse.promise;
    });
    const fake = fakeTools({ verification: failedVerification });
    let stopped = false;
    const controller = createController(
      { complete },
      fake.tools,
      { shouldStop: () => stopped },
    );

    const running = controller.runAgentSession({ session: createdRepairSession() });
    await providerStarted.promise;
    stopped = true;
    providerResponse.resolve({ kind: "run_verification", commandId: "test" });

    const result = await running;

    expect(result.session.state).toBe("stopped");
    expect(result.finalSummary).toBe("STOP_REQUESTED");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(fake.runVerification).toHaveBeenCalledTimes(1);
    expect(result.events.map((event) => event.kind)).toEqual([
      "verification",
      "state",
      "state",
    ]);
    expect(result.events.at(-1)?.summary).toBe("STOP_REQUESTED");
  });

  it("stops during approval resolution before writing an approved patch", async () => {
    const baseHash = deferred<string>();
    const baseHashStarted = deferred<void>();
    const fake = fakeTools({ verification: failedVerification });
    fake.getCurrentBaseHash.mockImplementation(() => {
      baseHashStarted.resolve();
      return baseHash.promise;
    });
    let stopped = false;
    const controller = createController(
      new ScriptedMockProvider([repairPatch()]),
      fake.tools,
      { policy: askForPatchPolicy, shouldStop: () => stopped },
    );
    const pending = await controller.runAgentSession({ session: createdRepairSession() });

    const resolving = controller.resolvePendingPatch({
      sessionId: "repair-session-1",
      approvalId: pending.pendingPatch?.approvalId ?? "missing",
      decision: "approve",
    });
    await baseHashStarted.promise;
    stopped = true;
    baseHash.resolve("a".repeat(64));

    const result = await resolving;

    expect(result.session.state).toBe("stopped");
    expect(result.finalSummary).toBe("STOP_REQUESTED");
    expect(fake.getCurrentBaseHash).toHaveBeenCalledOnce();
    expect(fake.applyApprovedPatch).not.toHaveBeenCalled();
    expect(result.events.at(-1)?.summary).toBe("STOP_REQUESTED");
  });

  it("keeps the existing behavior when no stop probe is configured", async () => {
    const provider = new ScriptedMockProvider([
      { kind: "finish", outcome: "needs_human", summary: "inspect" },
    ]);
    const fake = fakeTools({ verification: failedVerification });
    const controller = createController(provider, fake.tools);

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("blocked");
    expect(result.finalSummary).toBe("NEEDS_HUMAN");
    expect(provider.requests).toHaveLength(1);
    expect(fake.runVerification).toHaveBeenCalledTimes(1);
  });

  it("stops generically when the stop probe throws after a tool operation", async () => {
    let probeCalls = 0;
    const fake = fakeTools({ verification: failedVerification });
    const controller = createController(
      new ScriptedMockProvider([]),
      fake.tools,
      {
        shouldStop: () => {
          probeCalls += 1;
          if (probeCalls === 2) {
            throw new Error("stop-probe-secret");
          }
          return false;
        },
      },
    );

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("stopped");
    expect(result.finalSummary).toBe("STOP_REQUESTED");
    expect(fake.runVerification).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("stop-probe-secret");
  });

  it.each([
    ["returns true", (): boolean => true],
    ["throws", (): boolean => {
      throw new Error("stop-probe-secret");
    }],
  ] as const)(
    "keeps the stop result when the probe %s and its terminal event cannot be appended",
    async (_description, shouldStop) => {
      const append = vi.fn<EventSink["append"]>(async (event) => {
        if (event.kind === "state" && event.summary === "STOP_REQUESTED") {
          throw new Error("event-sink-secret");
        }
      });
      const provider = new ScriptedMockProvider([]);
      const fake = fakeTools({ verification: failedVerification });
      const controller = createController(provider, fake.tools, {
        eventSink: { append },
        shouldStop,
      });

      const result = await controller.runAgentSession({ session: createdRepairSession() });

      expect(result.session.state).toBe("stopped");
      expect(result.finalSummary).toBe("STOP_REQUESTED");
      expect(result.events).toEqual([]);
      expect(provider.requests).toEqual([]);
      expect(fake.runVerification).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("event-sink-secret");
      expect(JSON.stringify(result)).not.toContain("stop-probe-secret");
    },
  );

  it("keeps the stop result when its terminal event timestamp cannot be created", async () => {
    const timestampSecret = "stop-terminal-time-secret";
    const provider = new ScriptedMockProvider([]);
    const fake = fakeTools({ verification: failedVerification });
    const controller = createController(provider, fake.tools, {
      now: () => {
        throw new Error(timestampSecret);
      },
      shouldStop: () => true,
    });

    const result = await controller.runAgentSession({ session: createdRepairSession() });

    expect(result.session.state).toBe("stopped");
    expect(result.finalSummary).toBe("STOP_REQUESTED");
    expect(result.events).toEqual([]);
    expect(provider.requests).toEqual([]);
    expect(fake.runVerification).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(timestampSecret);
  });

  it("stops after an action audit is persisted instead of continuing to its terminal outcome", async () => {
    const actionAuditStarted = deferred<void>();
    const releaseActionAudit = deferred<void>();
    let stopped = false;
    const append = vi.fn<EventSink["append"]>(async (event) => {
      if (event.kind === "action") {
        actionAuditStarted.resolve();
        await releaseActionAudit.promise;
      }
    });
    const provider = new ScriptedMockProvider([
      { kind: "finish", outcome: "needs_human", summary: "inspect" },
    ]);
    const fake = fakeTools({ verification: failedVerification });
    const controller = createController(provider, fake.tools, {
      eventSink: { append },
      shouldStop: () => stopped,
    });

    const running = controller.runAgentSession({ session: createdRepairSession() });
    await actionAuditStarted.promise;
    stopped = true;
    releaseActionAudit.resolve();

    const result = await running;

    expect(result.session.state).toBe("stopped");
    expect(result.finalSummary).toBe("STOP_REQUESTED");
    expect(provider.requests).toHaveLength(1);
    expect(result.events.map((event) => event.kind)).toEqual([
      "verification",
      "state",
      "action",
      "state",
    ]);
    expect(result.events.at(-1)?.summary).toBe("STOP_REQUESTED");
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
    let verificationCalls = 0;
    const provider = new ScriptedMockProvider(
      Array.from({ length: 34 }, () => repairPatch()),
    );
    const fake = fakeTools({
      runVerification: async () => {
        verificationCalls += 1;
        return verificationCalls === 34 ? passingVerification : failedVerification;
      },
    });
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
    const resolved = await controller.resolvePendingPatch({
      sessionId: firstSession.id,
      approvalId: first.pendingPatch?.approvalId ?? "missing",
      decision: "approve",
    });
    const replacement = await controller.runAgentSession({
      session: { ...createdRepairSession(), id: "pending-session-34" },
    });

    expect(resolved.finalSummary).toBe("VERIFICATION_PASSED");
    expect(replacement.session.state).toBe("awaiting_approval");
    expect(provider.requests).toHaveLength(34);
    expect(fake.applyApprovedPatch).toHaveBeenCalledOnce();
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

  it.each([
    ["path-like", "test/path"],
    ["secret-like", "sk_live_12345678901234567890"],
  ] as const)(
    "rejects a %s verification command identifier without side effects or disclosure",
    async (_name, verificationCommandId) => {
      const provider = new ScriptedMockProvider([]);
      const fake = fakeTools({ verification: failedVerification });
      const controller = createController(provider, fake.tools);

      const result = await controller.runAgentSession({
        session: { ...createdRepairSession(), verificationCommandId },
      });

      expect(result.session.state).toBe("failed");
      expect(result.finalSummary).toBe("INVALID_SESSION_INPUT");
      expect(result.events).toEqual([]);
      expect(provider.requests).toEqual([]);
      expect(fake.runVerification).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(verificationCommandId);
    },
  );

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
    expect(Object.isFrozen(result.events[0]?.details)).toBe(true);
  });

});
