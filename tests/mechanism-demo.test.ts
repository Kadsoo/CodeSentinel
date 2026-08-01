import { describe, expect, it } from "vitest";
import { runMechanismDemo } from "../scripts/mechanism-demo.js";

describe("offline mechanism demonstration", () => {
  it("proves denial, feedback, and approval binding without side effects", async () => {
    const evidence = await runMechanismDemo();

    expect(evidence.guardrail).toEqual({ decision: "deny", toolCalls: 0 });
    expect(evidence.feedback).toEqual({
      firstAction: "run_verification",
      nextAction: "propose_patch",
      feedbackIncluded: true,
    });
    expect(evidence.approval).toEqual({
      required: true,
      appliedBeforeApproval: false,
      approvedWithMatchingBase: true,
    });
  });
});
