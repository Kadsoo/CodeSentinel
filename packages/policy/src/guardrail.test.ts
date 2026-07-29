import { describe, expect, it } from "vitest";
import { ActionSchema, type VerificationCommand } from "../../contracts/src/index.js";
import { createPolicy, evaluateAction } from "./guardrail.js";

const baseHash = "a".repeat(64);

const trustedCommand: VerificationCommand = {
  id: "test",
  launcher: "node_npm_cli",
  args: ["test"],
  timeoutMs: 1_000,
  maxOutputBytes: 1_024,
};

const context = {
  workspaceRoot: "C:/repo",
  config: {
    allowedPaths: ["src/**"],
    verificationCommands: [],
  },
};

describe("evaluateAction", () => {
  it("denies a .env read as a sensitive path", () => {
    expect(evaluateAction({ kind: "read_file", path: ".env" }, context)).toEqual({
      decision: "deny",
      reason: "SENSITIVE_PATH",
    });
  });

  it("denies parent traversal before normalizing the path", () => {
    expect(evaluateAction({ kind: "read_file", path: "../secret.txt" }, context)).toEqual({
      decision: "deny",
      reason: "OUTSIDE_WORKSPACE",
    });
  });

  it("asks for approval for a valid patch proposal", () => {
    const decision = evaluateAction(
      {
        kind: "propose_patch",
        path: "src/math.ts",
        baseHash,
        patch: "@@ -1 +1 @@\n-export const add = () => 0;\n+export const add = () => 2;",
        reason: "Fix incorrect addition",
      },
      context,
    );

    expect(decision).toEqual({ decision: "ask", reason: "PATCH_REQUIRES_APPROVAL" });
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it("denies an unconfigured verification command", () => {
    expect(evaluateAction({ kind: "run_verification", commandId: "publish" }, context)).toEqual({
      decision: "deny",
      reason: "UNKNOWN_COMMAND",
    });
  });

  it("normalizes valid command ids before matching a trusted configuration", () => {
    const commandContext = {
      ...context,
      config: {
        ...context.config,
        verificationCommands: [trustedCommand],
      },
    };

    expect(
      evaluateAction({ kind: "run_verification", commandId: "test" }, commandContext),
    ).toEqual({ decision: "allow", reason: "ALLOWED" });
    expect(
      evaluateAction({ kind: "run_verification", commandId: " test " }, commandContext),
    ).toEqual({ decision: "allow", reason: "ALLOWED" });
    expect(
      evaluateAction(
        ActionSchema.parse({ kind: "run_verification", commandId: " test " }),
        commandContext,
      ),
    ).toEqual({ decision: "allow", reason: "ALLOWED" });
  });

  it("denies malformed command ids instead of normalizing control characters", () => {
    const commandContext = {
      ...context,
      config: {
        ...context.config,
        verificationCommands: [trustedCommand],
      },
    };

    for (const commandId of ["test\0", "test\n", "test\u007f", "test\u009b31m", " ".repeat(129)]) {
      expect(evaluateAction({ kind: "run_verification", commandId }, commandContext)).toEqual({
        decision: "deny",
        reason: "UNKNOWN_COMMAND",
      });
    }

    const c1CommandId = `test${String.fromCharCode(0x9b)}31m`;
    expect(
      evaluateAction(
        { kind: "run_verification", commandId: c1CommandId },
        {
          ...context,
          config: {
            ...context.config,
            verificationCommands: [{ ...trustedCommand, id: c1CommandId }],
          },
        },
      ),
    ).toEqual({ decision: "deny", reason: "UNKNOWN_COMMAND" });
  });

  it("denies a legacy executable configuration even when its id matches", () => {
    const legacyCommand = {
      ...trustedCommand,
      executable: "npm.cmd",
    } as unknown as VerificationCommand;

    expect(
      evaluateAction(
        { kind: "run_verification", commandId: "test" },
        { ...context, config: { ...context.config, verificationCommands: [legacyCommand] } },
      ),
    ).toEqual({ decision: "deny", reason: "UNKNOWN_COMMAND" });
  });

  it("denies configured verification entries that could execute dangerous commands", () => {
    const commandContext = {
      ...context,
      config: {
        ...context.config,
        verificationCommands: [
          {
            id: "publish",
            executable: "npm",
            args: ["publish"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "install",
            executable: "npm",
            args: ["install"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "install-alias",
            executable: "npm",
            args: ["i"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "update",
            executable: "npm",
            args: ["update"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "uninstall",
            executable: "npm",
            args: ["uninstall"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "git-push",
            executable: "git",
            args: ["push"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "cmd",
            executable: "cmd.exe",
            args: ["/c", "npm test"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "powershell",
            executable: "powershell.exe",
            args: ["-Command", "npm test"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "chain",
            executable: "npm",
            args: ["test", "&&", "npm", "publish"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "cmd-alias",
            executable: "cmd.exe.",
            args: ["/c", "npm test"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "curl-alias",
            executable: "curl.exe.",
            args: ["https://example.test"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "npm-alias",
            executable: "npm.cmd.",
            args: ["publish"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "npm-up",
            executable: "npm",
            args: ["up"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "npm-ud",
            executable: "npm",
            args: ["ud"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "npm-un",
            executable: "npm",
            args: ["un"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "npm-unlink",
            executable: "npm",
            args: ["unlink"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "pnpm-up",
            executable: "pnpm",
            args: ["up"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "yarn-up",
            executable: "yarn",
            args: ["up"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "pnpx",
            executable: "pnpx",
            args: ["eslint"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "yarn-dlx",
            executable: "yarn",
            args: ["dlx", "eslint"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "bunx",
            executable: "bunx",
            args: ["eslint"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "rm",
            executable: "/bin/rm",
            args: ["-rf", "something"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "env-shell",
            executable: "/usr/bin/env",
            args: ["bash", "-c", "echo bypass"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "bash-exe",
            executable: "bash.exe",
            args: ["-c", "echo bypass"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "sh-exe",
            executable: "sh.exe",
            args: ["-c", "echo bypass"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "bitsadmin-exe",
            executable: "bitsadmin.exe",
            args: ["/transfer", "job", "https://example.test", "out"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "ftp-exe",
            executable: "ftp.exe",
            args: ["example.test"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "git-fetch",
            executable: "git",
            args: ["fetch"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "git-clone",
            executable: "git",
            args: ["clone", "https://example.test/repo.git"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "git-clean",
            executable: "git",
            args: ["clean", "-fdx"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "git-reset",
            executable: "git",
            args: ["reset", "--hard"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "git-alias",
            executable: "git",
            args: ["-c", "alias.x=!echo bypass", "status"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "node-eval",
            executable: "node",
            args: ["-e", "throw new Error('bypass')"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "npm-run-publish",
            executable: "npm",
            args: ["run", "publish"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "nul-argument",
            executable: "npm",
            args: ["test", "\0"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "nul-executable",
            executable: "npm\0",
            args: ["test"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "path-disguised-package-manager",
            executable: "C:\\untrusted\\npm.cmd",
            args: ["test"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "uppercase-executable",
            executable: "NPM",
            args: ["test"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "uppercase-entrypoint",
            executable: "npm",
            args: ["RUN", "lint"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "uppercase-script",
            executable: "npm",
            args: ["run", "LINT"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "test-prefix",
            executable: "npm",
            args: ["test", "--prefix", "C:/outside"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "t-script-shell",
            executable: "npm",
            args: ["t", "--script-shell", "cmd.exe"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "run-prefix",
            executable: "npm",
            args: ["run", "lint", "--prefix", "C:/outside"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "run-script-shell",
            executable: "npm",
            args: ["run-script", "lint", "--script-shell", "cmd.exe"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "test-extra-argument",
            executable: "npm",
            args: ["test", "arbitrary"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
          {
            id: "run-extra-argument",
            executable: "npm",
            args: ["run", "lint", "arbitrary"],
            timeoutMs: 30_000,
            maxOutputBytes: 1_000_000,
          },
        ] as unknown as VerificationCommand[],
      },
    };

    for (const commandId of [
      "publish",
      "install",
      "install-alias",
      "update",
      "uninstall",
      "git-push",
      "cmd",
      "powershell",
      "chain",
      "cmd-alias",
      "curl-alias",
      "npm-alias",
      "npm-up",
      "npm-ud",
      "npm-un",
      "npm-unlink",
      "pnpm-up",
      "yarn-up",
      "pnpx",
      "yarn-dlx",
      "bunx",
      "rm",
      "env-shell",
      "bash-exe",
      "sh-exe",
      "bitsadmin-exe",
      "ftp-exe",
      "git-fetch",
      "git-clone",
      "git-clean",
      "git-reset",
      "git-alias",
      "node-eval",
      "npm-run-publish",
      "nul-argument",
      "nul-executable",
      "path-disguised-package-manager",
      "uppercase-executable",
      "uppercase-entrypoint",
      "uppercase-script",
      "test-prefix",
      "t-script-shell",
      "run-prefix",
      "run-script-shell",
      "test-extra-argument",
      "run-extra-argument",
    ]) {
      expect(evaluateAction({ kind: "run_verification", commandId }, commandContext)).toEqual({
        decision: "deny",
        reason: "UNKNOWN_COMMAND",
      });
    }
  });

  it("allows only exact configured trusted npm launcher commands", () => {
    const commandContext = {
      ...context,
      config: {
        ...context.config,
        verificationCommands: [
          trustedCommand,
          { ...trustedCommand, id: "lint", args: ["run", "lint"] as const },
          { ...trustedCommand, id: "lint-run-script", args: ["run-script", "lint"] as const },
        ],
      },
    };

    for (const commandId of ["test", "lint", "lint-run-script"]) {
      expect(evaluateAction({ kind: "run_verification", commandId }, commandContext)).toEqual({
        decision: "allow",
        reason: "ALLOWED",
      });
    }
  });

  it("fails closed on duplicate verification command ids", () => {
    const safeTestCommand = trustedCommand;
    const invalidLauncherCommand = {
      ...safeTestCommand,
      launcher: "unknown",
    } as unknown as VerificationCommand;

    for (const verificationCommands of [
      [safeTestCommand, { ...safeTestCommand }],
      [safeTestCommand, invalidLauncherCommand],
    ]) {
      expect(
        evaluateAction(
          { kind: "run_verification", commandId: "test" },
          { ...context, config: { ...context.config, verificationCommands } },
        ),
      ).toEqual({ decision: "deny", reason: "UNKNOWN_COMMAND" });
    }
  });

  it("fails closed on malformed verification command configuration", () => {
    const malformedCommand = {
      id: "broken",
      executable: "npm",
      args: "test",
      timeoutMs: 30_000,
      maxOutputBytes: 1_000_000,
    } as unknown as VerificationCommand;

    expect(
      evaluateAction(
        { kind: "run_verification", commandId: "test" },
        {
          ...context,
          config: {
            ...context.config,
            verificationCommands: [
              trustedCommand,
              malformedCommand,
            ],
          },
        },
      ),
    ).toEqual({ decision: "deny", reason: "UNKNOWN_COMMAND" });
  });

  it("allows a read only when it matches an explicit allowed path", () => {
    expect(evaluateAction({ kind: "read_file", path: "src/math.ts" }, context)).toEqual({
      decision: "allow",
      reason: "ALLOWED",
    });
    expect(evaluateAction({ kind: "read_file", path: "docs/notes.md" }, context)).toEqual({
      decision: "deny",
      reason: "OUTSIDE_WORKSPACE",
    });
  });

  it("keeps allowed-path matching case-sensitive for a POSIX workspace root", () => {
    const posixContext = { ...context, workspaceRoot: "/repo" };

    expect(evaluateAction({ kind: "read_file", path: "SRC/math.ts" }, posixContext)).toEqual({
      decision: "deny",
      reason: "OUTSIDE_WORKSPACE",
    });
  });

  it("does not treat a POSIX literal backslash as an allowed-path separator", () => {
    const posixContext = { ...context, workspaceRoot: "/repo" };

    expect(evaluateAction({ kind: "read_file", path: "src\\private.txt" }, posixContext)).toEqual({
      decision: "deny",
      reason: "OUTSIDE_WORKSPACE",
    });
  });

  it("denies a matching path when the workspace root is not absolute", () => {
    expect(
      evaluateAction(
        { kind: "read_file", path: "src/math.ts" },
        { ...context, workspaceRoot: "relative-repo" },
      ),
    ).toEqual({ decision: "deny", reason: "OUTSIDE_WORKSPACE" });
  });

  it("does not let a canonical root override an invalid original workspace root", () => {
    expect(
      evaluateAction(
        { kind: "read_file", path: "src/math.ts" },
        { ...context, workspaceRoot: "relative-repo", canonicalWorkspaceRoot: "C:/repo" },
      ),
    ).toEqual({ decision: "deny", reason: "OUTSIDE_WORKSPACE" });
  });

  it("accepts exactly terminal separators on valid workspace roots", () => {
    for (const workspaceRoot of ["C:/repo/", "/repo/", "\\\\server\\share\\"]) {
      expect(
        evaluateAction(
          { kind: "read_file", path: "src/math.ts" },
          { ...context, workspaceRoot },
        ),
      ).toEqual({ decision: "allow", reason: "ALLOWED" });
    }
  });

  it("denies all file access when allowed paths are empty", () => {
    expect(
      evaluateAction(
        { kind: "read_file", path: "src/math.ts" },
        { ...context, config: { ...context.config, allowedPaths: [] } },
      ),
    ).toEqual({ decision: "deny", reason: "OUTSIDE_WORKSPACE" });
  });

  it("does not trim semantic path strings during validation", () => {
    expect(evaluateAction({ kind: "read_file", path: " src/math.ts " }, context)).toEqual({
      decision: "deny",
      reason: "OUTSIDE_WORKSPACE",
    });
  });

  it("denies pathless listing and search rather than scanning the workspace root", () => {
    expect(evaluateAction({ kind: "list_files" }, context)).toEqual({
      decision: "deny",
      reason: "OUTSIDE_WORKSPACE",
    });
    expect(evaluateAction({ kind: "search_text", query: "TODO" }, context)).toEqual({
      decision: "deny",
      reason: "OUTSIDE_WORKSPACE",
    });
  });

  it("allows list and search actions only when their explicit path is allowed", () => {
    expect(evaluateAction({ kind: "list_files", path: "src" }, context)).toEqual({
      decision: "allow",
      reason: "ALLOWED",
    });
    expect(
      evaluateAction({ kind: "search_text", query: "TODO", path: "src" }, context),
    ).toEqual({ decision: "allow", reason: "ALLOWED" });
  });

  it("denies Windows, UNC, device, ADS, and mixed-separator escape forms", () => {
    const paths = [
      "C:/other/secret.txt",
      "C:other/secret.txt",
      "\\\\server\\share\\secret.txt",
      "\\\\?\\C:\\other\\secret.txt",
      "src/file.txt:stream",
      "src\\nested/file.ts",
    ];

    for (const path of paths) {
      expect(evaluateAction({ kind: "read_file", path }, context)).toEqual({
        decision: "deny",
        reason: "OUTSIDE_WORKSPACE",
      });
    }
  });

  it("denies Windows trailing-dot and trailing-space aliases of blocked targets", () => {
    for (const path of ["src/.git./config", "src/image.png "]) {
      expect(evaluateAction({ kind: "read_file", path }, context)).toEqual({
        decision: "deny",
        reason: "OUTSIDE_WORKSPACE",
      });
    }
  });

  it("denies Windows reserved device aliases", () => {
    for (const path of [
      "src/NUL",
      "src/CON",
      "src/COM1",
      "src/NUL.txt",
      "src/CONIN$",
      "src/CONOUT$",
      "src/COM¹",
      "src/LPT³.txt",
    ]) {
      expect(evaluateAction({ kind: "read_file", path }, context)).toEqual({
        decision: "deny",
        reason: "SENSITIVE_PATH",
      });
    }
  });

  it("denies excessive path depth instead of overflowing the matcher stack", () => {
    const deepPath = `src/${Array.from({ length: 20_000 }, () => "nested").join("/")}`;

    expect(evaluateAction({ kind: "read_file", path: deepPath }, context)).toEqual({
      decision: "deny",
      reason: "OUTSIDE_WORKSPACE",
    });
  });

  it("rejects a Windows alias before configured sensitive-pattern matching", () => {
    const sensitiveContext = {
      ...context,
      config: { ...context.config, sensitivePatterns: ["src/private/**"] },
    };

    expect(evaluateAction({ kind: "read_file", path: "src/private./config.ts" }, sensitiveContext)).toEqual({
      decision: "deny",
      reason: "OUTSIDE_WORKSPACE",
    });
  });

  it("denies sensitive directories, credential-like files, binaries, and configured patterns", () => {
    const sensitiveContext = {
      ...context,
      config: {
        ...context.config,
        sensitivePatterns: ["src/private/**"],
      },
    };

    const paths = [
      "src/.GIT/config",
      "src/node_modules/pkg/index.js",
      "src/credentials.json",
      "src/access-token.txt",
      "src/APIKEYS.json",
      "src/accessToken.txt",
      "src/apiToken.txt",
      "src/clientSecret.txt",
      "src/privateKey.txt",
      "src/databaseCredentials.txt",
      "src/gitHubToken.txt",
      "src/ACCESS_TOKEN.txt",
      "src/image.PNG",
      "src/private/config.ts",
    ];

    for (const path of paths) {
      expect(evaluateAction({ kind: "read_file", path }, sensitiveContext)).toEqual({
        decision: "deny",
        reason: "SENSITIVE_PATH",
      });
    }
  });

  it("matches configured sensitive glob patterns by Unicode code point", () => {
    const emoji = String.fromCodePoint(0x1f600);
    const path = `src/private-${emoji}.txt`;

    for (const sensitivePattern of [path, "src/private-?.txt"]) {
      expect(
        evaluateAction(
          { kind: "read_file", path },
          {
            ...context,
            config: { ...context.config, sensitivePatterns: [sensitivePattern] },
          },
        ),
      ).toEqual({ decision: "deny", reason: "SENSITIVE_PATH" });
    }
  });

  it("fails closed on oversized path and pattern inputs before glob matching", () => {
    const oversizedSegment = "a".repeat(10_000);
    const oversizedPath = `src/${oversizedSegment}`;
    const oversizedPattern = `src/${oversizedSegment}`;

    expect(
      evaluateAction(
        { kind: "read_file", path: oversizedPath },
        { ...context, config: { ...context.config, allowedPaths: ["src/*"] } },
      ),
    ).toEqual({ decision: "deny", reason: "OUTSIDE_WORKSPACE" });
    expect(
      evaluateAction(
        { kind: "read_file", path: "src/math.ts" },
        {
          ...context,
          config: { ...context.config, sensitivePatterns: [oversizedPattern] },
        },
      ),
    ).toEqual({ decision: "deny", reason: "SENSITIVE_PATH" });
  });

  it("fails closed when injected canonical path data cannot prove workspace containment", () => {
    const canonicalContext = {
      ...context,
      canonicalPaths: {
        "src/link.ts": "C:/outside/secret.ts",
      },
    };

    expect(evaluateAction({ kind: "read_file", path: "src/link.ts" }, canonicalContext)).toEqual({
      decision: "deny",
      reason: "OUTSIDE_WORKSPACE",
    });
    expect(evaluateAction({ kind: "read_file", path: "src/math.ts" }, canonicalContext)).toEqual({
      decision: "deny",
      reason: "OUTSIDE_WORKSPACE",
    });
  });

  it("allows a canonical path only when the injected data keeps it inside the workspace", () => {
    const canonicalContext = {
      ...context,
      canonicalPaths: {
        "src/math.ts": "C:/repo/src/math.ts",
      },
    };

    expect(evaluateAction({ kind: "read_file", path: "src/math.ts" }, canonicalContext)).toEqual({
      decision: "allow",
      reason: "ALLOWED",
    });
  });

  it("rechecks a canonical target against built-in sensitive path rules", () => {
    const canonicalContext = {
      ...context,
      canonicalPaths: {
        "src/link.ts": "C:/repo/.git/config",
      },
    };

    expect(evaluateAction({ kind: "read_file", path: "src/link.ts" }, canonicalContext)).toEqual({
      decision: "deny",
      reason: "SENSITIVE_PATH",
    });
  });

  it("rechecks a canonical target against the configured allowed paths", () => {
    const canonicalContext = {
      ...context,
      canonicalPaths: {
        "src/link.ts": "C:/repo/docs/private.txt",
      },
    };

    expect(evaluateAction({ kind: "read_file", path: "src/link.ts" }, canonicalContext)).toEqual({
      decision: "deny",
      reason: "OUTSIDE_WORKSPACE",
    });
  });

  it("rejects Windows aliases in canonical sensitive targets before policy matching", () => {
    for (const canonicalPath of [
      "C:/repo/src/.git./config",
      "C:/repo/src/node_modules./pkg/index.js",
    ]) {
      const canonicalContext = {
        ...context,
        canonicalPaths: {
          "src/link.ts": canonicalPath,
        },
      };

      expect(evaluateAction({ kind: "read_file", path: "src/link.ts" }, canonicalContext)).toEqual({
        decision: "deny",
        reason: "OUTSIDE_WORKSPACE",
      });
    }
  });

  it("keeps apply_approved_patch gated until the approval state machine exists", () => {
    expect(
      evaluateAction(
        {
          kind: "apply_approved_patch",
          approvalId: "approval-1",
          path: "src/math.ts",
          baseHash,
          patch: "@@ -1 +1 @@\n-export const add = () => 0;\n+export const add = () => 2;",
        },
        context,
      ),
    ).toEqual({ decision: "deny", reason: "PATCH_REQUIRES_APPROVAL" });
  });

  it("allows finish without broadening file or process access", () => {
    expect(
      evaluateAction(
        { kind: "finish", outcome: "completed", summary: "Verification passed" },
        context,
      ),
    ).toEqual({ decision: "allow", reason: "ALLOWED" });
  });

  it("binds a policy adapter to its supplied context", () => {
    const policy = createPolicy(context);

    expect(policy.evaluate({ kind: "read_file", path: "src/math.ts" })).toEqual({
      decision: "allow",
      reason: "ALLOWED",
    });
  });
});
