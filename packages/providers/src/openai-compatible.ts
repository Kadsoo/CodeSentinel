import { ProviderError, type Provider, type ProviderRequest } from "./provider.js";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type OpenAICompatibleProviderOptions = Readonly<{
  endpoint: string;
  model: string;
  apiKey: string;
  fetch: FetchLike;
}>;

export const PROVIDER_REQUEST_TIMEOUT_MS = 20_000;
export const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;

export class OpenAICompatibleProvider implements Provider {
  readonly #endpoint: string;
  readonly #model: string;
  readonly #apiKey: string;
  readonly #fetch: FetchLike;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.#endpoint = validateEndpoint(options.endpoint);
    this.#model = options.model;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch;
  }

  async complete(request: ProviderRequest): Promise<unknown> {
    const body = serializeRequest(this.#model, request);
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, PROVIDER_REQUEST_TIMEOUT_MS);

    try {
      let response: Response;
      try {
        response = await this.#fetch(this.#endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
            "content-type": "application/json",
          },
          body,
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        throw new ProviderError(timedOut ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK_ERROR");
      }

      let responseIsSuccessful: boolean;
      try {
        responseIsSuccessful = response.ok;
      } catch {
        throw new ProviderError("PROVIDER_NETWORK_ERROR");
      }

      if (!responseIsSuccessful) {
        throw new ProviderError("PROVIDER_NETWORK_ERROR");
      }

      try {
        const responseText = await readBoundedUtf8Body(response.body, controller.signal);
        const completion = JSON.parse(responseText) as unknown;
        const content = getCompletionContent(completion);
        const result = JSON.parse(content) as unknown;

        if (timedOut) {
          throw new ProviderError("PROVIDER_TIMEOUT");
        }

        return result;
      } catch (error) {
        if (timedOut) {
          throw new ProviderError("PROVIDER_TIMEOUT");
        }

        if (error instanceof ProviderError) {
          throw error;
        }

        throw new ProviderError("PROVIDER_INVALID_RESPONSE");
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

function validateEndpoint(endpoint: string): string {
  try {
    if (endpoint.includes("?") || endpoint.includes("#")) {
      throw new Error();
    }

    const parsed = new URL(endpoint);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new Error();
    }

    return parsed.toString();
  } catch {
    throw new ProviderError("PROVIDER_INVALID_ENDPOINT");
  }
}

function serializeRequest(model: string, request: ProviderRequest): string {
  try {
    const body = JSON.stringify({ model, messages: request.messages });
    if (typeof body !== "string") {
      throw new Error();
    }

    return body;
  } catch {
    throw new ProviderError("PROVIDER_NETWORK_ERROR");
  }
}

function getCompletionContent(completion: unknown): string {
  if (!isRecord(completion) || !Array.isArray(completion.choices)) {
    throw new ProviderError("PROVIDER_INVALID_RESPONSE");
  }

  const firstChoice = completion.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throw new ProviderError("PROVIDER_INVALID_RESPONSE");
  }

  const { content } = firstChoice.message;
  if (typeof content !== "string") {
    throw new ProviderError("PROVIDER_INVALID_RESPONSE");
  }

  return content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readBoundedUtf8Body(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): Promise<string> {
  if (body === null) {
    throw new ProviderError("PROVIDER_INVALID_RESPONSE");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteLength = 0;
  let text = "";

  try {
    while (true) {
      const chunk = await readStreamChunk(reader, signal);
      if (chunk.done) {
        break;
      }

      if (!(chunk.value instanceof Uint8Array)) {
        throw new ProviderError("PROVIDER_INVALID_RESPONSE");
      }

      if (chunk.value.byteLength > MAX_PROVIDER_RESPONSE_BYTES - byteLength) {
        await cancelReader(reader);
        throw new ProviderError("PROVIDER_INVALID_RESPONSE");
      }

      byteLength += chunk.value.byteLength;
      text += decoder.decode(chunk.value, { stream: true });
    }

    return text + decoder.decode();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Releasing a reader after a failed stream is best-effort cleanup.
    }
  }
}

function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    return Promise.reject(new ProviderError("PROVIDER_TIMEOUT"));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      void cancelReader(reader);
      reject(new ProviderError("PROVIDER_TIMEOUT"));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      reader.read().then(
        (chunk) => {
          signal.removeEventListener("abort", onAbort);
          resolve(chunk);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    } catch (error) {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    }
  });
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Cancellation is only resource cleanup and must not replace a safe provider error.
  }
}
