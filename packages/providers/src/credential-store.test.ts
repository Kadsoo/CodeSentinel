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

function keytarWithDefaults(
  overrides: Partial<Record<keyof KeytarLike, unknown>> = {},
): KeytarLike {
  return {
    getPassword: async () => null,
    setPassword: async () => undefined,
    deletePassword: async () => true,
    ...overrides,
  } as unknown as KeytarLike;
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

  it("keeps its backing credential map inaccessible to ordinary external tampering", async () => {
    const { InMemoryCredentialStore } = await credentials();
    const store = new InMemoryCredentialStore();
    const externalView = store as unknown as Record<string, unknown>;
    const forgedCredentials = new Map([[reference, "forged-credential"]]);

    await store.set(reference, secretSentinel);

    expect(Object.getOwnPropertyNames(store)).not.toContain("credentials");
    expect(externalView.credentials).toBeUndefined();

    externalView.credentials = forgedCredentials;

    expect(await store.get(reference)).toBe(secretSentinel);
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

  describe("runtime injection hardening", () => {
    it("keeps its injected keytar port inaccessible to ordinary external tampering", async () => {
      const { CODESENTINEL_CREDENTIAL_SERVICE, WindowsCredentialStore } = await credentials();
      const injectedSetPassword = vi.fn(async () => undefined);
      const interceptedSetPassword = vi.fn(async () => undefined);
      const store = new WindowsCredentialStore(
        keytarWithDefaults({ setPassword: injectedSetPassword }),
      );
      const externalView = store as unknown as Record<string, unknown>;

      expect(Object.getOwnPropertyNames(store)).not.toContain("keytar");
      expect(externalView.keytar).toBeUndefined();

      externalView.keytar = keytarWithDefaults({ setPassword: interceptedSetPassword });
      await store.set(reference, secretSentinel);

      expect(injectedSetPassword).toHaveBeenCalledExactlyOnceWith(
        CODESENTINEL_CREDENTIAL_SERVICE,
        reference,
        secretSentinel,
      );
      expect(interceptedSetPassword).not.toHaveBeenCalled();
    });

    it("accepts a maximum-length nonblank credential returned by keytar", async () => {
      const { WindowsCredentialStore } = await credentials();
      const returnedSecret = "a".repeat(4096);
      const store = new WindowsCredentialStore(
        keytarWithDefaults({ getPassword: () => returnedSecret }),
      );

      expect(await store.get(reference)).toBe(returnedSecret);
      expect(await store.status(reference)).toBe("configured");
    });

    it.each([
      ["undefined", undefined],
      ["object", {}],
      ["empty string", ""],
      ["blank string", " \t "],
      ["too-long string", "a".repeat(4097)],
    ] as const)("rejects a %s getPassword result", async (_name, result) => {
      const { WindowsCredentialStore } = await credentials();
      const store = new WindowsCredentialStore(
        keytarWithDefaults({ getPassword: () => result }),
      );

      await expectCredentialStoreError(() => store.get(reference), "CREDENTIAL_UNAVAILABLE");
    });

    it("does not reinterpret an undefined getPassword result as a missing credential in status", async () => {
      const { WindowsCredentialStore } = await credentials();
      const store = new WindowsCredentialStore(
        keytarWithDefaults({ getPassword: () => undefined }),
      );

      await expectCredentialStoreError(() => store.status(reference), "CREDENTIAL_UNAVAILABLE");
    });

    it.each([
      ["null", null],
      ["boolean", false],
      ["string", "unexpected"],
      ["object", {}],
    ] as const)("rejects a %s setPassword result", async (_name, result) => {
      const { WindowsCredentialStore } = await credentials();
      const store = new WindowsCredentialStore(
        keytarWithDefaults({ setPassword: () => result }),
      );

      await expectCredentialStoreError(
        () => store.set(reference, secretSentinel),
        "CREDENTIAL_UNAVAILABLE",
      );
    });

    it.each([
      ["undefined", undefined],
      ["null", null],
      ["string", "false"],
      ["object", {}],
    ] as const)("rejects a %s deletePassword result", async (_name, result) => {
      const { WindowsCredentialStore } = await credentials();
      const store = new WindowsCredentialStore(
        keytarWithDefaults({ deletePassword: () => result }),
      );

      await expectCredentialStoreError(() => store.clear(reference), "CREDENTIAL_UNAVAILABLE");
    });

    it.each(["getPassword", "setPassword", "deletePassword"] as const)(
      "maps a synchronous %s method failure to an unavailable error without disclosing the secret",
      async (method) => {
        const { WindowsCredentialStore } = await credentials();
        const keytar = keytarWithDefaults({
          getPassword: () => {
            throw new Error(`getPassword sync failure: ${secretSentinel}`);
          },
          setPassword: () => {
            throw new Error(`setPassword sync failure: ${secretSentinel}`);
          },
          deletePassword: () => {
            throw new Error(`deletePassword sync failure: ${secretSentinel}`);
          },
        });
        const store = new WindowsCredentialStore(keytar);

        if (method === "getPassword") {
          await expectCredentialStoreError(() => store.get(reference), "CREDENTIAL_UNAVAILABLE");
        } else if (method === "setPassword") {
          await expectCredentialStoreError(
            () => store.set(reference, secretSentinel),
            "CREDENTIAL_UNAVAILABLE",
          );
        } else {
          await expectCredentialStoreError(() => store.clear(reference), "CREDENTIAL_UNAVAILABLE");
        }
      },
    );

    it.each(["getPassword", "setPassword", "deletePassword"] as const)(
      "maps a synchronous %s property failure to an unavailable error without disclosing the secret",
      async (property) => {
        const { WindowsCredentialStore } = await credentials();
        const keytar = keytarWithDefaults() as unknown as Record<string, unknown>;
        Object.defineProperty(keytar, property, {
          enumerable: true,
          get() {
            throw new Error(`${property} property failure: ${secretSentinel}`);
          },
        });
        const store = new WindowsCredentialStore(keytar as unknown as KeytarLike);

        if (property === "getPassword") {
          await expectCredentialStoreError(() => store.get(reference), "CREDENTIAL_UNAVAILABLE");
        } else if (property === "setPassword") {
          await expectCredentialStoreError(
            () => store.set(reference, secretSentinel),
            "CREDENTIAL_UNAVAILABLE",
          );
        } else {
          await expectCredentialStoreError(() => store.clear(reference), "CREDENTIAL_UNAVAILABLE");
        }
      },
    );
  });
});
