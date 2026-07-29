import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VerificationCommandSchema,
  type VerificationCommand,
} from "../../contracts/src/index.js";

const launcherResolution = vi.hoisted(() => ({
  unavailable: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();

  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const candidate = String(args[0]).replace(/\\/gu, "/");
      if (
        launcherResolution.unavailable &&
        candidate.endsWith("/node_modules/npm/bin/npm-cli.js")
      ) {
        throw new Error("simulated missing npm CLI");
      }

      return actual.realpath(...args);
    },
  };
});

import { runVerification } from "./verification.js";

const npmTestCommand: VerificationCommand = {
  id: "test",
  launcher: "node_npm_cli",
  args: ["test"],
  timeoutMs: 5_000,
  maxOutputBytes: 65_536,
};

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  launcherResolution.unavailable = false;
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

async function withPackageFixture<T>(
  source: string,
  operation: (cwd: string) => Promise<T>,
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "codesentinel-verification-"));
  temporaryDirectories.add(cwd);

  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      name: "codesentinel-verification-fixture",
      version: "1.0.0",
      private: true,
      scripts: { test: "node ./verification-script.mjs" },
    }),
    "utf8",
  );
  await writeFile(join(cwd, "verification-script.mjs"), source, "utf8");

  try {
    return await operation(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    temporaryDirectories.delete(cwd);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("runVerification", () => {
  it("runs a configured npm test through Node without an outer shell", async () => {
    await withPackageFixture('process.stdout.write("ok");', async (cwd) => {
      const result = await runVerification({ command: npmTestCommand, cwd });

      expect(result).toMatchObject({
        commandId: "test",
        status: "completed",
        exitCode: 0,
        timedOut: false,
      });
      expect(result.summary).toContain("ok");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  it("reports a normal non-zero npm-script exit as completed", async () => {
    await withPackageFixture('process.stderr.write("expected failure"); process.exit(7);', async (cwd) => {
      const result = await runVerification({ command: npmTestCommand, cwd });

      expect(result.status).toBe("completed");
      expect(result.exitCode).not.toBeNull();
      expect(result.exitCode).not.toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.summary).toContain("expected failure");
    });
  });

  it("returns a stable timeout result and settles any short-lived fixture child", async () => {
    await withPackageFixture('setTimeout(() => process.exit(0), 200);', async (cwd) => {
      const result = await runVerification({
        command: { ...npmTestCommand, timeoutMs: 20 },
        cwd,
      });

      expect(result).toMatchObject({
        commandId: "test",
        status: "timed_out",
        exitCode: null,
        timedOut: true,
        summary: "VERIFICATION_TIMEOUT",
      });
      expect(result.summary).not.toMatch(/ENOENT|spawn|[A-Z]:[\\/]/u);

      // npm may have already handed work to its script shell. This fixture always exits shortly,
      // so no test child remains after the assertion even though the runner only owns npm directly.
      await delay(300);
    });
  });

  it("kills a combined stdout and stderr flood without returning a truncated raw body", async () => {
    await withPackageFixture(
      'process.stdout.write("Bearer boundary-secret "); process.stdout.write("x".repeat(8192)); process.stderr.write("y".repeat(8192));',
      async (cwd) => {
        const result = await runVerification({
          command: { ...npmTestCommand, maxOutputBytes: 1_024 },
          cwd,
        });

        expect(result).toEqual(
          expect.objectContaining({
            commandId: "test",
            status: "output_limit",
            exitCode: null,
            timedOut: false,
            summary: "VERIFICATION_OUTPUT_LIMIT",
          }),
        );
        expect(result.summary).not.toContain("x".repeat(32));
        expect(result.summary).not.toContain("y".repeat(32));
        expect(result.summary).not.toContain("boundary-secret");
      },
    );
  });

  it("rejects missing, relative, and non-directory cwd values without filesystem details", async () => {
    await withPackageFixture('process.stdout.write("unused");', async (cwd) => {
      const fileCwd = join(cwd, "package.json");
      for (const invalidCwd of ["relative-cwd", join(cwd, "missing"), fileCwd]) {
        const result = await runVerification({ command: npmTestCommand, cwd: invalidCwd });

        expect(result).toEqual(
          expect.objectContaining({
            commandId: "test",
            status: "spawn_failed",
            exitCode: null,
            timedOut: false,
            summary: "VERIFICATION_INPUT_INVALID",
          }),
        );
        expect(result.summary).not.toContain(cwd);
      }
    });
  });

  it("strictly rejects legacy, shell-meta, and Windows-wrapper command objects at runtime", async () => {
    await withPackageFixture('process.stdout.write("must not run");', async (cwd) => {
      const invalidCommands: unknown[] = [
        {
          id: "test",
          executable: "npm",
          args: ["test"],
          timeoutMs: 1_000,
          maxOutputBytes: 1_024,
        },
        { ...npmTestCommand, executable: "npm.cmd" },
        { ...npmTestCommand, executable: "npm.bat" },
        { ...npmTestCommand, args: ["test", "&&", "publish"] },
      ];

      for (const command of invalidCommands) {
        const result = await runVerification({ command: command as VerificationCommand, cwd });

        expect(result).toMatchObject({
          commandId: "test",
          status: "spawn_failed",
          exitCode: null,
          timedOut: false,
          summary: "VERIFICATION_INPUT_INVALID",
        });
      }
    });
  });

  it("does not inherit NODE_OPTIONS or unrelated parent secrets", async () => {
    const previousNodeOptions = process.env.NODE_OPTIONS;
    const previousSecret = process.env.CODE_SENTINEL_TEST_SECRET;
    process.env.NODE_OPTIONS = "--trace-warnings";
    process.env.CODE_SENTINEL_TEST_SECRET = "parent-only-secret";

    try {
      await withPackageFixture(
        [
          'const nodeOptions = process.env.NODE_OPTIONS === undefined ? "node-options-absent" : "node-options-present";',
          'const secret = process.env.CODE_SENTINEL_TEST_SECRET === undefined ? "test-secret-absent" : "test-secret-present";',
          "process.stdout.write(`${nodeOptions};${secret}`);",
        ].join("\n"),
        async (cwd) => {
          const result = await runVerification({ command: npmTestCommand, cwd });

          expect(result.status).toBe("completed");
          expect(result.summary).toContain("node-options-absent");
          expect(result.summary).toContain("test-secret-absent");
          expect(result.summary).not.toContain("parent-only-secret");
        },
      );
    } finally {
      if (previousNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = previousNodeOptions;
      }
      if (previousSecret === undefined) {
        delete process.env.CODE_SENTINEL_TEST_SECRET;
      } else {
        process.env.CODE_SENTINEL_TEST_SECRET = previousSecret;
      }
    }
  });

  it("redacts common secret forms from completed stdout and stderr", async () => {
    await withPackageFixture(
      [
        'process.stdout.write("Bearer bearer-secret sk-live-secret password=hunter2");',
        'process.stderr.write(" token: token-secret api_key=api-secret");',
      ].join("\n"),
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        for (const secret of [
          "bearer-secret",
          "sk-live-secret",
          "hunter2",
          "token-secret",
          "api-secret",
        ]) {
          expect(result.summary).not.toContain(secret);
        }
        expect(result.summary).toContain("[REDACTED]");
      },
    );
  });

  it("removes ANSI, NUL, and C0 controls from completed output", async () => {
    await withPackageFixture(
      "process.stdout.write(Buffer.from([0x61, 0x00, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x62, 0x07, 0x63]));",
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        expect(result.summary).toContain("abc");
        expect(
          [...result.summary].some((character) => {
            const codePoint = character.codePointAt(0);
            return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
          }),
        ).toBe(false);
        expect(result.summary).not.toContain("[31m");
      },
    );
  });

  it("decodes a UTF-8 character written across output writes only after capture completes", async () => {
    await withPackageFixture(
      [
        "process.stdout.write(Buffer.from([0xe8, 0x8c]));",
        "setTimeout(() => process.stdout.write(Buffer.from([0x85])), 10);",
        "setTimeout(() => process.exit(0), 20);",
      ].join("\n"),
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        expect(result.summary).toContain("茅");
      },
    );
  });

  it("returns a stable non-text summary for invalid UTF-8 instead of decoding chunks separately", async () => {
    await withPackageFixture(
      "process.stdout.write(Buffer.from([0xff, 0xfe]));",
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result).toMatchObject({
          status: "completed",
          timedOut: false,
          summary: "VERIFICATION_NON_TEXT_OUTPUT",
        });
      },
    );
  });

  it("caps a completed summary even when captured output is within the byte limit", async () => {
    await withPackageFixture('process.stdout.write("z".repeat(6000));', async (cwd) => {
      const result = await runVerification({ command: npmTestCommand, cwd });

      expect(result.status).toBe("completed");
      expect(result.summary.length).toBeLessThanOrEqual(4_096);
    });
  });

  it("returns a stable failure when the canonical npm CLI cannot be resolved", async () => {
    launcherResolution.unavailable = true;

    try {
      await withPackageFixture('process.stdout.write("must not run");', async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result).toMatchObject({
          commandId: "test",
          status: "spawn_failed",
          exitCode: null,
          timedOut: false,
          summary: "VERIFICATION_LAUNCHER_UNAVAILABLE",
        });
        expect(result.summary).not.toMatch(/simulated|npm-cli|[A-Z]:[\\/]/u);
      });
    } finally {
      launcherResolution.unavailable = false;
    }
  });

  it("rejects Windows .cmd and .bat configurations before a launcher can be selected", () => {
    for (const executable of ["npm.cmd", "npm.bat"]) {
      expect(
        VerificationCommandSchema.safeParse({ ...npmTestCommand, executable }).success,
      ).toBe(false);
    }
  });
});
