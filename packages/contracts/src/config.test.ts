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

const completeConfig = {
  providerProfileId: "deepseek-default",
  allowedPaths: ["src/**", "tests/**"],
  sensitivePatterns: ["**/.env", "**/*.pem"],
  verificationCommands: [trustedCommand],
};

describe("CodeSentinelConfigSchema", () => {
  it("accepts a complete config with an explicit trusted npm CLI launcher", () => {
    expect(CodeSentinelConfigSchema.parse(completeConfig)).toMatchObject({
      providerProfileId: "deepseek-default",
      allowedPaths: ["src/**", "tests/**"],
      sensitivePatterns: ["**/.env", "**/*.pem"],
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
          ...completeConfig,
          verificationCommands: [{ ...trustedCommand, args }],
        }).success,
      ).toBe(true);
    }
  });

  it("rejects legacy executable and Windows command-wrapper fields alongside a trusted launcher", () => {
    for (const executable of ["npm", "npm.cmd", "npm.bat", "cmd.exe"]) {
      expect(
        CodeSentinelConfigSchema.safeParse({
          ...completeConfig,
          verificationCommands: [{ ...trustedCommand, executable }],
        }).success,
      ).toBe(false);
    }
  });

  it("requires the explicit trusted npm CLI launcher", () => {
    expect(
      CodeSentinelConfigSchema.safeParse({
        ...completeConfig,
        verificationCommands: [{ ...trustedCommand, launcher: undefined }],
      }).success,
    ).toBe(false);
  });

  it("rejects arguments and budgets outside the trusted runner grammar", () => {
    for (const candidate of [
      { ...trustedCommand, args: ["test", "&&", "publish"] },
      { ...trustedCommand, args: ["run", "deploy"] },
      { ...trustedCommand, timeoutMs: MAX_VERIFICATION_TIMEOUT_MS + 1 },
      { ...trustedCommand, maxOutputBytes: MAX_VERIFICATION_OUTPUT_BYTES + 1 },
    ]) {
      expect(
        CodeSentinelConfigSchema.safeParse({
          ...completeConfig,
          verificationCommands: [candidate],
        }).success,
      ).toBe(false);
    }
  });

  it("rejects non-positive runner budgets", () => {
    for (const candidate of [
      { ...trustedCommand, timeoutMs: 0 },
      { ...trustedCommand, maxOutputBytes: 0 },
    ]) {
      expect(
        CodeSentinelConfigSchema.safeParse({
          ...completeConfig,
          verificationCommands: [candidate],
        }).success,
      ).toBe(false);
    }
  });

  it("rejects control-bearing and overly long verification command ids", () => {
    for (const id of ["test\0", "test\n", "test\u009b31m", "x".repeat(129)]) {
      expect(
        CodeSentinelConfigSchema.safeParse({
          ...completeConfig,
          verificationCommands: [{ ...trustedCommand, id }],
        }).success,
      ).toBe(false);
    }
  });

  it("rejects duplicate verification command ids", () => {
    const result = CodeSentinelConfigSchema.safeParse({
      ...completeConfig,
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
        ...completeConfig,
        verificationCommands: [trustedCommand],
        unexpected: true,
      }),
    ).toThrow();
  });

  it("rejects unknown nested verification command properties", () => {
    expect(() =>
      CodeSentinelConfigSchema.parse({
        ...completeConfig,
        verificationCommands: [{ ...trustedCommand, unexpected: true }],
      }),
    ).toThrow();
  });

  it("rejects blank, control-bearing, and overly long provider profile ids", () => {
    for (const providerProfileId of [
      "",
      " \t ",
      "deepseek\0default",
      "deepseek\ndefault",
      "x".repeat(129),
    ]) {
      expect(
        CodeSentinelConfigSchema.safeParse({ ...completeConfig, providerProfileId }).success,
      ).toBe(false);
    }
  });

  it("requires at least one allowed path", () => {
    expect(
      CodeSentinelConfigSchema.safeParse({ ...completeConfig, allowedPaths: [] }).success,
    ).toBe(false);
  });

  it("rejects parent traversal and control-bearing path patterns", () => {
    for (const patterns of [["../**"], ["src/\0private/**"], ["src/\nprivate/**"]]) {
      expect(
        CodeSentinelConfigSchema.safeParse({ ...completeConfig, allowedPaths: patterns }).success,
      ).toBe(false);
      expect(
        CodeSentinelConfigSchema.safeParse({ ...completeConfig, sensitivePatterns: patterns })
          .success,
      ).toBe(false);
    }
  });

  it("rejects overly long path patterns and pattern lists", () => {
    const overlyLongPattern = "x".repeat(257);
    const tooManyPatterns = Array.from({ length: 65 }, (_, index) => `src/${index}/**`);

    for (const override of [
      { allowedPaths: [overlyLongPattern] },
      { sensitivePatterns: [overlyLongPattern] },
      { allowedPaths: tooManyPatterns },
      { sensitivePatterns: tooManyPatterns },
    ]) {
      expect(CodeSentinelConfigSchema.safeParse({ ...completeConfig, ...override }).success).toBe(
        false,
      );
    }
  });
});
