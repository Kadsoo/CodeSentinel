import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SessionRepository } from "../../persistence/src/index.js";
import type { Provider } from "../../providers/src/index.js";

const SECRET_SENTINEL = "sk-runtime-secret-sentinel-20260801";

const validConfig = Object.freeze({
  providerProfileId: "deepseek-default",
  allowedPaths: ["src/**"],
  verificationCommands: [
    {
      id: "test",
      launcher: "node_npm_cli",
      args: ["test"],
      timeoutMs: 30_000,
      maxOutputBytes: 4_096,
    },
  ],
});

const validProfile = Object.freeze({
  id: "deepseek-default",
  kind: "deepseek" as const,
  endpoint: "https://api.deepseek.com/chat/completions",
  model: "deepseek-v4-flash",
  credentialRef: "deepseek-default",
});

type HostModule = typeof import("./index.js") & {
  createWorkspaceConfigLoader: () => {
    load(input: Readonly<{ workspacePath: string }>): Promise<unknown>;
  };
  createWorkspaceRuntime: (
    input: Readonly<{ workspace: unknown; verificationCommandId: string }>,
    dependencies: unknown,
  ) => Promise<{
    workspaceId: string;
    profile: typeof validProfile;
    controller: {
      runAgentSession(input: unknown): Promise<unknown>;
    };
  }>;
};

async function host(): Promise<HostModule> {
  return (await import("./index.js")) as HostModule;
}

async function withWorkspace<T>(callback: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "codesentinel-runtime-"));
  try {
    await writeFile(join(workspaceRoot, "codesentinel.json"), JSON.stringify(validConfig), "utf8");
    return await callback(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function repositoryWithAppendSpy(): {
  repository: SessionRepository;
  append: ReturnType<typeof vi.fn<SessionRepository["append"]>>;
} {
  const append = vi.fn<SessionRepository["append"]>(async () => undefined);
  return { repository: { append } as unknown as SessionRepository, append };
}

function configuredDependencies(overrides: Record<string, unknown> = {}): {
  dependencies: Record<string, unknown>;
  providerFactory: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  append: ReturnType<typeof vi.fn<SessionRepository["append"]>>;
} {
  const provider: Provider = Object.freeze({
    complete: vi.fn(async () => ({ kind: "finish", outcome: "completed", summary: "done" })),
  });
  const providerFactory = vi.fn(() => provider);
  const status = vi.fn(async () => "configured" as const);
  const get = vi.fn(async () => SECRET_SENTINEL);
  const { repository, append } = repositoryWithAppendSpy();
  return {
    dependencies: {
      profileStore: { get: vi.fn(async () => validProfile) },
      credentialStore: { status, get },
      repository,
      providerFactory,
      now: () => Date.parse("2026-08-01T00:00:00.000Z"),
      createId: () => "runtime-action-1",
      shouldStop: () => false,
      ...overrides,
    },
    providerFactory,
    status,
    get,
    append,
  };
}

describe("workspace runtime composition", () => {
  it("uses the loaded canonical workspace for the selected profile without retaining its secret", async () => {
    await withWorkspace(async (workspaceRoot) => {
      const module = await host();
      const workspace = await module.createWorkspaceConfigLoader().load({ workspacePath: workspaceRoot });
      const { dependencies, providerFactory, status, get, append } = configuredDependencies();

      const runtime = await module.createWorkspaceRuntime(
        { workspace, verificationCommandId: "test" },
        dependencies,
      );

      expect(runtime.workspaceId).toMatch(/^workspace-[0-9a-f]{64}$/u);
      expect(runtime.profile).toEqual(validProfile);
      expect(status).toHaveBeenCalledWith(validProfile.credentialRef);
      expect(get).toHaveBeenCalledWith(validProfile.credentialRef);
      expect(status.mock.invocationCallOrder[0]).toBeLessThan(get.mock.invocationCallOrder[0] ?? 0);
      expect(providerFactory).toHaveBeenCalledWith({
        endpoint: validProfile.endpoint,
        model: validProfile.model,
        apiKey: SECRET_SENTINEL,
      });
      expect(JSON.stringify(runtime)).not.toContain(SECRET_SENTINEL);

      await runtime.controller.runAgentSession({
        session: {
          id: "runtime-session-1",
          taskKind: "feature_implementation",
          state: "created",
          round: 0,
          workspaceId: runtime.workspaceId,
          providerId: runtime.profile.id,
          verificationCommandId: "test",
          taskSummary: "finish immediately",
          acceptanceCriteria: "return a final outcome",
        },
      });
      expect(append).toHaveBeenCalled();
    });
  });

  it("rejects an unknown verification command before reading a credential", async () => {
    await withWorkspace(async (workspaceRoot) => {
      const module = await host();
      const workspace = await module.createWorkspaceConfigLoader().load({ workspacePath: workspaceRoot });
      const { dependencies, status, get } = configuredDependencies();

      await expect(
        module.createWorkspaceRuntime({ workspace, verificationCommandId: "unknown" }, dependencies),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "CONFIG_INVALID" });
      expect(status).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    });
  });

  it("rejects the config-selected profile when it does not exist", async () => {
    await withWorkspace(async (workspaceRoot) => {
      const module = await host();
      const workspace = await module.createWorkspaceConfigLoader().load({ workspacePath: workspaceRoot });
      const { dependencies, status, get } = configuredDependencies({
        profileStore: { get: vi.fn(async () => undefined) },
      });

      await expect(
        module.createWorkspaceRuntime({ workspace, verificationCommandId: "test" }, dependencies),
      ).rejects.toMatchObject({ code: "PROFILE_NOT_FOUND", message: "PROFILE_NOT_FOUND" });
      expect(status).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    });
  });

  it("requires configured credential status before retrieving or composing a provider", async () => {
    await withWorkspace(async (workspaceRoot) => {
      const module = await host();
      const workspace = await module.createWorkspaceConfigLoader().load({ workspacePath: workspaceRoot });
      const { dependencies, providerFactory, get } = configuredDependencies({
        credentialStore: {
          status: vi.fn(async () => "missing" as const),
          get: vi.fn(async () => SECRET_SENTINEL),
        },
      });

      await expect(
        module.createWorkspaceRuntime({ workspace, verificationCommandId: "test" }, dependencies),
      ).rejects.toMatchObject({ code: "CREDENTIAL_MISSING", message: "CREDENTIAL_MISSING" });
      expect(get).not.toHaveBeenCalled();
      expect(providerFactory).not.toHaveBeenCalled();
    });
  });
});
