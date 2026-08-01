import { describe, expect, it, vi } from "vitest";
import { buildServer, startServer, type ApiDependencies } from "./server.js";

function dependencies(): ApiDependencies {
  return {
    workspaceLoader: { load: vi.fn() },
    sessionService: {
      create: vi.fn(),
      get: vi.fn(),
      list: vi.fn(async () => []),
      timeline: vi.fn(),
      resolveApproval: vi.fn(),
      stop: vi.fn(),
      recover: vi.fn(async () => 0),
    },
    profileStore: { get: vi.fn(), list: vi.fn(), upsert: vi.fn(), remove: vi.fn() },
    credentialStore: { set: vi.fn(), get: vi.fn(), status: vi.fn(), clear: vi.fn() },
  } as ApiDependencies;
}

describe("loopback API server", () => {
  it("uses a bounded body and keeps Fastify logging disabled", async () => {
    const app = buildServer(dependencies());
    expect(app.initialConfig.bodyLimit).toBe(16 * 1024);
    const response = await app.inject({
      method: "POST",
      url: "/workspaces/validate",
      payload: { workspacePath: "x".repeat(16 * 1024) },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "CONFIG_INVALID" });
    await app.close();
  });

  it("passes only the fixed loopback host and port to an injected listener", async () => {
    const deps = dependencies();
    const listen = vi.fn(async () => "http://127.0.0.1:48761");
    const app = await startServer(deps, { listen });
    expect(listen).toHaveBeenCalledWith({ host: "127.0.0.1", port: 48_761 });
    expect(deps.sessionService.recover).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("maps EADDRINUSE to SERVER_ALREADY_RUNNING without probing or terminating", async () => {
    const listen = vi.fn(async () => {
      const error = new Error("address in use") as Error & { code: string };
      error.code = "EADDRINUSE";
      throw error;
    });
    await expect(startServer(dependencies(), { listen })).rejects.toMatchObject({
      code: "SERVER_ALREADY_RUNNING",
    });
    expect(listen).toHaveBeenCalledTimes(1);
  });
});
