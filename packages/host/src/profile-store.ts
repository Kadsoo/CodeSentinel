import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { HostError, hostError } from "./errors.js";

const PROFILES_FILE_NAME = "profiles.json";
const PROFILES_LOCK_DATABASE_FILE_NAME = ".profiles.lock.sqlite";
const PROFILES_VERSION = 1;
const MAX_PROFILES_FILE_BYTES = 65_536;
const MAX_PROFILES = 64;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_ENDPOINT_LENGTH = 2_048;
const MAX_MODEL_LENGTH = 128;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SAFE_TEMP_SUFFIX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const KNOWN_SECRET_FRAGMENT = /(?:sk-|sk_|pk_|rk_|ghp_)[A-Za-z0-9_-]{12,}/iu;
const SQLITE_BUSY_TIMEOUT_MS = 1_000;
const PROFILE_READ_ATTEMPTS = 3;
const PROFILE_READ_RETRY_DELAY_MS = 2;

const IdentifierSchema = z
  .string()
  .min(1)
  .max(MAX_IDENTIFIER_LENGTH)
  .regex(SAFE_IDENTIFIER)
  .refine((value) => !KNOWN_SECRET_FRAGMENT.test(value));

const ModelSchema = z
  .string()
  .max(MAX_MODEL_LENGTH)
  .refine((value) => value.trim().length > 0)
  .refine((value) => !hasControlCharacter(value))
  .refine((value) => !KNOWN_SECRET_FRAGMENT.test(value));

const EndpointSchema = z
  .string()
  .min(1)
  .max(MAX_ENDPOINT_LENGTH)
  .refine((value) => !hasControlCharacter(value))
  .refine((value) => !KNOWN_SECRET_FRAGMENT.test(value))
  .refine(isSafeHttpsEndpoint);

const ProviderProfileSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.enum(["deepseek", "nju_se_hub"]),
    endpoint: EndpointSchema,
    model: ModelSchema,
    credentialRef: IdentifierSchema,
  })
  .strict();

const ProfileEnvelopeSchema = z
  .object({
    version: z.literal(PROFILES_VERSION),
    profiles: z.array(ProviderProfileSchema).max(MAX_PROFILES),
  })
  .strict()
  .superRefine((envelope, context) => {
    const identifiers = new Set<string>();
    envelope.profiles.forEach((profile, index) => {
      if (identifiers.has(profile.id)) {
        context.addIssue({
          code: "custom",
          path: ["profiles", index, "id"],
          message: "Provider profile ids must be unique.",
        });
      }
      identifiers.add(profile.id);
    });
  });

export type ProviderProfile = Readonly<{
  id: string;
  kind: "deepseek" | "nju_se_hub";
  endpoint: string;
  model: string;
  credentialRef: string;
}>;

export interface ProfileStore {
  get(id: string): Promise<ProviderProfile | undefined>;
  list(): Promise<readonly ProviderProfile[]>;
  upsert(profile: ProviderProfile): Promise<void>;
  remove(id: string): Promise<void>;
}

export type ProfileStoreOptions = Readonly<{
  stateDirectory: string;
  randomSuffix?: () => string;
  testHooks?: ProfileStoreTestHooks;
}>;

export type ProfileStoreTestHooks = Readonly<{
  afterProfileFilePrecheck?: () => Promise<void>;
  beforeAtomicReplace?: () => Promise<void>;
}>;

type ProfileEnvelope = Readonly<{
  version: 1;
  profiles: readonly ProviderProfile[];
}>;

type RegularFileIdentity = Readonly<{
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}>;

type ProfileFileStatus =
  | "missing"
  | Readonly<{ kind: "regular"; identity: RegularFileIdentity }>;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 31 || codePoint === 127 || (codePoint >= 128 && codePoint <= 159))
    ) {
      return true;
    }
  }
  return false;
}

function isSafeHttpsEndpoint(value: string): boolean {
  try {
    const endpoint = new URL(value);
    return (
      endpoint.protocol === "https:" &&
      endpoint.hostname.length > 0 &&
      endpoint.username.length === 0 &&
      endpoint.password.length === 0 &&
      endpoint.search.length === 0 &&
      endpoint.hash.length === 0
    );
  } catch {
    return false;
  }
}

function regularFileIdentity(status: Stats): RegularFileIdentity {
  return Object.freeze({
    dev: status.dev,
    ino: status.ino,
    size: status.size,
    mtimeMs: status.mtimeMs,
    ctimeMs: status.ctimeMs,
  });
}

function hasSameIdentity(
  left: RegularFileIdentity,
  right: RegularFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function validatedRegularProfileFile(status: Stats): RegularFileIdentity {
  if (status.isSymbolicLink() || !status.isFile() || status.size > MAX_PROFILES_FILE_BYTES) {
    throw hostError("STATE_CORRUPT");
  }
  return regularFileIdentity(status);
}

function assertRegularLockDatabaseFile(status: Stats): void {
  if (status.isSymbolicLink() || !status.isFile()) {
    throw hostError("STATE_UNAVAILABLE");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function snapshotProfile(profile: z.infer<typeof ProviderProfileSchema>): ProviderProfile {
  return Object.freeze({
    id: profile.id,
    kind: profile.kind,
    endpoint: profile.endpoint,
    model: profile.model,
    credentialRef: profile.credentialRef,
  });
}

function snapshotEnvelope(
  envelope: z.infer<typeof ProfileEnvelopeSchema>,
): ProfileEnvelope {
  return Object.freeze({
    version: PROFILES_VERSION,
    profiles: Object.freeze(envelope.profiles.map(snapshotProfile)),
  });
}

function isHostError(error: unknown): error is HostError {
  return error instanceof HostError;
}

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const candidate = error as { code?: unknown };
  return typeof candidate.code === "string" ? candidate.code : undefined;
}

function validateIdentifier(value: unknown): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) {
    throw hostError("PROFILE_INVALID");
  }
  return parsed.data;
}

function validateProfile(value: unknown): ProviderProfile {
  try {
    const parsed = ProviderProfileSchema.safeParse(value);
    if (!parsed.success) {
      throw hostError("PROFILE_INVALID");
    }
    return snapshotProfile(parsed.data);
  } catch (error) {
    if (isHostError(error)) {
      throw error;
    }
    throw hostError("PROFILE_INVALID");
  }
}

function validateStateDirectory(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\u0000") ||
    basename(value) === ""
  ) {
    throw hostError("STATE_UNAVAILABLE");
  }
  return value;
}

function defaultRandomSuffix(): string {
  return Math.random().toString(36).slice(2);
}

/**
 * The local state directory is a cooperative trust boundary: its ACL must exclude
 * untrusted writers. Mutating CodeSentinel API/CLI instances coordinate through
 * a same-directory SQLite `BEGIN IMMEDIATE` transaction, while `profiles.json`
 * is still published by write, sync, close, and rename. SQLite locking and the
 * path checks below do not protect against arbitrary same-privilege mutation, so
 * they do not replace the directory ACL requirement.
 */

const profileMutationQueues = new Map<string, Promise<void>>();

function enqueueProfileMutation<T>(
  canonicalStateDirectory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = profileMutationQueues.get(canonicalStateDirectory) ?? Promise.resolve();
  const result = predecessor.then(operation, operation);
  const completion = result.then(
    () => undefined,
    () => undefined,
  );
  profileMutationQueues.set(canonicalStateDirectory, completion);
  void completion.then(() => {
    if (profileMutationQueues.get(canonicalStateDirectory) === completion) {
      profileMutationQueues.delete(canonicalStateDirectory);
    }
  });
  return result;
}

class FileProfileStore implements ProfileStore {
  readonly #stateDirectory: string;
  readonly #profilePath: string;
  readonly #lockDatabasePath: string;
  readonly #randomSuffix: () => string;
  readonly #testHooks: ProfileStoreTestHooks;

  constructor(options: ProfileStoreOptions) {
    this.#stateDirectory = validateStateDirectory(options.stateDirectory);
    this.#profilePath = join(this.#stateDirectory, PROFILES_FILE_NAME);
    this.#lockDatabasePath = join(
      this.#stateDirectory,
      PROFILES_LOCK_DATABASE_FILE_NAME,
    );
    this.#randomSuffix = options.randomSuffix ?? defaultRandomSuffix;
    if (typeof this.#randomSuffix !== "function") {
      throw hostError("STATE_UNAVAILABLE");
    }
    this.#testHooks = options.testHooks ?? {};
    if (
      typeof this.#testHooks !== "object" ||
      this.#testHooks === null ||
      (this.#testHooks.afterProfileFilePrecheck !== undefined &&
        typeof this.#testHooks.afterProfileFilePrecheck !== "function") ||
      (this.#testHooks.beforeAtomicReplace !== undefined &&
        typeof this.#testHooks.beforeAtomicReplace !== "function")
    ) {
      throw hostError("STATE_UNAVAILABLE");
    }
  }

  async get(id: string): Promise<ProviderProfile | undefined> {
    const profileId = validateIdentifier(id);
    const envelope = await this.#readEnvelope();
    return envelope.profiles.find((profile) => profile.id === profileId);
  }

  async list(): Promise<readonly ProviderProfile[]> {
    return (await this.#readEnvelope()).profiles;
  }

  async upsert(profile: ProviderProfile): Promise<void> {
    const validated = validateProfile(profile);
    await this.#withProfileTransaction(async () => {
      const current = await this.#readEnvelope();
      const existingIndex = current.profiles.findIndex(
        (candidate) => candidate.id === validated.id,
      );
      const profiles = [...current.profiles];
      if (existingIndex === -1) {
        profiles.push(validated);
      } else {
        profiles[existingIndex] = validated;
      }
      await this.#writeEnvelope({ version: PROFILES_VERSION, profiles });
    });
  }

  async remove(id: string): Promise<void> {
    const profileId = validateIdentifier(id);
    await this.#withProfileTransaction(async () => {
      const current = await this.#readEnvelope();
      const profiles = current.profiles.filter((profile) => profile.id !== profileId);
      if (profiles.length === current.profiles.length) {
        throw hostError("PROFILE_NOT_FOUND");
      }
      await this.#writeEnvelope({ version: PROFILES_VERSION, profiles });
    });
  }

  async #readEnvelope(): Promise<ProfileEnvelope> {
    for (let attempt = 0; attempt < PROFILE_READ_ATTEMPTS; attempt += 1) {
      const result = await this.#readEnvelopeAttempt();
      if (result !== "changed") {
        return result;
      }
      if (attempt + 1 < PROFILE_READ_ATTEMPTS) {
        await delay(PROFILE_READ_RETRY_DELAY_MS);
      }
    }
    throw hostError("STATE_UNAVAILABLE");
  }

  async #readEnvelopeAttempt(): Promise<ProfileEnvelope | "changed"> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const before = await this.#profileFileStatus();
      if (before === "missing") {
        return Object.freeze({ version: PROFILES_VERSION, profiles: Object.freeze([]) });
      }
      await this.#runTestHook("afterProfileFilePrecheck");

      handle = await open(this.#profilePath, "r");
      const opened = validatedRegularProfileFile(await handle.stat());
      if (!hasSameIdentity(before.identity, opened)) {
        return "changed";
      }
      const afterOpen = await this.#profileFileStatus();
      if (
        afterOpen === "missing" ||
        !hasSameIdentity(before.identity, afterOpen.identity)
      ) {
        return "changed";
      }
      const contents = await this.#readBoundedFile(handle, before.identity.size);
      const afterRead = validatedRegularProfileFile(await handle.stat());
      if (!hasSameIdentity(before.identity, afterRead)) {
        return "changed";
      }
      const afterReadPath = await this.#profileFileStatus();
      if (
        afterReadPath === "missing" ||
        !hasSameIdentity(before.identity, afterReadPath.identity)
      ) {
        return "changed";
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(contents.toString("utf8")) as unknown;
      } catch {
        throw hostError("STATE_CORRUPT");
      }
      const parsedEnvelope = ProfileEnvelopeSchema.safeParse(parsedJson);
      if (!parsedEnvelope.success) {
        throw hostError("STATE_CORRUPT");
      }
      return snapshotEnvelope(parsedEnvelope.data);
    } catch (error) {
      if (isHostError(error)) {
        throw error;
      }
      if (nodeErrorCode(error) === "ENOENT") {
        return "changed";
      }
      throw hostError("STATE_UNAVAILABLE");
    } finally {
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          // Reads already fail closed on every operational error above.
        }
      }
    }
  }

  async #readBoundedFile(
    handle: Awaited<ReturnType<typeof open>>,
    size: number,
  ): Promise<Buffer> {
    const contents = Buffer.alloc(size);
    let offset = 0;
    while (offset < contents.length) {
      const result = await handle.read(contents, offset, contents.length - offset, offset);
      if (result.bytesRead === 0) {
        throw hostError("STATE_CORRUPT");
      }
      offset += result.bytesRead;
    }
    return contents;
  }

  async #profileFileStatus(): Promise<ProfileFileStatus> {
    try {
      const status = await lstat(this.#profilePath);
      return Object.freeze({
        kind: "regular",
        identity: validatedRegularProfileFile(status),
      });
    } catch (error) {
      if (isHostError(error)) {
        throw error;
      }
      if (nodeErrorCode(error) === "ENOENT") {
        return "missing";
      }
      throw hostError("STATE_UNAVAILABLE");
    }
  }

  async #assertProfileFileUnchanged(expected: ProfileFileStatus): Promise<void> {
    const actual = await this.#profileFileStatus();
    if (expected === "missing" && actual === "missing") {
      return;
    }
    if (
      expected === "missing" ||
      actual === "missing" ||
      !hasSameIdentity(expected.identity, actual.identity)
    ) {
      if (actual !== "missing") {
        await this.#readEnvelope();
      }
      throw hostError("STATE_UNAVAILABLE");
    }
  }

  async #ensureStateDirectory(): Promise<void> {
    try {
      await mkdir(this.#stateDirectory, { recursive: true });
      const status = await lstat(this.#stateDirectory);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw hostError("STATE_UNAVAILABLE");
      }
    } catch (error) {
      if (isHostError(error)) {
        throw error;
      }
      throw hostError("STATE_UNAVAILABLE");
    }
  }

  async #runTestHook(
    name: keyof ProfileStoreTestHooks,
  ): Promise<void> {
    const hook = this.#testHooks[name];
    if (hook === undefined) {
      return;
    }
    try {
      await hook();
    } catch (error) {
      if (isHostError(error)) {
        throw error;
      }
      throw hostError("STATE_UNAVAILABLE");
    }
  }

  async #withProfileTransaction<T>(operation: () => Promise<T>): Promise<T> {
    await this.#ensureStateDirectory();
    let canonicalStateDirectory: string;
    try {
      canonicalStateDirectory = await realpath(this.#stateDirectory);
    } catch {
      throw hostError("STATE_UNAVAILABLE");
    }
    return enqueueProfileMutation(canonicalStateDirectory, async () => {
      await this.#ensureStateDirectory();
      await this.#assertLockDatabasePathIsSafe();
      return this.#runSqliteTransaction(operation);
    });
  }

  async #assertLockDatabasePathIsSafe(): Promise<void> {
    try {
      assertRegularLockDatabaseFile(await lstat(this.#lockDatabasePath));
    } catch (error) {
      if (isHostError(error)) {
        throw error;
      }
      if (nodeErrorCode(error) === "ENOENT") {
        return;
      }
      throw hostError("STATE_UNAVAILABLE");
    }
  }

  async #runSqliteTransaction<T>(operation: () => Promise<T>): Promise<T> {
    let database: Database.Database | undefined;
    let transactionStarted = false;
    let failure: unknown;
    let result: T | undefined;

    try {
      database = new Database(this.#lockDatabasePath);
      database.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      const journalMode = String(
        database.pragma("journal_mode = DELETE", { simple: true }),
      ).toLowerCase();
      if (journalMode !== "delete") {
        throw hostError("STATE_UNAVAILABLE");
      }
      database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      result = await operation();
      database.exec("COMMIT");
      transactionStarted = false;
    } catch (error) {
      failure = isHostError(error) ? error : hostError("STATE_UNAVAILABLE");
    } finally {
      if (transactionStarted) {
        try {
          database?.exec("ROLLBACK");
        } catch {
          // The original failure remains the externally visible stable error.
        }
      }
      try {
        database?.close();
      } catch {
        if (failure === undefined) {
          failure = hostError("STATE_UNAVAILABLE");
        }
      }
    }

    if (failure !== undefined) {
      throw failure;
    }
    return result as T;
  }

  async #discardOwnedOpenTemporaryFile(
    path: string,
    handle: Awaited<ReturnType<typeof open>>,
  ): Promise<void> {
    let identity: RegularFileIdentity | undefined;
    try {
      identity = validatedRegularProfileFile(await handle.stat());
    } catch {
      // Without a handle identity, cleanup would be unsafe.
    }
    try {
      await handle.close();
    } catch {
      // The triggering operation already returns a stable error.
    }
    if (identity !== undefined) {
      try {
        await this.#removeOwnedClosedTemporaryFile(path, identity);
      } catch {
        // The triggering operation already returns a stable error.
      }
    }
  }

  async #removeOwnedClosedTemporaryFile(
    path: string,
    expected: RegularFileIdentity,
  ): Promise<boolean> {
    try {
      const current = validatedRegularProfileFile(await lstat(path));
      if (!hasSameIdentity(expected, current)) {
        return false;
      }
      await rm(path);
      return true;
    } catch (error) {
      if (isHostError(error) || nodeErrorCode(error) === "ENOENT") {
        return false;
      }
      throw hostError("STATE_UNAVAILABLE");
    }
  }

  async #writeEnvelope(envelope: ProfileEnvelope): Promise<void> {
    const parsedEnvelope = ProfileEnvelopeSchema.safeParse(envelope);
    if (!parsedEnvelope.success) {
      throw hostError("PROFILE_INVALID");
    }
    const serialized = JSON.stringify(snapshotEnvelope(parsedEnvelope.data));
    if (Buffer.byteLength(serialized, "utf8") > MAX_PROFILES_FILE_BYTES) {
      throw hostError("PROFILE_INVALID");
    }

    await this.#ensureStateDirectory();
    const expectedStatus = await this.#profileFileStatus();
    if (expectedStatus !== "missing") {
      await this.#readEnvelope();
    }

    let suffix: string;
    try {
      suffix = this.#randomSuffix();
    } catch {
      throw hostError("STATE_UNAVAILABLE");
    }
    if (typeof suffix !== "string" || !SAFE_TEMP_SUFFIX.test(suffix)) {
      throw hostError("STATE_UNAVAILABLE");
    }

    const temporaryPath = join(
      this.#stateDirectory,
      `${PROFILES_FILE_NAME}.${suffix}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let temporaryIdentity: RegularFileIdentity | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      temporaryIdentity = validatedRegularProfileFile(await handle.stat());
      await handle.writeFile(serialized, "utf8");
      temporaryIdentity = validatedRegularProfileFile(await handle.stat());
      await handle.sync();
      temporaryIdentity = validatedRegularProfileFile(await handle.stat());
      await handle.close();
      handle = undefined;
      await this.#runTestHook("beforeAtomicReplace");
      await this.#assertProfileFileUnchanged(expectedStatus);
      await rename(temporaryPath, this.#profilePath);
    } catch (error) {
      if (handle !== undefined) {
        await this.#discardOwnedOpenTemporaryFile(temporaryPath, handle);
      }
      if (handle === undefined && temporaryIdentity !== undefined) {
        try {
          await this.#removeOwnedClosedTemporaryFile(temporaryPath, temporaryIdentity);
        } catch {
          // The outer operation intentionally exposes only a stable host error.
        }
      }
      if (isHostError(error)) {
        throw error;
      }
      throw hostError("STATE_UNAVAILABLE");
    }
  }
}

export function createProfileStore(options: ProfileStoreOptions): ProfileStore {
  try {
    if (typeof options !== "object" || options === null) {
      throw hostError("STATE_UNAVAILABLE");
    }
    return new FileProfileStore(options);
  } catch (error) {
    if (isHostError(error)) {
      throw error;
    }
    throw hostError("STATE_UNAVAILABLE");
  }
}
