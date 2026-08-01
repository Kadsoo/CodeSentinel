import { Command, CommanderError } from "commander";
import type { ProviderProfile, ProfileStore } from "../../../packages/host/src/profile-store.js";
import type {
  CredentialStatus,
  CredentialStore,
} from "../../../packages/providers/src/credential-store.js";

export const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions" as const;
export const DEEPSEEK_MODEL = "deepseek-v4-flash" as const;
export const MAX_MODEL_LENGTH = 128 as const;

export type CliOutput = Readonly<{
  write(chunk: string | Uint8Array): unknown;
}>;

export type CliStreams = Readonly<{
  stdout: CliOutput;
  stderr: CliOutput;
  stdin: Readonly<{ isTTY?: boolean }>;
}>;

export type CliProbe = (profile: ProviderProfile, secret: string) => Promise<void>;

export type CliDependencies = Readonly<{
  profileStore: ProfileStore;
  credentialStore: CredentialStore;
  streams?: CliStreams;
  promptHidden?: () => Promise<string>;
  probe?: CliProbe;
  start?: () => Promise<void>;
}>;

type CliContext = Readonly<{
  dependencies: CliDependencies;
  streams: CliStreams;
}>;

type SetOptions = Readonly<{
  provider?: string;
  model?: string;
  endpoint?: string;
}>;

type CliProvider = "deepseek" | "nju-se-hub";

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_SECRET_LENGTH = 4_096;
const KNOWN_ERROR_CODES = new Set([
  "CREDENTIAL_INVALID_INPUT",
  "CREDENTIAL_UNAVAILABLE",
  "PROFILE_INVALID",
  "PROFILE_NOT_FOUND",
  "STATE_UNAVAILABLE",
  "STATE_CORRUPT",
  "INTERNAL_ERROR",
]);

/**
 * Dispatches the local CLI without reading process arguments, environment
 * variables, or constructing a real credential store. Production code injects
 * those resources through `main.ts`; tests can therefore exercise the complete
 * command flow with in-memory ports.
 */
export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const context = readContext(dependencies);
  const program = createProgram(context);
  try {
    await program.parseAsync([...argv], { from: "user" });
    return 0;
  } catch (error) {
    if (isSuccessfulCommanderExit(error)) {
      return 0;
    }
    writeError(context.streams, error);
    return 1;
  }
}

function createProgram(context: CliContext): Command {
  const program = new Command();
  program
    .name("codesentinel")
    .exitOverride()
    .configureOutput({
      writeOut: (message) => context.streams.stdout.write(message),
      writeErr: (message) => context.streams.stderr.write(message),
    });

  program
    .command("start")
    .description("start the local loopback API")
    .action(async () => {
      if (context.dependencies.start === undefined) {
        throw new CliFailure("STATE_UNAVAILABLE");
      }
      await context.dependencies.start();
    });

  const credentials = program.command("credentials");
  credentials
    .command("set")
    .argument("<profileId>")
    .requiredOption("--provider <provider>")
    .requiredOption("--model <model>")
    .option("--endpoint <https-url>")
    .action(async (profileId: string, options: SetOptions) => {
      await setCredential(context, profileId, options);
    });
  credentials
    .command("status")
    .argument("<profileId>")
    .action(async (profileId: string) => {
      await showStatus(context, profileId);
    });
  credentials
    .command("clear")
    .argument("<profileId>")
    .action(async (profileId: string) => {
      await clearCredential(context, profileId);
    });
  credentials
    .command("probe")
    .argument("<profileId>")
    .action(async (profileId: string) => {
      await probeCredential(context, profileId);
    });

  return program;
}

async function setCredential(
  context: CliContext,
  profileIdInput: string,
  options: SetOptions,
): Promise<void> {
  const profileId = validateIdentifier(profileIdInput);
  const provider = validateProvider(options.provider);
  const model = validateModel(options.model);
  const endpoint = validateEndpoint(provider, options.endpoint);
  const existing = await readProfile(context.dependencies.profileStore, profileId);
  const credentialRef = existing?.credentialRef ?? profileId;
  const profile: ProviderProfile = Object.freeze({
    id: profileId,
    kind: provider === "nju-se-hub" ? "nju_se_hub" : provider,
    endpoint,
    model,
    credentialRef,
  });

  if (context.streams.stdin.isTTY !== true) {
    throw new CliFailure("CREDENTIAL_UNAVAILABLE");
  }
  const promptHidden = context.dependencies.promptHidden;
  if (promptHidden === undefined) {
    throw new CliFailure("CREDENTIAL_UNAVAILABLE");
  }

  const secret = await readSecret(promptHidden);
  // Publish only non-secret state first. A credential manager failure leaves a
  // valid profile behind, allowing a later retry without losing configuration.
  await context.dependencies.profileStore.upsert(profile);
  await context.dependencies.credentialStore.set(credentialRef, secret);
}

async function showStatus(context: CliContext, profileIdInput: string): Promise<void> {
  const profileId = validateIdentifier(profileIdInput);
  const profile = await requireProfile(context.dependencies.profileStore, profileId);
  const status = await readCredentialStatus(context.dependencies.credentialStore, profile.credentialRef);
  writeLine(context.streams.stdout, `${profileId}: ${status}`);
}

async function clearCredential(context: CliContext, profileIdInput: string): Promise<void> {
  const profileId = validateIdentifier(profileIdInput);
  const profile = await requireProfile(context.dependencies.profileStore, profileId);
  await context.dependencies.credentialStore.clear(profile.credentialRef);
  await context.dependencies.profileStore.remove(profile.id);
}

async function probeCredential(context: CliContext, profileIdInput: string): Promise<void> {
  const profileId = validateIdentifier(profileIdInput);
  const profile = await requireProfile(context.dependencies.profileStore, profileId);
  const status = await readCredentialStatus(context.dependencies.credentialStore, profile.credentialRef);
  if (status !== "configured") {
    throw new CliFailure("CREDENTIAL_UNAVAILABLE");
  }
  const secret = await readCredential(context.dependencies.credentialStore, profile.credentialRef);
  if (context.dependencies.probe === undefined) {
    throw new CliFailure("CREDENTIAL_UNAVAILABLE");
  }
  await context.dependencies.probe(profile, secret);
}

async function readSecret(promptHidden: () => Promise<string>): Promise<string> {
  try {
    const secret = await promptHidden();
    if (
      typeof secret !== "string" ||
      secret.trim().length === 0 ||
      secret.length > MAX_SECRET_LENGTH ||
      hasControlCharacter(secret)
    ) {
      throw new CliFailure("CREDENTIAL_INVALID_INPUT");
    }
    return secret;
  } catch (error) {
    if (error instanceof CliFailure) {
      throw error;
    }
    throw new CliFailure("CREDENTIAL_UNAVAILABLE");
  }
}

async function readCredentialStatus(
  credentialStore: CredentialStore,
  reference: string,
): Promise<CredentialStatus> {
  try {
    const status = await credentialStore.status(reference);
    if (status !== "configured" && status !== "missing") {
      throw new CliFailure("CREDENTIAL_UNAVAILABLE");
    }
    return status;
  } catch (error) {
    throw normalizeFailure(error);
  }
}

async function readCredential(credentialStore: CredentialStore, reference: string): Promise<string> {
  try {
    const secret = await credentialStore.get(reference);
    if (typeof secret !== "string" || secret.trim().length === 0 || secret.length > MAX_SECRET_LENGTH) {
      throw new CliFailure("CREDENTIAL_UNAVAILABLE");
    }
    return secret;
  } catch (error) {
    if (error instanceof CliFailure) {
      throw error;
    }
    throw normalizeFailure(error);
  }
}

async function readProfile(profileStore: ProfileStore, profileId: string): Promise<ProviderProfile | undefined> {
  try {
    return await profileStore.get(profileId);
  } catch (error) {
    throw normalizeFailure(error);
  }
}

async function requireProfile(profileStore: ProfileStore, profileId: string): Promise<ProviderProfile> {
  const profile = await readProfile(profileStore, profileId);
  if (profile === undefined) {
    throw new CliFailure("PROFILE_NOT_FOUND");
  }
  return profile;
}

function validateIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    SAFE_IDENTIFIER.exec(value)?.[0] !== value
  ) {
    throw new CliFailure("PROFILE_INVALID");
  }
  return value;
}

function validateProvider(value: unknown): CliProvider {
  if (value === "deepseek" || value === "nju-se-hub") {
    return value;
  }
  throw new CliFailure("PROFILE_INVALID");
}

function validateModel(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_MODEL_LENGTH ||
    hasControlCharacter(value)
  ) {
    throw new CliFailure("PROFILE_INVALID");
  }
  return value;
}

function validateEndpoint(
  provider: CliProvider,
  value: string | undefined,
): string {
  if (provider === "deepseek") {
    if (value !== undefined && value !== DEEPSEEK_ENDPOINT) {
      throw new CliFailure("PROFILE_INVALID");
    }
    return DEEPSEEK_ENDPOINT;
  }
  if (value === undefined || !isSafeHttpsEndpoint(value)) {
    throw new CliFailure("PROFILE_INVALID");
  }
  return value;
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
      endpoint.hash.length === 0 &&
      !hasControlCharacter(value)
    );
  } catch {
    return false;
  }
}

function readContext(dependencies: CliDependencies): CliContext {
  if (
    typeof dependencies !== "object" ||
    dependencies === null ||
    typeof dependencies.profileStore?.get !== "function" ||
    typeof dependencies.profileStore?.upsert !== "function" ||
    typeof dependencies.profileStore?.remove !== "function" ||
    typeof dependencies.credentialStore?.status !== "function" ||
    typeof dependencies.credentialStore?.get !== "function" ||
    typeof dependencies.credentialStore?.set !== "function" ||
    typeof dependencies.credentialStore?.clear !== "function"
  ) {
    throw new CliFailure("STATE_UNAVAILABLE");
  }
  const streams = dependencies.streams ?? defaultStreams();
  if (
    typeof streams.stdout?.write !== "function" ||
    typeof streams.stderr?.write !== "function" ||
    typeof streams.stdin !== "object" ||
    streams.stdin === null
  ) {
    throw new CliFailure("STATE_UNAVAILABLE");
  }
  return Object.freeze({ dependencies, streams });
}

function defaultStreams(): CliStreams {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
  };
}

function writeLine(output: CliOutput, text: string): void {
  output.write(`${text}\n`);
}

function writeError(streams: CliStreams, error: unknown): void {
  const code = errorCode(error);
  streams.stderr.write(`${code}\n`);
}

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

function errorCode(error: unknown): string {
  if (error instanceof CliFailure) {
    return error.code;
  }
  if (error instanceof CommanderError) {
    return "CONFIG_INVALID";
  }
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && KNOWN_ERROR_CODES.has(code)) {
      return code;
    }
  }
  return "INTERNAL_ERROR";
}

function isSuccessfulCommanderExit(error: unknown): boolean {
  return (
    error instanceof CommanderError &&
    (error.code === "commander.helpDisplayed" || error.code === "commander.version")
  );
}

function normalizeFailure(error: unknown): CliFailure {
  const code = errorCode(error);
  if (code === "CREDENTIAL_INVALID_INPUT" || code === "CREDENTIAL_UNAVAILABLE") {
    return new CliFailure(code);
  }
  if (code === "PROFILE_NOT_FOUND" || code === "PROFILE_INVALID") {
    return new CliFailure(code);
  }
  return new CliFailure("STATE_UNAVAILABLE");
}

class CliFailure extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CliFailure";
    this.code = code;
  }
}
