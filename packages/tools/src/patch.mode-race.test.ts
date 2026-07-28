import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const modeRace = vi.hoisted(() => ({
  changed: false,
  enabled: false,
  targetPath: "",
}));

const initialReadRace = vi.hoisted(() => ({
  changed: false,
  enabled: false,
  targetPath: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (modeRace.enabled && args[1] === "wx") {
        await actual.chmod(modeRace.targetPath, 0o666);
        modeRace.changed = true;
      }
      return handle;
    },
  };
});

vi.mock("./workspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspace.js")>();
  return {
    ...actual,
    readVerifiedWorkspaceFile: async (
      ...args: Parameters<typeof actual.readVerifiedWorkspaceFile>
    ) => {
      const result = await actual.readVerifiedWorkspaceFile(...args);
      if (initialReadRace.enabled && !initialReadRace.changed) {
        const fileSystem = await import("node:fs/promises");
        await fileSystem.chmod(initialReadRace.targetPath, 0o666);
        initialReadRace.changed = true;
      }
      return result;
    },
  };
});

import { applyApprovedPatch } from "./patch.js";

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  initialReadRace.changed = false;
  initialReadRace.enabled = false;
  initialReadRace.targetPath = "";
  modeRace.changed = false;
  modeRace.enabled = false;
  modeRace.targetPath = "";
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("applyApprovedPatch mode snapshots", () => {
  it("rejects a target permission change after initial validation without writing", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "codesentinel-tools-initial-mode-race-"));
    temporaryDirectories.add(workspaceRoot);
    const targetPath = join(workspaceRoot, "target.txt");
    const source = "before\n";
    const patch = "@@ -1 +1 @@\n-before\n+after\n";
    await writeFile(targetPath, source, "utf8");
    await chmod(targetPath, 0o444);

    initialReadRace.targetPath = targetPath;
    initialReadRace.enabled = true;
    try {
      await expect(
        applyApprovedPatch({
          workspaceRoot,
          path: "target.txt",
          patch,
          approval: {
            id: "approval-initial-mode-race",
            actionId: "action-initial-mode-race",
            patchHash: sha256(patch),
            baseHash: sha256(source),
            status: "approved",
            createdAt: Date.now() - 1_000,
            expiresAt: Date.now() + 60_000,
          },
        }),
      ).rejects.toMatchObject({ code: "WRITE_FAILED" });
    } finally {
      initialReadRace.enabled = false;
    }

    expect(initialReadRace.changed).toBe(true);
    await expect(readFile(targetPath, "utf8")).resolves.toBe(source);
    expect((await stat(targetPath)).mode & 0o777).toBe(0o666);
    const entries = await readdir(workspaceRoot);
    expect(entries.some((entry) => entry.includes(".codesentinel-"))).toBe(false);
  });

  it("rejects a target permission change between verified snapshots without writing", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "codesentinel-tools-mode-race-"));
    temporaryDirectories.add(workspaceRoot);
    const targetPath = join(workspaceRoot, "target.txt");
    const source = "before\n";
    const patch = "@@ -1 +1 @@\n-before\n+after\n";
    await writeFile(targetPath, source, "utf8");
    await chmod(targetPath, 0o444);

    modeRace.targetPath = targetPath;
    modeRace.enabled = true;
    try {
      await expect(
        applyApprovedPatch({
          workspaceRoot,
          path: "target.txt",
          patch,
          approval: {
            id: "approval-mode-race",
            actionId: "action-mode-race",
            patchHash: sha256(patch),
            baseHash: sha256(source),
            status: "approved",
            createdAt: Date.now() - 1_000,
            expiresAt: Date.now() + 60_000,
          },
        }),
      ).rejects.toMatchObject({ code: "WRITE_FAILED" });
    } finally {
      modeRace.enabled = false;
    }

    expect(modeRace.changed).toBe(true);
    await expect(readFile(targetPath, "utf8")).resolves.toBe(source);
    expect((await stat(targetPath)).mode & 0o777).toBe(0o666);
    const entries = await readdir(workspaceRoot);
    expect(entries.some((entry) => entry.includes(".codesentinel-"))).toBe(false);
  });
});
