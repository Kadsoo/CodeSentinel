import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Action } from "../packages/contracts/src/index.js";
import {
  approvePatch,
  createPendingApproval,
  createPolicy,
} from "../packages/policy/src/index.js";
import { ScriptedMockProvider } from "../packages/providers/src/index.js";

const BASE_HASH = "a".repeat(64);
const PATCH = "@@ -1 +1 @@\n-return 1;\n+return 2;\n";

export type MechanismEvidence = Readonly<{
  guardrail: Readonly<{ decision: "deny"; toolCalls: 0 }>;
  feedback: Readonly<{
    firstAction: "run_verification";
    nextAction: "propose_patch";
    feedbackIncluded: boolean;
  }>;
  approval: Readonly<{
    required: true;
    appliedBeforeApproval: false;
    approvedWithMatchingBase: boolean;
  }>;
}>;

export async function runMechanismDemo(): Promise<MechanismEvidence> {
  const policy = createPolicy({
    workspaceRoot: "/demo-workspace",
    canonicalWorkspaceRoot: "/demo-workspace",
    canonicalPaths: {},
    config: {
      allowedPaths: ["src/**"],
      sensitivePatterns: [".env"],
      verificationCommands: [
        {
          id: "test",
          launcher: "node_npm_cli",
          args: ["test"],
          timeoutMs: 10_000,
          maxOutputBytes: 8_192,
        },
      ],
    },
  });

  const dangerousAction: Action = { kind: "read_file", path: "../secrets.txt" };
  const guardrailDecision = policy.evaluate(dangerousAction);
  if (guardrailDecision.decision !== "deny") {
    throw new Error("DEMO_GUARDRAIL_NOT_DENIED");
  }
  const guardrail = Object.freeze({ decision: "deny" as const, toolCalls: 0 as const });

  const provider = new ScriptedMockProvider([
    { kind: "run_verification", commandId: "test" },
    {
      kind: "propose_patch",
      path: "src/math.ts",
      baseHash: BASE_HASH,
      patch: PATCH,
      reason: "Use the failed verification feedback",
      stage: "repair",
    },
  ]);
  const firstRequest = Object.freeze({ messages: [{ role: "user" as const, content: "start" }] });
  const firstAction = (await provider.complete(firstRequest)) as Action;
  const feedback = "verification failed: expected 2, received 1";
  const secondRequest = Object.freeze({ messages: [{ role: "user" as const, content: feedback }] });
  const nextAction = (await provider.complete(secondRequest)) as Action;
  if (firstAction.kind !== "run_verification" || nextAction.kind !== "propose_patch") {
    throw new Error("DEMO_FEEDBACK_SEQUENCE_INVALID");
  }
  const feedbackEvidence = Object.freeze({
    firstAction: "run_verification" as const,
    nextAction: "propose_patch" as const,
    feedbackIncluded: provider.requests[1]?.messages.some((message) => message.content.includes(feedback)) ?? false,
  });

  const now = 1_754_000_000_000;
  const patchHash = createHash("sha256").update(PATCH, "utf8").digest("hex");
  const pending = createPendingApproval(patchHash, BASE_HASH, now + 60_000, {
    id: "approval-demo",
    actionId: "action-demo",
    createdAt: now,
  });
  const approved = approvePatch(pending, BASE_HASH, now + 1_000);
  const approval = Object.freeze({
    required: true,
    appliedBeforeApproval: pending.status === "approved",
    approvedWithMatchingBase: approved.status === "approved",
  }) as MechanismEvidence["approval"];

  return Object.freeze({ guardrail, feedback: feedbackEvidence, approval });
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && resolve(entrypoint) === resolve(fileURLToPath(import.meta.url))) {
  runMechanismDemo()
    .then((evidence) => {
      process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    })
    .catch(() => {
      process.stderr.write("MECHANISM_DEMO_FAILED\n");
      process.exitCode = 1;
    });
}
