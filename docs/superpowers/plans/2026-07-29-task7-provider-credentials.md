# Task 7 Provider and Windows Credential Abstractions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an offline-testable provider package with a scripted mock, a bounded OpenAI-compatible transport, and a Windows Credential Manager abstraction that never persists or exposes secrets outside its backend boundary.

**Architecture:** `packages/providers` owns one-shot Provider transport only. The mock deep-freezes snapshots for deterministic Task 8 feedback tests; the compatible provider accepts an injected fetch implementation and returns JSON-decoded `unknown` without interpreting Actions. Credential storage is injected through a narrow keytar-shaped port, so mock/unit tests never load the native keytar module or contact Windows Credential Manager.

**Tech Stack:** Node.js 22.17.0, TypeScript 5.9.3 (ESM), Vitest 4.1.10, native `fetch`/Web Streams, and keytar 7.9.0 through an injected runtime port.

---

## File map

| File | Responsibility |
| --- | --- |
| `packages/providers/package.json` | Register the private `@kadsoo/codesentinel-providers` workspace package. |
| `packages/providers/src/provider.ts` | Provider message/request contract, stable provider errors, deep snapshot helper, and explicit non-executing probe request. |
| `packages/providers/src/mock.ts` | Deterministic finite scripted Provider with immutable request and response snapshots. |
| `packages/providers/src/openai-compatible.ts` | HTTPS-only bounded compatibility transport with injected `fetch`, timeout, no redirects/retries, and safe response decoding. |
| `packages/providers/src/credential-store.ts` | Credential store interface, in-memory test store, injected Keytar port, and Windows Credential Manager adapter. |
| `packages/providers/src/provider.test.ts` | Provider contract, scripted mock, snapshot, exhaustion, and probe tests. |
| `packages/providers/src/openai-compatible.test.ts` | Transport safety, no-leak, timeout, status, response-size, and malformed-response tests using fake fetch. |
| `packages/providers/src/credential-store.test.ts` | In-memory and injected Windows credential store tests without keytar loading. |
| `packages/providers/src/index.ts` | Explicit public exports for Task 8 and future composition roots. |
| `package-lock.json` | Register the new workspace link without adding or changing external dependencies. |
| `PLAN.md` | Mark Task 7 complete and correct the Task 8 provider package example after integration. |
| `AGENT_LOG.md` | Record actual TDD, review, merge, and verification evidence after integration. |

## Non-negotiable boundaries

- Do not import `keytar` anywhere in `packages/providers`; Task 10 dynamically loads it in the CLI composition root and injects the narrow port.
- Do not read `process.env`, `.env`, workspace files, SQLite, or Git for an API key.
- Do not log, return, persist, attach as `cause`, or include in thrown messages a key, Authorization header, provider body, or raw keytar/fetch exception.
- Do not use `findPassword` or `findCredentials`; only `getPassword`, `setPassword`, and `deletePassword` are allowed.
- Do not access DeepSeek, NJU SE Hub, Windows Credential Manager, or the network in tests, CI, or this task's verification.
- Do not make the explicit `probeProvider` call part of startup, test, CI, or demo paths. It only invokes an already-composed Provider once and never executes an Action.
- Do not add an HTTP exception for NJU SE Hub. A later user-approved security design is required before any key can be sent to HTTP.

### Task 0: Create an isolated Task 7 worktree and establish the baseline

**Files:**

- No source files change in this task.

- [ ] **Step 1: Verify the main checkout is clean and create the feature worktree**

Run from the repository root:

```powershell
git status --short --branch
git worktree add .worktrees/task-7-providers -b feat/task-7-providers main
```

Expected: `main` has no uncommitted changes before the worktree is created. The new worktree is `CodeSentinel/.worktrees/task-7-providers` on `feat/task-7-providers` and is based on the approved specification commit `47e7c31` or its descendant. Do not use `git pull`, `git push`, or a global `safe.directory` configuration.

- [ ] **Step 2: Install the already-locked dependencies without native install scripts**

Run inside `CodeSentinel/.worktrees/task-7-providers`:

```powershell
npm ci --offline --ignore-scripts --no-audit --no-fund
npm test -- --run packages/contracts/src/id.test.ts
```

Expected: npm uses the existing lockfile and does not run keytar's native install script. The baseline contract test passes. Record no server PID because these commands do not start a long-lived process.

### Task 1: Define the Provider contract, deterministic mock, and explicit probe

**Files:**

- Create: `packages/providers/package.json`
- Create: `packages/providers/src/provider.ts`
- Create: `packages/providers/src/mock.ts`
- Create: `packages/providers/src/provider.test.ts`
- Create: `packages/providers/src/index.ts`

- [ ] **Step 1: Create the package manifest and write the failing Provider tests**

Create `packages/providers/package.json`:

```json
{
  "name": "@kadsoo/codesentinel-providers",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts"
}
```

Create `packages/providers/src/provider.test.ts` before creating any implementation module:

```ts
import { describe, expect, it, vi } from "vitest";
import { ScriptedMockProvider } from "./mock.js";
import {
  PROVIDER_PROBE_REQUEST,
  probeProvider,
  type ProviderRequest,
} from "./provider.js";

const request: ProviderRequest = {
  messages: [{ role: "user", content: "Repair the failing test." }],
};

describe("ScriptedMockProvider", () => {
  it("returns scripted responses in order", async () => {
    const provider = new ScriptedMockProvider([
      { kind: "run_verification", commandId: "test" },
      { kind: "finish", outcome: "completed", summary: "done" },
    ]);

    await expect(provider.complete(request)).resolves.toEqual({
      kind: "run_verification",
      commandId: "test",
    });
    await expect(provider.complete(request)).resolves.toEqual({
      kind: "finish",
      outcome: "completed",
      summary: "done",
    });
  });

  it("captures deeply immutable request and response snapshots", async () => {
    const mutableRequest: { messages: Array<{ role: "user"; content: string }> } = {
      messages: [{ role: "user", content: "original" }],
    };
    const provider = new ScriptedMockProvider([{ nested: { value: "scripted" } }]);

    const response = (await provider.complete(mutableRequest)) as { nested: { value: string } };
    mutableRequest.messages[0]!.content = "mutated after call";

    expect(provider.requests[0]?.messages[0]?.content).toBe("original");
    expect(Object.isFrozen(provider.requests)).toBe(true);
    expect(Object.isFrozen(provider.requests[0])).toBe(true);
    expect(Object.isFrozen(provider.requests[0]?.messages)).toBe(true);
    expect(Object.isFrozen(provider.requests[0]?.messages[0])).toBe(true);
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.nested)).toBe(true);
  });

  it("fails safely when the finite script is exhausted", async () => {
    const provider = new ScriptedMockProvider([]);

    await expect(provider.complete(request)).rejects.toMatchObject({
      code: "PROVIDER_SCRIPT_EXHAUSTED",
    });
  });
});

describe("probeProvider", () => {
  it("performs one explicit Provider call without interpreting or executing its result", async () => {
    const complete = vi.fn().mockResolvedValue({ kind: "finish", summary: "uninterpreted" });

    await probeProvider({ complete });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(PROVIDER_PROBE_REQUEST);
    expect(PROVIDER_PROBE_REQUEST.messages[0]?.content).toContain("connectivity");
  });
});
```

- [ ] **Step 2: Run the focused test and record the red state**

Run:

```powershell
npm test -- --run packages/providers/src/provider.test.ts
```

Expected: the test command fails because `mock.js` and `provider.js` do not exist. Do not create a placeholder implementation merely to change the failure shape.

- [ ] **Step 3: Implement the Provider boundary and deterministic mock**

Create `packages/providers/src/provider.ts`:

```ts
export type ProviderRole = "system" | "user" | "assistant";

export type ProviderMessage = Readonly<{
  role: ProviderRole;
  content: string;
}>;

export type ProviderRequest = Readonly<{
  messages: readonly ProviderMessage[];
}>;

export interface Provider {
  complete(request: ProviderRequest): Promise<unknown>;
}

export type ProviderErrorCode =
  | "PROVIDER_INVALID_ENDPOINT"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_NETWORK_ERROR"
  | "PROVIDER_INVALID_RESPONSE"
  | "PROVIDER_SCRIPT_EXHAUSTED";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode) {
    super(code);
    this.name = "ProviderError";
    this.code = code;
  }
}

export const PROVIDER_PROBE_REQUEST: ProviderRequest = cloneAndFreeze({
  messages: [
    {
      role: "user",
      content:
        'Respond with exactly JSON: {"kind":"finish","outcome":"completed","summary":"provider connectivity check"}.',
    },
  ],
});

export async function probeProvider(provider: Provider): Promise<void> {
  await provider.complete(PROVIDER_PROBE_REQUEST);
}

export function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return value;
  }

  seen.add(value);
  for (const property of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    if (descriptor !== undefined && "value" in descriptor) {
      deepFreeze(descriptor.value, seen);
    }
  }
  Object.freeze(value);
  return value;
}
```

Create `packages/providers/src/mock.ts`:

```ts
import {
  cloneAndFreeze,
  ProviderError,
  type Provider,
  type ProviderRequest,
} from "./provider.js";

export class ScriptedMockProvider implements Provider {
  readonly #responses: readonly unknown[];
  readonly #requests: ProviderRequest[] = [];
  #nextResponseIndex = 0;

  constructor(responses: readonly unknown[]) {
    this.#responses = Object.freeze(responses.map((response) => cloneAndFreeze(response)));
  }

  get requests(): readonly ProviderRequest[] {
    return Object.freeze([...this.#requests]);
  }

  async complete(request: ProviderRequest): Promise<unknown> {
    this.#requests.push(cloneAndFreeze(request));

    if (this.#nextResponseIndex >= this.#responses.length) {
      throw new ProviderError("PROVIDER_SCRIPT_EXHAUSTED");
    }

    const response = this.#responses[this.#nextResponseIndex];
    this.#nextResponseIndex += 1;
    return cloneAndFreeze(response);
  }
}
```

Create `packages/providers/src/index.ts`:

```ts
export { ScriptedMockProvider } from "./mock.js";
export { PROVIDER_PROBE_REQUEST, probeProvider, ProviderError } from "./provider.js";
export type {
  Provider,
  ProviderErrorCode,
  ProviderMessage,
  ProviderRequest,
  ProviderRole,
} from "./provider.js";
```

- [ ] **Step 4: Run the focused Provider tests and static checks**

Run:

```powershell
npm test -- --run packages/providers/src/provider.test.ts
npm run typecheck
npm run lint
```

Expected: all commands pass. The mock returns only cloned/frozen values, records each attempted request including an exhausted call, and has no import or call path to network or keytar.

- [ ] **Step 5: Commit the Provider contract and mock**

```powershell
git add packages/providers/package.json packages/providers/src/provider.ts packages/providers/src/mock.ts packages/providers/src/provider.test.ts packages/providers/src/index.ts
git commit -m "feat: add provider contract and scripted mock"
```

### Task 2: Add the bounded OpenAI-compatible Provider transport

**Files:**

- Create: `packages/providers/src/openai-compatible.ts`
- Create: `packages/providers/src/openai-compatible.test.ts`
- Modify: `packages/providers/src/index.ts`

- [ ] **Step 1: Write failing transport tests with an injected fake fetch**

Create `packages/providers/src/openai-compatible.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  MAX_PROVIDER_RESPONSE_BYTES,
  OpenAICompatibleProvider,
  PROVIDER_REQUEST_TIMEOUT_MS,
  type FetchLike,
} from "./openai-compatible.js";
import { type ProviderRequest } from "./provider.js";

const endpoint = "https://provider.example/v1/chat/completions";
const apiKey = "provider-api-key-sentinel";
const request: ProviderRequest = {
  messages: [{ role: "user", content: "Return one structured action." }],
};

function createProvider(fetch: FetchLike): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    endpoint,
    model: "test-model",
    apiKey,
    fetch,
  });
}

function validResponse(payload: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function expectSafeError(
  operation: () => Promise<unknown>,
  code: string,
  forbiddenText: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await operation();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toMatchObject({ code });
  expect(String(thrown)).not.toContain(forbiddenText);
  expect((thrown as { cause?: unknown }).cause).toBeUndefined();
}

describe("OpenAICompatibleProvider", () => {
  it("sends one bounded no-redirect JSON request through its injected fetch", async () => {
    let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined;
    const fetch: FetchLike = async (input, init) => {
      captured = { input, init };
      return validResponse({ kind: "finish", outcome: "completed", summary: "done" });
    };

    const result = await createProvider(fetch).complete(request);
    const headers = new Headers(captured?.init?.headers);

    expect(result).toEqual({ kind: "finish", outcome: "completed", summary: "done" });
    expect(captured?.input).toBe(endpoint);
    expect(captured?.init).toMatchObject({ method: "POST", redirect: "error" });
    expect(headers.get("authorization")).toBe(`Bearer ${apiKey}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(captured?.init?.body))).toEqual({
      model: "test-model",
      messages: request.messages,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects insecure or credential-bearing endpoints without calling fetch", () => {
    const fetch = vi.fn<FetchLike>();

    for (const unsafeEndpoint of [
      "http://provider.example/chat/completions",
      "https://user:password@provider.example/chat/completions",
      "https://provider.example/chat/completions?token=leak",
      "https://provider.example/chat/completions#fragment",
    ]) {
      expect(() =>
        new OpenAICompatibleProvider({
          endpoint: unsafeEndpoint,
          model: "test-model",
          apiKey,
          fetch,
        }),
      ).toThrowError("PROVIDER_INVALID_ENDPOINT");
    }

    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps a raw network exception to one safe no-retry error", async () => {
    const fetch = vi.fn<FetchLike>(async () => {
      throw new Error(`network failure includes ${apiKey}`);
    });

    await expectSafeError(
      () => createProvider(fetch).complete(request),
      "PROVIDER_NETWORK_ERROR",
      apiKey,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("maps non-success bodies and malformed or oversized replies to safe errors", async () => {
    const unsafeBodies = [
      new Response(`server body includes ${apiKey}`, { status: 500 }),
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      new Response(
        JSON.stringify({ choices: [{ message: { content: `not-json-${apiKey}` } }] }),
        { status: 200 },
      ),
      new Response("x".repeat(MAX_PROVIDER_RESPONSE_BYTES + 1), { status: 200 }),
    ];

    for (const response of unsafeBodies) {
      await expectSafeError(
        () => createProvider(async () => response).complete(request),
        response.status === 500 ? "PROVIDER_NETWORK_ERROR" : "PROVIDER_INVALID_RESPONSE",
        apiKey,
      );
    }
  });

  it("aborts an unresponsive fetch at the fixed timeout without exposing the abort error", async () => {
    vi.useFakeTimers();
    try {
      const fetch: FetchLike = (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error(`abort includes ${apiKey}`)),
            { once: true },
          );
        });
      const rejection = expect(createProvider(fetch).complete(request)).rejects;

      await vi.advanceTimersByTimeAsync(PROVIDER_REQUEST_TIMEOUT_MS);

      await rejection.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run the transport test and record the red state**

Run:

```powershell
npm test -- --run packages/providers/src/openai-compatible.test.ts
```

Expected: failure because `openai-compatible.js` and its exports do not exist. The test must not make an HTTP request because every fetch is injected.

- [ ] **Step 3: Implement the strict compatible transport**

Create `packages/providers/src/openai-compatible.ts`:

```ts
import {
  cloneAndFreeze,
  ProviderError,
  type Provider,
  type ProviderRequest,
} from "./provider.js";

export const PROVIDER_REQUEST_TIMEOUT_MS = 20_000;
export const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type OpenAICompatibleProviderOptions = Readonly<{
  endpoint: string;
  model: string;
  apiKey: string;
  fetch: FetchLike;
}>;

export class OpenAICompatibleProvider implements Provider {
  readonly #endpoint: string;
  readonly #model: string;
  readonly #apiKey: string;
  readonly #fetch: FetchLike;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.#endpoint = parseSafeEndpoint(options.endpoint);
    this.#model = options.model;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch;
  }

  async complete(request: ProviderRequest): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, PROVIDER_REQUEST_TIMEOUT_MS);

    try {
      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: this.#model, messages: request.messages }),
        redirect: "error",
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new ProviderError("PROVIDER_NETWORK_ERROR");
      }

      const body = await readBoundedResponse(response);
      return cloneAndFreeze(extractCompatiblePayload(body));
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }

      if (timedOut) {
        throw new ProviderError("PROVIDER_TIMEOUT");
      }

      throw new ProviderError("PROVIDER_NETWORK_ERROR");
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseSafeEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new ProviderError("PROVIDER_INVALID_ENDPOINT");
  }

  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new ProviderError("PROVIDER_INVALID_ENDPOINT");
  }

  return endpoint.href;
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (response.body === null) {
    throw new ProviderError("PROVIDER_INVALID_RESPONSE");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        break;
      }

      totalBytes += next.value.byteLength;
      if (totalBytes > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderError("PROVIDER_INVALID_RESPONSE");
      }

      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    throw new ProviderError("PROVIDER_INVALID_RESPONSE");
  }
}

function extractCompatiblePayload(body: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ProviderError("PROVIDER_INVALID_RESPONSE");
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) {
    throw new ProviderError("PROVIDER_INVALID_RESPONSE");
  }

  const firstChoice = parsed.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throw new ProviderError("PROVIDER_INVALID_RESPONSE");
  }

  const content = firstChoice.message.content;
  if (typeof content !== "string") {
    throw new ProviderError("PROVIDER_INVALID_RESPONSE");
  }

  try {
    return JSON.parse(content);
  } catch {
    throw new ProviderError("PROVIDER_INVALID_RESPONSE");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
```

Replace `packages/providers/src/index.ts` with:

```ts
export { ScriptedMockProvider } from "./mock.js";
export {
  MAX_PROVIDER_RESPONSE_BYTES,
  OpenAICompatibleProvider,
  PROVIDER_REQUEST_TIMEOUT_MS,
} from "./openai-compatible.js";
export type { FetchLike, OpenAICompatibleProviderOptions } from "./openai-compatible.js";
export { PROVIDER_PROBE_REQUEST, probeProvider, ProviderError } from "./provider.js";
export type {
  Provider,
  ProviderErrorCode,
  ProviderMessage,
  ProviderRequest,
  ProviderRole,
} from "./provider.js";
```

- [ ] **Step 4: Run transport, Provider, and static checks**

Run:

```powershell
npm test -- --run packages/providers/src/provider.test.ts packages/providers/src/openai-compatible.test.ts
npm run typecheck
npm run lint
```

Expected: all commands pass. Every non-success status, raw fetch exception, malformed body, oversized body, and abort maps to a fixed `ProviderError` code without a raw `cause`, body, endpoint query, or API key. Fetch is called once per completion and receives `redirect: "error"`.

- [ ] **Step 5: Commit the compatible transport**

```powershell
git add packages/providers/src/openai-compatible.ts packages/providers/src/openai-compatible.test.ts packages/providers/src/index.ts
git commit -m "feat: add bounded compatible provider transport"
```

### Task 3: Add test-only memory credentials and injected Windows credentials

**Files:**

- Create: `packages/providers/src/credential-store.ts`
- Create: `packages/providers/src/credential-store.test.ts`
- Modify: `packages/providers/src/index.ts`

- [ ] **Step 1: Write failing credential-store tests without loading keytar**

Create `packages/providers/src/credential-store.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  CODESENTINEL_CREDENTIAL_SERVICE,
  CredentialStoreError,
  InMemoryCredentialStore,
  WindowsCredentialStore,
  type KeytarLike,
} from "./credential-store.js";

const ref = "deepseek-default";
const secret = "credential-secret-sentinel";

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }

  throw new Error("Expected the operation to reject.");
}

function createKeytar(overrides: Partial<KeytarLike> = {}): KeytarLike {
  return {
    getPassword: vi.fn(async () => null),
    setPassword: vi.fn(async () => undefined),
    deletePassword: vi.fn(async () => true),
    ...overrides,
  };
}

describe("InMemoryCredentialStore", () => {
  it("reports status without returning a secret through status", async () => {
    const store = new InMemoryCredentialStore();

    await store.set(ref, secret);

    await expect(store.status(ref)).resolves.toBe("configured");
    await expect(store.get(ref)).resolves.toBe(secret);
    await store.clear(ref);
    await expect(store.status(ref)).resolves.toBe("missing");
    await expect(store.get(ref)).resolves.toBeUndefined();
  });

  it("rejects unsafe credential references and blank secrets", async () => {
    const store = new InMemoryCredentialStore();

    for (const unsafeRef of ["", "../outside", "nested/ref", "bad\u0000ref", ".leading-dot"]) {
      await expect(store.status(unsafeRef)).rejects.toMatchObject({
        code: "CREDENTIAL_INVALID_INPUT",
      });
    }

    await expect(store.set(ref, "   ")).rejects.toMatchObject({
      code: "CREDENTIAL_INVALID_INPUT",
    });
  });
});

describe("WindowsCredentialStore", () => {
  it("uses only the fixed service and one validated account", async () => {
    const getPassword = vi.fn(async () => secret);
    const setPassword = vi.fn(async () => undefined);
    const deletePassword = vi.fn(async () => true);
    const keytar: KeytarLike = { getPassword, setPassword, deletePassword };
    const store = new WindowsCredentialStore(keytar);

    await store.set(ref, secret);
    await expect(store.get(ref)).resolves.toBe(secret);
    await expect(store.status(ref)).resolves.toBe("configured");
    await store.clear(ref);

    expect(setPassword).toHaveBeenCalledWith(CODESENTINEL_CREDENTIAL_SERVICE, ref, secret);
    expect(getPassword).toHaveBeenCalledWith(CODESENTINEL_CREDENTIAL_SERVICE, ref);
    expect(deletePassword).toHaveBeenCalledWith(CODESENTINEL_CREDENTIAL_SERVICE, ref);
  });

  it("maps a keytar exception containing a secret to an unavailable error without cause", async () => {
    const keytar = createKeytar({
      getPassword: vi.fn(async () => {
        throw new Error(`native failure contains ${secret}`);
      }),
    });
    const store = new WindowsCredentialStore(keytar);

    const error = await captureError(() => store.get(ref));

    expect(error).toBeInstanceOf(CredentialStoreError);
    expect(error).toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    expect(String(error)).not.toContain(secret);
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });

  it("treats a missing keytar record as missing and never enumerates credentials", async () => {
    const getPassword = vi.fn(async () => null);
    const keytar = createKeytar({ getPassword });
    const store = new WindowsCredentialStore(keytar);

    await expect(store.get(ref)).resolves.toBeUndefined();
    await expect(store.status(ref)).resolves.toBe("missing");
    expect(Object.keys(keytar)).toEqual(["getPassword", "setPassword", "deletePassword"]);
  });
});
```

- [ ] **Step 2: Run the credential tests and record the red state**

Run:

```powershell
npm test -- --run packages/providers/src/credential-store.test.ts
```

Expected: failure because `credential-store.js` does not exist. Confirm that the failure does not attempt to load `keytar` or call Windows Credential Manager.

- [ ] **Step 3: Implement the credential stores and safe errors**

Create `packages/providers/src/credential-store.ts`:

```ts
export const CODESENTINEL_CREDENTIAL_SERVICE = "Kadsoo.CodeSentinel";

export type CredentialStatus = "configured" | "missing";
export type CredentialStoreErrorCode = "CREDENTIAL_INVALID_INPUT" | "CREDENTIAL_UNAVAILABLE";

export class CredentialStoreError extends Error {
  readonly code: CredentialStoreErrorCode;

  constructor(code: CredentialStoreErrorCode) {
    super(code);
    this.name = "CredentialStoreError";
    this.code = code;
  }
}

export interface CredentialStore {
  set(reference: string, secret: string): Promise<void>;
  get(reference: string): Promise<string | undefined>;
  status(reference: string): Promise<CredentialStatus>;
  clear(reference: string): Promise<void>;
}

export interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

export class InMemoryCredentialStore implements CredentialStore {
  readonly #secrets = new Map<string, string>();

  async set(reference: string, secret: string): Promise<void> {
    this.#secrets.set(validateReference(reference), validateSecret(secret));
  }

  async get(reference: string): Promise<string | undefined> {
    return this.#secrets.get(validateReference(reference));
  }

  async status(reference: string): Promise<CredentialStatus> {
    return (await this.get(reference)) === undefined ? "missing" : "configured";
  }

  async clear(reference: string): Promise<void> {
    this.#secrets.delete(validateReference(reference));
  }
}

export class WindowsCredentialStore implements CredentialStore {
  readonly #keytar: KeytarLike;

  constructor(keytar: KeytarLike) {
    this.#keytar = keytar;
  }

  async set(reference: string, secret: string): Promise<void> {
    const account = validateReference(reference);
    const password = validateSecret(secret);
    await callKeytar(() =>
      this.#keytar.setPassword(CODESENTINEL_CREDENTIAL_SERVICE, account, password),
    );
  }

  async get(reference: string): Promise<string | undefined> {
    const account = validateReference(reference);
    const password = await callKeytar(() =>
      this.#keytar.getPassword(CODESENTINEL_CREDENTIAL_SERVICE, account),
    );
    return password ?? undefined;
  }

  async status(reference: string): Promise<CredentialStatus> {
    return (await this.get(reference)) === undefined ? "missing" : "configured";
  }

  async clear(reference: string): Promise<void> {
    const account = validateReference(reference);
    await callKeytar(() =>
      this.#keytar.deletePassword(CODESENTINEL_CREDENTIAL_SERVICE, account),
    );
  }
}

function validateReference(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new CredentialStoreError("CREDENTIAL_INVALID_INPUT");
  }

  return value;
}

function validateSecret(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 4_096) {
    throw new CredentialStoreError("CREDENTIAL_INVALID_INPUT");
  }

  return value;
}

async function callKeytar<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new CredentialStoreError("CREDENTIAL_UNAVAILABLE");
  }
}
```

Replace `packages/providers/src/index.ts` with:

```ts
export {
  CODESENTINEL_CREDENTIAL_SERVICE,
  CredentialStoreError,
  InMemoryCredentialStore,
  WindowsCredentialStore,
} from "./credential-store.js";
export type {
  CredentialStatus,
  CredentialStore,
  CredentialStoreErrorCode,
  KeytarLike,
} from "./credential-store.js";
export { ScriptedMockProvider } from "./mock.js";
export {
  MAX_PROVIDER_RESPONSE_BYTES,
  OpenAICompatibleProvider,
  PROVIDER_REQUEST_TIMEOUT_MS,
} from "./openai-compatible.js";
export type { FetchLike, OpenAICompatibleProviderOptions } from "./openai-compatible.js";
export { PROVIDER_PROBE_REQUEST, probeProvider, ProviderError } from "./provider.js";
export type {
  Provider,
  ProviderErrorCode,
  ProviderMessage,
  ProviderRequest,
  ProviderRole,
} from "./provider.js";
```

- [ ] **Step 4: Run credential, Provider, and static checks**

Run:

```powershell
npm test -- --run packages/providers/src/provider.test.ts packages/providers/src/openai-compatible.test.ts packages/providers/src/credential-store.test.ts
npm run typecheck
npm run lint
```

Expected: all commands pass. The tests import only the local injected `KeytarLike` shape; no test import reaches the native `keytar` module. A status call returns only `configured` or `missing`; a keytar failure throws `CREDENTIAL_UNAVAILABLE` with no raw cause.

- [ ] **Step 5: Commit the credential abstraction**

```powershell
git add packages/providers/src/credential-store.ts packages/providers/src/credential-store.test.ts packages/providers/src/index.ts
git commit -m "feat: add Windows credential store abstraction"
```

### Task 4: Register the workspace and run the complete offline regression suite

**Files:**

- Modify: `package-lock.json`

- [ ] **Step 1: Update only the workspace lockfile entry**

Run inside `CodeSentinel/.worktrees/task-7-providers`:

```powershell
npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund
npm ls @kadsoo/codesentinel-providers --depth=0
```

Expected: `package-lock.json` gains the `packages/providers` workspace record and its local link. No package version changes, network access, native keytar build, or source modification occurs.

- [ ] **Step 2: Run focused and whole-repository checks from the clean lockfile state**

Run:

```powershell
npm ci --offline --ignore-scripts --no-audit --no-fund
npm test -- --run packages/providers/src/provider.test.ts packages/providers/src/openai-compatible.test.ts packages/providers/src/credential-store.test.ts
npm test
npm run typecheck
npm run lint
git diff --check main...HEAD
```

Expected: all commands pass. No process remains running after the commands. The complete test run stays offline, and no test requires a real Provider, real credential, or native keytar binary.

- [ ] **Step 3: Commit the workspace registration**

```powershell
git add package-lock.json
git commit -m "chore: register provider workspace"
```

### Task 5: Perform independent security and quality review before local integration

**Files:**

- Review only: all Task 7 branch changes against `main` and `docs/superpowers/specs/2026-07-29-task7-provider-credential-design.md`.

- [ ] **Step 1: Request an independent security review with no write authority**

Give a fresh reviewer the approved specification path and the range `main...feat/task-7-providers`. Require it to inspect these exact concerns:

```text
1. No static keytar import, native module load, credential enumeration, environment read, plaintext fallback, or secret persistence.
2. No raw API key, Authorization value, response body, endpoint query, fetch exception, keytar exception, or Error.cause can leave the provider/credential boundary.
3. Endpoint validation requires HTTPS and rejects username, password, query, fragment, redirect following, unbounded response capture, and retry behavior.
4. Provider returns unknown data only and does not validate or execute Actions.
5. Tests have zero real network and zero real Credential Manager access.
```

Expected: the reviewer returns `COMPLIANT` or a ranked list of concrete findings with file/line evidence. Do not merge while any Critical or Important finding remains unresolved.

- [ ] **Step 2: Request a separate quality and compatibility review with no write authority**

Give a different reviewer the same specification and range. Require it to inspect:

```text
1. ESM .js imports, strict TypeScript, package name, public exports, and package-lock workspace link.
2. Scripted request snapshots are deeply immutable and cannot be altered by callers.
3. Test names cover success, exhaustion, endpoint refusal, status/timeout/network failures, malformed/oversized bodies, credential missing/unavailable, and no-leak behavior.
4. Task 8 can use ProviderRequest, Provider, ScriptedMockProvider.requests, and unknown completion results without a dependency cycle.
5. The branch changes no policy, tool, database, CLI, API, or workspace-write behavior outside Task 7.
```

Expected: the reviewer returns `COMPLIANT` or a ranked list of concrete findings with file/line evidence.

- [ ] **Step 3: Address only substantiated review findings through the affected red-green loop**

For each accepted finding, first add a failing test to the relevant existing test file, run that single test to capture the red state, implement the smallest change in the named source file, then re-run its focused test plus `npm run typecheck` and `npm run lint`. Commit each coherent correction with a message describing the repaired boundary. Reject findings that conflict with the approved specification and record the exact reason in the review handoff.

- [ ] **Step 4: Re-run final branch verification**

Run:

```powershell
npm test
npm run typecheck
npm run lint
git diff --check main...HEAD
git status --short --branch
```

Expected: tests, type check, lint, and diff check pass; the feature branch has no uncommitted files. Preserve the reviewers' final conclusions for `AGENT_LOG.md` after integration.

### Task 6: Locally merge the reviewed branch and record completion evidence

**Files:**

- Modify: `PLAN.md`
- Modify: `AGENT_LOG.md`

- [ ] **Step 1: Merge locally without contacting GitHub**

From the main worktree, first verify the target and branch state, then merge:

```powershell
git status --short --branch
git log --oneline -1 main
git log --oneline -1 feat/task-7-providers
git merge --no-ff feat/task-7-providers -m "merge: complete Task 7 provider abstractions"
```

Expected: `main` receives a local merge commit. Do not run `git pull`, `git push`, publish a package, invoke a real provider probe, or load a real Credential Manager credential.

- [ ] **Step 2: Update the root plan and agent log with actual evidence only**

In `PLAN.md`, mark all five original Task 7 steps as completed and replace the Task 8 sample import:

```ts
import { ScriptedMockProvider } from "@kadsoo/codesentinel-providers";
```

Add an `AGENT_LOG.md` entry containing the feature branch name, local merge commit, the exact focused/full test, typecheck, lint, and diff-check results, both reviewer conclusions, the fact that no remote push/pull occurred, and the retained security boundaries: no real Key, no real Provider, no CLI dynamic keytar load, no plaintext fallback, and no HTTP endpoint exception. Do not include a key, URL with a query, raw transport body, raw error, or unverified result.

- [ ] **Step 3: Verify the merged main branch and commit the completion record**

Run:

```powershell
npm test
npm run typecheck
npm run lint
git diff --check
git status --short --branch
git add PLAN.md AGENT_LOG.md
git commit -m "docs: record Task 7 completion"
git status --short --branch
```

Expected: all checks pass on `main`, the documentation commit contains only `PLAN.md` and `AGENT_LOG.md`, and the working tree is clean. These commands do not leave a running process.

- [ ] **Step 4: Remove only the verified Task 7 worktree after successful integration**

Run from the main worktree only after `git worktree list` shows the exact Task 7 path and `git status --short --branch` is clean:

```powershell
$root = (Resolve-Path '.').Path
$target = Join-Path $root '.worktrees/task-7-providers'
if (-not $target.StartsWith((Join-Path $root '.worktrees'))) { throw "Refusing to remove a path outside .worktrees: $target" }
git worktree remove $target
git branch -d feat/task-7-providers
```

Expected: only `CodeSentinel/.worktrees/task-7-providers` and its merged local branch are removed. Do not remove any other worktree or branch.
