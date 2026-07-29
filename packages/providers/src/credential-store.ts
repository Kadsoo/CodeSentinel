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

const referencePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const maxReferenceLength = 128;
const maxSecretLength = 4096;

function invalidInput(): CredentialStoreError {
  return new CredentialStoreError("CREDENTIAL_INVALID_INPUT");
}

function unavailable(): CredentialStoreError {
  return new CredentialStoreError("CREDENTIAL_UNAVAILABLE");
}

function validateReference(reference: unknown): asserts reference is string {
  if (
    typeof reference !== "string" ||
    reference.length === 0 ||
    reference.length > maxReferenceLength ||
    referencePattern.exec(reference)?.[0] !== reference
  ) {
    throw invalidInput();
  }
}

function validateSecret(secret: unknown): asserts secret is string {
  if (typeof secret !== "string" || secret.trim().length === 0 || secret.length > maxSecretLength) {
    throw invalidInput();
  }
}

export class InMemoryCredentialStore implements CredentialStore {
  readonly #credentials = new Map<string, string>();

  async set(reference: string, secret: string): Promise<void> {
    validateReference(reference);
    validateSecret(secret);
    this.#credentials.set(reference, secret);
  }

  async get(reference: string): Promise<string | undefined> {
    validateReference(reference);
    return this.#credentials.get(reference);
  }

  async status(reference: string): Promise<CredentialStatus> {
    return (await this.get(reference)) === undefined ? "missing" : "configured";
  }

  async clear(reference: string): Promise<void> {
    validateReference(reference);
    this.#credentials.delete(reference);
  }
}

export class WindowsCredentialStore implements CredentialStore {
  constructor(private readonly keytar: KeytarLike) {}

  async set(reference: string, secret: string): Promise<void> {
    validateReference(reference);
    validateSecret(secret);

    try {
      await this.keytar.setPassword(CODESENTINEL_CREDENTIAL_SERVICE, reference, secret);
    } catch {
      throw unavailable();
    }
  }

  async get(reference: string): Promise<string | undefined> {
    validateReference(reference);

    try {
      const secret = await this.keytar.getPassword(CODESENTINEL_CREDENTIAL_SERVICE, reference);
      return typeof secret === "string" ? secret : undefined;
    } catch {
      throw unavailable();
    }
  }

  async status(reference: string): Promise<CredentialStatus> {
    return (await this.get(reference)) === undefined ? "missing" : "configured";
  }

  async clear(reference: string): Promise<void> {
    validateReference(reference);

    try {
      await this.keytar.deletePassword(CODESENTINEL_CREDENTIAL_SERVICE, reference);
    } catch {
      throw unavailable();
    }
  }
}
