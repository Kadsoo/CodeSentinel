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
      }).kind,
    ).toBe("propose_patch");
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
