import { describe, expect, it, vi } from "vitest";
import { HostError } from "../../../packages/host/src/errors.js";
import type { LoadedWorkspace } from "../../../packages/host/src/workspace-config.js";
import type { PersistedSession } from "../../../packages/persistence/src/types.js";
import { buildServer, type ApiDependencies } from "./server.js";

const workspace = Object.freeze({
  canonicalRoot: "C:/fixture",
  workspaceId: "workspace-fixture",
  config: Object.freeze({
    providerProfileId: "deepseek-default",
    allowedPaths: ["src/**"],
    verificationCommands: [
      Object.freeze({
        id: "test",
        launcher: "node_npm_cli" as const,
        args: ["test"],
        timeoutMs: 30_000,
        maxOutputBytes: 4_096,
      }),
    ],
  }),
}) as unknown as LoadedWorkspace;

const profile = Object.freeze({
  id: "deepseek-default",
  kind: "deepseek" as const,
  endpoint: "https://api.deepseek.com/chat/completions",
  model: "deepseek-v4-flash",
  credentialRef: "deepseek-default",
});

function session(id = "session-1"): PersistedSession {
  return Object.freeze({
    id,
    taskKind: "test_repair",
    state: "created",
    round: 0,
    workspaceId: "workspace-fixture",
    providerId: "deepseek-default",
    verificationCommandId: "test",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
}

function dependencies(overrides: Partial<ApiDependencies> = {}): ApiDependencies {
  return {
    workspaceLoader: {
      load: vi.fn(async () => workspace),
    },
    sessionService: {
      create: vi.fn(async () => ({ sessionId: "session-1", state: "created" as const })),
      get: vi.fn(async () => session()),
      list: vi.fn(async () => [session()]),
      timeline: vi.fn(async () => []),
      resolveApproval: vi.fn(async () => undefined),
      stop: vi.fn(async () => "accepted" as const),
      recover: vi.fn(async () => 0),
    },
    profileStore: {
      get: vi.fn(async () => profile),
      list: vi.fn(async () => [profile]),
      upsert: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
    credentialStore: {
      status: vi.fn(async () => "missing" as const),
      set: vi.fn(async () => undefined),
      get: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    },
    ...overrides,
  } as ApiDependencies;
}

const validSessionBody = {
  taskKind: "test_repair",
  workspacePath: "C:/repo",
  verificationCommandId: "test",
  taskSummary: "repair the failing project",
};

describe("strict loopback API routes", () => {
  it("rejects unknown body fields before creating a session", async () => {
    const deps = dependencies();
    const app = buildServer(deps);
    const response = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { ...validSessionBody, unexpected: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "CONFIG_INVALID" });
    expect(deps.sessionService.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 202 for an accepted asynchronous session", async () => {
    const deps = dependencies();
    const app = buildServer(deps);
    const response = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: validSessionBody,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ sessionId: "session-1", state: "created" });
    expect(deps.sessionService.create).toHaveBeenCalledWith(validSessionBody);
    await app.close();
  });

  it("maps an unknown verification command to CONFIG_INVALID", async () => {
    const deps = dependencies({
      sessionService: {
        ...dependencies().sessionService,
        create: vi.fn(async () => {
          throw new HostError("CONFIG_INVALID");
        }),
      },
    });
    const app = buildServer(deps);
    const response = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { ...validSessionBody, verificationCommandId: "unknown" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "CONFIG_INVALID" });
    await app.close();
  });

  it("maps a concurrently active session to 409", async () => {
    const deps = dependencies({
      sessionService: {
        ...dependencies().sessionService,
        create: vi.fn(async () => {
          throw new HostError("SESSION_ACTIVE");
        }),
      },
    });
    const app = buildServer(deps);
    const response = await app.inject({ method: "POST", url: "/sessions", payload: validSessionBody });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: "SESSION_ACTIVE" });
    await app.close();
  });

  it("passes bounded session and timeline limits and rejects out-of-range values", async () => {
    const deps = dependencies();
    const app = buildServer(deps);

    const sessions = await app.inject({ method: "GET", url: "/sessions?limit=7" });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json()).toEqual([session()]);
    expect(deps.sessionService.list).toHaveBeenCalledWith(7);

    const timeline = await app.inject({ method: "GET", url: "/sessions/session-1/timeline?limit=11" });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json()).toEqual([]);
    expect(deps.sessionService.timeline).toHaveBeenCalledWith("session-1", 11);

    const invalidList = await app.inject({ method: "GET", url: "/sessions?limit=101" });
    expect(invalidList.statusCode).toBe(400);
    expect(invalidList.json()).toEqual({ code: "CONFIG_INVALID" });
    const invalidTimeline = await app.inject({ method: "GET", url: "/sessions/session-1/timeline?limit=501" });
    expect(invalidTimeline.statusCode).toBe(400);
    expect(invalidTimeline.json()).toEqual({ code: "CONFIG_INVALID" });
    await app.close();
  });

  it("forwards approval and returns an idempotent stop result", async () => {
    const deps = dependencies();
    const app = buildServer(deps);
    const approval = await app.inject({
      method: "POST",
      url: "/sessions/session-1/approvals/approval-1",
      payload: { decision: "approve" },
    });
    expect(approval.statusCode).toBe(204);
    expect(deps.sessionService.resolveApproval).toHaveBeenCalledWith({
      sessionId: "session-1",
      approvalId: "approval-1",
      decision: "approve",
    });

    const stop = await app.inject({ method: "POST", url: "/sessions/session-1/stop" });
    expect(stop.statusCode).toBe(200);
    expect(stop.json()).toEqual({ status: "accepted" });
    expect(deps.sessionService.stop).toHaveBeenCalledWith({ sessionId: "session-1" });
    await app.close();
  });

  it("validates credentials without echoing a secret and clears profile after the store", async () => {
    const secret = "sk-api-secret-sentinel-20260801";
    const deps = dependencies();
    const app = buildServer(deps);

    const status = await app.inject({ method: "GET", url: "/credentials/deepseek-default/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ status: "missing" });

    const set = await app.inject({
      method: "PUT",
      url: "/credentials/deepseek-default",
      payload: { secret },
    });
    expect(set.statusCode).toBe(204);
    expect(set.body).toBe("");
    expect(deps.credentialStore.set).toHaveBeenCalledWith("deepseek-default", secret);
    expect(set.body).not.toContain(secret);

    const clear = await app.inject({ method: "DELETE", url: "/credentials/deepseek-default" });
    expect(clear.statusCode).toBe(204);
    expect(deps.credentialStore.clear).toHaveBeenCalledWith("deepseek-default");
    expect(deps.profileStore.remove).toHaveBeenCalledWith("deepseek-default");
    expect((deps.credentialStore.clear as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (deps.profileStore.remove as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    );

    const unsupportedRead = await app.inject({ method: "GET", url: "/credentials/deepseek-default" });
    expect(unsupportedRead.statusCode).toBe(404);
    await app.close();
  });

  it("returns only safe workspace metadata", async () => {
    const deps = dependencies();
    const app = buildServer(deps);
    const response = await app.inject({
      method: "POST",
      url: "/workspaces/validate",
      payload: { workspacePath: "C:/repo" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      providerProfileId: "deepseek-default",
      verificationCommandIds: ["test"],
    });
    expect(response.body).not.toContain("C:/repo");
    await app.close();
  });

  it("maps unexpected failures to a stable internal error without details", async () => {
    const deps = dependencies({
      sessionService: {
        ...dependencies().sessionService,
        list: vi.fn(async () => {
          throw new Error("secret native failure");
        }),
      },
    });
    const app = buildServer(deps);
    const response = await app.inject({ method: "GET", url: "/sessions" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: "INTERNAL_ERROR" });
    expect(response.body).not.toContain("secret native failure");
    await app.close();
  });
});
