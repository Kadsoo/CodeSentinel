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
});

describe("cloneAndFreeze", () => {
  it("clones and freezes cyclic JSON-like structures", () => {
    const source: {
      nested: { values: number[] };
      self?: unknown;
    } = { nested: { values: [1] } };
    source.self = source;

    const snapshot = cloneAndFreeze(source);

    expect(snapshot).not.toBe(source);
    expect(snapshot.self).toBe(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.nested)).toBe(true);
    expect(Object.isFrozen(snapshot.nested.values)).toBe(true);
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
