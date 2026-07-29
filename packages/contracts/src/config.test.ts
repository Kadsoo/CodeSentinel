import { describe, expect, it } from "vitest";
import {
  CodeSentinelConfigSchema,
  MAX_VERIFICATION_OUTPUT_BYTES,
  MAX_VERIFICATION_TIMEOUT_MS,
} from "./index.js";

const trustedCommand = {
  id: "test",
  launcher: "node_npm_cli",
  args: ["test"],
  timeoutMs: 1_000,
  maxOutputBytes: 1_024,
};

describe("CodeSentinelConfigSchema", () => {
  it("accepts an explicit trusted npm CLI launcher", () => {
    expect(
      CodeSentinelConfigSchema.parse({ verificationCommands: [trustedCommand] }),
    ).toMatchObject({
      verificationCommands: [{ launcher: "node_npm_cli", args: ["test"] }],
    });
  });

  it("accepts the explicit npm run and run-script forms", () => {
    for (const args of [
      ["run", "check"],
      ["run", "lint"],
      ["run", "test"],
      ["run", "typecheck"],
      ["run", "verify"],
      ["run-script", "lint"],
    ]) {
      expect(
        CodeSentinelConfigSchema.safeParse({
          verificationCommands: [{ ...trustedCommand, args }],
        }).success,
      ).toBe(true);
    }
  });

  it("rejects legacy executable and Windows command-wrapper configuration", () => {
    for (const executable of ["npm", "npm.cmd", "npm.bat", "cmd.exe"]) {
      expect(
        CodeSentinelConfigSchema.safeParse({
          verificationCommands: [{ ...trustedCommand, executable, launcher: undefined }],
        }).success,
      ).toBe(false);
    }
  });

  it("rejects arguments and budgets outside the trusted runner grammar", () => {
    for (const candidate of [
      { ...trustedCommand, args: ["test", "&&", "publish"] },
      { ...trustedCommand, args: ["run", "deploy"] },
      { ...trustedCommand, timeoutMs: MAX_VERIFICATION_TIMEOUT_MS + 1 },
      { ...trustedCommand, maxOutputBytes: MAX_VERIFICATION_OUTPUT_BYTES + 1 },
    ]) {
      expect(
        CodeSentinelConfigSchema.safeParse({ verificationCommands: [candidate] }).success,
      ).toBe(false);
    }
  });

  it("rejects non-positive runner budgets", () => {
    for (const candidate of [
      { ...trustedCommand, timeoutMs: 0 },
      { ...trustedCommand, maxOutputBytes: 0 },
    ]) {
      expect(
        CodeSentinelConfigSchema.safeParse({ verificationCommands: [candidate] }).success,
      ).toBe(false);
    }
  });

  it("rejects control-bearing and overly long verification command ids", () => {
    for (const id of ["test\0", "test\n", "x".repeat(129)]) {
      expect(
        CodeSentinelConfigSchema.safeParse({
          verificationCommands: [{ ...trustedCommand, id }],
        }).success,
      ).toBe(false);
    }
  });

  it("rejects duplicate verification command ids", () => {
    const result = CodeSentinelConfigSchema.safeParse({
      verificationCommands: [trustedCommand, { ...trustedCommand }],
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
        verificationCommands: [trustedCommand],
        unexpected: true,
      }),
    ).toThrow();
  });

  it("rejects unknown nested verification command properties", () => {
    expect(() =>
      CodeSentinelConfigSchema.parse({
        verificationCommands: [{ ...trustedCommand, unexpected: true }],
      }),
    ).toThrow();
  });
});
