import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SECRET_SENTINEL = "sk-profile-secret-sentinel-20260731";
const profilesFileName = "profiles.json";
const EXTERNAL_PROCESS_TIMEOUT_MS = 5_000;

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
    await rm(stateDirectory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 20,
    });
  }
}

async function expectHostError(
  operation: () => Promise<unknown>,
  code: HostErrorCode | readonly HostErrorCode[],
): Promise<void> {
  const { HostError } = await host();
  const expectedCodes = Array.isArray(code) ? code : [code];
  let captured: unknown;
  try {
    await operation();
  } catch (error) {
    captured = error;
  }

  expect(captured).toBeInstanceOf(HostError);
  const actualCode = (captured as { code: HostErrorCode }).code;
  expect(expectedCodes).toContain(actualCode);
  expect(captured).toMatchObject({ code: actualCode, message: actualCode });
  expect(captured).not.toHaveProperty("cause");
  expect(captured).not.toHaveProperty("input");
  expect(String(captured)).not.toContain(SECRET_SENTINEL);
}

type ExternalUpsert = Readonly<{
  started: Promise<void>;
  completed: Promise<Readonly<{ exitCode: number | null; output: string }>>;
  hasCompleted: () => boolean;
  terminateAndReap: () => Promise<void>;
}>;

function startExternalProcess(
  helper: string,
  arguments_: readonly string[],
): ExternalUpsert {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", helper, ...arguments_],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let resolveStarted: (() => void) | undefined;
  let rejectStarted: ((error: Error) => void) | undefined;
  let hasStarted = false;
  let hasCompleted = false;
  let output = "";
  const started = new Promise<void>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  let resolveCompleted: ((result: Readonly<{ exitCode: number | null; output: string }>) => void) | undefined;
  const completed = new Promise<Readonly<{ exitCode: number | null; output: string }>>((resolve) => {
    resolveCompleted = resolve;
  });
  const finish = (exitCode: number | null): void => {
    if (hasCompleted) {
      return;
    }
    hasCompleted = true;
    clearTimeout(timeout);
    if (!hasStarted) {
      rejectStarted?.(new Error(`External profile writer exited before starting: ${output}`));
    }
    resolveCompleted?.({ exitCode, output });
  };
  const timeout = setTimeout(() => {
    if (!hasCompleted) {
      if (!hasStarted) {
        rejectStarted?.(new Error(`External profile writer timed out before starting: ${output}`));
      }
      child.kill();
    }
  }, EXTERNAL_PROCESS_TIMEOUT_MS);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
    if (!hasStarted && output.includes("started\n")) {
      hasStarted = true;
      resolveStarted?.();
    }
  });
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
  });
  child.on("error", () => {
    finish(null);
  });
  child.on("close", (exitCode) => {
    finish(exitCode);
  });
  return Object.freeze({
    started,
    completed,
    hasCompleted: () => hasCompleted,
    terminateAndReap: async () => {
      if (!hasCompleted) {
        child.kill();
      }
      await completed;
    },
  });
}

function startExternalUpsert(
  stateDirectory: string,
  profile: object,
): ExternalUpsert {
  const helper = [
    `import { createProfileStore } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};`,
    "const [stateDirectory, profileJson] = process.argv.slice(1);",
    "process.stdout.write('started\\n');",
    "await createProfileStore({ stateDirectory, randomSuffix: () => 'external-sqlite' }).upsert(JSON.parse(profileJson));",
    "process.stdout.write('completed\\n');",
  ].join("\n");
  return startExternalProcess(helper, [stateDirectory, JSON.stringify(profile)]);
}

function startExternalLockHolder(lockDatabasePath: string): ExternalUpsert {
  const helper = [
    "import Database from 'better-sqlite3';",
    "const [lockDatabasePath] = process.argv.slice(1);",
    "const database = new Database(lockDatabasePath);",
    "database.pragma('journal_mode = DELETE');",
    "database.exec('BEGIN IMMEDIATE');",
    "process.stdout.write('started\\n');",
    "setTimeout(() => { database.exec('COMMIT'); database.close(); process.stdout.write('completed\\n'); }, 1500);",
  ].join("\n");
  return startExternalProcess(helper, [lockDatabasePath]);
}

describe("profile store", () => {
  it("treats an absent initial state directory as empty without creating it", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { createProfileStore } = await host();
      const absentStateDirectory = join(stateDirectory, "absent-state");
      const store = createProfileStore({
        stateDirectory: absentStateDirectory,
        randomSuffix: () => "absent-read-only",
      });

      expect(await store.list()).toEqual([]);
      expect(await store.get(validProfile.id)).toBeUndefined();
      expect(existsSync(absentStateDirectory)).toBe(false);
    });
  });

  it("rejects reads through a junction state directory even when its target has a valid profile", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { createProfileStore } = await host();
      const targetStateDirectory = join(stateDirectory, "target-state");
      const junctionStateDirectory = join(stateDirectory, "junction-state");
      await mkdir(targetStateDirectory);
      const writer = createProfileStore({
        stateDirectory: targetStateDirectory,
        randomSuffix: () => "junction-state-writer",
      });
      await writer.upsert(validProfile);
      await symlink(targetStateDirectory, junctionStateDirectory, "junction");
      const reader = createProfileStore({
        stateDirectory: junctionStateDirectory,
        randomSuffix: () => "junction-state-reader",
      });

      await expectHostError(() => reader.list(), "STATE_UNAVAILABLE");
      await expectHostError(() => reader.get(validProfile.id), "STATE_UNAVAILABLE");
    });
  });

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

  it("serializes concurrent upserts from separate stores sharing one state directory", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { createProfileStore } = await host();
      const first = createProfileStore({
        stateDirectory,
        randomSuffix: () => "concurrent-first",
      });
      const second = createProfileStore({
        stateDirectory,
        randomSuffix: () => "concurrent-second",
      });
      const njuProfile = {
        id: "nju-default",
        kind: "nju_se_hub" as const,
        endpoint: "https://hub.example.edu/v1/chat/completions",
        model: "course-model",
        credentialRef: "nju-default",
      };

      await Promise.all([first.upsert(validProfile), second.upsert(njuProfile)]);

      const ids = (await first.list()).map((profile) => profile.id);
      expect(ids).toHaveLength(2);
      expect(ids).toEqual(
        expect.arrayContaining([validProfile.id, njuProfile.id]),
      );
      expect(existsSync(join(stateDirectory, "profiles.lock"))).toBe(false);
    });
  });

  it("queues a second store while the first holds a controlled write boundary", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { createProfileStore } = await host();
      let enteredFirstWrite: (() => void) | undefined;
      let releaseFirstWrite: (() => void) | undefined;
      const firstEntered = new Promise<void>((resolve) => {
        enteredFirstWrite = resolve;
      });
      const firstRelease = new Promise<void>((resolve) => {
        releaseFirstWrite = resolve;
      });
      let secondReachedWriteBoundary = false;
      const first = createProfileStore({
        stateDirectory,
        randomSuffix: () => "sqlite-queue-first",
        testHooks: {
          beforeAtomicReplace: async () => {
            enteredFirstWrite?.();
            await firstRelease;
          },
        },
      });
      const second = createProfileStore({
        stateDirectory,
        randomSuffix: () => "sqlite-queue-second",
        testHooks: {
          beforeAtomicReplace: async () => {
            secondReachedWriteBoundary = true;
          },
        },
      });
      const njuProfile = {
        id: "nju-queued",
        kind: "nju_se_hub" as const,
        endpoint: "https://hub.example.edu/v1/chat/completions",
        model: "course-model",
        credentialRef: "nju-queued",
      };

      const firstWrite = first.upsert(validProfile);
      await firstEntered;
      const secondWrite = second.upsert(njuProfile);
      const secondOutcome = secondWrite.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await new Promise((resolve) => {
        setTimeout(resolve, 400);
      });
      expect(secondReachedWriteBoundary).toBe(false);
      releaseFirstWrite?.();
      await firstWrite;
      const completedSecondWrite = await secondOutcome;
      if (!completedSecondWrite.ok) {
        throw completedSecondWrite.error;
      }

      expect(secondReachedWriteBoundary).toBe(true);
      expect(await first.list()).toEqual([validProfile, njuProfile]);
      expect(existsSync(join(stateDirectory, "profiles.lock"))).toBe(false);
    });
  });

  it("serializes an external process while a local SQLite transaction is open", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { createProfileStore } = await host();
      let enteredFirstWrite: (() => void) | undefined;
      let releaseFirstWrite: (() => void) | undefined;
      const firstEntered = new Promise<void>((resolve) => {
        enteredFirstWrite = resolve;
      });
      const firstRelease = new Promise<void>((resolve) => {
        releaseFirstWrite = resolve;
      });
      const first = createProfileStore({
        stateDirectory,
        randomSuffix: () => "sqlite-process-first",
        testHooks: {
          beforeAtomicReplace: async () => {
            enteredFirstWrite?.();
            await firstRelease;
          },
        },
      });
      const njuProfile = {
        id: "nju-external",
        kind: "nju_se_hub" as const,
        endpoint: "https://hub.example.edu/v1/chat/completions",
        model: "course-model",
        credentialRef: "nju-external",
      };

      const firstWrite = first.upsert(validProfile);
      await firstEntered;
      const external = startExternalUpsert(stateDirectory, njuProfile);
      try {
        await external.started;
        await new Promise((resolve) => {
          setTimeout(resolve, 400);
        });
        expect(external.hasCompleted()).toBe(false);

        releaseFirstWrite?.();
        await firstWrite;
        const externalResult = await external.completed;
        expect(externalResult).toMatchObject({ exitCode: 0, output: "started\ncompleted\n" });
        expect(await first.list()).toEqual([validProfile, njuProfile]);
      } finally {
        releaseFirstWrite?.();
        await firstWrite.catch(() => undefined);
        await external.terminateAndReap();
      }
    });
  });

  it("fails within the SQLite busy timeout and recovers after an external transaction releases", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { createProfileStore } = await host();
      const lockDatabasePath = join(stateDirectory, ".profiles.lock.sqlite");
      const store = createProfileStore({
        stateDirectory,
        randomSuffix: () => "sqlite-busy-timeout",
      });
      await store.upsert({ ...validProfile, id: "initial-profile", credentialRef: "initial-profile" });
      const external = startExternalLockHolder(lockDatabasePath);
      try {
        await external.started;

        await expectHostError(() => store.upsert(validProfile), "STATE_UNAVAILABLE");
        expect(await store.get(validProfile.id)).toBeUndefined();

        const externalResult = await external.completed;
        expect(externalResult).toMatchObject({ exitCode: 0, output: "started\ncompleted\n" });
        await store.upsert(validProfile);
        expect(await store.get(validProfile.id)).toEqual(validProfile);
      } finally {
        await external.terminateAndReap();
      }
    });
  });

  it("ignores a legacy profiles.lock file rather than allowing it to block writes", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { createProfileStore } = await host();
      const legacyLockPath = join(stateDirectory, "profiles.lock");
      await writeFile(legacyLockPath, "legacy lock is not coordination state", "utf8");
      const store = createProfileStore({
        stateDirectory,
        randomSuffix: () => "sqlite-ignores-legacy",
      });

      await store.upsert(validProfile);

      expect(await store.get(validProfile.id)).toEqual(validProfile);
      expect(await readFile(legacyLockPath, "utf8")).toBe(
        "legacy lock is not coordination state",
      );
    });
  });

  it("fails closed when the SQLite lock database path is a symlink", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { createProfileStore } = await host();
      const lockDatabasePath = join(stateDirectory, ".profiles.lock.sqlite");
      const outsidePath = join(stateDirectory, "outside-lock-directory");
      await mkdir(outsidePath);
      await symlink(outsidePath, lockDatabasePath, "junction");
      const store = createProfileStore({
        stateDirectory,
        randomSuffix: () => "sqlite-lock-symlink",
      });

      await expectHostError(() => store.upsert(validProfile), "STATE_UNAVAILABLE");
      expect(existsSync(join(stateDirectory, profilesFileName))).toBe(false);
      expect(existsSync(outsidePath)).toBe(true);
    });
  });

  it("fails closed when the SQLite lock database path is nonregular", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { createProfileStore } = await host();
      const lockDatabasePath = join(stateDirectory, ".profiles.lock.sqlite");
      await mkdir(lockDatabasePath);
      const store = createProfileStore({
        stateDirectory,
        randomSuffix: () => "sqlite-lock-directory",
      });

      await expectHostError(() => store.upsert(validProfile), "STATE_UNAVAILABLE");
      expect(existsSync(join(stateDirectory, profilesFileName))).toBe(false);
    });
  });

  it("rolls back and closes the SQLite transaction when atomic publication fails", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { createProfileStore } = await host();
      const failingStore = createProfileStore({
        stateDirectory,
        randomSuffix: () => "sqlite-rollback-failure",
        testHooks: {
          beforeAtomicReplace: async () => {
            throw new Error("simulated atomic publication failure");
          },
        },
      });
      const recoveringStore = createProfileStore({
        stateDirectory,
        randomSuffix: () => "sqlite-rollback-recovery",
      });

      await expectHostError(() => failingStore.upsert(validProfile), "STATE_UNAVAILABLE");
      await recoveringStore.upsert(validProfile);

      expect(await recoveringStore.get(validProfile.id)).toEqual(validProfile);
    });
  });

  it("fails closed when a checked profile file is replaced with a symlink before reading", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { createProfileStore } = await host();
      const profilePath = join(stateDirectory, profilesFileName);
      const outsidePath = join(stateDirectory, "outside-profile.json");
      const initialStore = createProfileStore({
        stateDirectory,
        randomSuffix: () => "safe-read-initial",
      });
      await initialStore.upsert(validProfile);
      await writeFile(outsidePath, "x".repeat(65_537), "utf8");
      let hookRan = false;
      const racingStore = createProfileStore({
        stateDirectory,
        randomSuffix: () => "safe-read-race",
        testHooks: {
          afterProfileFilePrecheck: async () => {
            hookRan = true;
            await rm(profilePath);
            await symlink(outsidePath, profilePath, "file");
          },
        },
      });

      await expectHostError(() => racingStore.list(), [
        "STATE_CORRUPT",
        "STATE_UNAVAILABLE",
      ]);
      expect(hookRan).toBe(true);
      expect(await readFile(outsidePath, "utf8")).toHaveLength(65_537);
    });
  });

  it("returns a complete snapshot when a cooperative writer atomically replaces profiles after precheck", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { createProfileStore } = await host();
      const profilePath = join(stateDirectory, profilesFileName);
      const replacementPath = join(stateDirectory, "profiles.replacement.json");
      const replacementProfile = {
        id: "nju-replacement",
        kind: "nju_se_hub" as const,
        endpoint: "https://hub.example.edu/v1/chat/completions",
        model: "course-model",
        credentialRef: "nju-replacement",
      };
      const initialStore = createProfileStore({
        stateDirectory,
        randomSuffix: () => "reader-replacement-initial",
      });
      await initialStore.upsert(validProfile);
      await writeFile(
        replacementPath,
        JSON.stringify({ version: 1, profiles: [replacementProfile] }),
        "utf8",
      );
      let swapped = false;
      const reader = createProfileStore({
        stateDirectory,
        randomSuffix: () => "reader-replacement",
        testHooks: {
          afterProfileFilePrecheck: async () => {
            if (!swapped) {
              swapped = true;
              await rename(replacementPath, profilePath);
            }
          },
        },
      });

      const profiles = await reader.list();

      expect(swapped).toBe(true);
      expect(profiles).toEqual([replacementProfile]);
      expect(await reader.get(replacementProfile.id)).toEqual(replacementProfile);
    });
  });

  it("does not overwrite a profile file corrupted after mutation validation", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { createProfileStore } = await host();
      const profilePath = join(stateDirectory, profilesFileName);
      const initialStore = createProfileStore({
        stateDirectory,
        randomSuffix: () => "replace-race-initial",
      });
      await initialStore.upsert(validProfile);
      let hookRan = false;
      const racingStore = createProfileStore({
        stateDirectory,
        randomSuffix: () => "replace-race",
        testHooks: {
          beforeAtomicReplace: async () => {
            hookRan = true;
            await writeFile(profilePath, "{corrupted-after-validation", "utf8");
          },
        },
      });

      await expectHostError(
        () => racingStore.upsert({ ...validProfile, model: "replacement-model" }),
        "STATE_CORRUPT",
      );
      expect(hookRan).toBe(true);
      expect(await readFile(profilePath, "utf8")).toBe("{corrupted-after-validation");
      expect(existsSync(join(stateDirectory, "profiles.json.replace-race.tmp"))).toBe(false);
    });
  });

  it("does not delete a pre-existing temporary-path collision it did not create", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { createProfileStore } = await host();
      const collisionPath = join(stateDirectory, "profiles.json.collision.tmp");
      await writeFile(collisionPath, "not-owned-by-store", "utf8");
      const store = createProfileStore({
        stateDirectory,
        randomSuffix: () => "collision",
      });

      await expectHostError(() => store.upsert(validProfile), "STATE_UNAVAILABLE");
      expect(await readFile(collisionPath, "utf8")).toBe("not-owned-by-store");
      expect(existsSync(join(stateDirectory, profilesFileName))).toBe(false);
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
