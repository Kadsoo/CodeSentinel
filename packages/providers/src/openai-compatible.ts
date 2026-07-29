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
    const { endpoint, model, apiKey, fetch } = readProviderOptions(options);

    this.#endpoint = validateEndpoint(endpoint);
    this.#model = model;
    this.#apiKey = apiKey;
    this.#fetch = fetch;
  }

  async complete(request: ProviderRequest): Promise<unknown> {
    const body = serializeRequest(this.#model, request);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, PROVIDER_REQUEST_TIMEOUT_MS);

    try {
      let response: Response;
      try {
        response = await raceWithAbort(
          () =>
            this.#fetch(this.#endpoint, {
              method: "POST",
              headers: {
                authorization: `Bearer ${this.#apiKey}`,
                "content-type": "application/json",
              },
              body,
              redirect: "error",
              signal: controller.signal,
            }),
          controller.signal,
          cancelResponseBody,
        );
      } catch {
        throw errorForSignal(controller.signal, "PROVIDER_NETWORK_ERROR");
      }

      let responseIsSuccessful: unknown;
      try {
        responseIsSuccessful = response.ok;
      } catch {
        cancelResponseBody(response);
        throw errorForSignal(controller.signal, "PROVIDER_INVALID_RESPONSE");
      }

      if (typeof responseIsSuccessful !== "boolean") {
        cancelResponseBody(response);
        throw errorForSignal(controller.signal, "PROVIDER_INVALID_RESPONSE");
      }

      if (!responseIsSuccessful) {
        cancelResponseBody(response);
        throw errorForSignal(controller.signal, "PROVIDER_NETWORK_ERROR");
      }

      try {
        const responseText = await readBoundedUtf8Body(response, controller.signal);
        const completion = JSON.parse(responseText) as unknown;
        const content = getCompletionContent(completion);
        const result = JSON.parse(content) as unknown;

        if (controller.signal.aborted) {
          throw new ProviderError("PROVIDER_TIMEOUT");
        }

        return result;
      } catch {
        throw errorForSignal(controller.signal, "PROVIDER_INVALID_RESPONSE");
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

function readProviderOptions(
  options: OpenAICompatibleProviderOptions,
): OpenAICompatibleProviderOptions {
  try {
    return {
      endpoint: options.endpoint,
      model: options.model,
      apiKey: options.apiKey,
      fetch: options.fetch,
    };
  } catch {
    throw new ProviderError("PROVIDER_INVALID_ENDPOINT");
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
    throw new Error();
  }

  const firstChoice = completion.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throw new Error();
  }

  const { content } = firstChoice.message;
  if (typeof content !== "string") {
    throw new Error();
  }

  return content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorForSignal(
  signal: AbortSignal,
  code: "PROVIDER_NETWORK_ERROR" | "PROVIDER_INVALID_RESPONSE",
): ProviderError {
  return new ProviderError(signal.aborted ? "PROVIDER_TIMEOUT" : code);
}

async function readBoundedUtf8Body(response: Response, signal: AbortSignal): Promise<string> {
  const body: unknown = response.body;

  if (!isObject(body)) {
    cancelBody(body);
    throw new Error();
  }

  let reader: unknown;
  try {
    const getReader = (body as { getReader?: unknown }).getReader;
    if (typeof getReader !== "function") {
      throw new Error();
    }

    reader = getReader.call(body);
    if (!isObject(reader)) {
      throw new Error();
    }
  } catch (error) {
    cancelBody(body);
    throw error;
  }

  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let byteLength = 0;
    let text = "";

    while (true) {
      const chunk = await raceWithAbort(
        () => {
          const read = (reader as { read?: unknown }).read;
          if (typeof read !== "function") {
            throw new Error();
          }

          return read.call(reader) as Promise<ReadableStreamReadResult<Uint8Array>>;
        },
        signal,
      );

      if (chunk.done) {
        return text + decoder.decode();
      }

      if (!(chunk.value instanceof Uint8Array)) {
        throw new Error();
      }

      if (chunk.value.byteLength > MAX_PROVIDER_RESPONSE_BYTES - byteLength) {
        throw new Error();
      }

      byteLength += chunk.value.byteLength;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    if (!cancelReader(reader)) {
      cancelBody(body);
    }
    throw error;
  } finally {
    releaseReader(reader);
  }
}

function raceWithAbort<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  onLateResolution?: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (settlement: () => void): boolean => {
      if (settled) {
        return false;
      }

      settled = true;
      signal.removeEventListener("abort", onAbort);
      settlement();
      return true;
    };
    const onAbort = () => {
      settle(() => reject(new ProviderError("PROVIDER_TIMEOUT")));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });

    try {
      const operationPromise = operation();
      Promise.resolve(operationPromise).then(
        (value) => {
          if (!settle(() => resolve(value))) {
            onLateResolution?.(value);
          }
        },
        (error: unknown) => {
          settle(() => reject(error));
        },
      );
    } catch (error) {
      settle(() => reject(error));
    }
  });
}

function cancelResponseBody(response: unknown): void {
  try {
    cancelBody((response as { body?: unknown }).body);
  } catch {
    // Best-effort cleanup must never replace a stable provider error.
  }
}

function cancelBody(body: unknown): void {
  if (!isObject(body)) {
    return;
  }

  try {
    const cancel = (body as { cancel?: unknown }).cancel;
    if (typeof cancel !== "function") {
      return;
    }

    void Promise.resolve(cancel.call(body)).catch(() => undefined);
  } catch {
    // Best-effort cleanup must never replace a stable provider error.
  }
}

function cancelReader(reader: unknown): boolean {
  if (!isObject(reader)) {
    return false;
  }

  try {
    const cancel = (reader as { cancel?: unknown }).cancel;
    if (typeof cancel !== "function") {
      return false;
    }

    void Promise.resolve(cancel.call(reader)).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

function releaseReader(reader: unknown): void {
  if (!isObject(reader)) {
    return;
  }

  try {
    const releaseLock = (reader as { releaseLock?: unknown }).releaseLock;
    if (typeof releaseLock === "function") {
      releaseLock.call(reader);
    }
  } catch {
    // Best-effort cleanup must never replace a stable provider error.
  }
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
