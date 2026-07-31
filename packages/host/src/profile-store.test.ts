import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SECRET_SENTINEL = "sk-profile-secret-sentinel-20260731";
const profilesFileName = "profiles.json";

const validProfile = {
  id: "deepseek-default",
  kind: "deepseek",
  endpoint: "https://api.deepseek.com/chat/completions",
  model: "deepseek-v4-flash",
  credentialRef: "deepseek-default",
} as const;

type HostErrorCode =
  | "PROFILE_INVALID"
  | "PROFILE_NOT_FOUND"
  | "STATE_UNAVAILABLE"
  | "STATE_CORRUPT";

async function host() {
  return import("./index.js");
}

async function withStateDirectory(
  callback: (stateDirectory: string) => Promise<void>,
): Promise<void> {
  const stateDirectory = await mkdtemp(join(tmpdir(), "codesentinel-profiles-"));
  try {
    await callback(stateDirectory);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

async function expectHostError(
  operation: () => Promise<unknown>,
  code: HostErrorCode,
): Promise<void> {
  const { HostError } = await host();
  let captured: unknown;
  try {
    await operation();
  } catch (error) {
    captured = error;
  }

  expect(captured).toBeInstanceOf(HostError);
  expect(captured).toMatchObject({ code, message: code });
  expect(captured).not.toHaveProperty("cause");
  expect(captured).not.toHaveProperty("input");
  expect(String(captured)).not.toContain(SECRET_SENTINEL);
}

describe("profile store", () => {
  it("round trips, orders, and removes non-secret provider profiles", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { createProfileStore } = await host();
      const store = createProfileStore({
        stateDirectory,
        randomSuffix: () => "round-trip",
      });
      const njuProfile = {
        id: "nju-default",
        kind: "nju_se_hub" as const,
        endpoint: "https://hub.example.edu/v1/chat/completions",
        model: "course-model",
        credentialRef: "nju-default",
      };

      expect(await store.list()).toEqual([]);
      expect(await store.get(validProfile.id)).toBeUndefined();

      await store.upsert(validProfile);
      await store.upsert(njuProfile);

      expect(await store.get(validProfile.id)).toEqual(validProfile);
      expect(await store.list()).toEqual([validProfile, njuProfile]);
      expect(Object.isFrozen((await store.get(validProfile.id)) ?? {})).toBe(true);

      await store.remove(validProfile.id);
      expect(await store.get(validProfile.id)).toBeUndefined();
      expect(await store.list()).toEqual([njuProfile]);

      const stored = await readFile(join(stateDirectory, profilesFileName), "utf8");
      expect(stored).toContain('"version":1');
      expect(stored).not.toContain(SECRET_SENTINEL);
    });
  });

  it("replaces an existing valid profile atomically without leftover temporary files", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { createProfileStore } = await host();
      let suffix = 0;
      const store = createProfileStore({
        stateDirectory,
        randomSuffix: () => `replace-${++suffix}`,
      });

      await store.upsert(validProfile);
      await store.upsert({ ...validProfile, model: "replacement-model" });

      expect(await store.get(validProfile.id)).toEqual({
        ...validProfile,
        model: "replacement-model",
      });
      expect(existsSync(join(stateDirectory, "profiles.json.replace-1.tmp"))).toBe(false);
      expect(existsSync(join(stateDirectory, "profiles.json.replace-2.tmp"))).toBe(false);
    });
  });

  it.each([
    ["malformed", "{not json"],
    ["unknown envelope key", JSON.stringify({ version: 1, profiles: [], unexpected: true })],
    ["unknown profile key", JSON.stringify({ version: 1, profiles: [{ ...validProfile, secret: SECRET_SENTINEL }] })],
    ["duplicate profile ids", JSON.stringify({ version: 1, profiles: [validProfile, validProfile] })],
  ])("rejects a %s stored profile file without replacing it", async (_label, contents) => {
    await withStateDirectory(async (stateDirectory) => {
      const { createProfileStore } = await host();
      const profilePath = join(stateDirectory, profilesFileName);
      await writeFile(profilePath, contents, "utf8");
      const before = await readFile(profilePath, "utf8");
      const store = createProfileStore({ stateDirectory, randomSuffix: () => "corrupt" });

      await expectHostError(() => store.upsert(validProfile), "STATE_CORRUPT");
      await expectHostError(() => store.list(), "STATE_CORRUPT");
      expect(await readFile(profilePath, "utf8")).toBe(before);
      expect(existsSync(join(stateDirectory, "profiles.json.corrupt.tmp"))).toBe(false);
    });
  });

  it("rejects an oversized stored profile file", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { createProfileStore } = await host();
      const profilePath = join(stateDirectory, profilesFileName);
      await writeFile(profilePath, " ".repeat(65_537), "utf8");
      const store = createProfileStore({ stateDirectory, randomSuffix: () => "oversized" });

      await expectHostError(() => store.list(), "STATE_CORRUPT");
      await expectHostError(() => store.upsert(validProfile), "STATE_CORRUPT");
      expect(await readFile(profilePath, "utf8")).toHaveLength(65_537);
    });
  });

  it.each([
    ["HTTP endpoint", { endpoint: "http://api.example.test/v1" }],
    ["endpoint query", { endpoint: "https://api.example.test/v1?token=x" }],
    ["endpoint fragment", { endpoint: "https://api.example.test/v1#fragment" }],
    ["endpoint credentials", { endpoint: "https://name:pass@api.example.test/v1" }],
    ["unsafe credential reference", { credentialRef: "ref/unsafe" }],
    ["blank model", { model: " \t" }],
    ["secret-looking model", { model: SECRET_SENTINEL }],
    ["secret-looking credential reference", { credentialRef: SECRET_SENTINEL }],
    ["unexpected secret field", { secret: SECRET_SENTINEL }],
  ] as const)("rejects a %s before persistence", async (_label, overrides) => {
    await withStateDirectory(async (stateDirectory) => {
      const { createProfileStore } = await host();
      const store = createProfileStore({ stateDirectory, randomSuffix: () => "invalid" });

      await expectHostError(
        () => store.upsert({ ...validProfile, ...overrides }),
        "PROFILE_INVALID",
      );
      expect(existsSync(join(stateDirectory, profilesFileName))).toBe(false);
    });
  });

  it("rejects a missing profile removal and unsafe lookup identifiers", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { createProfileStore } = await host();
      const store = createProfileStore({ stateDirectory, randomSuffix: () => "missing" });

      await expectHostError(() => store.remove(validProfile.id), "PROFILE_NOT_FOUND");
      await expectHostError(() => store.get("../unsafe"), "PROFILE_INVALID");
      await expectHostError(() => store.remove("../unsafe"), "PROFILE_INVALID");
    });
  });

  it("refuses to read or replace a non-regular profile path", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { createProfileStore } = await host();
      const profilePath = join(stateDirectory, profilesFileName);
      await symlink(stateDirectory, profilePath, "junction");
      const store = createProfileStore({ stateDirectory, randomSuffix: () => "nonregular" });

      await expectHostError(() => store.list(), "STATE_CORRUPT");
      await expectHostError(() => store.upsert(validProfile), "STATE_CORRUPT");
      expect((await lstat(profilePath)).isSymbolicLink()).toBe(true);
      expect(existsSync(join(stateDirectory, "profiles.json.nonregular.tmp"))).toBe(false);
    });
  });
});
