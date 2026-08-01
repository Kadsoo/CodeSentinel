import type { FastifyInstance } from "fastify";
import { z, type ZodType } from "zod";
import type {
  ProfileStore,
  SessionService,
  WorkspaceConfigLoader,
} from "../../../packages/host/src/index.js";
import { HostError, hostError } from "../../../packages/host/src/errors.js";
import type { CredentialStore } from "../../../packages/providers/src/credential-store.js";

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_SESSION_TEXT_LENGTH = 4_096;
const MAX_WORKSPACE_PATH_LENGTH = 4_096;

const identifier = z
  .string()
  .min(1)
  .max(MAX_IDENTIFIER_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

const workspacePath = z
  .string()
  .min(1)
  .max(MAX_WORKSPACE_PATH_LENGTH)
  .refine((value) => !hasControlCharacter(value));

const taskText = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SESSION_TEXT_LENGTH)
  .refine((value) => !hasControlCharacter(value));

const sessionBodySchema = z
  .object({
    workspacePath,
    taskKind: z.enum(["test_repair", "feature_implementation"]),
    verificationCommandId: identifier,
    taskSummary: taskText,
    acceptanceCriteria: taskText.optional(),
  })
  .strict();

const workspaceValidationSchema = z
  .object({ workspacePath })
  .strict();

const approvalBodySchema = z
  .object({ decision: z.enum(["approve", "reject"]) })
  .strict();

const credentialBodySchema = z
  .object({
    secret: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => value.trim().length > 0)
      .refine((value) => !hasControlCharacter(value)),
  })
  .strict();

const identifierParamsSchema = z
  .object({ id: identifier })
  .strict();

const sessionApprovalParamsSchema = z
  .object({ id: identifier, approvalId: identifier })
  .strict();

const profileParamsSchema = z
  .object({ profileId: identifier })
  .strict();

const optionalLimitSchema = z
  .object({ limit: z.string().regex(/^\d+$/u).optional() })
  .strict();

export type ApiDependencies = Readonly<{
  workspaceLoader: WorkspaceConfigLoader;
  sessionService: SessionService;
  profileStore: ProfileStore;
  credentialStore: CredentialStore;
}>;

export function registerRoutes(app: FastifyInstance, dependencies: ApiDependencies): void {
  app.get("/health", async () => ({ status: "ok" }));

  app.post("/workspaces/validate", async (request) => {
    const input = parseBody(workspaceValidationSchema, request.body);
    const workspace = await dependencies.workspaceLoader.load({ workspacePath: input.workspacePath });
    return Object.freeze({
      providerProfileId: workspace.config.providerProfileId,
      verificationCommandIds: workspace.config.verificationCommands.map((command) => command.id),
    });
  });

  app.post("/sessions", async (request, reply) => {
    const input = parseBody(sessionBodySchema, request.body);
    const created = await dependencies.sessionService.create(input);
    return reply.code(202).send({ sessionId: created.sessionId, state: created.state });
  });

  app.get("/sessions", async (request) => {
    const limit = readLimit(request.query, 100);
    return dependencies.sessionService.list(limit);
  });

  app.get("/sessions/:id", async (request) => {
    const { id } = parseParams(identifierParamsSchema, request.params);
    const session = await dependencies.sessionService.get(id);
    if (session === undefined) {
      throw hostError("SESSION_NOT_FOUND");
    }
    return session;
  });

  app.get("/sessions/:id/timeline", async (request) => {
    const { id } = parseParams(identifierParamsSchema, request.params);
    const limit = readLimit(request.query, 500);
    return dependencies.sessionService.timeline(id, limit);
  });

  app.post("/sessions/:id/approvals/:approvalId", async (request, reply) => {
    const params = parseParams(sessionApprovalParamsSchema, request.params);
    const body = parseBody(approvalBodySchema, request.body);
    await dependencies.sessionService.resolveApproval({
      sessionId: params.id,
      approvalId: params.approvalId,
      decision: body.decision,
    });
    return reply.code(204).send();
  });

  app.post("/sessions/:id/stop", async (request) => {
    const { id } = parseParams(identifierParamsSchema, request.params);
    const status = await dependencies.sessionService.stop({ sessionId: id });
    return { status };
  });

  app.get("/credentials/:profileId/status", async (request) => {
    const { profileId } = parseParams(profileParamsSchema, request.params);
    const profile = await requireProfile(dependencies.profileStore, profileId);
    const status = await dependencies.credentialStore.status(profile.credentialRef);
    return { status };
  });

  app.put("/credentials/:profileId", async (request, reply) => {
    const { profileId } = parseParams(profileParamsSchema, request.params);
    const input = parseBody(credentialBodySchema, request.body);
    const profile = await requireProfile(dependencies.profileStore, profileId);
    await dependencies.credentialStore.set(profile.credentialRef, input.secret);
    return reply.code(204).send();
  });

  app.delete("/credentials/:profileId", async (request, reply) => {
    const { profileId } = parseParams(profileParamsSchema, request.params);
    const profile = await requireProfile(dependencies.profileStore, profileId);
    await dependencies.credentialStore.clear(profile.credentialRef);
    await dependencies.profileStore.remove(profileId);
    return reply.code(204).send();
  });
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    const mapped = mapError(error);
    reply.code(mapped.statusCode).send({ code: mapped.code });
  });
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ code: "NOT_FOUND" });
  });
}

type MappedError = Readonly<{
  statusCode: number;
  code: string;
}>;

export function mapError(error: unknown): MappedError {
  const code = readErrorCode(error);
  switch (code) {
    case "CONFIG_INVALID":
    case "WORKSPACE_INVALID":
    case "PROFILE_INVALID":
    case "CREDENTIAL_MISSING":
    case "CREDENTIAL_INVALID_INPUT":
      return { statusCode: 400, code };
    case "PROFILE_NOT_FOUND":
    case "SESSION_NOT_FOUND":
    case "APPROVAL_NOT_FOUND":
      return { statusCode: 404, code };
    case "SESSION_ACTIVE":
    case "SESSION_NOT_ACTIVE":
      return { statusCode: 409, code };
    case "STATE_UNAVAILABLE":
    case "STATE_CORRUPT":
    case "CREDENTIAL_UNAVAILABLE":
      return { statusCode: 503, code };
    case "FST_ERR_CTP_BODY_TOO_LARGE":
    case "FST_ERR_CTP_INVALID_JSON_BODY":
    case "FST_ERR_CTP_EMPTY_JSON_BODY":
      return { statusCode: 400, code: "CONFIG_INVALID" };
    default:
      return { statusCode: 500, code: "INTERNAL_ERROR" };
  }
}

function parseBody<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw hostError("CONFIG_INVALID");
  }
  return parsed.data;
}

function parseParams<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw hostError("CONFIG_INVALID");
  }
  return parsed.data;
}

function readLimit(value: unknown, maximum: number): number {
  const parsed = optionalLimitSchema.safeParse(value);
  if (!parsed.success) {
    throw hostError("CONFIG_INVALID");
  }
  const raw = parsed.data.limit;
  if (raw === undefined) {
    return maximum;
  }
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw hostError("CONFIG_INVALID");
  }
  return limit;
}

async function requireProfile(profileStore: ProfileStore, id: string) {
  const profile = await profileStore.get(id);
  if (profile === undefined) {
    throw hostError("PROFILE_NOT_FOUND");
  }
  return profile;
}

function readErrorCode(error: unknown): string | undefined {
  if (error instanceof HostError) {
    return error.code;
  }
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
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
