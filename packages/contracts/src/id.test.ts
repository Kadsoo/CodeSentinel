import { describe, expect, it } from "vitest";
import { createId } from "./id.js";

describe("createId", () => {
  it("returns a non-empty UUID-shaped identifier", () => {
    expect(createId()).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
