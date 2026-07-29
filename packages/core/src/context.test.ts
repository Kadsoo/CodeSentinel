import { describe, expect, it } from "vitest";
import { buildProviderRequest } from "./context.js";

describe("buildProviderRequest", () => {
  it("bounds and redacts feedback before constructing a provider request", () => {
    const request = buildProviderRequest({
      taskSummary: "Repair the selected test",
      phase: "repair",
      feedback: [
        {
          kind: "verification",
          summary: "Authorization: Bearer sentinel-secret-value\n" + "x".repeat(5_000),
        },
      ],
    });

    const content = request.messages.at(-1)?.content ?? "";
    expect(request.messages).toHaveLength(2);
    expect(content).toContain("Repair the selected test");
    expect(content).not.toContain("sentinel-secret-value");
    expect(content.length).toBeLessThanOrEqual(4_096);
  });

  it("redacts short values assigned to bare secret field names", () => {
    const request = buildProviderRequest({
      taskSummary: "Repair the selected test",
      phase: "repair",
      feedback: [
        {
          kind: "verification",
          summary: "token=short-secret-value secret: another-short-secret",
        },
      ],
    });

    const content = request.messages.at(-1)?.content ?? "";
    expect(content).not.toContain("short-secret-value");
    expect(content).not.toContain("another-short-secret");
    expect(content).toContain("[REDACTED]");
  });

  it("redacts long standard and URL-safe Base64-like values", () => {
    const standardBase64 = "AAAAAAAAAAAAAAAA/BBBBBBBBBBBBBB=";
    const urlSafeBase64 = "CCCCCCCCCCCCCCCC_DDDDDDDDDDDDDD-";
    const request = buildProviderRequest({
      taskSummary: "Repair the selected test",
      phase: "repair",
      feedback: [
        {
          kind: "verification",
          summary: `encoded ${standardBase64} ${urlSafeBase64}`,
        },
      ],
    });

    const content = request.messages.at(-1)?.content ?? "";
    expect(content).not.toContain(standardBase64);
    expect(content).not.toContain(urlSafeBase64);
    expect(content).toContain("[REDACTED]");
  });
});
