import { describe, expect, it, vi } from "vitest";
import { cloneAndFreeze } from "./mock.js";
import {
  PROVIDER_PROBE_REQUEST,
  ProviderError,
  type Provider,
  type ProviderErrorCode,
  type ProviderRequest,
  ScriptedMockProvider,
  probeProvider,
} from "./index.js";

function request(content = "hello"): ProviderRequest {
  return {
    messages: [{ role: "user", content }],
  };
}

function captureError(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }

  return undefined;
}

function expectInvalidSnapshot(error: unknown): void {
  expect(error).toBeInstanceOf(ProviderError);
  expect(error).toMatchObject({
    code: "PROVIDER_INVALID_RESPONSE",
    message: "PROVIDER_INVALID_RESPONSE",
  });
  if (error instanceof ProviderError) {
    expect("cause" in error).toBe(false);
  }
}

describe("ScriptedMockProvider", () => {
  it("returns independently frozen scripted responses in order", async () => {
    const firstScript = {
      sequence: 1,
      nested: { value: "first" },
      list: [{ value: "one" }],
    };
    const secondScript = {
      sequence: 2,
      nested: { value: "second" },
      list: [{ value: "two" }],
    };
    const provider = new ScriptedMockProvider([firstScript, secondScript]);

    firstScript.nested.value = "mutated after setup";
    const first = await provider.complete(request());
    const second = await provider.complete(request());
    const firstResponse = first as {
      sequence: number;
      nested: { value: string };
      list: Array<{ value: string }>;
    };

    expect(first).toEqual({
      sequence: 1,
      nested: { value: "first" },
      list: [{ value: "one" }],
    });
    expect(second).toEqual(secondScript);
    expect(first).not.toBe(firstScript);
    expect(second).not.toBe(secondScript);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(firstResponse.nested)).toBe(true);
    expect(Object.isFrozen(firstResponse.list)).toBe(true);
    expect(Object.isFrozen(firstResponse.list[0])).toBe(true);
  });

  it("preserves sparse scripted array snapshots after the input changes", async () => {
    const scriptedResponse = new Array<number>(3);
    scriptedResponse[0] = 1;
    scriptedResponse[2] = 3;
    const provider = new ScriptedMockProvider([scriptedResponse]);

    scriptedResponse[0] = 9;
    scriptedResponse[1] = 2;
    scriptedResponse[2] = 9;
    const snapshot = (await provider.complete(request())) as readonly unknown[];

    expect(snapshot).toHaveLength(3);
    expect(1 in snapshot).toBe(false);
    expect(snapshot[0]).toBe(1);
    expect(snapshot[2]).toBe(3);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("rejects enumerable indexed array accessors without invoking their getter", () => {
    let getterCalls = 0;
    const scriptedResponse: unknown[] = [];
    Object.defineProperty(scriptedResponse, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must not be read";
      },
    });

    const error = captureError(() => new ScriptedMockProvider([scriptedResponse]));

    expect(getterCalls).toBe(0);
    expectInvalidSnapshot(error);
  });

  it("captures a frozen request snapshot that is insulated from caller mutation", async () => {
    const provider = new ScriptedMockProvider([null]);
    const original = {
      messages: [{ role: "user" as const, content: "before" }],
    };

    await provider.complete(original);
    original.messages[0].content = "after";

    const recorded = provider.requests[0];
    expect(recorded).toEqual({
      messages: [{ role: "user", content: "before" }],
    });
    expect(Object.isFrozen(provider.requests)).toBe(true);
    expect(Object.isFrozen(recorded)).toBe(true);
    expect(Object.isFrozen(recorded?.messages)).toBe(true);
    expect(Object.isFrozen(recorded?.messages[0])).toBe(true);
  });

  it("keeps request records, response order, and exhaustion independent of ordinary property tampering", async () => {
    const provider = new ScriptedMockProvider([{ sequence: "first" }, { sequence: "second" }]);

    await expect(provider.complete(request("first request"))).resolves.toEqual({ sequence: "first" });
    Object.assign(provider as object, {
      responses: [{ sequence: "tampered" }],
      recordedRequests: [],
      nextResponseIndex: 0,
    });

    await expect(provider.complete(request("second request"))).resolves.toEqual({ sequence: "second" });
    await expect(provider.complete(request("exhausted request"))).rejects.toMatchObject({
      code: "PROVIDER_SCRIPT_EXHAUSTED",
    });
    expect(provider.requests).toEqual([
      { messages: [{ role: "user", content: "first request" }] },
      { messages: [{ role: "user", content: "second request" }] },
      { messages: [{ role: "user", content: "exhausted request" }] },
    ]);
  });

  it("fails with a stable code after the script is exhausted", async () => {
    const provider = new ScriptedMockProvider([]);

    await expect(provider.complete(request())).rejects.toMatchObject({
      code: "PROVIDER_SCRIPT_EXHAUSTED",
      message: "PROVIDER_SCRIPT_EXHAUSTED",
    });

    const networkErrorCode: ProviderErrorCode = "PROVIDER_NETWORK_ERROR";
    const error = new ProviderError(networkErrorCode);
    expect(error.code).toBe("PROVIDER_NETWORK_ERROR");
    expect(error.message).toBe("PROVIDER_NETWORK_ERROR");
    expect("cause" in error).toBe(false);
  });

  it("records an exhausted call as an immutable request snapshot", async () => {
    const provider = new ScriptedMockProvider([]);
    const exhaustedRequest = {
      messages: [{ role: "user" as const, content: "before exhaustion" }],
    };

    await expect(provider.complete(exhaustedRequest)).rejects.toMatchObject({
      code: "PROVIDER_SCRIPT_EXHAUSTED",
    });
    exhaustedRequest.messages[0].content = "after exhaustion";

    const recorded = provider.requests[0];
    expect(recorded).toEqual({
      messages: [{ role: "user", content: "before exhaustion" }],
    });
    expect(Object.isFrozen(provider.requests)).toBe(true);
    expect(Object.isFrozen(recorded)).toBe(true);
    expect(Object.isFrozen(recorded?.messages)).toBe(true);
    expect(Object.isFrozen(recorded?.messages[0])).toBe(true);
  });
});

describe("cloneAndFreeze", () => {
  it("rejects a direct function with a stable error", () => {
    const responseFunction = () => "sentinel";

    expectInvalidSnapshot(captureError(() => cloneAndFreeze(responseFunction)));
  });

  it("rejects a nested function with a stable error", () => {
    const response = { nested: [{ callback: () => "sentinel" }] };

    expectInvalidSnapshot(captureError(() => cloneAndFreeze(response)));
  });

  it("rejects accessor properties without invoking their getter", () => {
    let getterCalls = 0;
    const response = {};
    Object.defineProperty(response, "sentinel", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must not be read";
      },
    });

    const error = captureError(() => cloneAndFreeze(response));

    expect(getterCalls).toBe(0);
    expectInvalidSnapshot(error);
  });

  it("rejects objects whose state cannot be safely snapshotted", () => {
    expectInvalidSnapshot(captureError(() => cloneAndFreeze(new Date())));
  });

  it("clones and freezes cyclic JSON-like structures while preserving shared references", () => {
    const shared = { values: [1] };
    const source: {
      first: { values: number[] };
      second: { values: number[] };
      self?: unknown;
    } = { first: shared, second: shared };
    source.self = source;

    const snapshot = cloneAndFreeze(source);

    expect(snapshot).not.toBe(source);
    expect(snapshot.self).toBe(snapshot);
    expect(snapshot.first).toBe(snapshot.second);
    expect(snapshot.first).not.toBe(shared);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.first)).toBe(true);
    expect(Object.isFrozen(snapshot.first.values)).toBe(true);
  });
});

describe("probeProvider", () => {
  it("calls the provider once with the fixed probe request and ignores its result", async () => {
    const complete = vi.fn(async (providerRequest: ProviderRequest) => providerRequest);
    const provider: Provider = { complete };

    await expect(probeProvider(provider)).resolves.toBeUndefined();

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[0]).toBe(PROVIDER_PROBE_REQUEST);
    expect(PROVIDER_PROBE_REQUEST.messages).toHaveLength(1);
    expect(PROVIDER_PROBE_REQUEST.messages[0]).toMatchObject({ role: "user" });
    expect(PROVIDER_PROBE_REQUEST.messages[0]?.content).toContain("provider connectivity check");
    expect(Object.isFrozen(PROVIDER_PROBE_REQUEST)).toBe(true);
    expect(Object.isFrozen(PROVIDER_PROBE_REQUEST.messages)).toBe(true);
    expect(Object.isFrozen(PROVIDER_PROBE_REQUEST.messages[0])).toBe(true);
  });
});
