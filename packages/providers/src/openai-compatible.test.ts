import { describe, expect, it, vi } from "vitest";
import {
  MAX_PROVIDER_RESPONSE_BYTES,
  OpenAICompatibleProvider,
  PROVIDER_REQUEST_TIMEOUT_MS,
  type FetchLike,
} from "./openai-compatible.js";
import { ProviderError, type ProviderRequest } from "./provider.js";

const endpoint = "https://provider.example.test/v1/chat/completions";
const apiKey = "test-api-key-not-for-network";
const model = "test-model";
const secretSentinel = "do-not-disclose-provider-secret";

function request(): ProviderRequest {
  return {
    messages: [
      { role: "system", content: "Use JSON only." },
      { role: "user", content: "Complete the task." },
    ],
  };
}

function provider(fetch: FetchLike, configuredEndpoint = endpoint): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    endpoint: configuredEndpoint,
    model,
    apiKey,
    fetch,
  });
}

function completionResponse(content: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
    }),
    { status: 200 },
  );
}

async function expectProviderError(
  operation: () => Promise<unknown>,
  code: ProviderError["code"],
): Promise<void> {
  let captured: unknown;

  try {
    await operation();
  } catch (error) {
    captured = error;
  }

  expectSafeProviderError(captured, code);
}

function expectSafeProviderError(error: unknown, code: ProviderError["code"]): void {
  expect(error).toBeInstanceOf(ProviderError);
  expect(error).toMatchObject({ code, message: code });
  expect(error).not.toHaveProperty("cause");
  expect(String(error)).not.toContain(secretSentinel);
}

type PromiseState =
  | { status: "pending" }
  | { status: "resolved"; value: unknown }
  | { status: "rejected"; reason: unknown };

function observePromise(promise: Promise<unknown>): { state: PromiseState } {
  const observation: { state: PromiseState } = { state: { status: "pending" } };
  void promise.then(
    (value) => {
      observation.state = { status: "resolved", value };
    },
    (reason: unknown) => {
      observation.state = { status: "rejected", reason };
    },
  );

  return observation;
}

function expectObservedProviderError(
  observation: { state: PromiseState },
  code: ProviderError["code"],
): void {
  expect(observation.state.status).toBe("rejected");
  if (observation.state.status === "rejected") {
    expectSafeProviderError(observation.state.reason, code);
  }
}

function responseBodyText(contentPaddingLength: number): string {
  return JSON.stringify({
    choices: [
      {
        message: {
          content: JSON.stringify({ padding: "x".repeat(contentPaddingLength) }),
        },
      },
    ],
  });
}

function responseWithChunkedText(text: string, chunkLengths: readonly number[]): Response {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let offset = 0;
      for (const length of chunkLengths) {
        controller.enqueue(bytes.slice(offset, offset + length));
        offset += length;
      }
      controller.close();
    },
  });

  return new Response(stream, { status: 200 });
}

describe("OpenAICompatibleProvider", () => {
  it("exposes the transport class and constants through the public providers entrypoint", async () => {
    const publicExports = (await import("./index.js")) as Record<string, unknown>;

    expect(publicExports.OpenAICompatibleProvider).toBe(OpenAICompatibleProvider);
    expect(publicExports.PROVIDER_REQUEST_TIMEOUT_MS).toBe(PROVIDER_REQUEST_TIMEOUT_MS);
    expect(publicExports.MAX_PROVIDER_RESPONSE_BYTES).toBe(MAX_PROVIDER_RESPONSE_BYTES);
  });

  it("sends one exact bounded POST request and returns the JSON content", async () => {
    const action = {
      kind: "finish",
      outcome: "completed",
      metadata: { attempts: 1 },
    };
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetch: FetchLike = async (input, init) => {
      calls.push({ input, init });
      return completionResponse(JSON.stringify(action));
    };

    const result = await provider(fetch).complete(request());

    expect(result).toEqual(action);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(endpoint);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toEqual({
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    });
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({
        model,
        messages: request().messages,
      }),
    );
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.init?.signal?.aborted).toBe(false);
  });

  it.each([
    "http://provider.example.test/v1/chat/completions",
    "not a URL",
    "https://user@provider.example.test/v1/chat/completions",
    "https://user:password@provider.example.test/v1/chat/completions",
    "https://provider.example.test/v1/chat/completions?apiKey=leak",
    "https://provider.example.test/v1/chat/completions#fragment",
  ])("rejects an unsafe endpoint without calling fetch: %s", (unsafeEndpoint) => {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls += 1;
      return completionResponse("null");
    };

    let captured: unknown;
    try {
      provider(fetch, unsafeEndpoint);
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(ProviderError);
    expect(captured).toMatchObject({
      code: "PROVIDER_INVALID_ENDPOINT",
      message: "PROVIDER_INVALID_ENDPOINT",
    });
    expect(captured).not.toHaveProperty("cause");
    expect(String(captured)).not.toContain(unsafeEndpoint);
    expect(calls).toBe(0);
  });

  it("maps a raw fetch failure to a safe network error without retrying", async () => {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls += 1;
      throw new Error(`network failure with ${secretSentinel} and ${apiKey}`);
    };

    await expectProviderError(
      () => provider(fetch).complete(request()),
      "PROVIDER_NETWORK_ERROR",
    );
    expect(calls).toBe(1);
  });

  it("maps an HTTP failure to a safe network error without reading its body", async () => {
    let calls = 0;
    let bodyRead = false;
    const fetch: FetchLike = async () => {
      calls += 1;
      return {
        ok: false,
        body: {
          getReader() {
            bodyRead = true;
            throw new Error(secretSentinel);
          },
          cancel: async () => undefined,
        },
      } as unknown as Response;
    };

    await expectProviderError(
      () => provider(fetch).complete(request()),
      "PROVIDER_NETWORK_ERROR",
    );
    expect(calls).toBe(1);
    expect(bodyRead).toBe(false);
  });

  it.each([
    ["malformed response JSON", new Response(`{${secretSentinel}`, { status: 200 })],
    ["missing choices", new Response(JSON.stringify({}), { status: 200 })],
    ["non-string content", completionResponse(42)],
    ["malformed content JSON", completionResponse(`{${secretSentinel}`)],
    [
      "oversized response",
      new Response(new Uint8Array(MAX_PROVIDER_RESPONSE_BYTES + 1), { status: 200 }),
    ],
  ] as const)("maps a %s response to a safe invalid-response error", async (_name, response) => {
    const fetch: FetchLike = async () => response;

    await expectProviderError(
      () => provider(fetch).complete(request()),
      "PROVIDER_INVALID_RESPONSE",
    );
  });

  it("maps a missing body to a safe invalid-response error", async () => {
    const fetch: FetchLike = async () => new Response(null, { status: 200 });

    await expectProviderError(
      () => provider(fetch).complete(request()),
      "PROVIDER_INVALID_RESPONSE",
    );
  });

  it("maps invalid UTF-8 to a safe invalid-response error", async () => {
    const invalidUtf8 = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xff]));
        controller.close();
      },
    });
    const fetch: FetchLike = async () => new Response(invalidUtf8, { status: 200 });

    await expectProviderError(
      () => provider(fetch).complete(request()),
      "PROVIDER_INVALID_RESPONSE",
    );
  });

  it("aborts the one request at the fixed timeout and hides the abort failure", async () => {
    vi.useFakeTimers();

    try {
      let calls = 0;
      let signal: AbortSignal | undefined;
      const fetch: FetchLike = (_input, init) => {
        calls += 1;
        signal = init?.signal ?? undefined;

        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error(`abort carried ${secretSentinel} and ${apiKey}`)),
            { once: true },
          );
        });
      };
      const pending = provider(fetch).complete(request());
      const expectedTimeout = expectProviderError(() => pending, "PROVIDER_TIMEOUT");

      await vi.advanceTimersByTimeAsync(PROVIDER_REQUEST_TIMEOUT_MS);

      await expectedTimeout;
      expect(calls).toBe(1);
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles as a timeout when the injected fetch ignores the aborted signal", async () => {
    vi.useFakeTimers();

    try {
      let calls = 0;
      let signal: AbortSignal | undefined;
      const fetch: FetchLike = (_input, init) => {
        calls += 1;
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      };
      const observation = observePromise(provider(fetch).complete(request()));

      await vi.advanceTimersByTimeAsync(PROVIDER_REQUEST_TIMEOUT_MS);

      expectObservedProviderError(observation, "PROVIDER_TIMEOUT");
      expect(calls).toBe(1);
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("absorbs a late injected-fetch rejection after the timeout wins", async () => {
    vi.useFakeTimers();

    try {
      let rejectFetch: ((reason: unknown) => void) | undefined;
      const fetch: FetchLike = () =>
        new Promise<Response>((_resolve, reject) => {
          rejectFetch = reject;
        });
      const observation = observePromise(provider(fetch).complete(request()));

      await vi.advanceTimersByTimeAsync(PROVIDER_REQUEST_TIMEOUT_MS);
      expectObservedProviderError(observation, "PROVIDER_TIMEOUT");

      rejectFetch?.(new Error(`${secretSentinel} after timeout`));
      await vi.advanceTimersByTimeAsync(0);

      expectObservedProviderError(observation, "PROVIDER_TIMEOUT");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps timeout precedence when an aborted fetch resolves with HTTP 500", async () => {
    vi.useFakeTimers();

    try {
      const fetch: FetchLike = (_input, init) =>
        new Promise<Response>((resolve) => {
          init?.signal?.addEventListener(
            "abort",
            () => resolve(new Response(secretSentinel, { status: 500 })),
            { once: true },
          );
        });
      const observation = observePromise(provider(fetch).complete(request()));

      await vi.advanceTimersByTimeAsync(PROVIDER_REQUEST_TIMEOUT_MS);

      expectObservedProviderError(observation, "PROVIDER_TIMEOUT");
    } finally {
      vi.useRealTimers();
    }
  });

  it("normalizes an untrusted ProviderError from a stream reader", async () => {
    let cancelCalls = 0;
    const reader = {
      read: () => Promise.reject(new ProviderError(secretSentinel as ProviderError["code"])),
      cancel: async () => {
        cancelCalls += 1;
      },
      releaseLock: () => undefined,
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const body = {
      getReader: () => reader,
      cancel: async () => undefined,
    } as unknown as ReadableStream<Uint8Array>;
    const fetch: FetchLike = async () => ({ ok: true, body } as unknown as Response);

    await expectProviderError(
      () => provider(fetch).complete(request()),
      "PROVIDER_INVALID_RESPONSE",
    );
    expect(cancelCalls).toBe(1);
  });

  it("does not wait for a never-settling cancel after an oversized stream chunk", async () => {
    vi.useFakeTimers();

    try {
      let cancelCalls = 0;
      const reader = {
        read: async () => ({
          done: false,
          value: new Uint8Array(MAX_PROVIDER_RESPONSE_BYTES + 1),
        }),
        cancel: () => {
          cancelCalls += 1;
          return new Promise<void>(() => undefined);
        },
        releaseLock: () => undefined,
      } as unknown as ReadableStreamDefaultReader<Uint8Array>;
      const body = {
        getReader: () => reader,
      } as unknown as ReadableStream<Uint8Array>;
      const observation = observePromise(
        provider(async () => ({ ok: true, body } as unknown as Response)).complete(request()),
      );

      await vi.advanceTimersByTimeAsync(0);

      expectObservedProviderError(observation, "PROVIDER_INVALID_RESPONSE");
      expect(cancelCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a non-2xx body without reading it", async () => {
    let bodyRead = false;
    let cancelCalls = 0;
    const body = {
      getReader: () => {
        bodyRead = true;
        throw new Error(secretSentinel);
      },
      cancel: async () => {
        cancelCalls += 1;
      },
    } as unknown as ReadableStream<Uint8Array>;
    const fetch: FetchLike = async () => ({ ok: false, body } as unknown as Response);

    await expectProviderError(
      () => provider(fetch).complete(request()),
      "PROVIDER_NETWORK_ERROR",
    );
    expect(cancelCalls).toBe(1);
    expect(bodyRead).toBe(false);
  });

  it("cancels and releases a reader after an early read failure", async () => {
    let cancelCalls = 0;
    let releaseCalls = 0;
    const reader = {
      read: () => Promise.reject(new Error(secretSentinel)),
      cancel: async () => {
        cancelCalls += 1;
      },
      releaseLock: () => {
        releaseCalls += 1;
      },
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const body = {
      getReader: () => reader,
    } as unknown as ReadableStream<Uint8Array>;
    const fetch: FetchLike = async () => ({ ok: true, body } as unknown as Response);

    await expectProviderError(
      () => provider(fetch).complete(request()),
      "PROVIDER_INVALID_RESPONSE",
    );
    expect(cancelCalls).toBe(1);
    expect(releaseCalls).toBe(1);
  });

  it("cancels an unsupported body exactly once before returning an invalid response", async () => {
    let cancelCalls = 0;
    const body = {
      cancel: async () => {
        cancelCalls += 1;
      },
    } as unknown as ReadableStream<Uint8Array>;
    const fetch: FetchLike = async () => ({ ok: true, body } as unknown as Response);

    await expectProviderError(
      () => provider(fetch).complete(request()),
      "PROVIDER_INVALID_RESPONSE",
    );
    expect(cancelCalls).toBe(1);
  });

  it("rejects a valid response that exceeds the byte cap across chunks", async () => {
    const baseLength = new TextEncoder().encode(responseBodyText(0)).byteLength;
    const body = responseBodyText(MAX_PROVIDER_RESPONSE_BYTES + 1 - baseLength);
    expect(new TextEncoder().encode(body)).toHaveLength(MAX_PROVIDER_RESPONSE_BYTES + 1);
    const fetch: FetchLike = async () =>
      responseWithChunkedText(body, [MAX_PROVIDER_RESPONSE_BYTES - 1, 2]);

    await expectProviderError(
      () => provider(fetch).complete(request()),
      "PROVIDER_INVALID_RESPONSE",
    );
  });

  it("accepts a valid response exactly at the byte cap across chunks", async () => {
    const baseLength = new TextEncoder().encode(responseBodyText(0)).byteLength;
    const paddingLength = MAX_PROVIDER_RESPONSE_BYTES - baseLength;
    const body = responseBodyText(paddingLength);
    expect(new TextEncoder().encode(body)).toHaveLength(MAX_PROVIDER_RESPONSE_BYTES);
    const fetch: FetchLike = async () =>
      responseWithChunkedText(body, [MAX_PROVIDER_RESPONSE_BYTES - 1, 1]);

    await expect(provider(fetch).complete(request())).resolves.toEqual({
      padding: "x".repeat(paddingLength),
    });
  });
});
