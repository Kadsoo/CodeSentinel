export type CoreErrorCode =
  | "INVALID_SESSION_INPUT"
  | "INVALID_ACTION"
  | "PROVIDER_FAILED"
  | "POLICY_DENIED"
  | "UNSUPPORTED_TOOL"
  | "TOOL_FAILED"
  | "EVENT_SINK_FAILED"
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_ALREADY_RESOLVED"
  | "ROUND_LIMIT_REACHED"
  | "VERIFICATION_REQUIRED"
  | "FEATURE_STAGE_INVALID"
  | "FEATURE_TEST_DID_NOT_FAIL";

export class CodeSentinelCoreError extends Error {
  readonly code: CoreErrorCode;

  constructor(code: CoreErrorCode) {
    super(code);
    this.name = "CodeSentinelCoreError";
    this.code = code;
    Object.freeze(this);
  }
}
