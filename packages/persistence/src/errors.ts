import type { PersistenceErrorCode } from "./constants.js";

export class CodeSentinelPersistenceError extends Error {
  readonly code: PersistenceErrorCode;

  constructor(code: PersistenceErrorCode) {
    super(code);
    this.name = "CodeSentinelPersistenceError";
    this.code = code;
    Object.defineProperty(this, "code", {
      value: code,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
}

export function persistenceError(code: PersistenceErrorCode): CodeSentinelPersistenceError {
  return new CodeSentinelPersistenceError(code);
}
