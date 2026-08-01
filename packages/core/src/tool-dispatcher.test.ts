import { describe, expect, it, vi } from "vitest";
import { applyApprovedPatch as applyWorkspacePatch } from "../../tools/src/index.js";
import { listWorkspaceFiles } from "../../tools/src/index.js";
import type { ApplyApprovedPatchInput } from "../../tools/src/index.js";
import { createToolDispatcher } from "./tool-dispatcher.js";
import { failedVerification, testCommand } from "./test-support.js";

vi.mock("../../tools/src/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../tools/src/index.js")>();
  return {
    ...actual,
    applyApprovedPatch: vi.fn(async (input: ApplyApprovedPatchInput) =>
      Object.freeze({ path: input.path, hash: "b".repeat(64) }),
    ),
    listWorkspaceFiles: vi.fn(async () =>
      Object.freeze({ entries: Object.freeze([]), truncated: false }),
    ),
  };
});

describe("createToolDispatcher", () => {
  it("uses only the selected command and reports an omitted capability deterministically", async () => {
    const dispatcher = createToolDispatcher({
      verificationCommands: [testCommand],
      runVerification: async () => failedVerification,
    });

    await expect(
      dispatcher.runVerification({ kind: "run_verification", commandId: "test" }),
    ).resolves.toEqual(failedVerification);
    await expect(
      dispatcher.searchText({
        kind: "search_text",
        path: "src",
        query: "needle",
        maxResults: 1,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_TOOL" });
  });

  it("keeps the bound workspace root when an untrusted patch input includes one", async () => {
    const dispatcher = createToolDispatcher({
      workspaceRoot: "C:/bound-workspace",
      verificationCommands: [testCommand],
      canReadPath: () => true,
    });
    const untrustedInput = {
      workspaceRoot: "C:/untrusted-workspace",
      path: "src/math.ts",
      patch: "@@ -1 +1 @@\n-before\n+after\n",
      approval: {
        id: "approval-1",
        actionId: "action-1",
        patchHash: "a".repeat(64),
        baseHash: "a".repeat(64),
        status: "approved",
        createdAt: 0,
        expiresAt: 1,
      },
    };

    await dispatcher.applyApprovedPatch(untrustedInput);

    expect(vi.mocked(applyWorkspacePatch)).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: "C:/bound-workspace" }),
    );
  });

  it("rejects a disallowed listing path before the default tool is called", async () => {
    vi.mocked(listWorkspaceFiles).mockClear();
    const dispatcher = createToolDispatcher({
      workspaceRoot: "C:/bound-workspace",
      verificationCommands: [testCommand],
      canReadPath: (path) => path !== "private",
    });

    await expect(
      dispatcher.listFiles({ kind: "list_files", path: "private", depth: 1 }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_TOOL" });
    expect(vi.mocked(listWorkspaceFiles)).not.toHaveBeenCalled();
  });
});
