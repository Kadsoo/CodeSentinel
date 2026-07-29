import { describe, expect, it, vi } from "vitest";
import type { KeytarLike } from "./credential-store.js";

const reference = "openai.default";
const secretSentinel = "credential-secret-sentinel";

type CredentialStoreErrorCode = "CREDENTIAL_INVALID_INPUT" | "CREDENTIAL_UNAVAILABLE";

async function credentials() {
  return import("./credential-store.js");
}

async function captureFailure(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }

  return undefined;
}

async function expectCredentialStoreError(
  operation: () => Promise<unknown>,
  code: CredentialStoreErrorCode,
): Promise<void> {
  const { CredentialStoreError } = await credentials();
  const error = await captureFailure(operation);

  expect(error).toBeInstanceOf(CredentialStoreError);
  expect(error).toMatchObject({ code, message: code });
  expect(error).not.toHaveProperty("cause");
  expect(String(error)).not.toContain(secretSentinel);
}

describe("credential-store module", () => {
  it("loads without a real keytar loader and exposes its API through the public entrypoint", async () => {
    const module = await credentials();
    const publicExports = await import("./index.js");

    expect(module.CODESENTINEL_CREDENTIAL_SERVICE).toBe("Kadsoo.CodeSentinel");
    expect(publicExports.CODESENTINEL_CREDENTIAL_SERVICE).toBe(module.CODESENTINEL_CREDENTIAL_SERVICE);
    expect(publicExports.CredentialStoreError).toBe(module.CredentialStoreError);
    expect(publicExports.InMemoryCredentialStore).toBe(module.InMemoryCredentialStore);
    expect(publicExports.WindowsCredentialStore).toBe(module.WindowsCredentialStore);
    expect("loadKeytar" in module).toBe(false);
  });
});

describe("InMemoryCredentialStore", () => {
  it("sets, gets, reports, and clears credentials", async () => {
    const { InMemoryCredentialStore } = await credentials();
    const store = new InMemoryCredentialStore();

    expect(await store.status(reference)).toBe("missing");
    expect(await store.get(reference)).toBeUndefined();

    await store.set(reference, ` ${secretSentinel} `);

    expect(await store.get(reference)).toBe(` ${secretSentinel} `);
    expect(await store.status(reference)).toBe("configured");

    await store.clear(reference);

    expect(await store.get(reference)).toBeUndefined();
    expect(await store.status(reference)).toBe("missing");
  });

  it("returns a non-secret credential status", async () => {
    const { InMemoryCredentialStore } = await credentials();
    const store = new InMemoryCredentialStore();

    await store.set(reference, secretSentinel);
    const status = await store.status(reference);

    expect(status).toBe("configured");
    expect(String(status)).not.toContain(secretSentinel);
  });

  it("accepts the maximum-length valid reference", async () => {
    const { InMemoryCredentialStore } = await credentials();
    const store = new InMemoryCredentialStore();
    const longestReference = `a${"b".repeat(127)}`;

    await store.set(longestReference, secretSentinel);

    expect(await store.get(longestReference)).toBe(secretSentinel);
  });

  it.each([
    "",
    ".leading-dot",
    "-leading-dash",
    "_leading-underscore",
    "contains/slash",
    "contains\\backslash",
    "contains\u0000control",
    "contains\nnewline",
    "contains space",
    "a".repeat(129),
    null,
    42,
  ] as const)("rejects invalid reference input: %j", async (invalidReference) => {
    const { InMemoryCredentialStore } = await credentials();
    const store = new InMemoryCredentialStore();
    const unsafeReference = invalidReference as string;
    const operations: ReadonlyArray<() => Promise<unknown>> = [
      () => store.set(unsafeReference, secretSentinel),
      () => store.get(unsafeReference),
      () => store.status(unsafeReference),
      () => store.clear(unsafeReference),
    ];

    for (const operation of operations) {
      await expectCredentialStoreError(operation, "CREDENTIAL_INVALID_INPUT");
    }
  });

  it.each(["", "   ", "\t", "a".repeat(4097), null, 42] as const)(
    "rejects invalid secret input: %j",
    async (invalidSecret) => {
      const { InMemoryCredentialStore } = await credentials();
      const store = new InMemoryCredentialStore();

      await expectCredentialStoreError(
        () => store.set(reference, invalidSecret as string),
        "CREDENTIAL_INVALID_INPUT",
      );
    },
  );
});

describe("WindowsCredentialStore", () => {
  it("uses only the injected keytar operations with the fixed service and validated account", async () => {
    const { CODESENTINEL_CREDENTIAL_SERVICE, WindowsCredentialStore } = await credentials();
    const getPassword = vi.fn(async () => secretSentinel);
    const setPassword = vi.fn(async () => undefined);
    const deletePassword = vi.fn(async () => true);
    const keytar = { getPassword, setPassword, deletePassword } satisfies KeytarLike;
    const store = new WindowsCredentialStore(keytar);

    expect(Object.keys(keytar)).toEqual(["getPassword", "setPassword", "deletePassword"]);
    expect("findPassword" in keytar).toBe(false);
    expect("findCredentials" in keytar).toBe(false);

    await store.set(reference, secretSentinel);
    expect(setPassword).toHaveBeenCalledExactlyOnceWith(
      CODESENTINEL_CREDENTIAL_SERVICE,
      reference,
      secretSentinel,
    );

    expect(await store.get(reference)).toBe(secretSentinel);
    expect(await store.status(reference)).toBe("configured");
    expect(getPassword).toHaveBeenNthCalledWith(1, CODESENTINEL_CREDENTIAL_SERVICE, reference);
    expect(getPassword).toHaveBeenNthCalledWith(2, CODESENTINEL_CREDENTIAL_SERVICE, reference);

    await store.clear(reference);
    expect(deletePassword).toHaveBeenCalledExactlyOnceWith(CODESENTINEL_CREDENTIAL_SERVICE, reference);
  });

  it("treats a null keytar credential as missing", async () => {
    const { CODESENTINEL_CREDENTIAL_SERVICE, WindowsCredentialStore } = await credentials();
    const getPassword = vi.fn(async () => null);
    const keytar = {
      getPassword,
      setPassword: vi.fn(async () => undefined),
      deletePassword: vi.fn(async () => true),
    } satisfies KeytarLike;
    const store = new WindowsCredentialStore(keytar);

    expect(await store.get(reference)).toBeUndefined();
    expect(await store.status(reference)).toBe("missing");
    expect(getPassword).toHaveBeenNthCalledWith(1, CODESENTINEL_CREDENTIAL_SERVICE, reference);
    expect(getPassword).toHaveBeenNthCalledWith(2, CODESENTINEL_CREDENTIAL_SERVICE, reference);
  });

  it("makes clear idempotent when keytar reports that no credential was deleted", async () => {
    const { CODESENTINEL_CREDENTIAL_SERVICE, WindowsCredentialStore } = await credentials();
    const deletePassword = vi.fn(async () => false);
    const keytar = {
      getPassword: vi.fn(async () => null),
      setPassword: vi.fn(async () => undefined),
      deletePassword,
    } satisfies KeytarLike;
    const store = new WindowsCredentialStore(keytar);

    await expect(store.clear(reference)).resolves.toBeUndefined();
    await expect(store.clear(reference)).resolves.toBeUndefined();

    expect(deletePassword).toHaveBeenCalledTimes(2);
    expect(deletePassword).toHaveBeenNthCalledWith(1, CODESENTINEL_CREDENTIAL_SERVICE, reference);
    expect(deletePassword).toHaveBeenNthCalledWith(2, CODESENTINEL_CREDENTIAL_SERVICE, reference);
  });

  it("validates a reference before any injected keytar operation", async () => {
    const { WindowsCredentialStore } = await credentials();
    const getPassword = vi.fn(async () => null);
    const setPassword = vi.fn(async () => undefined);
    const deletePassword = vi.fn(async () => true);
    const keytar = { getPassword, setPassword, deletePassword } satisfies KeytarLike;
    const store = new WindowsCredentialStore(keytar);

    await expectCredentialStoreError(
      () => store.set("invalid/reference", secretSentinel),
      "CREDENTIAL_INVALID_INPUT",
    );
    await expectCredentialStoreError(() => store.get("invalid/reference"), "CREDENTIAL_INVALID_INPUT");
    await expectCredentialStoreError(
      () => store.status("invalid/reference"),
      "CREDENTIAL_INVALID_INPUT",
    );
    await expectCredentialStoreError(() => store.clear("invalid/reference"), "CREDENTIAL_INVALID_INPUT");

    expect(getPassword).not.toHaveBeenCalled();
    expect(setPassword).not.toHaveBeenCalled();
    expect(deletePassword).not.toHaveBeenCalled();
  });

  it("maps all injected keytar errors to an unavailable error without disclosing the secret", async () => {
    const { WindowsCredentialStore } = await credentials();
    const keytar = {
      getPassword: vi.fn(async () => {
        throw new Error(`get failed: ${secretSentinel}`);
      }),
      setPassword: vi.fn(async () => {
        throw new Error(`set failed: ${secretSentinel}`);
      }),
      deletePassword: vi.fn(async () => {
        throw new Error(`delete failed: ${secretSentinel}`);
      }),
    } satisfies KeytarLike;
    const store = new WindowsCredentialStore(keytar);

    await expectCredentialStoreError(
      () => store.set(reference, secretSentinel),
      "CREDENTIAL_UNAVAILABLE",
    );
    await expectCredentialStoreError(() => store.get(reference), "CREDENTIAL_UNAVAILABLE");
    await expectCredentialStoreError(() => store.status(reference), "CREDENTIAL_UNAVAILABLE");
    await expectCredentialStoreError(() => store.clear(reference), "CREDENTIAL_UNAVAILABLE");
  });
});
