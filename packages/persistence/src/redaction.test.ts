import { describe, expect, it } from "vitest";
import { redactText } from "./redaction.js";

describe("redactText", () => {
  it.each([
    ["Authorization: Bearer sk-proj-1234567890abcdef", "sk-proj-1234567890abcdef"],
    ["api_key=sk_1234567890abcdef", "sk_1234567890abcdef"],
    ['{"refresh_token":"token-value-123456"}', "token-value-123456"],
    ["token\u200B=split-secret-value", "split-secret-value"],
    ["ghp_1234567890abcdef", "ghp_1234567890abcdef"],
    ["x".repeat(40), "x".repeat(40)],
  ])("redacts a secret and remains idempotent: %s", (input, secret) => {
    const redacted = redactText(input);

    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain(secret);
    expect(redactText(redacted)).toBe(redacted);
  });

  it("rejects an oversized input without serializing the secret", () => {
    const secret = `sk-proj-${"x".repeat(70_000)}`;

    try {
      redactText(secret);
      throw new Error("expected redactText to throw");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_PERSISTENCE_INPUT" });
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  it("leaves ordinary text unchanged", () => {
    expect(redactText("ordinary text is safe")).toBe("ordinary text is safe");
  });

  it("accepts an input exactly at the scan limit and bounds the output", () => {
    const input = "safe text ".repeat(7_282).slice(0, 65_536);

    expect(input).toHaveLength(65_536);
    expect(redactText(input)).toHaveLength(4_096);
  });

  it("redacts before truncating a secret at the output boundary", () => {
    const secret = "sk-proj-1234567890abcdef";
    const redacted = redactText(`${"a ".repeat(2_043)}${secret}`);

    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toMatch(/sk-proj-?$/);
  });
});
