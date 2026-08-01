import { describe, expect, it, vi } from "vitest";
import { runCli, type CliDependencies } from "./main.js";

function dependencies(): CliDependencies {
  const output = { write: vi.fn(() => true) };
  return {
    profileStore: {
      get: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      upsert: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
    credentialStore: {
      set: vi.fn(async () => undefined),
      get: vi.fn(async () => undefined),
      status: vi.fn(async () => "missing" as const),
      clear: vi.fn(async () => undefined),
    },
    streams: { stdout: output, stderr: output, stdin: { isTTY: true } },
    promptHidden: vi.fn(async () => "secret"),
    probe: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
  };
}

describe("CLI entrypoint", () => {
  it("exports the same testable dispatcher and delegates start without probing", async () => {
    const deps = dependencies();
    await expect(runCli(["start"], deps)).resolves.toBe(0);
    expect(deps.start).toHaveBeenCalledTimes(1);
    expect(deps.probe).not.toHaveBeenCalled();
  });
});
