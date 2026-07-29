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

  expect(captured).toBeInstanceOf(ProviderError);
  expect(captured).toMatchObject({ code, message: code });
  expect(captured).not.toHaveProperty("cause");
  expect(String(captured)).not.toContain(secretSentinel);
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
        get body() {
          bodyRead = true;
          throw new Error(secretSentinel);
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
});
