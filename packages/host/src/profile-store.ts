import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { HostError, hostError } from "./errors.js";

const PROFILES_FILE_NAME = "profiles.json";
const PROFILES_LOCK_FILE_NAME = "profiles.lock";
const PROFILES_VERSION = 1;
const MAX_PROFILES_FILE_BYTES = 65_536;
const MAX_LOCK_FILE_BYTES = 512;
const MAX_PROFILES = 64;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_ENDPOINT_LENGTH = 2_048;
const MAX_MODEL_LENGTH = 128;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SAFE_TEMP_SUFFIX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const KNOWN_SECRET_FRAGMENT = /(?:sk-|sk_|pk_|rk_|ghp_)[A-Za-z0-9_-]{12,}/iu;
const LOCK_ACQUISITION_ATTEMPTS = 20;
const LOCK_RETRY_DELAY_MS = 5;
const LOCK_STALE_AFTER_MS = 30_000;
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

const LockEnvelopeSchema = z
  .object({
    version: z.literal(1),
    owner: z.string().min(1).max(64).regex(SAFE_TEMP_SUFFIX),
    processId: z.number().int().safe().positive(),
    acquiredAt: z.number().int().safe().nonnegative(),
  })
  .strict();

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
  now?: () => number;
  isLockOwnerAlive?: (processId: number) => boolean;
  testHooks?: ProfileStoreTestHooks;
}>;

export type ProfileStoreTestHooks = Readonly<{
  afterProfileFilePrecheck?: () => Promise<void>;
  beforeAtomicReplace?: () => Promise<void>;
  beforeLockSync?: () => Promise<void>;
  beforeLockStat?: () => Promise<void>;
}>;

type ProfileEnvelope = Readonly<{
  version: 1;
  profiles: readonly ProviderProfile[];
}>;

type LockEnvelope = Readonly<z.infer<typeof LockEnvelopeSchema>>;

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

type OwnedDirectoryLock = Readonly<{
  handle: Awaited<ReturnType<typeof open>>;
  identity: RegularFileIdentity;
  owner: string;
}>;

type ExistingDirectoryLock = Readonly<{
  identity: RegularFileIdentity;
  acquiredAt: number;
  processId: number | undefined;
}>;

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

function validatedRegularLockFile(status: Stats): RegularFileIdentity {
  if (status.isSymbolicLink() || !status.isFile() || status.size > MAX_LOCK_FILE_BYTES) {
    throw hostError("STATE_UNAVAILABLE");
  }
  return regularFileIdentity(status);
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

function defaultLockOwnerAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return nodeErrorCode(error) !== "ESRCH";
  }
}

function validatedNow(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw hostError("STATE_UNAVAILABLE");
  }
  return value;
}

/**
 * The local state directory is a cooperative trust boundary: its ACL must exclude
 * untrusted writers, and CodeSentinel API/CLI instances must follow this lock
 * protocol. Node cannot make pathname compare-and-delete atomic against an
 * arbitrary same-privilege mutator. Handle/lstat identity checks fail closed for
 * static and racing corruption before reads, but do not replace directory ACLs.
 */

class FileProfileStore implements ProfileStore {
  readonly #stateDirectory: string;
  readonly #profilePath: string;
  readonly #lockPath: string;
  readonly #randomSuffix: () => string;
  readonly #now: () => number;
  readonly #isLockOwnerAlive: (processId: number) => boolean;
  readonly #testHooks: ProfileStoreTestHooks;
  #pending: Promise<void> = Promise.resolve();

  constructor(options: ProfileStoreOptions) {
    this.#stateDirectory = validateStateDirectory(options.stateDirectory);
    this.#profilePath = join(this.#stateDirectory, PROFILES_FILE_NAME);
    this.#lockPath = join(this.#stateDirectory, PROFILES_LOCK_FILE_NAME);
    this.#randomSuffix = options.randomSuffix ?? defaultRandomSuffix;
    if (typeof this.#randomSuffix !== "function") {
      throw hostError("STATE_UNAVAILABLE");
    }
    this.#now = options.now ?? Date.now;
    this.#isLockOwnerAlive = options.isLockOwnerAlive ?? defaultLockOwnerAlive;
    if (
      typeof this.#now !== "function" ||
      typeof this.#isLockOwnerAlive !== "function"
    ) {
      throw hostError("STATE_UNAVAILABLE");
    }
    this.#testHooks = options.testHooks ?? {};
    if (
      typeof this.#testHooks !== "object" ||
      this.#testHooks === null ||
      (this.#testHooks.afterProfileFilePrecheck !== undefined &&
        typeof this.#testHooks.afterProfileFilePrecheck !== "function") ||
      (this.#testHooks.beforeAtomicReplace !== undefined &&
        typeof this.#testHooks.beforeAtomicReplace !== "function") ||
      (this.#testHooks.beforeLockSync !== undefined &&
        typeof this.#testHooks.beforeLockSync !== "function") ||
      (this.#testHooks.beforeLockStat !== undefined &&
        typeof this.#testHooks.beforeLockStat !== "function")
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
    await this.#enqueue(() =>
      this.#withDirectoryLock(async () => {
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
      }),
    );
  }

  async remove(id: string): Promise<void> {
    const profileId = validateIdentifier(id);
    await this.#enqueue(() =>
      this.#withDirectoryLock(async () => {
        const current = await this.#readEnvelope();
        const profiles = current.profiles.filter((profile) => profile.id !== profileId);
        if (profiles.length === current.profiles.length) {
          throw hostError("PROFILE_NOT_FOUND");
        }
        await this.#writeEnvelope({ version: PROFILES_VERSION, profiles });
      }),
    );
  }

  async #enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.#pending.then(operation, operation);
    this.#pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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

  async #withDirectoryLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = await this.#acquireDirectoryLock();
    try {
      return await operation();
    } finally {
      await this.#releaseDirectoryLock(lock);
    }
  }

  async #acquireDirectoryLock(): Promise<OwnedDirectoryLock> {
    await this.#ensureStateDirectory();

    for (let attempt = 0; attempt < LOCK_ACQUISITION_ATTEMPTS; attempt += 1) {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(this.#lockPath, "wx", 0o600);
        const owner = this.#newLockOwner();
        const lock: LockEnvelope = {
          version: 1,
          owner,
          processId: process.pid,
          acquiredAt: this.#currentTime(),
        };
        await handle.writeFile(JSON.stringify(lock), "utf8");
        await this.#runTestHook("beforeLockSync");
        await handle.sync();
        await this.#runTestHook("beforeLockStat");
        const identity = validatedRegularLockFile(await handle.stat());
        return Object.freeze({ handle, identity, owner });
      } catch (error) {
        if (handle !== undefined) {
          await this.#discardOwnedOpenPath(this.#lockPath, handle, "lock");
        }
        if (nodeErrorCode(error) !== "EEXIST") {
          if (isHostError(error)) {
            throw error;
          }
          throw hostError("STATE_UNAVAILABLE");
        }
        if (await this.#recoverStaleDirectoryLock()) {
          continue;
        }
        await delay(LOCK_RETRY_DELAY_MS);
      }
    }

    throw hostError("STATE_UNAVAILABLE");
  }

  async #recoverStaleDirectoryLock(): Promise<boolean> {
    const existing = await this.#readExistingDirectoryLock();
    if (existing === "missing" || existing === "changed") {
      return true;
    }
    const now = this.#currentTime();
    if (now - existing.acquiredAt < LOCK_STALE_AFTER_MS) {
      return false;
    }
    if (existing.processId !== undefined && this.#lockOwnerIsAlive(existing.processId)) {
      return false;
    }
    return this.#removeOwnedClosedPath(this.#lockPath, existing.identity, "lock");
  }

  async #readExistingDirectoryLock(): Promise<
    ExistingDirectoryLock | "missing" | "changed"
  > {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const before = await this.#lockFileStatus();
      if (before === "missing") {
        return "missing";
      }
      handle = await open(this.#lockPath, "r");
      const opened = validatedRegularLockFile(await handle.stat());
      if (!hasSameIdentity(before.identity, opened)) {
        return "changed";
      }
      const afterOpen = await this.#lockFileStatus();
      if (
        afterOpen === "missing" ||
        !hasSameIdentity(before.identity, afterOpen.identity)
      ) {
        return "changed";
      }
      const contents = await this.#readBoundedFile(handle, before.identity.size);
      const afterRead = validatedRegularLockFile(await handle.stat());
      if (!hasSameIdentity(before.identity, afterRead)) {
        return "changed";
      }
      const afterReadPath = await this.#lockFileStatus();
      if (
        afterReadPath === "missing" ||
        !hasSameIdentity(before.identity, afterReadPath.identity)
      ) {
        return "changed";
      }

      if (contents.length === 0) {
        return this.#legacyDirectoryLock(before.identity);
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(contents.toString("utf8")) as unknown;
      } catch {
        return this.#legacyDirectoryLock(before.identity);
      }
      const parsedLock = LockEnvelopeSchema.safeParse(parsedJson);
      if (!parsedLock.success) {
        return this.#legacyDirectoryLock(before.identity);
      }
      return Object.freeze({
        identity: before.identity,
        acquiredAt: parsedLock.data.acquiredAt,
        processId: parsedLock.data.processId,
      });
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
          // A failed close never exposes a native filesystem error.
        }
      }
    }
  }

  #legacyDirectoryLock(identity: RegularFileIdentity): ExistingDirectoryLock {
    return Object.freeze({
      identity,
      acquiredAt: validatedNow(Math.floor(identity.mtimeMs)),
      processId: undefined,
    });
  }

  async #lockFileStatus(): Promise<ProfileFileStatus> {
    try {
      const status = await lstat(this.#lockPath);
      return Object.freeze({
        kind: "regular",
        identity: validatedRegularLockFile(status),
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

  #newLockOwner(): string {
    let owner: string;
    try {
      owner = this.#randomSuffix();
    } catch {
      throw hostError("STATE_UNAVAILABLE");
    }
    if (typeof owner !== "string" || !SAFE_TEMP_SUFFIX.test(owner)) {
      throw hostError("STATE_UNAVAILABLE");
    }
    return owner;
  }

  #currentTime(): number {
    try {
      return validatedNow(this.#now());
    } catch (error) {
      if (isHostError(error)) {
        throw error;
      }
      throw hostError("STATE_UNAVAILABLE");
    }
  }

  #lockOwnerIsAlive(processId: number): boolean {
    try {
      const alive = this.#isLockOwnerAlive(processId);
      if (typeof alive !== "boolean") {
        throw hostError("STATE_UNAVAILABLE");
      }
      return alive;
    } catch (error) {
      if (isHostError(error)) {
        throw error;
      }
      throw hostError("STATE_UNAVAILABLE");
    }
  }

  async #releaseDirectoryLock(lock: OwnedDirectoryLock): Promise<void> {
    let currentIdentity: RegularFileIdentity;
    try {
      currentIdentity = validatedRegularLockFile(await lock.handle.stat());
    } catch {
      try {
        await lock.handle.close();
      } catch {
        // A failed close never exposes a native filesystem error.
      }
      throw hostError("STATE_UNAVAILABLE");
    }
    try {
      await lock.handle.close();
    } catch {
      throw hostError("STATE_UNAVAILABLE");
    }
    if (!hasSameIdentity(lock.identity, currentIdentity)) {
      return;
    }
    await this.#removeOwnedClosedPath(this.#lockPath, lock.identity, "lock");
  }

  async #discardOwnedOpenPath(
    path: string,
    handle: Awaited<ReturnType<typeof open>>,
    kind: "lock" | "temporary",
  ): Promise<void> {
    let identity: RegularFileIdentity | undefined;
    try {
      const status = await handle.stat();
      identity =
        kind === "lock"
          ? validatedRegularLockFile(status)
          : validatedRegularProfileFile(status);
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
        await this.#removeOwnedClosedPath(path, identity, kind);
      } catch {
        // The triggering operation already returns a stable error.
      }
    }
  }

  async #removeOwnedClosedPath(
    path: string,
    expected: RegularFileIdentity,
    kind: "lock" | "temporary",
  ): Promise<boolean> {
    try {
      const status = await lstat(path);
      const current =
        kind === "lock"
          ? validatedRegularLockFile(status)
          : validatedRegularProfileFile(status);
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
        await this.#discardOwnedOpenPath(temporaryPath, handle, "temporary");
      }
      if (handle === undefined && temporaryIdentity !== undefined) {
        try {
          await this.#removeOwnedClosedPath(
            temporaryPath,
            temporaryIdentity,
            "temporary",
          );
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
