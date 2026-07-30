import { describe, expect, it } from "vitest";
import { persistenceError } from "./errors.js";

describe("persistenceError", () => {
  it("exposes an immutable public error code at runtime", () => {
    const error = persistenceError("INVALID_PERSISTENCE_INPUT");

    expect(error).toMatchObject({
      name: "CodeSentinelPersistenceError",
      message: "INVALID_PERSISTENCE_INPUT",
      code: "INVALID_PERSISTENCE_INPUT",
    });
    expect(Object.hasOwn(error, "cause")).toBe(false);
    expect(JSON.stringify(error)).toBe(
      '{"code":"INVALID_PERSISTENCE_INPUT","name":"CodeSentinelPersistenceError"}',
    );
    expect.soft(
      Object.getOwnPropertyDescriptor(error, "code"),
    ).toEqual({
      value: "INVALID_PERSISTENCE_INPUT",
      enumerable: true,
      writable: false,
      configurable: false,
    });
    expect.soft(
      Reflect.set(error, "code", "PERSISTENCE_FAILED"),
    ).toBe(false);
    expect.soft(error.code).toBe("INVALID_PERSISTENCE_INPUT");

    const strictAssignmentError = persistenceError(
      "INVALID_PERSISTENCE_INPUT",
    );
    expect.soft(() => {
      (
        strictAssignmentError as {
          code: string;
        }
      ).code = "PERSISTENCE_FAILED";
    }).toThrow(TypeError);
    expect.soft(strictAssignmentError.code).toBe(
      "INVALID_PERSISTENCE_INPUT",
    );
  });
});
