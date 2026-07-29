import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyApprovedPatch } from "./patch.js";

type ApprovalFixture = {
  id: string;
  actionId: string;
  patchHash: string;
  baseHash: string;
  status: string;
  createdAt: number;
  expiresAt: number;
};

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "codesentinel-tools-patch-"));
  temporaryDirectories.add(workspaceRoot);
  return workspaceRoot;
}

async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function approvedFor(
  base: string,
  patch: string,
  overrides: Partial<ApprovalFixture> = {},
): ApprovalFixture {
  const now = Date.now();
  return {
    id: "approval-1",
    actionId: "action-1",
    patchHash: sha256(Buffer.from(patch, "utf8")),
    baseHash: sha256(Buffer.from(base, "utf8")),
    status: "approved",
    createdAt: now - 1_000,
    expiresAt: now + 60_000,
    ...overrides,
  };
}

async function expectToolError(
  operation: () => Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(operation()).rejects.toMatchObject({ code });
}

const replaceBeforeWithAfter = "@@ -1 +1 @@\n-before\n+after\n";

describe("applyApprovedPatch", () => {
  it("atomically replaces only the approved target when hashes match", async () => {
    const workspaceRoot = await createWorkspace();
    const targetPath = join(workspaceRoot, "target.txt");
    const untouchedPath = join(workspaceRoot, "untouched.txt");
    await writeTextFile(targetPath, "before\n");
    await writeTextFile(untouchedPath, "unchanged\n");

    await expect(
      applyApprovedPatch({
        workspaceRoot,
        path: "target.txt",
        patch: replaceBeforeWithAfter,
        approval: approvedFor("before\n", replaceBeforeWithAfter),
      }),
    ).resolves.toEqual({
      path: "target.txt",
      hash: sha256("after\n"),
    });

    await expect(readFile(targetPath, "utf8")).resolves.toBe("after\n");
    await expect(readFile(untouchedPath, "utf8")).resolves.toBe("unchanged\n");
    const workspaceEntries = await readdir(workspaceRoot);
    expect(workspaceEntries.some((entry) => entry.includes(".codesentinel-"))).toBe(false);
  });

  it("preserves target POSIX permission bits when the platform supports them", async (context) => {
    if (process.platform === "win32") {
      context.skip("Windows does not expose POSIX executable permission semantics through fs.stat().mode.");
      return;
    }

    const workspaceRoot = await createWorkspace();
    const targetPath = join(workspaceRoot, "script.sh");
    await writeTextFile(targetPath, "before\n");
    await chmod(targetPath, 0o755);

    await expect(
      applyApprovedPatch({
        workspaceRoot,
        path: "script.sh",
        patch: replaceBeforeWithAfter,
        approval: approvedFor("before\n", replaceBeforeWithAfter),
      }),
    ).resolves.toMatchObject({ path: "script.sh" });

    expect((await stat(targetPath)).mode & 0o777).toBe(0o755);
  });

  it("rejects non-approved, unbound, and syntactically empty approvals without writing", async () => {
    const workspaceRoot = await createWorkspace();
    const targetPath = join(workspaceRoot, "target.txt");
    await writeTextFile(targetPath, "before\n");

    const invalidApprovals = [
      approvedFor("before\n", replaceBeforeWithAfter, { status: "rejected" }),
      approvedFor("before\n", replaceBeforeWithAfter, { id: "unbound-approval" }),
      approvedFor("before\n", replaceBeforeWithAfter, { actionId: "unbound-action" }),
      approvedFor("before\n", replaceBeforeWithAfter, { id: "" }),
    ];

    for (const approval of invalidApprovals) {
      await expectToolError(
        () =>
          applyApprovedPatch({
            workspaceRoot,
            path: "target.txt",
            patch: replaceBeforeWithAfter,
            approval,
          }),
        "APPROVAL_REQUIRED",
      );
      await expect(readFile(targetPath, "utf8")).resolves.toBe("before\n");
    }
  });

  it("rejects expired approvals without writing", async () => {
    const workspaceRoot = await createWorkspace();
    const targetPath = join(workspaceRoot, "target.txt");
    await writeTextFile(targetPath, "before\n");
    const now = Date.now();

    await expectToolError(
      () =>
        applyApprovedPatch({
          workspaceRoot,
          path: "target.txt",
          patch: replaceBeforeWithAfter,
          approval: approvedFor("before\n", replaceBeforeWithAfter, {
            createdAt: now - 2_000,
            expiresAt: now - 1,
          }),
        }),
      "APPROVAL_EXPIRED",
    );
    await expect(readFile(targetPath, "utf8")).resolves.toBe("before\n");
  });

  it("rejects patch and base hash mismatches without writing", async () => {
    const workspaceRoot = await createWorkspace();
    const targetPath = join(workspaceRoot, "target.txt");
    await writeTextFile(targetPath, "before\n");

    await expectToolError(
      () =>
        applyApprovedPatch({
          workspaceRoot,
          path: "target.txt",
          patch: replaceBeforeWithAfter,
          approval: approvedFor("before\n", replaceBeforeWithAfter, { patchHash: "0".repeat(64) }),
        }),
      "PATCH_HASH_MISMATCH",
    );
    await expect(readFile(targetPath, "utf8")).resolves.toBe("before\n");

    await expectToolError(
      () =>
        applyApprovedPatch({
          workspaceRoot,
          path: "target.txt",
          patch: replaceBeforeWithAfter,
          approval: approvedFor("before\n", replaceBeforeWithAfter, { baseHash: "0".repeat(64) }),
        }),
      "BASE_HASH_MISMATCH",
    );
    await expect(readFile(targetPath, "utf8")).resolves.toBe("before\n");
  });

  it("rejects malformed and non-applicable patches without writing", async () => {
    const workspaceRoot = await createWorkspace();
    const targetPath = join(workspaceRoot, "target.txt");
    await writeTextFile(targetPath, "before\n");

    const malformedPatch = "this is not a unified diff";
    await expectToolError(
      () =>
        applyApprovedPatch({
          workspaceRoot,
          path: "target.txt",
          patch: malformedPatch,
          approval: approvedFor("before\n", malformedPatch),
        }),
      "INVALID_PATCH",
    );
    await expect(readFile(targetPath, "utf8")).resolves.toBe("before\n");

    const nonApplicablePatch = "@@ -1 +1 @@\n-missing\n+after\n";
    await expectToolError(
      () =>
        applyApprovedPatch({
          workspaceRoot,
          path: "target.txt",
          patch: nonApplicablePatch,
          approval: approvedFor("before\n", nonApplicablePatch),
        }),
      "PATCH_NOT_APPLICABLE",
    );
    await expect(readFile(targetPath, "utf8")).resolves.toBe("before\n");
  });

  it("rejects a hunk whose declared line does not match instead of relocating it", async () => {
    const workspaceRoot = await createWorkspace();
    const targetPath = join(workspaceRoot, "target.txt");
    const source = "other\nbefore\n";
    const misplacedPatch = "@@ -1 +1 @@\n-before\n+after\n";
    await writeTextFile(targetPath, source);

    await expectToolError(
      () =>
        applyApprovedPatch({
          workspaceRoot,
          path: "target.txt",
          patch: misplacedPatch,
          approval: approvedFor(source, misplacedPatch),
        }),
      "PATCH_NOT_APPLICABLE",
    );
    await expect(readFile(targetPath, "utf8")).resolves.toBe(source);

    const inconsistentNewPositionPatch = "@@ -2 +99 @@\n-before\n+after\n";
    await expectToolError(
      () =>
        applyApprovedPatch({
          workspaceRoot,
          path: "target.txt",
          patch: inconsistentNewPositionPatch,
          approval: approvedFor(source, inconsistentNewPositionPatch),
        }),
      "PATCH_NOT_APPLICABLE",
    );
    await expect(readFile(targetPath, "utf8")).resolves.toBe(source);
  });

  it("rejects overlapping hunk ranges instead of relocating a later hunk", async () => {
    const workspaceRoot = await createWorkspace();
    const targetPath = join(workspaceRoot, "target.txt");
    const source = "a\na\n";
    const overlappingPatch =
      "@@ -1 +1 @@\n-a\n+x\n" +
      "@@ -1 +1 @@\n-a\n+y\n";
    await writeTextFile(targetPath, source);

    await expectToolError(
      () =>
        applyApprovedPatch({
          workspaceRoot,
          path: "target.txt",
          patch: overlappingPatch,
          approval: approvedFor(source, overlappingPatch),
        }),
      "PATCH_NOT_APPLICABLE",
    );
    await expect(readFile(targetPath, "utf8")).resolves.toBe(source);
  });

  it("applies ordered, non-overlapping hunk ranges at their declared boundaries", async () => {
    const workspaceRoot = await createWorkspace();
    const targetPath = join(workspaceRoot, "target.txt");
    const source = "a\nb\n";
    const patch = "@@ -1 +1 @@\n-a\n+x\n@@ -2 +2 @@\n-b\n+y\n";
    await writeTextFile(targetPath, source);

    await expect(
      applyApprovedPatch({
        workspaceRoot,
        path: "target.txt",
        patch,
        approval: approvedFor(source, patch),
      }),
    ).resolves.toEqual({
      path: "target.txt",
      hash: sha256("x\ny\n"),
    });
    await expect(readFile(targetPath, "utf8")).resolves.toBe("x\ny\n");
  });

  it("applies ordered insertions whose new locations account for prior line growth", async () => {
    const workspaceRoot = await createWorkspace();
    const targetPath = join(workspaceRoot, "target.txt");
    const source = "a\nb\nc\nd\n";
    const patch = "@@ -0,0 +1 @@\n+x\n@@ -3,0 +5 @@\n+y\n";
    const expected = "x\na\nb\nc\ny\nd\n";
    await writeTextFile(targetPath, source);

    await expect(
      applyApprovedPatch({
        workspaceRoot,
        path: "target.txt",
        patch,
        approval: approvedFor(source, patch),
      }),
    ).resolves.toEqual({
      path: "target.txt",
      hash: sha256(expected),
    });
    await expect(readFile(targetPath, "utf8")).resolves.toBe(expected);
  });

  it("rejects oversized targets and patches before writing", async () => {
    const workspaceRoot = await createWorkspace();
    const targetPath = join(workspaceRoot, "target.txt");
    const oversizedText = "a".repeat(1_048_577);
    const smallPatch = "@@ -1 +1 @@\n-x\n+y\n";
    await writeTextFile(targetPath, `${oversizedText}\n`);

    await expectToolError(
      () =>
        applyApprovedPatch({
          workspaceRoot,
          path: "target.txt",
          patch: smallPatch,
          approval: approvedFor(`${oversizedText}\n`, smallPatch),
        }),
      "FILE_TOO_LARGE",
    );
    await expect(readFile(targetPath, "utf8")).resolves.toBe(`${oversizedText}\n`);

    const normalSource = "before\n";
    const oversizedPatch = `@@ -1 +1 @@\n-${oversizedText}\n+after\n`;
    await writeTextFile(targetPath, normalSource);
    await expectToolError(
      () =>
        applyApprovedPatch({
          workspaceRoot,
          path: "target.txt",
          patch: oversizedPatch,
          approval: approvedFor(normalSource, oversizedPatch),
        }),
      "INVALID_PATCH",
    );
    await expect(readFile(targetPath, "utf8")).resolves.toBe(normalSource);
  });

  it("rejects outside paths and symlink escapes without touching external files", async (context) => {
    const container = await mkdtemp(join(tmpdir(), "codesentinel-tools-patch-symlink-"));
    temporaryDirectories.add(container);
    const workspaceRoot = join(container, "workspace");
    const outsidePath = join(container, "outside.txt");
    const linkPath = join(workspaceRoot, "escape.txt");
    await mkdir(workspaceRoot);
    await writeTextFile(outsidePath, "before\n");

    await expectToolError(
      () =>
        applyApprovedPatch({
          workspaceRoot,
          path: "../outside.txt",
          patch: replaceBeforeWithAfter,
          approval: approvedFor("before\n", replaceBeforeWithAfter),
        }),
      "INVALID_PATH",
    );
    await expect(readFile(outsidePath, "utf8")).resolves.toBe("before\n");

    try {
      await symlink(outsidePath, linkPath, "file");
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
        applyApprovedPatch({
          workspaceRoot,
          path: "escape.txt",
          patch: replaceBeforeWithAfter,
          approval: approvedFor("before\n", replaceBeforeWithAfter),
        }),
      "SYMLINK_NOT_ALLOWED",
    );
    await expect(readFile(outsidePath, "utf8")).resolves.toBe("before\n");
  });

  it("rejects headers for another target and multi-file patches without changing either file", async () => {
    const workspaceRoot = await createWorkspace();
    const targetPath = join(workspaceRoot, "target.txt");
    const otherPath = join(workspaceRoot, "other.txt");
    await writeTextFile(targetPath, "before\n");
    await writeTextFile(otherPath, "other\n");

    const wrongTargetPatch = "--- a/other.txt\n+++ b/other.txt\n@@ -1 +1 @@\n-before\n+after\n";
    await expectToolError(
      () =>
        applyApprovedPatch({
          workspaceRoot,
          path: "target.txt",
          patch: wrongTargetPatch,
          approval: approvedFor("before\n", wrongTargetPatch),
        }),
      "INVALID_PATCH",
    );

    const multiFilePatch =
      "--- a/target.txt\n+++ b/target.txt\n@@ -1 +1 @@\n-before\n+after\n" +
      "--- a/other.txt\n+++ b/other.txt\n@@ -1 +1 @@\n-other\n+changed\n";
    await expectToolError(
      () =>
        applyApprovedPatch({
          workspaceRoot,
          path: "target.txt",
          patch: multiFilePatch,
          approval: approvedFor("before\n", multiFilePatch),
        }),
      "INVALID_PATCH",
    );

    await expect(readFile(targetPath, "utf8")).resolves.toBe("before\n");
    await expect(readFile(otherPath, "utf8")).resolves.toBe("other\n");
  });

  it("rejects raw Git headers for another target and parser-ignored trailing content", async () => {
    const workspaceRoot = await createWorkspace();
    const targetPath = join(workspaceRoot, "target.txt");
    await writeTextFile(targetPath, "before\n");

    const disguisedGitTargetPatch =
      "diff --git a/other.txt b/other.txt\n" +
      "--- a/target.txt\n+++ b/target.txt\n@@ -1 +1 @@\n-before\n+after\n";
    await expectToolError(
      () =>
        applyApprovedPatch({
          workspaceRoot,
          path: "target.txt",
          patch: disguisedGitTargetPatch,
          approval: approvedFor("before\n", disguisedGitTargetPatch),
        }),
      "INVALID_PATCH",
    );
    await expect(readFile(targetPath, "utf8")).resolves.toBe("before\n");

    const ignoredTailPatch = "@@ -1 +1 @@\n-before\n+after\nindex ignored";
    await expectToolError(
      () =>
        applyApprovedPatch({
          workspaceRoot,
          path: "target.txt",
          patch: ignoredTailPatch,
          approval: approvedFor("before\n", ignoredTailPatch),
        }),
      "INVALID_PATCH",
    );
    await expect(readFile(targetPath, "utf8")).resolves.toBe("before\n");

    const malformedNoNewlineMarker = "@@ -1 +1 @@\n-before\n+after\n\\ ignored marker";
    await expectToolError(
      () =>
        applyApprovedPatch({
          workspaceRoot,
          path: "target.txt",
          patch: malformedNoNewlineMarker,
          approval: approvedFor("before\n", malformedNoNewlineMarker),
        }),
      "INVALID_PATCH",
    );
    await expect(readFile(targetPath, "utf8")).resolves.toBe("before\n");
  });

  it("permits valid no-newline markers but rejects duplicate, dangling, and interior markers", async () => {
    const workspaceRoot = await createWorkspace();
    const targetPath = join(workspaceRoot, "target.txt");
    const source = "before";
    const marker = "\\ No newline at end of file";
    const validPatch = `@@ -1 +1 @@\n-before\n${marker}\n+after\n${marker}\n`;
    await writeTextFile(targetPath, source);

    await expect(
      applyApprovedPatch({
        workspaceRoot,
        path: "target.txt",
        patch: validPatch,
        approval: approvedFor(source, validPatch),
      }),
    ).resolves.toEqual({
      path: "target.txt",
      hash: sha256("after"),
    });
    await expect(readFile(targetPath, "utf8")).resolves.toBe("after");

    const duplicateMarkerPatch = `${validPatch}${marker}\n`;
    await writeTextFile(targetPath, source);
    await expectToolError(
      () =>
        applyApprovedPatch({
          workspaceRoot,
          path: "target.txt",
          patch: duplicateMarkerPatch,
          approval: approvedFor(source, duplicateMarkerPatch),
        }),
      "INVALID_PATCH",
    );
    await expect(readFile(targetPath, "utf8")).resolves.toBe(source);

    const danglingMarkerPatch = `@@ -1 +1 @@\n${marker}\n-before\n+after\n`;
    await expectToolError(
      () =>
        applyApprovedPatch({
          workspaceRoot,
          path: "target.txt",
          patch: danglingMarkerPatch,
          approval: approvedFor(source, danglingMarkerPatch),
        }),
      "INVALID_PATCH",
    );
    await expect(readFile(targetPath, "utf8")).resolves.toBe(source);

    const sourceWithTrailingLine = "before\nnext";
    const interiorMarkerPatch =
      `@@ -1,2 +1,2 @@\n-before\n${marker}\n-next\n+after\n+next\n`;
    await writeTextFile(targetPath, sourceWithTrailingLine);
    await expectToolError(
      () =>
        applyApprovedPatch({
          workspaceRoot,
          path: "target.txt",
          patch: interiorMarkerPatch,
          approval: approvedFor(sourceWithTrailingLine, interiorMarkerPatch),
        }),
      "INVALID_PATCH",
    );
    await expect(readFile(targetPath, "utf8")).resolves.toBe(sourceWithTrailingLine);

    const detachedMarkerPatch = `@@ -1 +1 @@\n-before\n${marker}\n+after\n`;
    await expectToolError(
      () =>
        applyApprovedPatch({
          workspaceRoot,
          path: "target.txt",
          patch: detachedMarkerPatch,
          approval: approvedFor(sourceWithTrailingLine, detachedMarkerPatch),
        }),
      "INVALID_PATCH",
    );
    await expect(readFile(targetPath, "utf8")).resolves.toBe(sourceWithTrailingLine);
  });
});
