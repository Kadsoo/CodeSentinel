import { describe, expect, it } from "vitest";
import { PendingPatchStore } from "./pending-patch-store.js";

function patch(path: string) {
  return {
    kind: "propose_patch" as const,
    path,
    baseHash: "a".repeat(64),
    patch: "@@ -1 +1 @@\n-before\n+after\n",
    reason: "Repair the selected failure",
    stage: "repair" as const,
  };
}

describe("PendingPatchStore", () => {
  it("keeps session and approval identifiers as an unambiguous pair", () => {
    const store = new PendingPatchStore();
    const first = store.create({
      sessionId: "session\u0000approval",
      approvalId: "one",
      actionId: "action-one",
      now: 0,
      action: patch("src/first.ts"),
    });
    store.create({
      sessionId: "session",
      approvalId: "approval\u0000one",
      actionId: "action-two",
      now: 0,
      action: patch("src/second.ts"),
    });

    expect(store.getView("session\u0000approval", first.approvalId)).toMatchObject({
      path: "src/first.ts",
    });
  });
});
