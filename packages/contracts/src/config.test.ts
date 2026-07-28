import { describe, expect, it } from "vitest";
import { CodeSentinelConfigSchema } from "./index.js";

const validVerificationCommand = {
  id: "test",
  executable: "npm",
  args: ["test", "--", "--runInBand"],
  timeoutMs: 30_000,
  maxOutputBytes: 1_000_000,
};

describe("CodeSentinelConfigSchema", () => {
  it("accepts a complete structured verification command", () => {
    expect(
      CodeSentinelConfigSchema.parse({
        verificationCommands: [validVerificationCommand],
      }),
    ).toMatchObject({ verificationCommands: [{ executable: "npm" }] });
  });

  it("rejects a non-array args value on an otherwise valid command", () => {
    expect(() =>
      CodeSentinelConfigSchema.parse({
        verificationCommands: [
          {
            id: "test",
            executable: "npm",
            args: "--runInBand",
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
        ],
      }),
    ).toThrow();
  });

  it("requires executable and argument-array verification commands", () => {
    expect(() =>
      CodeSentinelConfigSchema.parse({
        verificationCommands: [{ id: "test", command: "npm test" }],
      }),
    ).toThrow();
  });

  it("rejects duplicate verification command ids", () => {
    const result = CodeSentinelConfigSchema.safeParse({
      verificationCommands: [
        validVerificationCommand,
        { ...validVerificationCommand, executable: "pnpm" },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    expect(result.error.issues[0]?.path).toEqual(["verificationCommands", 1, "id"]);
  });

  it("rejects unknown root properties on a complete config", () => {
    expect(() =>
      CodeSentinelConfigSchema.parse({
        verificationCommands: [validVerificationCommand],
        unexpected: true,
      }),
    ).toThrow();
  });

  it("rejects unknown nested verification command properties", () => {
    expect(() =>
      CodeSentinelConfigSchema.parse({
        verificationCommands: [{ ...validVerificationCommand, unexpected: true }],
      }),
    ).toThrow();
  });
});
