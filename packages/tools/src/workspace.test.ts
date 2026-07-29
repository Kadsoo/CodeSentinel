import { afterEach, describe, expect, it } from "vitest";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readWorkspaceFile } from "./workspace.js";

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "codesentinel-tools-workspace-"));
  temporaryDirectories.add(workspaceRoot);
  return workspaceRoot;
}

async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function expectToolError(
  operation: () => Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(operation()).rejects.toMatchObject({ code });
}

describe("readWorkspaceFile", () => {
  it("reads an existing text file inside the selected workspace", async () => {
    const workspaceRoot = await createWorkspace();
    await writeTextFile(join(workspaceRoot, "src", "message.txt"), "hello workspace\n");

    await expect(
      readWorkspaceFile({
        workspaceRoot,
        path: "src/message.txt",
        maxBytes: 1_024,
      }),
    ).resolves.toContain("hello workspace");
  });

  it("rejects traversal and absolute file paths", async () => {
    const workspaceRoot = await createWorkspace();
    const insideFile = join(workspaceRoot, "inside.txt");
    await writeTextFile(insideFile, "inside\n");

    await expectToolError(
      () => readWorkspaceFile({ workspaceRoot, path: "../inside.txt", maxBytes: 64 }),
      "INVALID_PATH",
    );
    await expectToolError(
      () => readWorkspaceFile({ workspaceRoot, path: insideFile, maxBytes: 64 }),
      "INVALID_PATH",
    );
    await expectToolError(
      () => readWorkspaceFile({ workspaceRoot, path: "COM\u00b9.txt", maxBytes: 64 }),
      "INVALID_PATH",
    );
    await expectToolError(
      () => readWorkspaceFile({ workspaceRoot, path: "LPT\u00b2", maxBytes: 64 }),
      "INVALID_PATH",
    );
  });

  it("rejects a symlink that escapes the workspace when the platform permits symlinks", async (
    context,
  ) => {
    const container = await mkdtemp(join(tmpdir(), "codesentinel-tools-symlink-"));
    temporaryDirectories.add(container);
    const workspaceRoot = join(container, "workspace");
    const outsideFile = join(container, "outside.txt");
    const linkPath = join(workspaceRoot, "escape.txt");
    await mkdir(workspaceRoot);
    await writeTextFile(outsideFile, "outside\n");

    try {
      await symlink(outsideFile, linkPath, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
        context.skip("Windows denied unprivileged symlink creation (EPERM/EACCES).");
        return;
      }
      throw error;
    }

    await expectToolError(
      () => readWorkspaceFile({ workspaceRoot, path: "escape.txt", maxBytes: 64 }),
      "SYMLINK_NOT_ALLOWED",
    );
  });

  it("rejects a hard link to a file outside the workspace when the platform permits hard links", async (
    context,
  ) => {
    const container = await mkdtemp(join(tmpdir(), "codesentinel-tools-hardlink-"));
    temporaryDirectories.add(container);
    const workspaceRoot = join(container, "workspace");
    const outsideFile = join(container, "outside.txt");
    const linkedPath = join(workspaceRoot, "linked.txt");
    await mkdir(workspaceRoot);
    await writeTextFile(outsideFile, "outside\n");

    try {
      await link(outsideFile, linkedPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "EXDEV") {
        context.skip("The current platform/filesystem denied hard-link creation (EPERM/EACCES/EXDEV).");
        return;
      }
      throw error;
    }

    await expectToolError(
      () => readWorkspaceFile({ workspaceRoot, path: "linked.txt", maxBytes: 64 }),
      "UNSAFE_FILE",
    );
  });

  it("rejects directories, NUL-containing binary data, and malformed UTF-8", async () => {
    const workspaceRoot = await createWorkspace();
    await mkdir(join(workspaceRoot, "folder"));
    await writeFile(join(workspaceRoot, "binary.bin"), Buffer.from([0x61, 0x00, 0x62]));
    await writeFile(join(workspaceRoot, "invalid-utf8.bin"), Buffer.from([0xc3]));
    await writeFile(
      join(workspaceRoot, "invalid-after-boundary.bin"),
      Buffer.from([0x61, 0xc3, 0xa9, 0xff]),
    );

    await expectToolError(
      () => readWorkspaceFile({ workspaceRoot, path: "folder", maxBytes: 64 }),
      "NOT_A_FILE",
    );
    await expectToolError(
      () => readWorkspaceFile({ workspaceRoot, path: "binary.bin", maxBytes: 64 }),
      "BINARY_CONTENT",
    );
    await expectToolError(
      () => readWorkspaceFile({ workspaceRoot, path: "invalid-utf8.bin", maxBytes: 64 }),
      "BINARY_CONTENT",
    );
    await expectToolError(
      () =>
        readWorkspaceFile({
          workspaceRoot,
          path: "invalid-after-boundary.bin",
          maxBytes: 3,
        }),
      "BINARY_CONTENT",
    );
  });

  it("returns only a bounded prefix with a deterministic truncation marker", async () => {
    const workspaceRoot = await createWorkspace();
    await writeTextFile(join(workspaceRoot, "long.txt"), "prefixSECRET_TAIL");
    await writeTextFile(join(workspaceRoot, "exact.txt"), "exact");
    await writeTextFile(join(workspaceRoot, "unicode.txt"), "é");

    await expect(
      readWorkspaceFile({ workspaceRoot, path: "long.txt", maxBytes: 6 }),
    ).resolves.toBe("prefix\n[CodeSentinel output truncated]");
    await expect(
      readWorkspaceFile({ workspaceRoot, path: "exact.txt", maxBytes: 5 }),
    ).resolves.toBe("exact");
    await expect(
      readWorkspaceFile({ workspaceRoot, path: "unicode.txt", maxBytes: 1 }),
    ).resolves.toBe("\n[CodeSentinel output truncated]");
    await expect(
      readWorkspaceFile({ workspaceRoot, path: "unicode.txt", maxBytes: 2 }),
    ).resolves.toBe("é");
  });

  it("rejects invalid byte bounds", async () => {
    const workspaceRoot = await createWorkspace();
    await writeTextFile(join(workspaceRoot, "inside.txt"), "inside\n");

    for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_048_577]) {
      await expectToolError(
        () => readWorkspaceFile({ workspaceRoot, path: "inside.txt", maxBytes }),
        "INVALID_MAX_BYTES",
      );
    }
  });
});
