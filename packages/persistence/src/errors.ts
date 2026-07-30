import type { PersistenceErrorCode } from "./constants.js";

export class CodeSentinelPersistenceError extends Error {
  readonly code: PersistenceErrorCode;

  constructor(code: PersistenceErrorCode) {
    super(code);
    this.name = "CodeSentinelPersistenceError";
    this.code = code;
  }
}

export function persistenceError(code: PersistenceErrorCode): CodeSentinelPersistenceError {
  return new CodeSentinelPersistenceError(code);
}
