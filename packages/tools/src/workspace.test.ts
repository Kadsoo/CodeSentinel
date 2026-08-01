import { afterEach, describe, expect, it, vi } from "vitest";
import * as fsPromises from "node:fs/promises";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MAX_SEARCH_TOTAL_BYTES,
  getWorkspaceFileHash,
  listWorkspaceFiles,
  readWorkspaceFile,
  searchWorkspaceText,
} from "./workspace.js";

vi.mock("node:fs/promises", { spy: true });

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
  vi.clearAllMocks();
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

describe("listWorkspaceFiles", () => {
  it("returns a sorted, bounded pre-order traversal", async () => {
    const workspaceRoot = await createWorkspace();
    await writeTextFile(join(workspaceRoot, "src", "a.ts"), "a\n");
    await writeTextFile(join(workspaceRoot, "src", "nested", "b.ts"), "b\n");
    await writeTextFile(join(workspaceRoot, "src", "z.ts"), "z\n");

    await expect(
      listWorkspaceFiles({
        workspaceRoot,
        path: "src",
        depth: 8,
        maxEntries: 2,
        shouldInclude: () => true,
      }),
    ).resolves.toEqual({
      entries: [
        { kind: "file", path: "src/a.ts" },
        { kind: "directory", path: "src/nested" },
      ],
      truncated: true,
    });
  });

  it("skips POSIX literal-backslash names that cannot round-trip through workspace paths", async (context) => {
    if (process.platform === "win32") {
      context.skip("Windows reserves backslash as a path separator.");
      return;
    }

    const workspaceRoot = await createWorkspace();
    const literalBackslashPath = join(workspaceRoot, "a\\b");
    const nestedPath = join(workspaceRoot, "a", "b");
    await writeTextFile(literalBackslashPath, "needle literal\n");
    await writeTextFile(nestedPath, "needle nested\n");

    const listed = await listWorkspaceFiles({
      workspaceRoot,
      depth: 2,
      maxEntries: 10,
      shouldInclude: () => true,
    });
    const filteredPaths: string[] = [];
    const openSpy = vi.mocked(fsPromises.open);
    openSpy.mockClear();
    const searched = await searchWorkspaceText({
      workspaceRoot,
      query: "needle",
      maxResults: 10,
      shouldInclude: (path) => {
        filteredPaths.push(path);
        return true;
      },
    });

    expect({
      entries: listed.entries,
      matches: searched.matches,
      filteredPaths,
      openedPaths: openSpy.mock.calls.map(([path]) => path),
    }).toEqual({
      entries: [
        { kind: "directory", path: "a" },
        { kind: "file", path: "a/b" },
      ],
      matches: [{ path: "a/b", line: 1, snippet: "needle nested" }],
      filteredPaths: ["a/b"],
      openedPaths: [nestedPath],
    });
  });

  it("skips symlinks during traversal when the platform permits symlinks", async (context) => {
    const workspaceRoot = await createWorkspace();
    const sourceDirectory = join(workspaceRoot, "src");
    const linkedDirectory = join(sourceDirectory, "middle-link");
    await writeTextFile(join(sourceDirectory, "a.ts"), "a\n");
    await writeTextFile(join(sourceDirectory, "nested", "secret.ts"), "secret\n");

    try {
      await symlink(join(sourceDirectory, "nested"), linkedDirectory, "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
        context.skip("Windows denied unprivileged symlink creation (EPERM/EACCES).");
        return;
      }
      throw error;
    }

    await expect(
      listWorkspaceFiles({
        workspaceRoot,
        path: "src",
        depth: 8,
        maxEntries: 10,
        shouldInclude: () => true,
      }),
    ).resolves.toEqual({
      entries: [
        { kind: "file", path: "src/a.ts" },
        { kind: "directory", path: "src/nested" },
        { kind: "file", path: "src/nested/secret.ts" },
      ],
      truncated: false,
    });
  });

  it("rejects invalid browse bounds, traversal, and a non-directory root", async () => {
    const workspaceRoot = await createWorkspace();
    await writeTextFile(join(workspaceRoot, "src", "safe.ts"), "safe\n");

    for (const depth of [0, 9]) {
      await expectToolError(
        () =>
          listWorkspaceFiles({
            workspaceRoot,
            depth,
            maxEntries: 1,
            shouldInclude: () => true,
          }),
        "INVALID_DEPTH",
      );
    }

    for (const maxEntries of [0, 501]) {
      await expectToolError(
        () =>
          listWorkspaceFiles({
            workspaceRoot,
            depth: 1,
            maxEntries,
            shouldInclude: () => true,
          }),
        "INVALID_MAX_ENTRIES",
      );
    }

    await expectToolError(
      () =>
        listWorkspaceFiles({
          workspaceRoot,
          path: "../src",
          depth: 1,
          maxEntries: 1,
          shouldInclude: () => true,
        }),
      "INVALID_PATH",
    );
    await expectToolError(
      () =>
        listWorkspaceFiles({
          workspaceRoot,
          path: "src/safe.ts",
          depth: 1,
          maxEntries: 1,
          shouldInclude: () => true,
        }),
      "NOT_A_DIRECTORY",
    );
  });

  it("rejects an explicitly selected symbolic directory root when permitted", async (context) => {
    const workspaceRoot = await createWorkspace();
    await writeTextFile(join(workspaceRoot, "src", "nested", "safe.ts"), "safe\n");

    try {
      await symlink(
        join(workspaceRoot, "src", "nested"),
        join(workspaceRoot, "src", "linked-root"),
        "dir",
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
        context.skip("Windows denied unprivileged symlink creation (EPERM/EACCES).");
        return;
      }
      throw error;
    }

    await expectToolError(
      () =>
        listWorkspaceFiles({
          workspaceRoot,
          path: "src/linked-root",
          depth: 1,
          maxEntries: 1,
          shouldInclude: () => true,
        }),
      "SYMLINK_NOT_ALLOWED",
    );
  });

  it("fails closed when an ancestor is replaced after directory validation", async () => {
    const workspaceRoot = await createWorkspace();
    const outsideRoot = await createWorkspace();
    const escapedPath = join(outsideRoot, "escaped.txt");
    const racedCandidatePath = join(workspaceRoot, "escaped.txt");
    await writeTextFile(escapedPath, "needle outside the workspace\n");

    const actualFsPromises = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    let ancestorWasReplaced = false;
    const replaceRacedAncestor = (path: string): string => {
      if (!ancestorWasReplaced) {
        return path;
      }
      if (path === workspaceRoot) {
        return outsideRoot;
      }
      if (path === racedCandidatePath) {
        return escapedPath;
      }
      return path;
    };

    vi.mocked(fsPromises.readdir).mockImplementation(
      (async (path: string, options: { withFileTypes: true }) => {
        if (path === workspaceRoot) {
          ancestorWasReplaced = true;
          return actualFsPromises.readdir(outsideRoot, options);
        }
        return actualFsPromises.readdir(path, options);
      }) as typeof fsPromises.readdir,
    );
    vi.mocked(fsPromises.realpath).mockImplementation(
      (async (path: string) => actualFsPromises.realpath(replaceRacedAncestor(path))) as typeof fsPromises.realpath,
    );
    vi.mocked(fsPromises.lstat).mockImplementation(
      (async (path: string) => actualFsPromises.lstat(replaceRacedAncestor(path))) as typeof fsPromises.lstat,
    );
    vi.mocked(fsPromises.stat).mockImplementation(
      (async (path: string) => actualFsPromises.stat(replaceRacedAncestor(path))) as typeof fsPromises.stat,
    );

    const openSpy = vi.mocked(fsPromises.open);
    openSpy.mockClear();
    await expectToolError(
      () =>
        listWorkspaceFiles({
          workspaceRoot,
          depth: 1,
          maxEntries: 10,
          shouldInclude: () => true,
        }),
      "PATH_OUTSIDE_WORKSPACE",
    );

    ancestorWasReplaced = false;
    await expectToolError(
      () =>
        searchWorkspaceText({
          workspaceRoot,
          query: "needle",
          maxResults: 10,
          shouldInclude: () => true,
        }),
      "PATH_OUTSIDE_WORKSPACE",
    );
    expect(openSpy).not.toHaveBeenCalledWith(escapedPath, "r");
  });
});

describe("searchWorkspaceText", () => {
  it("filters excluded files before search reads and returns only bounded safe snippets", async () => {
    const workspaceRoot = await createWorkspace();
    const sourceDirectory = join(workspaceRoot, "src");
    const excludedPath = join(sourceDirectory, ".env");
    const includedPath = join(sourceDirectory, "safe.ts");
    await mkdir(sourceDirectory, { recursive: true });
    await writeTextFile(includedPath, "const value = 'needle-safe';\n");
    await writeTextFile(excludedPath, "needle that must not be read\n");

    const filteredPaths: string[] = [];
    const openSpy = vi.mocked(fsPromises.open);
    openSpy.mockClear();
    await expect(
      searchWorkspaceText({
        workspaceRoot,
        path: "src",
        query: "needle",
        maxResults: 10,
        shouldInclude: (path) => {
          filteredPaths.push(path);
          return path !== "src/.env";
        },
      }),
    ).resolves.toEqual({
      matches: [{ path: "src/safe.ts", line: 1, snippet: "const value = 'needle-safe';" }],
      truncated: false,
    });
    expect(filteredPaths).toContain("src/.env");
    expect(openSpy).toHaveBeenCalledWith(includedPath, "r");
    expect(openSpy).not.toHaveBeenCalledWith(excludedPath, "r");
  });

  it("rejects an exact target when its bound root is replaced in place before reading", async () => {
    const workspaceRoot = await createWorkspace();
    const outsideRoot = await createWorkspace();
    const insidePath = join(workspaceRoot, "safe.txt");
    const outsidePath = join(outsideRoot, "safe.txt");
    await writeTextFile(insidePath, "inside\n");
    await writeTextFile(outsidePath, "needle outside\n");

    const actualFsPromises = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    let rootWasReplaced = false;
    const replaceInPlace = (path: string): string => {
      if (!rootWasReplaced) {
        return path;
      }
      if (path === workspaceRoot) {
        return outsideRoot;
      }
      if (path === insidePath) {
        return outsidePath;
      }
      return path;
    };

    vi.mocked(fsPromises.realpath).mockImplementation(
      (async (path: string) => {
        if (rootWasReplaced && (path === workspaceRoot || path === insidePath)) {
          return path;
        }
        return actualFsPromises.realpath(path);
      }) as typeof fsPromises.realpath,
    );
    vi.mocked(fsPromises.lstat).mockImplementation(
      (async (path: string) => actualFsPromises.lstat(replaceInPlace(path))) as typeof fsPromises.lstat,
    );
    vi.mocked(fsPromises.stat).mockImplementation(
      (async (path: string) => actualFsPromises.stat(replaceInPlace(path))) as typeof fsPromises.stat,
    );
    const openSpy = vi.mocked(fsPromises.open);
    openSpy.mockImplementation(
      (async (path: string, flags: string) =>
        actualFsPromises.open(replaceInPlace(path), flags)) as typeof fsPromises.open,
    );
    openSpy.mockClear();

    await expectToolError(
      () =>
        searchWorkspaceText({
          workspaceRoot,
          path: "safe.txt",
          query: "needle",
          maxResults: 10,
          shouldInclude: () => {
            rootWasReplaced = true;
            return true;
          },
        }),
      "PATH_OUTSIDE_WORKSPACE",
    );
    expect(openSpy).not.toHaveBeenCalledWith(outsidePath, "r");
  });

  it("rejects a traversed candidate when its root is rebased after filtering", async () => {
    const workspaceRoot = await createWorkspace();
    const outsideRoot = await createWorkspace();
    const outsidePath = join(outsideRoot, "safe.txt");
    await writeTextFile(join(workspaceRoot, "safe.txt"), "inside\n");
    await writeTextFile(outsidePath, "needle outside\n");

    const actualFsPromises = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    let rootWasRebased = false;
    vi.mocked(fsPromises.realpath).mockImplementation(
      (async (path: string) =>
        actualFsPromises.realpath(rootWasRebased && path === workspaceRoot ? outsideRoot : path)) as typeof fsPromises.realpath,
    );

    const openSpy = vi.mocked(fsPromises.open);
    openSpy.mockClear();
    await expectToolError(
      () =>
        searchWorkspaceText({
          workspaceRoot,
          query: "needle",
          maxResults: 10,
          shouldInclude: () => {
            rootWasRebased = true;
            return true;
          },
        }),
      "PATH_OUTSIDE_WORKSPACE",
    );
    expect(openSpy).not.toHaveBeenCalledWith(outsidePath, "r");
  });

  it("rejects an allowed path that resolves to an in-workspace sensitive file after filtering", async () => {
    const workspaceRoot = await createWorkspace();
    const allowedPath = join(workspaceRoot, "allowed.txt");
    const sensitivePath = join(workspaceRoot, ".env");
    await writeTextFile(allowedPath, "allowed\n");
    await writeTextFile(sensitivePath, "needle sensitive\n");

    const actualFsPromises = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    let allowedPathWasApproved = false;
    vi.mocked(fsPromises.realpath).mockImplementation(
      (async (path: string) =>
        actualFsPromises.realpath(
          allowedPathWasApproved && path === allowedPath ? sensitivePath : path,
        )) as typeof fsPromises.realpath,
    );

    const openSpy = vi.mocked(fsPromises.open);
    openSpy.mockClear();
    await expectToolError(
      () =>
        searchWorkspaceText({
          workspaceRoot,
          query: "needle",
          maxResults: 10,
          shouldInclude: (path) => {
            if (path === "allowed.txt") {
              allowedPathWasApproved = true;
              return true;
            }
            return false;
          },
        }),
      "SYMLINK_NOT_ALLOWED",
    );
    expect(openSpy).not.toHaveBeenCalledWith(sensitivePath, "r");
  });

  it("stops after an oversized candidate instead of scanning later matches", async () => {
    const workspaceRoot = await createWorkspace();
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(join(workspaceRoot, "src", "a-too-large.txt"), Buffer.alloc(1_048_577, 0x61));
    await writeTextFile(join(workspaceRoot, "src", "z-safe.ts"), "const value = 'needle';\n");

    await expect(
      searchWorkspaceText({
        workspaceRoot,
        path: "src",
        query: "needle",
        maxResults: 10,
        shouldInclude: () => true,
      }),
    ).resolves.toEqual({ matches: [], truncated: true });
  });

  it("reads no more than the remaining aggregate budget for an exactly bounded file", async () => {
    const workspaceRoot = await createWorkspace();
    const sourceDirectory = join(workspaceRoot, "src");
    const boundedPath = join(sourceDirectory, "a-budget.txt");
    const laterMatchPath = join(sourceDirectory, "z-safe.ts");
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(boundedPath, Buffer.alloc(MAX_SEARCH_TOTAL_BYTES, 0x61));
    await writeTextFile(laterMatchPath, "const value = 'needle';\n");

    const requestedReadLengths: number[] = [];
    const actualFsPromises = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    const openSpy = vi.mocked(fsPromises.open);
    openSpy.mockClear();
    openSpy.mockImplementationOnce(async (...args) => {
      const handle = await actualFsPromises.open(...args);
      const originalRead = handle.read.bind(handle);
      handle.read = ((buffer: Buffer, offset?: number, length?: number, position?: number | null) => {
        requestedReadLengths.push(length ?? buffer.byteLength);
        return originalRead(buffer, offset, length, position);
      }) as typeof handle.read;
      return handle;
    });

    await expect(
      searchWorkspaceText({
        workspaceRoot,
        path: "src",
        query: "needle",
        maxResults: 10,
        shouldInclude: () => true,
      }),
    ).resolves.toEqual({ matches: [], truncated: true });
    expect(requestedReadLengths).toEqual([MAX_SEARCH_TOTAL_BYTES]);
    expect(openSpy).not.toHaveBeenCalledWith(laterMatchPath, "r");
  });

  it("stops traversal after a budget-exhausting binary file", async () => {
    const workspaceRoot = await createWorkspace();
    const sourceDirectory = join(workspaceRoot, "src");
    const binaryPath = join(sourceDirectory, "a-binary.bin");
    const laterMatchPath = join(sourceDirectory, "z-safe.ts");
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(binaryPath, Buffer.alloc(MAX_SEARCH_TOTAL_BYTES));
    await writeTextFile(laterMatchPath, "const value = 'needle';\n");

    const includedPaths: string[] = [];
    const openSpy = vi.mocked(fsPromises.open);
    openSpy.mockClear();
    await expect(
      searchWorkspaceText({
        workspaceRoot,
        path: "src",
        query: "needle",
        maxResults: 10,
        shouldInclude: (path) => {
          includedPaths.push(path);
          return true;
        },
      }),
    ).resolves.toEqual({ matches: [], truncated: true });
    expect(includedPaths).toEqual(["src/a-binary.bin"]);
    expect(openSpy).toHaveBeenCalledWith(binaryPath, "r");
    expect(openSpy).not.toHaveBeenCalledWith(laterMatchPath, "r");
  });

  it("returns a lowercase SHA-256 baseline that changes with file bytes", async () => {
    const workspaceRoot = await createWorkspace();
    const filePath = join(workspaceRoot, "src", "baseline.ts");
    await writeTextFile(filePath, "first\n");

    const initialHash = await getWorkspaceFileHash({
      workspaceRoot,
      path: "src/baseline.ts",
    });
    await writeTextFile(filePath, "second\n");
    const updatedHash = await getWorkspaceFileHash({
      workspaceRoot,
      path: "src/baseline.ts",
    });

    expect(initialHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(updatedHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(updatedHash).not.toBe(initialHash);
  });

  it("rejects invalid query and result bounds while accepting a 4096-character query", async () => {
    const workspaceRoot = await createWorkspace();
    await writeTextFile(join(workspaceRoot, "src", "safe.ts"), "safe\n");

    for (const maxResults of [0, 101]) {
      await expectToolError(
        () =>
          searchWorkspaceText({
            workspaceRoot,
            query: "safe",
            maxResults,
            shouldInclude: () => true,
          }),
        "INVALID_MAX_RESULTS",
      );
    }

    for (const query of ["", "   ", "x".repeat(4_097)]) {
      await expectToolError(
        () =>
          searchWorkspaceText({
            workspaceRoot,
            query,
            maxResults: 1,
            shouldInclude: () => true,
          }),
        "INVALID_QUERY",
      );
    }

    await expect(
      searchWorkspaceText({
        workspaceRoot,
        query: "x".repeat(4_096),
        maxResults: 1,
        shouldInclude: () => true,
      }),
    ).resolves.toEqual({ matches: [], truncated: false });
  });

  it("skips binary content and returns no match for an exact safe file path", async () => {
    const workspaceRoot = await createWorkspace();
    await writeTextFile(join(workspaceRoot, "src", "safe.ts"), "safe\n");
    await writeFile(join(workspaceRoot, "src", "binary.bin"), Buffer.from([0x6e, 0x00, 0x65]));

    await expect(
      searchWorkspaceText({
        workspaceRoot,
        path: "src",
        query: "needle",
        maxResults: 10,
        shouldInclude: () => true,
      }),
    ).resolves.toEqual({ matches: [], truncated: false });
    await expect(
      searchWorkspaceText({
        workspaceRoot,
        path: "src/safe.ts",
        query: "needle",
        maxResults: 10,
        shouldInclude: () => true,
      }),
    ).resolves.toEqual({ matches: [], truncated: false });
  });

  it("preserves the unsafe-file error for an exact hard-linked search path when permitted", async (
    context,
  ) => {
    const container = await mkdtemp(join(tmpdir(), "codesentinel-tools-search-hardlink-"));
    temporaryDirectories.add(container);
    const workspaceRoot = join(container, "workspace");
    const outsidePath = join(container, "outside.txt");
    const linkedPath = join(workspaceRoot, "src", "linked.txt");
    await mkdir(dirname(linkedPath), { recursive: true });
    await writeTextFile(outsidePath, "needle\n");

    try {
      await link(outsidePath, linkedPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "EXDEV") {
        context.skip("The current platform/filesystem denied hard-link creation (EPERM/EACCES/EXDEV).");
        return;
      }
      throw error;
    }

    await expectToolError(
      () =>
        searchWorkspaceText({
          workspaceRoot,
          path: "src/linked.txt",
          query: "needle",
          maxResults: 1,
          shouldInclude: () => true,
        }),
      "UNSAFE_FILE",
    );
  });
});
