import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { HostError, hostError } from "./errors.js";

const PROFILES_FILE_NAME = "profiles.json";
const PROFILES_VERSION = 1;
const MAX_PROFILES_FILE_BYTES = 65_536;
const MAX_PROFILES = 64;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_ENDPOINT_LENGTH = 2_048;
const MAX_MODEL_LENGTH = 128;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SAFE_TEMP_SUFFIX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const KNOWN_SECRET_FRAGMENT = /(?:sk-|sk_|pk_|rk_|ghp_)[A-Za-z0-9_-]{12,}/iu;

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
}>;

type ProfileEnvelope = Readonly<{
  version: 1;
  profiles: readonly ProviderProfile[];
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

class FileProfileStore implements ProfileStore {
  readonly #stateDirectory: string;
  readonly #profilePath: string;
  readonly #randomSuffix: () => string;
  #pending: Promise<void> = Promise.resolve();

  constructor(options: ProfileStoreOptions) {
    this.#stateDirectory = validateStateDirectory(options.stateDirectory);
    this.#profilePath = join(this.#stateDirectory, PROFILES_FILE_NAME);
    this.#randomSuffix = options.randomSuffix ?? defaultRandomSuffix;
    if (typeof this.#randomSuffix !== "function") {
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
    await this.#enqueue(async () => {
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
    await this.#enqueue(async () => {
      const current = await this.#readEnvelope();
      const profiles = current.profiles.filter((profile) => profile.id !== profileId);
      if (profiles.length === current.profiles.length) {
        throw hostError("PROFILE_NOT_FOUND");
      }
      await this.#writeEnvelope({ version: PROFILES_VERSION, profiles });
    });
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
    try {
      const status = await this.#profileFileStatus();
      if (status === "missing") {
        return Object.freeze({ version: PROFILES_VERSION, profiles: Object.freeze([]) });
      }

      const contents = await readFile(this.#profilePath, "utf8");
      if (Buffer.byteLength(contents, "utf8") > MAX_PROFILES_FILE_BYTES) {
        throw hostError("STATE_CORRUPT");
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(contents) as unknown;
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
      throw hostError("STATE_UNAVAILABLE");
    }
  }

  async #profileFileStatus(): Promise<"missing" | "regular"> {
    try {
      const status = await lstat(this.#profilePath);
      if (status.isSymbolicLink() || !status.isFile()) {
        throw hostError("STATE_CORRUPT");
      }
      if (status.size > MAX_PROFILES_FILE_BYTES) {
        throw hostError("STATE_CORRUPT");
      }
      return "regular";
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
    const status = await this.#profileFileStatus();
    if (status === "regular") {
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
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.#profilePath);
    } catch {
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          // The outer operation intentionally exposes only a stable host error.
        }
      }
      try {
        await rm(temporaryPath, { force: true });
      } catch {
        // The outer operation intentionally exposes only a stable host error.
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
