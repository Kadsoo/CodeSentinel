import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const VALID_CONFIG = Object.freeze({
  providerProfileId: "deepseek-default",
  allowedPaths: ["src/**"],
  sensitivePatterns: ["**/.env"],
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

type HostModule = typeof import("./index.js") & {
  createWorkspaceConfigLoader: () => {
    load(input: Readonly<{ workspacePath: string }>): Promise<{
      canonicalRoot: string;
      workspaceId: string;
      config: typeof VALID_CONFIG;
    }>;
  };
};

async function host(): Promise<HostModule> {
  return (await import("./index.js")) as HostModule;
}

async function withWorkspace(
  callback: (workspaceRoot: string) => Promise<void>,
): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "codesentinel-workspace-"));
  try {
    await callback(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function writeConfig(workspaceRoot: string, contents: string): Promise<void> {
  await writeFile(join(workspaceRoot, "codesentinel.json"), contents, "utf8");
}

async function expectHostError(
  operation: () => Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(operation()).rejects.toMatchObject({ code, message: code });
}

describe("workspace config loader", () => {
  it("loads only a canonical workspace config and derives a path-free workspace id", async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeConfig(workspaceRoot, JSON.stringify(VALID_CONFIG));
      const loader = (await host()).createWorkspaceConfigLoader();

      const loaded = await loader.load({ workspacePath: join(workspaceRoot, ".") });

      expect(loaded.canonicalRoot).toBe(workspaceRoot);
      expect(loaded.workspaceId).toMatch(/^workspace-[0-9a-f]{64}$/u);
      expect(loaded.workspaceId).not.toContain(workspaceRoot);
      expect(loaded.config.verificationCommands.map((command) => command.id)).toEqual(["test"]);
    });
  });

  it.each([
    ["a missing workspace", "WORKSPACE_INVALID"],
    ["a non-directory workspace", "WORKSPACE_INVALID"],
  ])("rejects %s", async (_label, code) => {
    await withWorkspace(async (workspaceRoot) => {
      const candidate = join(workspaceRoot, "missing");
      if (_label === "a non-directory workspace") {
        await writeFile(candidate, "not a directory", "utf8");
      }
      const loader = (await host()).createWorkspaceConfigLoader();

      await expectHostError(() => loader.load({ workspacePath: candidate }), code);
    });
  });

  it("rejects a symlink workspace root", async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeConfig(workspaceRoot, JSON.stringify(VALID_CONFIG));
      const linkPath = join(workspaceRoot, "workspace-link");
      await symlink(workspaceRoot, linkPath, "junction");
      const loader = (await host()).createWorkspaceConfigLoader();

      await expectHostError(() => loader.load({ workspacePath: linkPath }), "WORKSPACE_INVALID");
    });
  });

  it.each([
    ["a missing config", undefined],
    ["invalid JSON", "{"],
    ["an invalid strict config", JSON.stringify({ ...VALID_CONFIG, unexpected: true })],
    ["an over-limit config", "x".repeat(65_537)],
  ])("rejects %s without exposing filesystem details", async (_label, contents) => {
    await withWorkspace(async (workspaceRoot) => {
      if (contents !== undefined) {
        await writeConfig(workspaceRoot, contents);
      }
      const loader = (await host()).createWorkspaceConfigLoader();

      await expectHostError(() => loader.load({ workspacePath: workspaceRoot }), "CONFIG_INVALID");
    });
  });

  it("does not load a config from a nested directory", async () => {
    await withWorkspace(async (workspaceRoot) => {
      const nested = join(workspaceRoot, "nested");
      await mkdir(nested);
      await writeConfig(nested, JSON.stringify(VALID_CONFIG));
      const loader = (await host()).createWorkspaceConfigLoader();

      await expectHostError(() => loader.load({ workspacePath: workspaceRoot }), "CONFIG_INVALID");
    });
  });
});
