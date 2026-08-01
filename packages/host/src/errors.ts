export type HostErrorCode =
  | "WORKSPACE_INVALID"
  | "CONFIG_INVALID"
  | "PROFILE_INVALID"
  | "PROFILE_NOT_FOUND"
  | "CREDENTIAL_MISSING"
  | "SESSION_ACTIVE"
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_ACTIVE"
  | "APPROVAL_NOT_FOUND"
  | "STATE_UNAVAILABLE"
  | "STATE_CORRUPT";

export class HostError extends Error {
  readonly code: HostErrorCode;

  constructor(code: HostErrorCode) {
    super(code);
    this.name = "HostError";
    this.code = code;
    Object.defineProperty(this, "code", {
      value: code,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
}

export function hostError(code: HostErrorCode): HostError {
  return new HostError(code);
}
