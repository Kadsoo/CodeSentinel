import {
  createAgentSessionController,
  createToolDispatcher,
  type AgentSessionController,
  type StopProbe,
} from "../../core/src/index.js";
import { CodeSentinelConfigSchema, type CodeSentinelConfig } from "../../contracts/src/index.js";
import { evaluatePath, createPolicy, type PolicyContext } from "../../policy/src/index.js";
import type { SessionRepository } from "../../persistence/src/index.js";
import {
  OpenAICompatibleProvider,
  type CredentialStore,
  type Provider,
} from "../../providers/src/index.js";
import type { ProfileStore, ProviderProfile } from "./profile-store.js";
import { hostError } from "./errors.js";
import { workspaceIdFor, type LoadedWorkspace } from "./workspace-config.js";

export type ProviderFactory = (input: Readonly<{
  endpoint: string;
  model: string;
  apiKey: string;
}>) => Provider;

export type CreateWorkspaceRuntimeInput = Readonly<{
  workspace: LoadedWorkspace;
  verificationCommandId: string;
}>;

export type CreateWorkspaceRuntimeDependencies = Readonly<{
  profileStore: ProfileStore;
  credentialStore: CredentialStore;
  repository: SessionRepository;
  now: () => number;
  createId: () => string;
  shouldStop?: StopProbe;
  providerFactory?: ProviderFactory;
}>;

export type WorkspaceRuntime = Readonly<{
  workspaceId: string;
  profile: ProviderProfile;
  controller: AgentSessionController;
}>;

export async function createWorkspaceRuntime(
  input: CreateWorkspaceRuntimeInput,
  dependencies: CreateWorkspaceRuntimeDependencies,
): Promise<WorkspaceRuntime> {
  const { workspace, verificationCommandId } = readInput(input);
  const dependencySet = readDependencies(dependencies);
  if (!workspace.config.verificationCommands.some((command) => command.id === verificationCommandId)) {
    throw hostError("CONFIG_INVALID");
  }

  const profile = await loadSelectedProfile(dependencySet.profileStore, workspace.config);
  const secret = await loadCredential(dependencySet.credentialStore, profile.credentialRef);
  const provider = createProvider(dependencySet.providerFactory, profile, secret);
  const policyContext = createPolicyContext(workspace);
  const policy = createPolicy(policyContext);
  const tools = createToolDispatcher({
    workspaceRoot: workspace.canonicalRoot,
    verificationCommands: workspace.config.verificationCommands,
    canReadPath: (path) => evaluatePath(path, policyContext).status === "safe",
  });
  const controller = createAgentSessionController({
    provider,
    policy,
    tools,
    eventSink: dependencySet.repository,
    now: dependencySet.now,
    createId: dependencySet.createId,
    ...(dependencySet.shouldStop === undefined ? {} : { shouldStop: dependencySet.shouldStop }),
  });

  return Object.freeze({
    workspaceId: workspace.workspaceId,
    profile,
    controller,
  });
}

function readInput(input: CreateWorkspaceRuntimeInput): Readonly<{
  workspace: LoadedWorkspace;
  verificationCommandId: string;
}> {
  try {
    const workspace = input.workspace;
    const verificationCommandId = input.verificationCommandId;
    if (
      !isLoadedWorkspace(workspace) ||
      typeof verificationCommandId !== "string" ||
      verificationCommandId.length === 0
    ) {
      throw hostError("CONFIG_INVALID");
    }
    return Object.freeze({ workspace, verificationCommandId });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "CONFIG_INVALID") {
      throw error;
    }
    throw hostError("CONFIG_INVALID");
  }
}

function isLoadedWorkspace(value: unknown): value is LoadedWorkspace {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const workspace = value as Partial<LoadedWorkspace>;
  if (
    typeof workspace.canonicalRoot !== "string" ||
    workspace.canonicalRoot.length === 0 ||
    workspace.canonicalRoot.includes("\u0000") ||
    typeof workspace.workspaceId !== "string" ||
    workspace.workspaceId !== workspaceIdFor(workspace.canonicalRoot)
  ) {
    return false;
  }
  return CodeSentinelConfigSchemaSafe(workspace.config);
}

function CodeSentinelConfigSchemaSafe(value: unknown): value is CodeSentinelConfig {
  return CodeSentinelConfigSchema.safeParse(value).success;
}

function readDependencies(
  dependencies: CreateWorkspaceRuntimeDependencies,
): CreateWorkspaceRuntimeDependencies {
  try {
    if (
      typeof dependencies !== "object" ||
      dependencies === null ||
      typeof dependencies.profileStore?.get !== "function" ||
      typeof dependencies.credentialStore?.status !== "function" ||
      typeof dependencies.credentialStore?.get !== "function" ||
      typeof dependencies.repository?.append !== "function" ||
      typeof dependencies.now !== "function" ||
      typeof dependencies.createId !== "function" ||
      (dependencies.shouldStop !== undefined && typeof dependencies.shouldStop !== "function") ||
      (dependencies.providerFactory !== undefined && typeof dependencies.providerFactory !== "function")
    ) {
      throw hostError("STATE_UNAVAILABLE");
    }
    return dependencies;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "STATE_UNAVAILABLE") {
      throw error;
    }
    throw hostError("STATE_UNAVAILABLE");
  }
}

async function loadSelectedProfile(
  profileStore: ProfileStore,
  config: CodeSentinelConfig,
): Promise<ProviderProfile> {
  try {
    const profile = await profileStore.get(config.providerProfileId);
    if (profile === undefined) {
      throw hostError("PROFILE_NOT_FOUND");
    }
    return Object.freeze({ ...profile });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "PROFILE_NOT_FOUND") {
      throw error;
    }
    throw hostError("STATE_UNAVAILABLE");
  }
}

async function loadCredential(credentialStore: CredentialStore, reference: string): Promise<string> {
  try {
    if ((await credentialStore.status(reference)) !== "configured") {
      throw hostError("CREDENTIAL_MISSING");
    }
    const secret = await credentialStore.get(reference);
    if (typeof secret !== "string" || secret.trim().length === 0) {
      throw hostError("CREDENTIAL_MISSING");
    }
    return secret;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "CREDENTIAL_MISSING") {
      throw error;
    }
    throw hostError("STATE_UNAVAILABLE");
  }
}

function createProvider(
  factory: ProviderFactory | undefined,
  profile: ProviderProfile,
  secret: string,
): Provider {
  try {
    return (factory ?? defaultProviderFactory)(Object.freeze({
      endpoint: profile.endpoint,
      model: profile.model,
      apiKey: secret,
    }));
  } catch {
    throw hostError("STATE_UNAVAILABLE");
  }
}

function defaultProviderFactory(input: Readonly<{
  endpoint: string;
  model: string;
  apiKey: string;
}>): Provider {
  return new OpenAICompatibleProvider({ ...input, fetch: globalThis.fetch });
}

function createPolicyContext(workspace: LoadedWorkspace): PolicyContext {
  return Object.freeze({
    workspaceRoot: workspace.canonicalRoot,
    canonicalWorkspaceRoot: workspace.canonicalRoot,
    config: Object.freeze({
      allowedPaths: workspace.config.allowedPaths,
      verificationCommands: workspace.config.verificationCommands,
      ...(workspace.config.sensitivePatterns === undefined
        ? {}
        : { sensitivePatterns: workspace.config.sensitivePatterns }),
    }),
  });
}
