import { describe, expect, it } from "vitest";
import { isConfiguredVerificationCommand } from "./command-policy.js";

const trustedCommand = {
  id: "test",
  launcher: "node_npm_cli",
  args: ["test"],
  timeoutMs: 1_000,
  maxOutputBytes: 1_024,
};

describe("isConfiguredVerificationCommand", () => {
  it("accepts a trusted verification command without fabricating workspace config", () => {
    expect(isConfiguredVerificationCommand(" test ", [trustedCommand])).toBe(true);
  });

  it("rejects verification commands with unknown fields", () => {
    expect(
      isConfiguredVerificationCommand("test", [{ ...trustedCommand, unexpected: true }]),
    ).toBe(false);
  });
});
