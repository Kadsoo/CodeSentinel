import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import {
  VerificationCommandSchema,
  type VerificationCommand,
} from "../../contracts/src/index.js";

const launcherResolution = vi.hoisted(() => ({
  unavailable: false,
}));

const spawnHarness = vi.hoisted(() => ({
  calls: [] as Array<Readonly<{ command: unknown; args: unknown; options: unknown }>>,
  nextChild: undefined as unknown,
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

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const observedSpawn = ((...args: unknown[]) => {
    spawnHarness.calls.push({
      command: args[0],
      args: args[1],
      options: args[2],
    });

    if (spawnHarness.nextChild !== undefined) {
      const child = spawnHarness.nextChild;
      spawnHarness.nextChild = undefined;
      return child;
    }

    return Reflect.apply(actual.spawn, undefined, args);
  }) as typeof actual.spawn;

  return { ...actual, spawn: observedSpawn };
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
  spawnHarness.calls.length = 0;
  spawnHarness.nextChild = undefined;
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

type FakeChild = EventEmitter & {
  stderr: PassThrough;
  stdout: PassThrough;
  killed: boolean;
  killCalls: Array<NodeJS.Signals | number | undefined>;
  kill: (signal?: NodeJS.Signals | number) => boolean;
};

function createFakeChild({ markKilled = true }: { markKilled?: boolean } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    if (markKilled) {
      child.killed = true;
    }
    return true;
  };
  return child;
}

async function waitForSpawnCount(expectedCount: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (spawnHarness.calls.length < expectedCount) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the runner to invoke spawn.");
    }
    await delay(1);
  }
}

function emitStreamError(stream: PassThrough, message: string): boolean {
  try {
    stream.emit("error", new Error(message));
    return false;
  } catch {
    return true;
  }
}

async function resolveWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for stubborn child cleanup."));
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
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

  it("applies the output limit jointly to stdout and stderr", async () => {
    await withPackageFixture(
      'process.stdout.write("o".repeat(600)); process.stderr.write("e".repeat(600));',
      async (cwd) => {
        const result = await runVerification({
          command: { ...npmTestCommand, maxOutputBytes: 1_024 },
          cwd,
        });

        expect(result).toMatchObject({
          status: "output_limit",
          exitCode: null,
          timedOut: false,
          summary: "VERIFICATION_OUTPUT_LIMIT",
        });
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

  it("rejects C1-bearing command ids before spawning and never reports them", async () => {
    await withPackageFixture('process.stdout.write("must not run");', async (cwd) => {
      const c1CommandId = `test${String.fromCharCode(0x9b)}31m`;
      const result = await runVerification({
        command: { ...npmTestCommand, id: c1CommandId },
        cwd,
      });

      expect(result).toMatchObject({
        commandId: "unknown",
        status: "spawn_failed",
        exitCode: null,
        timedOut: false,
        summary: "VERIFICATION_INPUT_INVALID",
      });
      expect(result.commandId).not.toContain(c1CommandId);
      expect(spawnHarness.calls).toHaveLength(0);
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

  it("uses exactly canonical Node/npm arguments, fixed no-shell options, and a stripped environment", async () => {
    const inheritedNames = [
      "NODE_OPTIONS",
      "npm_config_registry",
      "HTTPS_PROXY",
      "CODE_SENTINEL_TEST_TOKEN",
      "API_KEY",
    ] as const;
    const inheritedValues = new Map(inheritedNames.map((name) => [name, process.env[name]]));
    const originalPath = process.env.PATH;
    process.env.PATH = "untrusted-parent-path";
    for (const name of inheritedNames) {
      process.env[name] = `parent-${name}`;
    }

    try {
      await withPackageFixture('process.stdout.write("observed");', async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });
        const [call] = spawnHarness.calls;
        const canonicalNode = await realpath(process.execPath);
        const canonicalNpmCli = await realpath(
          join(dirname(canonicalNode), "node_modules", "npm", "bin", "npm-cli.js"),
        );
        const options = call?.options as
          | {
              cwd?: unknown;
              detached?: unknown;
              env?: NodeJS.ProcessEnv;
              shell?: unknown;
              stdio?: unknown;
              windowsHide?: unknown;
              windowsVerbatimArguments?: unknown;
            }
          | undefined;
        const environment = options?.env;

        expect(result.status).toBe("completed");
        expect(spawnHarness.calls).toHaveLength(1);
        expect(call?.command).toBe(canonicalNode);
        expect(call?.args).toEqual([canonicalNpmCli, "test"]);
        expect(options).toMatchObject({
          cwd: await realpath(cwd),
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: false,
          detached: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        expect(environment?.PATH).toBe(dirname(canonicalNode));
        expect(environment?.PATH).not.toBe("untrusted-parent-path");
        expect(environment).not.toHaveProperty("Path");
        for (const name of inheritedNames) {
          expect(environment).not.toHaveProperty(name);
        }
        expect(
          Object.keys(environment ?? {}).every((name) =>
            ["PATH", "SystemRoot", "ComSpec", "TEMP", "TMP"].includes(name),
          ),
        ).toBe(true);
      });
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      for (const name of inheritedNames) {
        const value = inheritedValues.get(name);
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
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

  it("normalizes C0, DEL, and C1 controls before redacting split and camel-case secret keys", async () => {
    await withPackageFixture(
      [
        "const nul = String.fromCharCode(0);",
        "const lineFeed = String.fromCharCode(10);",
        "const escape = String.fromCharCode(27);",
        "const del = String.fromCharCode(0x7f);",
        "const c1Control = String.fromCharCode(0x91);",
        "const c1Osc = String.fromCharCode(0x9d);",
        "const bell = String.fromCharCode(7);",
        'process.stdout.write([`pass${nul}word=alpha-nul-leak`, `api_key${nul}=bravo-nul-leak`, `secret${lineFeed}Key=charlie-newline-leak`, `db${escape}[31mPassword=delta-ansi-leak`, `api${c1Control}Key=echo-c1-leak`, `access${del}Token=foxtrot-del-token-leak`, `authToken=golf-auth-token-leak`, `clientSecret=hotel-client-secret-leak`, `password=india${lineFeed}value-tail-leak`, `p${nul}a${nul}ss${nul}word=juliet-fragment-leak`, `apiK${nul}ey=kilo-fragment-leak`, `Be${nul}arer lima-bearer-fragment-leak`, `sk-${nul}mike-openai-fragment-leak`, `${c1Osc}window-title${bell}plain`, "ordinary-output-tail"].join("|"));',
      ].join("\n"),
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        for (const secret of [
          "alpha-nul-leak",
          "bravo-nul-leak",
          "charlie-newline-leak",
          "delta-ansi-leak",
          "echo-c1-leak",
          "foxtrot-del-token-leak",
          "golf-auth-token-leak",
          "hotel-client-secret-leak",
          "indiavalue-tail-leak",
          "value-tail-leak",
          "juliet-fragment-leak",
          "kilo-fragment-leak",
          "lima-bearer-fragment-leak",
          "mike-openai-fragment-leak",
        ]) {
          expect(result.summary).not.toContain(secret);
        }
        expect(result.summary).toContain("ordinary-output-tail");
        expect(result.summary).not.toContain("\u2063");
        expect(
          [...result.summary].some((character) => {
            const codePoint = character.codePointAt(0);
            return (
              codePoint !== undefined &&
              (codePoint <= 31 || codePoint === 127 || (codePoint >= 128 && codePoint <= 159))
            );
          }),
        ).toBe(false);
      },
    );
  });

  it("removes complete C1 CSI and OSC sequences before redacting mixed control separators", async () => {
    await withPackageFixture(
      [
        "const nul = String.fromCharCode(0);",
        "const lineFeed = String.fromCharCode(10);",
        "const escape = String.fromCharCode(27);",
        "const bell = String.fromCharCode(7);",
        "const c1Csi = String.fromCharCode(0x9b);",
        "const c1Osc = String.fromCharCode(0x9d);",
        "const c1St = String.fromCharCode(0x9c);",
        "const slash = String.fromCharCode(92);",
        'process.stdout.write([`password${c1Csi}31m=alpha-c1-csi-leak`, `db${c1Csi}31mPassword=bravo-c1-camel-leak`, `${c1Osc}window-title${bell}clientSecret=charlie-c1-osc-leak`, `${c1Osc}escape-title${escape}${slash}serviceToken=hotel-c1-osc-escape-leak`, `${c1Osc}st-title${c1St}sessionToken=india-c1-osc-st-leak`, `password ${nul}=delta-space-control-leak`, `password=${lineFeed} ${nul}echo-mixed-control-leak`, `apiKey${escape}[31m ${nul}=foxtrot-escape-control-leak`, `token${c1Csi}1m ${lineFeed}${nul}: golf-c1-mixed-control-leak`, "ordinary-output-tail"].join("|"));',
      ].join("\n"),
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        for (const secret of [
          "alpha-c1-csi-leak",
          "bravo-c1-camel-leak",
          "charlie-c1-osc-leak",
          "hotel-c1-osc-escape-leak",
          "india-c1-osc-st-leak",
          "delta-space-control-leak",
          "echo-mixed-control-leak",
          "foxtrot-escape-control-leak",
          "golf-c1-mixed-control-leak",
        ]) {
          expect(result.summary).not.toContain(secret);
        }
        expect(result.summary).toContain("ordinary-output-tail");
        expect(result.summary).not.toContain("31m");
        for (const oscPayload of ["window-title", "escape-title", "st-title"]) {
          expect(result.summary).not.toContain(oscPayload);
        }
        expect(
          [...result.summary].some((character) => {
            const codePoint = character.codePointAt(0);
            return codePoint !== undefined && codePoint >= 128 && codePoint <= 159;
          }),
        ).toBe(false);
      },
    );
  });

  it("redacts a secret whose key contains a bare C1 CSI final before removing that CSI", async () => {
    await withPackageFixture(
      [
        "const c1Csi = String.fromCharCode(0x9b);",
        'process.stdout.write(`api${c1Csi}Key=bare-c1-csi-secret-leak|ordinary-output-tail`);',
      ].join("\n"),
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        expect(result.summary).not.toContain("bare-c1-csi-secret-leak");
        expect(result.summary).toContain("ordinary-output-tail");
        expect(result.summary).not.toContain("\u009b");
      },
    );
  });

  it("treats a C1 OSC ESC-backslash terminator atomically", async () => {
    await withPackageFixture(
      [
        "const c1Osc = String.fromCharCode(0x9d);",
        "const escape = String.fromCharCode(27);",
        "const slash = String.fromCharCode(92);",
        'process.stdout.write(`${c1Osc}escape-title${escape}${slash}serviceToken=synthetic-osc-secret|ordinary-output-tail`);',
      ].join("\n"),
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        expect(result.summary).not.toContain("escape-title");
        expect(result.summary).not.toContain("synthetic-osc-secret");
        expect(result.summary).toContain("ordinary-output-tail");
        expect(
          [...result.summary].some((character) => {
            const codePoint = character.codePointAt(0);
            return (
              codePoint !== undefined &&
              (codePoint <= 31 || codePoint === 127 || (codePoint >= 128 && codePoint <= 159))
            );
          }),
        ).toBe(false);
      },
    );
  });

  it("pre-redacts a 7-bit CSI final embedded in a secret key", async () => {
    await withPackageFixture(
      [
        "const escape = String.fromCharCode(27);",
        'process.stdout.write(`api${escape}[Key=synthetic-7bit-csi-secret|ordinary-output-tail`);',
      ].join("\n"),
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        expect(result.summary).not.toContain("synthetic-7bit-csi-secret");
        expect(result.summary).toContain("ordinary-output-tail");
        expect(result.summary).not.toContain("\u001b");
      },
    );
  });

  it("pre-redacts a C1 CSI final with a mixed control separator", async () => {
    await withPackageFixture(
      [
        "const c1Csi = String.fromCharCode(0x9b);",
        "const nul = String.fromCharCode(0);",
        'process.stdout.write(`api${c1Csi}Key${nul}=synthetic-c1-csi-gap-secret|ordinary-output-tail`);',
      ].join("\n"),
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        expect(result.summary).not.toContain("synthetic-c1-csi-gap-secret");
        expect(result.summary).toContain("ordinary-output-tail");
        expect(result.summary).not.toContain("\u009b");
      },
    );
  });

  it(
    "processes a near-budget control run without a verification-test timeout",
    async () => {
      await withPackageFixture(
        [
          "const nul = String.fromCharCode(0);",
          'process.stdout.write(`api${nul.repeat(60 * 1024)}not-a-secret|ordinary-output-tail`);',
        ].join("\n"),
        async (cwd) => {
          const result = await runVerification({ command: npmTestCommand, cwd });

          expect(result.status).toBe("completed");
          expect(result.summary).toContain("ordinary-output-tail");
        },
      );
    },
    2_000,
  );

  it("pre-redacts an ESC c final that completes a secret key", async () => {
    await withPackageFixture(
      [
        "const escape = String.fromCharCode(27);",
        'process.stdout.write(`pass${escape}cword=top-secret|ordinary-output-tail`);',
      ].join("\n"),
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        expect(result.summary).not.toContain("top-secret");
        expect(result.summary).toContain("ordinary-output-tail");
        expect(result.summary).not.toContain("\u001b");
      },
    );
  });

  it("consumes complete ESC intermediate and final sequences", async () => {
    await withPackageFixture(
      [
        "const escape = String.fromCharCode(27);",
        'process.stdout.write(`prefix${escape}7${escape}8${escape}(0ordinary-output-tail`);',
      ].join("\n"),
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        expect(result.summary).toContain("prefixordinary-output-tail");
        expect(result.summary).not.toContain("\u001b");
      },
    );
  });

  it("fails closed for an unterminated nested 7-bit CSI", async () => {
    await withPackageFixture(
      [
        "const escape = String.fromCharCode(27);",
        'process.stdout.write(`pass${escape}[${escape}[word=top-secret`);',
      ].join("\n"),
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        expect(result.summary).toContain("pass");
        expect(result.summary).not.toContain("top-secret");
        expect(result.summary).not.toContain("word=");
        expect(result.summary).not.toContain("\u001b");
      },
    );
  });

  it("fails closed for an unterminated nested C1 CSI", async () => {
    await withPackageFixture(
      [
        "const c1Csi = String.fromCharCode(0x9b);",
        'process.stdout.write(`pass${c1Csi}${c1Csi}word=top-secret|untrusted-tail`);',
      ].join("\n"),
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        expect(result.summary).toContain("pass");
        expect(result.summary).not.toContain("top-secret");
        expect(result.summary).not.toContain("word=");
        expect(result.summary).not.toContain("untrusted-tail");
        expect(
          [...result.summary].some((character) => {
            const codePoint = character.codePointAt(0);
            return codePoint !== undefined && codePoint >= 128 && codePoint <= 159;
          }),
        ).toBe(false);
      },
    );
  });

  it("fails closed for an unknown ESC control sequence", async () => {
    await withPackageFixture(
      [
        "const escape = String.fromCharCode(27);",
        "const nul = String.fromCharCode(0);",
        'process.stdout.write(`pass${escape}${nul}unknown-control-payload|untrusted-tail`);',
      ].join("\n"),
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        expect(result.summary).toContain("pass");
        expect(result.summary).not.toContain("unknown-control-payload");
        expect(result.summary).not.toContain("untrusted-tail");
        expect(result.summary).not.toContain("\u001b");
      },
    );
  });

  it.each([
    ["OSC", 0x5d],
    ["DCS", 0x50],
    ["SOS", 0x58],
    ["PM", 0x5e],
    ["APC", 0x5f],
  ] as const)("consumes a complete 7-bit %s string atomically", async (name, introducer) => {
    const payload = `seven-bit-${name.toLowerCase()}-payload`;
    const secret = `seven-bit-${name.toLowerCase()}-secret`;
    await withPackageFixture(
      [
        `process.stdout.write(String.fromCharCode(27, ${introducer}) + "${payload}" + String.fromCharCode(27, 92) + "serviceToken=${secret}|ordinary-output-tail");`,
      ].join("\n"),
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        expect(result.summary).not.toContain(payload);
        expect(result.summary).not.toContain(secret);
        expect(result.summary).toContain("ordinary-output-tail");
        expect(result.summary).not.toContain("\u001b");
      },
    );
  });

  it.each([
    ["OSC", 0x9d],
    ["DCS", 0x90],
    ["SOS", 0x98],
    ["PM", 0x9e],
    ["APC", 0x9f],
  ] as const)("consumes a complete C1 %s string atomically", async (name, introducer) => {
    const payload = `c1-${name.toLowerCase()}-payload`;
    const secret = `c1-${name.toLowerCase()}-secret`;
    await withPackageFixture(
      [
        `process.stdout.write(String.fromCharCode(${introducer}) + "${payload}" + String.fromCharCode(27, 92) + "serviceToken=${secret}|ordinary-output-tail");`,
      ].join("\n"),
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        expect(result.summary).not.toContain(payload);
        expect(result.summary).not.toContain(secret);
        expect(result.summary).toContain("ordinary-output-tail");
        expect(
          [...result.summary].some((character) => {
            const codePoint = character.codePointAt(0);
            return codePoint !== undefined && codePoint >= 128 && codePoint <= 159;
          }),
        ).toBe(false);
      },
    );
  });

  it("redacts a JSON quoted secret key", async () => {
    await withPackageFixture(
      "process.stdout.write('{\"password\":\"json-secret\"}|ordinary-output-tail');",
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        expect(result.summary).not.toContain("json-secret");
        expect(result.summary).toContain("ordinary-output-tail");
      },
    );
  });

  it("redacts a quoted value through escaped quotes", async () => {
    await withPackageFixture(
      [
        "const quote = String.fromCharCode(34);",
        "const slash = String.fromCharCode(92);",
        'process.stdout.write(`password=${quote}first${slash}${quote}second${quote}|ordinary-output-tail`);',
      ].join("\n"),
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        expect(result.summary).not.toContain("first");
        expect(result.summary).not.toContain("second");
        expect(result.summary).toContain("ordinary-output-tail");
      },
    );
  });

  it("redacts generic underscore-delimited environment secret names", async () => {
    await withPackageFixture(
      'process.stdout.write("MY_PASSWORD=underscore-secret|USER_TOKEN=user-token-secret|monkey=ordinary-monkey-value|ordinary-output-tail");',
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        expect(result.summary).not.toContain("underscore-secret");
        expect(result.summary).not.toContain("user-token-secret");
        expect(result.summary).toContain("ordinary-monkey-value");
        expect(result.summary).toContain("ordinary-output-tail");
      },
    );
  });

  it(
    "redacts near-budget repeated environment secret assignments without timing out",
    async () => {
      await withPackageFixture(
        'process.stdout.write("USER_TOKEN=top-secret|".repeat(2600) + "ordinary-output-tail");',
        async (cwd) => {
          const result = await runVerification({ command: npmTestCommand, cwd });

          expect(result.status).toBe("completed");
          expect(result.summary).not.toContain("top-secret");
          expect(result.summary).toContain("[REDACTED]");
        },
      );
    },
    2_000,
  );

  it.each([
    ["7-bit CSI", 'String.fromCharCode(27) + "[1234;5678m"', "1234;5678m"],
    [
      "7-bit OSC",
      'String.fromCharCode(27) + "]seven-bit-osc-boundary-payload" + String.fromCharCode(7)',
      "seven-bit-osc-boundary-payload",
    ],
    [
      "7-bit DCS",
      'String.fromCharCode(27, 80) + "seven-bit-dcs-boundary-payload" + String.fromCharCode(27, 92)',
      "seven-bit-dcs-boundary-payload",
    ],
    [
      "7-bit SOS",
      'String.fromCharCode(27, 88) + "seven-bit-sos-boundary-payload" + String.fromCharCode(27, 92)',
      "seven-bit-sos-boundary-payload",
    ],
    [
      "7-bit PM",
      'String.fromCharCode(27, 94) + "seven-bit-pm-boundary-payload" + String.fromCharCode(27, 92)',
      "seven-bit-pm-boundary-payload",
    ],
    [
      "7-bit APC",
      'String.fromCharCode(27, 95) + "seven-bit-apc-boundary-payload" + String.fromCharCode(27, 92)',
      "seven-bit-apc-boundary-payload",
    ],
    ["C1 CSI", 'String.fromCharCode(0x9b) + "1234;5678m"', "1234;5678m"],
    [
      "C1 OSC",
      'String.fromCharCode(0x9d) + "c1-osc-boundary-payload" + String.fromCharCode(27, 92)',
      "c1-osc-boundary-payload",
    ],
    [
      "C1 DCS",
      'String.fromCharCode(0x90) + "c1-dcs-boundary-payload" + String.fromCharCode(27, 92)',
      "c1-dcs-boundary-payload",
    ],
    [
      "C1 SOS",
      'String.fromCharCode(0x98) + "c1-sos-boundary-payload" + String.fromCharCode(27, 92)',
      "c1-sos-boundary-payload",
    ],
    [
      "C1 PM",
      'String.fromCharCode(0x9e) + "c1-pm-boundary-payload" + String.fromCharCode(27, 92)',
      "c1-pm-boundary-payload",
    ],
    [
      "C1 APC",
      'String.fromCharCode(0x9f) + "c1-apc-boundary-payload" + String.fromCharCode(27, 92)',
      "c1-apc-boundary-payload",
    ],
    ["ESC 7", "String.fromCharCode(27, 55)", "7"],
  ] as const)(
    "keeps a sensitive-name boundary after a complete %s sequence",
    async (name, sequenceExpression, payload) => {
      const secret = `boundary-${name.toLowerCase().replaceAll(" ", "-")}-secret`;
      await withPackageFixture(
        [
          `process.stdout.write("prefix" + ${sequenceExpression} + "password=${secret}|ordinary-output-tail");`,
        ].join("\n"),
        async (cwd) => {
          const result = await runVerification({ command: npmTestCommand, cwd });

          expect(result.status).toBe("completed");
          expect(result.summary).not.toContain(secret);
          expect(result.summary).not.toContain(payload);
          expect(result.summary).toContain("ordinary-output-tail");
          expect(result.summary).not.toContain("\u001b");
          expect(
            [...result.summary].some((character) => {
              const codePoint = character.codePointAt(0);
              return codePoint !== undefined && codePoint >= 128 && codePoint <= 159;
            }),
          ).toBe(false);
        },
      );
    },
  );

  it("redacts compound and escaped JSON secret keys without masking ordinary JSON keys", async () => {
    await withPackageFixture(
      'process.stdout.write(String.raw`{"MY_PASSWORD":"json-suffix-secret"}|{"USER_TOKEN":"json-token-secret"}|{"pass\\u0077ord":"escaped-key-secret"}|{"monkey":"json-ordinary-value"}|ordinary-output-tail`);',
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        for (const secret of ["json-suffix-secret", "json-token-secret", "escaped-key-secret"]) {
          expect(result.summary).not.toContain(secret);
        }
        expect(result.summary).toContain("json-ordinary-value");
        expect(result.summary).toContain("ordinary-output-tail");
      },
    );
  });

  it("normalizes Unicode format gaps before secret and bearer redaction", async () => {
    await withPackageFixture(
      [
        "const zeroWidthSpace = String.fromCharCode(0x200b);",
        "const wordJoiner = String.fromCharCode(0x2060);",
        'process.stdout.write([`pass${zeroWidthSpace}word=unicode-zwsp-secret`, `api${wordJoiner}Key=unicode-word-joiner-secret`, `Bearer${zeroWidthSpace}unicode-bearer-secret`, "ordinary-output-tail"].join("|"));',
      ].join("\n"),
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        for (const secret of [
          "unicode-zwsp-secret",
          "unicode-word-joiner-secret",
          "unicode-bearer-secret",
        ]) {
          expect(result.summary).not.toContain(secret);
        }
        expect(result.summary).toContain("ordinary-output-tail");
        expect(result.summary).not.toContain("\u200b");
        expect(result.summary).not.toContain("\u2060");
      },
    );
  });

  it.each([
    ["U+0890", 0x0890],
    ["U+0891", 0x0891],
    ["U+08E2", 0x08e2],
    ["zero-width space", 0x200b],
    ["word joiner", 0x2060],
    ["language tag", 0xe0001],
  ] as const)(
    "normalizes the %s Unicode format gap before masking the next nonempty field segment",
    async (_name, codePoint) => {
      const splitKeySecret = `format-gap-${codePoint.toString(16)}-split-key-secret`;
      const fallbackSecret = `format-gap-${codePoint.toString(16)}-fallback-secret`;
      await withPackageFixture(
        [
          `const formatCharacter = String.fromCodePoint(${codePoint});`,
          `process.stdout.write(\`pass\${formatCharacter}word=${splitKeySecret}|password=\${formatCharacter}|${fallbackSecret}|tail\`);`,
        ].join("\n"),
        async (cwd) => {
          const result = await runVerification({ command: npmTestCommand, cwd });

          expect(result.status).toBe("completed");
          expect(result.summary).not.toContain(splitKeySecret);
          expect(result.summary).not.toContain(fallbackSecret);
          expect(result.summary).toContain("tail");
          expect(result.summary).not.toContain(String.fromCodePoint(codePoint));
          expect(result.summary).not.toContain("\u2063");
        },
      );
    },
  );

  it("normalizes decoded and raw JSON secret-key gaps before recognizing complete sensitive names", async () => {
    await withPackageFixture(
      [
        "const zeroWidthSpace = String.fromCharCode(0x200b);",
        "const wordJoiner = String.fromCharCode(0x2060);",
        "process.stdout.write([",
        '  String.raw`{"pass\\u200bword":"escaped-zwsp-key-leak"}`,',
        '  String.raw`{"pass\\u0000word":"escaped-nul-key-leak"}`,',
        '  String.raw`{"pass\\u001b[31mword":"escaped-ansi-key-leak"}`,',
        '  `{"MY_${zeroWidthSpace}PASSWORD":"raw-compound-key-leak"}`,',
        '  `{"USER_TO${wordJoiner}KEN":"raw-user-token-key-leak"}`,',
        '  String.raw`{"MY_\\u200bPASSWORD":"escaped-compound-key-leak"}`,',
        '  String.raw`{"USER_TO\\u2060KEN":"escaped-user-token-key-leak"}`,',
        '  `{"monkey":"json-ordinary-value"}`,',
        '  "tail",',
        '].join("|"));',
      ].join("\n"),
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        for (const secret of [
          "escaped-zwsp-key-leak",
          "escaped-nul-key-leak",
          "escaped-ansi-key-leak",
          "raw-compound-key-leak",
          "raw-user-token-key-leak",
          "escaped-compound-key-leak",
          "escaped-user-token-key-leak",
        ]) {
          expect(result.summary).not.toContain(secret);
        }
        expect(result.summary).toContain("json-ordinary-value");
        expect(result.summary).toContain("tail");
      },
    );
  });

  it("recognizes complete JSON sensitive names with leading or trailing decoded normalization gaps", async () => {
    await withPackageFixture(
      [
        "const marker = String.fromCharCode(0x2063);",
        "process.stdout.write([",
        '  String.raw`{"\\u200bpassword":"escaped-leading-cf-key-leak"}`,',
        '  String.raw`{"password\\u200b":"escaped-trailing-cf-key-leak"}`,',
        '  String.raw`{"\\u0000password":"escaped-leading-c0-key-leak"}`,',
        '  String.raw`{"password\\u001b[31m":"escaped-trailing-terminal-key-leak"}`,',
        '  `{"${marker}password":"raw-leading-marker-key-leak"}`,',
        '  String.raw`{"password\\u2063":"escaped-trailing-marker-key-leak"}`,',
        '  "tail",',
        '].join("|"));',
      ].join("\n"),
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        for (const secret of [
          "escaped-leading-cf-key-leak",
          "escaped-trailing-cf-key-leak",
          "escaped-leading-c0-key-leak",
          "escaped-trailing-terminal-key-leak",
          "raw-leading-marker-key-leak",
          "escaped-trailing-marker-key-leak",
        ]) {
          expect(result.summary).not.toContain(secret);
        }
        expect(result.summary).toContain("tail");
      },
    );
  });

  it("treats an input U+2063 marker as a removable format gap without letting it bypass redaction", async () => {
    await withPackageFixture(
      [
        "const marker = String.fromCharCode(0x2063);",
        'process.stdout.write(`monkey${marker}password=marker-boundary-secret|ordinary-output-tail`);',
      ].join("\n"),
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        expect(result.summary).not.toContain("marker-boundary-secret");
        expect(result.summary).toContain("ordinary-output-tail");
        expect(result.summary).not.toContain("\u2063");
      },
    );
  });

  it(
    "handles an alternating quote-and-escape tail with a single linear JSON-string scan",
    async () => {
      await withPackageFixture(
        "process.stdout.write(String.fromCharCode(34, 92).repeat(30_000));",
        async (cwd) => {
          const result = await runVerification({ command: npmTestCommand, cwd });

          expect(result).toMatchObject({
            status: "completed",
            timedOut: false,
            summary: "VERIFICATION_OUTPUT_REDACTED",
          });
        },
      );
    },
    2_000,
  );

  it("does not join a stderr bare fragment to a stdout dangling sensitive assignment", async () => {
    await withPackageFixture(
      [
        'process.stderr.write("cross-stream-secret");',
        'setTimeout(() => process.stdout.write("password="), 15);',
      ].join("\n"),
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result).toMatchObject({
          status: "completed",
          timedOut: false,
          summary: "VERIFICATION_OUTPUT_REDACTED",
        });
        expect(result.summary).not.toContain("cross-stream-secret");
      },
    );
  });

  it("keeps immediate stderr and stdout writes from forming a synthetic secret assignment", async () => {
    await withPackageFixture(
      [
        'process.stderr.write("immediate-cross-stream-secret");',
        'process.stdout.write("password=");',
      ].join("\n"),
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result).toMatchObject({
          status: "completed",
          timedOut: false,
          summary: "VERIFICATION_OUTPUT_REDACTED",
        });
        expect(result.summary).not.toContain("immediate-cross-stream-secret");
      },
    );
  });

  it("keeps independent ordinary stdout and stderr output without using a conservative summary", async () => {
    await withPackageFixture(
      'process.stderr.write("ordinary-stderr-output"); process.stdout.write("ordinary-stdout-output");',
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        expect(result.summary).toContain("ordinary-stdout-output");
        expect(result.summary).toContain("ordinary-stderr-output");
        expect(result.summary).not.toBe("VERIFICATION_OUTPUT_REDACTED");
      },
    );
  });

  it("redacts the first nonempty segment after empty secret assignments across streams", async () => {
    await withPackageFixture(
      [
        'process.stdout.write("password=|operator-secret|pipe-tail\\n");',
        'process.stderr.write("password=;semicolon-secret;semicolon-tail\\n");',
        'process.stdout.write("password=,comma-secret,comma-tail\\n");',
      ].join("\n"),
      async (cwd) => {
        const result = await runVerification({ command: npmTestCommand, cwd });

        expect(result.status).toBe("completed");
        for (const secret of ["operator-secret", "semicolon-secret", "comma-secret"]) {
          expect(result.summary).not.toContain(secret);
        }
        for (const tail of ["pipe-tail", "semicolon-tail", "comma-tail"]) {
          expect(result.summary).toContain(tail);
        }
      },
    );
  });

  it(
    "processes exact repeated secret candidates linearly",
    async () => {
      await withPackageFixture(
        'process.stdout.write("X_TOKEN=x_".repeat(6000));',
        async (cwd) => {
          const result = await runVerification({ command: npmTestCommand, cwd });

          expect(result.status).toBe("completed");
          expect(result.summary).not.toContain("x_");
          expect(result.summary).toContain("[REDACTED]");
        },
      );
    },
    2_000,
  );

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

  it("keeps a spawn failure stable when the child later closes", async () => {
    await withPackageFixture('process.stdout.write("unused");', async (cwd) => {
      const child = createFakeChild();
      spawnHarness.nextChild = child;
      const completion = runVerification({ command: npmTestCommand, cwd });

      await waitForSpawnCount(1);
      child.emit("error", new Error("spawn raw host detail"));
      child.emit("close", 0);

      await expect(completion).resolves.toMatchObject({
        status: "spawn_failed",
        exitCode: null,
        timedOut: false,
        summary: "VERIFICATION_SPAWN_FAILED",
      });
    });
  });

  it("handles stdout and stderr errors once without raw host details", async () => {
    await withPackageFixture('process.stdout.write("unused");', async (cwd) => {
      let expectedSpawnCount = 0;
      for (const streamName of ["stdout", "stderr"] as const) {
        const child = createFakeChild();
        spawnHarness.nextChild = child;
        const completion = runVerification({ command: npmTestCommand, cwd });

        expectedSpawnCount += 1;
        await waitForSpawnCount(expectedSpawnCount);
        const firstErrorWasUnhandled = emitStreamError(
          child[streamName],
          `${streamName} first raw host detail`,
        );
        const secondErrorWasUnhandled = emitStreamError(
          child[streamName],
          `${streamName} second raw host detail`,
        );
        child.emit("close", 0);

        const result = await completion;
        expect(firstErrorWasUnhandled).toBe(false);
        expect(secondErrorWasUnhandled).toBe(false);
        expect(child.killed).toBe(true);
        expect(result).toMatchObject({
          status: "spawn_failed",
          exitCode: null,
          timedOut: false,
          summary: "VERIFICATION_SPAWN_FAILED",
        });
        expect(result.summary).not.toContain("raw host detail");
      }
    });
  });

  it("preserves timeout and output-limit terminal results across late stream-error and close races", async () => {
    await withPackageFixture('process.stdout.write("unused");', async (cwd) => {
      const scenarios = [
        {
          command: { ...npmTestCommand, timeoutMs: 1 },
          expected: { status: "timed_out", timedOut: true, summary: "VERIFICATION_TIMEOUT" },
          trigger: async (child: FakeChild) => {
            await delay(20);
            return emitStreamError(child.stdout, "timeout race raw host detail");
          },
        },
        {
          command: { ...npmTestCommand, maxOutputBytes: 1_024 },
          expected: {
            status: "output_limit",
            timedOut: false,
            summary: "VERIFICATION_OUTPUT_LIMIT",
          },
          trigger: async (child: FakeChild) => {
            child.stdout.write(Buffer.alloc(1_025));
            return emitStreamError(child.stderr, "output race raw host detail");
          },
        },
      ] as const;

      let expectedSpawnCount = 0;
      for (const scenario of scenarios) {
        const child = createFakeChild();
        spawnHarness.nextChild = child;
        const completion = runVerification({ command: scenario.command, cwd });

        expectedSpawnCount += 1;
        await waitForSpawnCount(expectedSpawnCount);
        const errorWasUnhandled = await scenario.trigger(child);
        child.emit("close", null);

        await expect(completion).resolves.toMatchObject({
          ...scenario.expected,
          exitCode: null,
        });
        expect(errorWasUnhandled).toBe(false);
        expect(child.killed).toBe(true);
      }
    });
  });

  it(
    "escalates stubborn direct children, stops capture before fallback, and preserves terminal results",
    async () => {
      await withPackageFixture('process.stdout.write("unused");', async (cwd) => {
        const scenarios = [
          {
            command: { ...npmTestCommand, timeoutMs: 1 },
            expected: { status: "timed_out", timedOut: true, summary: "VERIFICATION_TIMEOUT" },
            trigger: async (): Promise<void> => {
              await delay(20);
            },
          },
          {
            command: { ...npmTestCommand, maxOutputBytes: 1_024 },
            expected: {
              status: "output_limit",
              timedOut: false,
              summary: "VERIFICATION_OUTPUT_LIMIT",
            },
            trigger: async (child: FakeChild): Promise<void> => {
              child.stdout.write(Buffer.alloc(1_025));
            },
          },
        ] as const;

        let expectedSpawnCount = 0;
        for (const scenario of scenarios) {
          const child = createFakeChild({ markKilled: false });
          spawnHarness.nextChild = child;
          const completion = runVerification({ command: scenario.command, cwd });

          expectedSpawnCount += 1;
          await waitForSpawnCount(expectedSpawnCount);
          await scenario.trigger(child);

          const result = await resolveWithin(completion, 3_500);

          expect(result).toMatchObject({ ...scenario.expected, exitCode: null });
          expect(child.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
          expect(child.killed).toBe(false);
          expect(child.stdout.listenerCount("data")).toBe(0);
          expect(child.stderr.listenerCount("data")).toBe(0);

          child.stdout.write("late raw output that must not be captured");
          const streamErrorWasUnhandled = emitStreamError(
            child.stdout,
            "late stream error after bounded cleanup",
          );
          child.emit("close", 0);

          expect(streamErrorWasUnhandled).toBe(false);
          await expect(completion).resolves.toEqual(result);
        }
      });
    },
    12_000,
  );

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
