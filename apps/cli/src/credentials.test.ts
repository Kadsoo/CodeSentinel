import { describe, expect, it, vi } from "vitest";
import type { ProviderProfile, ProfileStore } from "../../../packages/host/src/profile-store.js";
import type { CredentialStore } from "../../../packages/providers/src/credential-store.js";
import { runCli, type CliDependencies, type CliOutput } from "./credentials.js";

const SECRET_SENTINEL = "sk-cli-secret-sentinel-20260801";

const profile: ProviderProfile = Object.freeze({
  id: "deepseek-default",
  kind: "deepseek",
  endpoint: "https://api.deepseek.com/chat/completions",
  model: "deepseek-v4-flash",
  credentialRef: "deepseek-default",
});

function captureOutput(): CliOutput & { text(): string } {
  let contents = "";
  return {
    write(chunk: string | Uint8Array): boolean {
      contents += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
    text: () => contents,
  };
}

function dependencies(overrides: Partial<CliDependencies> = {}): CliDependencies & {
  output: CliOutput & { text(): string };
  profileStore: ProfileStore;
  credentialStore: CredentialStore;
} {
  const output = captureOutput();
  const profiles = new Map<string, ProviderProfile>([[profile.id, profile]]);
  const profileStore: ProfileStore = {
    get: vi.fn(async (id: string) => profiles.get(id)),
    list: vi.fn(async () => [...profiles.values()]),
    upsert: vi.fn(async (next: ProviderProfile) => {
      profiles.set(next.id, next);
    }),
    remove: vi.fn(async (id: string) => {
      profiles.delete(id);
    }),
  };
  const credentialStore: CredentialStore = {
    set: vi.fn(async () => undefined),
    get: vi.fn(async () => SECRET_SENTINEL),
    status: vi.fn(async () => "missing" as const),
    clear: vi.fn(async () => undefined),
  };
  return {
    profileStore,
    credentialStore,
    output,
    streams: {
      stdout: output,
      stderr: output,
      stdin: { isTTY: true },
    },
    promptHidden: vi.fn(async () => SECRET_SENTINEL),
    probe: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("credential CLI commands", () => {
  it("requires a TTY and never reads an environment variable for set", async () => {
    const deps = dependencies({
      streams: {
        stdout: captureOutput(),
        stderr: captureOutput(),
        stdin: { isTTY: false },
      },
    });

    await expect(
      runCli(
        [
          "credentials",
          "set",
          "deepseek-default",
          "--provider",
          "deepseek",
          "--model",
          "deepseek-v4-flash",
        ],
        deps,
      ),
    ).resolves.toBe(1);
    expect(deps.promptHidden).not.toHaveBeenCalled();
    expect(deps.credentialStore.set).not.toHaveBeenCalled();
    expect(deps.output.text()).not.toContain(SECRET_SENTINEL);
  });

  it("prompts exactly once, persists the safe profile before the credential, and never prints the secret", async () => {
    const deps = dependencies();
    const result = await runCli(
      [
        "credentials",
        "set",
        "deepseek-default",
        "--provider",
        "deepseek",
        "--model",
        "deepseek-v4-flash",
      ],
      deps,
    );

    expect(result).toBe(0);
    expect(deps.promptHidden).toHaveBeenCalledTimes(1);
    expect(deps.profileStore.upsert).toHaveBeenCalledWith(profile);
    expect(deps.credentialStore.set).toHaveBeenCalledWith(profile.credentialRef, SECRET_SENTINEL);
    expect(
      (deps.profileStore.upsert as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    ).toBeLessThan((deps.credentialStore.set as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
    expect(deps.output.text()).not.toContain(SECRET_SENTINEL);
  });

  it("keeps the safe profile when credential persistence fails", async () => {
    const deps = dependencies({
      credentialStore: {
        ...dependencies().credentialStore,
        set: vi.fn(async () => {
          throw new Error("credential manager unavailable");
        }),
      },
    });
    await expect(
      runCli(
        [
          "credentials",
          "set",
          "deepseek-default",
          "--provider",
          "deepseek",
          "--model",
          "deepseek-v4-flash",
        ],
        deps,
      ),
    ).resolves.toBe(1);
    expect(deps.profileStore.upsert).toHaveBeenCalledTimes(1);
    expect(deps.output.text()).not.toContain(SECRET_SENTINEL);
  });

  it("prints only the non-secret status", async () => {
    const deps = dependencies();
    await expect(
      runCli(["credentials", "status", "deepseek-default"], deps),
    ).resolves.toBe(0);
    expect(deps.output.text()).toBe("deepseek-default: missing\n");
    expect(deps.output.text()).not.toContain(SECRET_SENTINEL);
  });

  it("clears the credential before removing its profile", async () => {
    const deps = dependencies();
    await expect(
      runCli(["credentials", "clear", "deepseek-default"], deps),
    ).resolves.toBe(0);
    expect(deps.credentialStore.clear).toHaveBeenCalledWith(profile.credentialRef);
    expect(deps.profileStore.remove).toHaveBeenCalledWith(profile.id);
    expect(
      (deps.credentialStore.clear as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    ).toBeLessThan((deps.profileStore.remove as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
  });

  it("only probes when the explicit probe command is requested", async () => {
    const deps = dependencies({
      credentialStore: {
        ...dependencies().credentialStore,
        status: vi.fn(async () => "configured" as const),
        get: vi.fn(async () => SECRET_SENTINEL),
      },
    });
    await expect(
      runCli(["credentials", "probe", "deepseek-default"], deps),
    ).resolves.toBe(0);
    expect(deps.probe).toHaveBeenCalledTimes(1);
    const startDeps = dependencies();
    await expect(runCli(["start"], startDeps)).resolves.toBe(0);
    expect(startDeps.probe).not.toHaveBeenCalled();
    expect(startDeps.start).toHaveBeenCalledTimes(1);
  });

  it("requires an HTTPS endpoint for NJU and rejects an endpoint for DeepSeek", async () => {
    const deepseek = dependencies();
    await expect(
      runCli(
        [
          "credentials",
          "set",
          "deepseek-default",
          "--provider",
          "deepseek",
          "--model",
          "m",
          "--endpoint",
          "https://other.example.test/v1",
        ],
        deepseek,
      ),
    ).resolves.toBe(1);
    expect(deepseek.promptHidden).not.toHaveBeenCalled();

    const nju = dependencies();
    await expect(
      runCli(
        [
          "credentials",
          "set",
          "deepseek-default",
          "--provider",
          "nju-se-hub",
          "--model",
          "m",
          "--endpoint",
          "http://insecure.example.test/v1",
        ],
        nju,
      ),
    ).resolves.toBe(1);
    expect(nju.promptHidden).not.toHaveBeenCalled();
  });
});
