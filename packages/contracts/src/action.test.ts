import { describe, expect, it } from "vitest";
import { ActionSchema, CodeSentinelConfigSchema } from "./index.js";

describe("ActionSchema", () => {
  it("accepts one structured patch proposal", () => {
    expect(
      ActionSchema.parse({
        kind: "propose_patch",
        path: "src/math.ts",
        baseHash: "a".repeat(64),
        patch: "@@ -1 +1 @@\n-export const add = () => 0;\n+export const add = () => 2;",
        reason: "Fix incorrect addition",
        stage: "repair",
      }).kind,
    ).toBe("propose_patch");
  });

  it("rejects a patch proposal without a stage", () => {
    expect(() =>
      ActionSchema.parse({
        kind: "propose_patch",
        path: "src/math.ts",
        baseHash: "a".repeat(64),
        patch: "@@ -1 +1 @@\n-export const add = () => 0;\n+export const add = () => 2;",
        reason: "Fix incorrect addition",
      }),
    ).toThrow();
  });

  it("accepts each supported patch proposal stage", () => {
    for (const stage of ["repair", "test", "implementation"]) {
      expect(
        ActionSchema.safeParse({
          kind: "propose_patch",
          path: "src/math.ts",
          baseHash: "a".repeat(64),
          patch: "@@ -1 +1 @@\n-export const add = () => 0;\n+export const add = () => 2;",
          reason: "Fix incorrect addition",
          stage,
        }).success,
      ).toBe(true);
    }
  });

  it("rejects an unsupported patch proposal stage", () => {
    expect(
      ActionSchema.safeParse({
        kind: "propose_patch",
        path: "src/math.ts",
        baseHash: "a".repeat(64),
        patch: "@@ -1 +1 @@\n-export const add = () => 0;\n+export const add = () => 2;",
        reason: "Fix incorrect addition",
        stage: "publish",
      }).success,
    ).toBe(false);
  });

  it("rejects file listings deeper than eight levels", () => {
    expect(ActionSchema.safeParse({ kind: "list_files", depth: 9 }).success).toBe(false);
  });

  it("rejects text searches returning more than 100 matches", () => {
    expect(
      ActionSchema.safeParse({ kind: "search_text", query: "TODO", maxResults: 101 }).success,
    ).toBe(false);
  });

  it("rejects an arbitrary shell field", () => {
    expect(() => ActionSchema.parse({ kind: "shell", command: "rm -rf /" })).toThrow();
  });

  it("preserves surrounding whitespace in an accepted path", () => {
    expect(
      ActionSchema.parse({ kind: "read_file", path: "  src/math.ts  " }),
    ).toEqual({ kind: "read_file", path: "  src/math.ts  " });
  });

  it("rejects whitespace-only paths", () => {
    expect(() => ActionSchema.parse({ kind: "read_file", path: "   " })).toThrow();
  });

  it("rejects unknown properties on a supported action", () => {
    expect(() =>
      ActionSchema.parse({
        kind: "read_file",
        path: "src/math.ts",
        unexpected: true,
      }),
    ).toThrow();
  });

  it("normalizes verification command ids for config lookup", () => {
    const config = CodeSentinelConfigSchema.parse({
      providerProfileId: "deepseek-default",
      allowedPaths: ["src/**"],
      verificationCommands: [
        {
          id: " test ",
          launcher: "node_npm_cli",
          args: ["test"],
          timeoutMs: 30_000,
          maxOutputBytes: 65_536,
        },
      ],
    });

    expect(
      ActionSchema.parse({ kind: "run_verification", commandId: " test " }),
    ).toEqual({
      kind: "run_verification",
      commandId: config.verificationCommands[0].id,
    });
  });

  it("rejects control-bearing verification command ids before normalizing", () => {
    for (const commandId of ["test\0", "test\n", "test\u007f", "test\u009b31m"]) {
      expect(
        ActionSchema.safeParse({ kind: "run_verification", commandId }).success,
      ).toBe(false);
    }
  });
});
