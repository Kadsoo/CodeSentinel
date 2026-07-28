import type { Action, VerificationCommand } from "../../contracts/src/index.js";
import { isConfiguredVerificationCommand } from "./command-policy.js";
import { evaluatePath } from "./path-policy.js";
import type { PathPolicyContext } from "./path-policy.js";

export type PolicyReason =
  | "SENSITIVE_PATH"
  | "OUTSIDE_WORKSPACE"
  | "UNKNOWN_COMMAND"
  | "PATCH_REQUIRES_APPROVAL"
  | "ALLOWED";

export type GuardrailDecision = Readonly<{
  decision: "allow" | "ask" | "deny";
  reason: PolicyReason;
}>;

export type PolicyConfig = Readonly<{
  allowedPaths: readonly string[];
  sensitivePatterns?: readonly string[];
  verificationCommands: readonly VerificationCommand[];
}>;

export type PolicyContext = Omit<PathPolicyContext, "config"> &
  Readonly<{
    config: PolicyConfig;
  }>;

export interface Policy {
  evaluate(action: Action, context: PolicyContext): GuardrailDecision;
}

export interface BoundPolicy {
  evaluate(action: Action): GuardrailDecision;
}

export function evaluateAction(action: Action, context: PolicyContext): GuardrailDecision {
  switch (action.kind) {
    case "list_files":
      return action.path === undefined
        ? decision("deny", "OUTSIDE_WORKSPACE")
        : evaluatePathDecision(action.path, context, "allow");
    case "read_file":
      return evaluatePathDecision(action.path, context, "allow");
    case "search_text":
      return action.path === undefined
        ? decision("deny", "OUTSIDE_WORKSPACE")
        : evaluatePathDecision(action.path, context, "allow");
    case "propose_patch":
      return evaluatePathDecision(action.path, context, "ask");
    case "apply_approved_patch": {
      const pathDecision = evaluatePathDecision(action.path, context, "deny");
      return pathDecision.decision === "deny" && pathDecision.reason !== "PATCH_REQUIRES_APPROVAL"
        ? pathDecision
        : decision("deny", "PATCH_REQUIRES_APPROVAL");
    }
    case "run_verification":
      return isConfiguredVerificationCommand(
        action.commandId,
        context?.config?.verificationCommands ?? [],
      )
        ? decision("allow", "ALLOWED")
        : decision("deny", "UNKNOWN_COMMAND");
    case "finish":
      return decision("allow", "ALLOWED");
    default:
      return decision("deny", "OUTSIDE_WORKSPACE");
  }
}

export function createPolicy(context: PolicyContext): BoundPolicy {
  return Object.freeze({
    evaluate(action: Action): GuardrailDecision {
      return evaluateAction(action, context);
    },
  });
}

function evaluatePathDecision(
  path: string,
  context: PolicyContext,
  allowedDecision: "allow" | "ask" | "deny",
): GuardrailDecision {
  const pathCheck = evaluatePath(path, context);
  if (pathCheck.status === "deny") {
    return decision("deny", pathCheck.reason);
  }

  if (allowedDecision === "ask") {
    return decision("ask", "PATCH_REQUIRES_APPROVAL");
  }

  return allowedDecision === "allow"
    ? decision("allow", "ALLOWED")
    : decision("deny", "PATCH_REQUIRES_APPROVAL");
}

function decision(decisionValue: GuardrailDecision["decision"], reason: PolicyReason): GuardrailDecision {
  return Object.freeze({ decision: decisionValue, reason });
}
