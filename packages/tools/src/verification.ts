import { spawn, type ChildProcess } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { TextDecoder } from "node:util";
import {
  MAX_VERIFICATION_OUTPUT_BYTES,
  MAX_VERIFICATION_TIMEOUT_MS,
  VerificationCommandSchema,
  type VerificationCommand,
} from "../../contracts/src/index.js";

const MAX_SUMMARY_CHARACTERS = 4_096;
const TERMINATION_SIGNAL_GRACE_MS = 1_000;
const TERMINATION_FINAL_GRACE_MS = 1_000;
const UNKNOWN_COMMAND_ID = "unknown";

const INPUT_INVALID_SUMMARY = "VERIFICATION_INPUT_INVALID";
const LAUNCHER_UNAVAILABLE_SUMMARY = "VERIFICATION_LAUNCHER_UNAVAILABLE";
const SPAWN_FAILED_SUMMARY = "VERIFICATION_SPAWN_FAILED";
const TIMEOUT_SUMMARY = "VERIFICATION_TIMEOUT";
const OUTPUT_LIMIT_SUMMARY = "VERIFICATION_OUTPUT_LIMIT";
const NON_TEXT_OUTPUT_SUMMARY = "VERIFICATION_NON_TEXT_OUTPUT";
const CONTROL_GAP = "\u2063";
const CONTROL_GAP_PATTERN = "\\u2063*";
const CONTROL_GAPS_PATTERN = "\\u2063+";
const CONTROL_OR_WHITESPACE_PATTERN = "[\\s\\u2063]*";

const ANSI_ESCAPE_SEQUENCE =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-_])/gu; // eslint-disable-line no-control-regex -- Terminal escape and bell sequences must be removed.
const C1_ANSI_ESCAPE_SEQUENCE =
  /\u009b[0-?]*[ -/]*[@-~]|\u009d[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?/gu; // eslint-disable-line no-control-regex -- C1 CSI and OSC terminal sequences must be removed.
// eslint-disable-next-line no-control-regex -- Completed summaries must remove all C0, DEL, and C1 controls.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/gu;
const SECRET_NAME_SUFFIXES = [
  "key",
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
] as const;
const SECRET_NAME_PREFIXES = [
  "api",
  "access",
  "auth",
  "bearer",
  "client",
  "db",
  "database",
  "secret",
  "private",
  "service",
  "session",
  "refresh",
] as const;
const SECRET_NAME_SUFFIX = `(?:${SECRET_NAME_SUFFIXES
  .map(withControlGaps)
  .join("|")})`;
const SECRET_NAME_PREFIX = `(?:${SECRET_NAME_PREFIXES
  .map(withControlGaps)
  .join("|")})`;
const SECRET_NAME = `(?:${SECRET_NAME_PREFIX}${CONTROL_GAP_PATTERN}[_-]?${CONTROL_GAP_PATTERN}${SECRET_NAME_SUFFIX}|${SECRET_NAME_SUFFIX})`;
const SECRET_VALUE = `(?:"[^"]*"|'[^']*'|[^\\s,;|\\u2063]+(?:${CONTROL_GAPS_PATTERN}[^\\s,;|\\u2063]+)*)`;
const CSI_AWARE_SECRET_NAME = `(?:${[
  ...SECRET_NAME_SUFFIXES.map(withCsiFinals),
  ...SECRET_NAME_PREFIXES.flatMap((prefix) =>
    SECRET_NAME_SUFFIXES.map(
      (suffix) => `${withCsiFinals(prefix)}(?:[_-])?${withCsiFinals(suffix)}`,
    ),
  ),
].join("|")})`;
const BEARER_TOKEN = new RegExp(
  `\\b${withControlGaps("bearer")}(?:\\s|\\u2063)+${SECRET_VALUE}`,
  "giu",
);
const OPENAI_STYLE_TOKEN = new RegExp(
  `\\b${withControlGaps("sk")}${CONTROL_GAP_PATTERN}-${CONTROL_GAP_PATTERN}[A-Za-z0-9](?:[A-Za-z0-9_-]|\\u2063)*`,
  "gu",
);
const SECRET_ASSIGNMENT = new RegExp(
  `\\b(${SECRET_NAME})${CONTROL_OR_WHITESPACE_PATTERN}([=:])${CONTROL_OR_WHITESPACE_PATTERN}${SECRET_VALUE}`,
  "giu",
);
const CSI_AWARE_SECRET_ASSIGNMENT = new RegExp(
  `\\b(${CSI_AWARE_SECRET_NAME})\\s*([=:])\\s*${SECRET_VALUE}`,
  "giu",
);

export type VerificationStatus = "completed" | "timed_out" | "spawn_failed" | "output_limit";

export type VerificationResult = Readonly<{
  commandId: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  status: VerificationStatus;
  summary: string;
}>;

export type RunVerificationInput = Readonly<{
  command: VerificationCommand;
  cwd: string;
}>;

type ValidatedInput = Readonly<{
  command: VerificationCommand;
  cwd: string;
}>;

type TrustedNpmInvocation = Readonly<{
  args: readonly string[];
  nodeDirectory: string;
  nodeExecutable: string;
}>;

type TerminalStatus = Exclude<VerificationStatus, "completed">;

/**
 * Runs one already-configured npm verification command. Callers remain responsible for policy,
 * approval, and workspace-containment authorization; this is not a sandbox for npm scripts.
 */
export async function runVerification(input: RunVerificationInput): Promise<VerificationResult> {
  const startedAt = Date.now();
  const reportedCommandId = getReportedCommandId(input);
  const validated = await validateInput(input);

  if (validated === undefined) {
    return resultFor(
      reportedCommandId,
      startedAt,
      "spawn_failed",
      false,
      INPUT_INVALID_SUMMARY,
    );
  }

  const invocation = await resolveTrustedNpmInvocation(validated.command);
  if (invocation === undefined) {
    return resultFor(
      validated.command.id,
      startedAt,
      "spawn_failed",
      false,
      LAUNCHER_UNAVAILABLE_SUMMARY,
    );
  }

  let child: ChildProcess;
  try {
    child = spawn(invocation.nodeExecutable, invocation.args, {
      cwd: validated.cwd,
      env: buildChildEnvironment(invocation.nodeDirectory),
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: false,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return resultFor(
      validated.command.id,
      startedAt,
      "spawn_failed",
      false,
      SPAWN_FAILED_SUMMARY,
    );
  }

  return captureBoundedOutput({
    child,
    command: validated.command,
    commandId: validated.command.id,
    startedAt,
  });
}

async function validateInput(input: unknown): Promise<ValidatedInput | undefined> {
  try {
    if (!isRecord(input) || typeof input.cwd !== "string" || !isAbsolute(input.cwd)) {
      return undefined;
    }

    const parsedCommand = VerificationCommandSchema.safeParse(input.command);
    if (!parsedCommand.success) {
      return undefined;
    }

    const canonicalCwd = await realpath(input.cwd);
    const cwdInfo = await stat(canonicalCwd);
    if (!cwdInfo.isDirectory()) {
      return undefined;
    }

    const command = freezeCommand(parsedCommand.data);
    return Object.freeze({ command, cwd: canonicalCwd });
  } catch {
    return undefined;
  }
}

async function resolveTrustedNpmInvocation(
  command: VerificationCommand,
): Promise<TrustedNpmInvocation | undefined> {
  try {
    const nodeExecutable = await realpath(process.execPath);
    const nodeInfo = await stat(nodeExecutable);
    if (!nodeInfo.isFile()) {
      return undefined;
    }

    const nodeDirectory = dirname(nodeExecutable);
    const npmCliCandidate = join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js");
    const npmCli = await realpath(npmCliCandidate);
    if (!isContainedBy(nodeDirectory, npmCli)) {
      return undefined;
    }

    const npmCliInfo = await stat(npmCli);
    if (!npmCliInfo.isFile()) {
      return undefined;
    }

    return Object.freeze({
      args: Object.freeze([npmCli, ...command.args]),
      nodeDirectory,
      nodeExecutable,
    });
  } catch {
    return undefined;
  }
}

function buildChildEnvironment(nodeDirectory: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PATH: nodeDirectory };

  if (process.platform === "win32") {
    for (const name of ["SystemRoot", "ComSpec", "TEMP", "TMP"] as const) {
      const value = readWindowsRuntimeEnvironment(name);
      if (value !== undefined) {
        environment[name] = value;
      }
    }
  }

  return environment;
}

function captureBoundedOutput(input: {
  child: ChildProcess;
  command: VerificationCommand;
  commandId: string;
  startedAt: number;
}): Promise<VerificationResult> {
  const { child, command, commandId, startedAt } = input;

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let capturedBytes = 0;
    let settled = false;
    let closed = false;
    let closeCode: number | null = null;
    let terminalStatus: TerminalStatus | undefined;
    let executionTimer: ReturnType<typeof setTimeout> | undefined;
    let terminationGraceTimer: ReturnType<typeof setTimeout> | undefined;
    let finalCloseGraceTimer: ReturnType<typeof setTimeout> | undefined;
    let stdoutDataListener: ((chunk: Buffer) => void) | undefined;
    let stderrDataListener: ((chunk: Buffer) => void) | undefined;

    const clearTimers = (): void => {
      if (executionTimer !== undefined) {
        clearTimeout(executionTimer);
        executionTimer = undefined;
      }
      if (terminationGraceTimer !== undefined) {
        clearTimeout(terminationGraceTimer);
        terminationGraceTimer = undefined;
      }
      if (finalCloseGraceTimer !== undefined) {
        clearTimeout(finalCloseGraceTimer);
        finalCloseGraceTimer = undefined;
      }
    };

    const stopOutputCapture = (): void => {
      if (stdoutDataListener !== undefined) {
        child.stdout?.off("data", stdoutDataListener);
        stdoutDataListener = undefined;
      }
      if (stderrDataListener !== undefined) {
        child.stderr?.off("data", stderrDataListener);
        stderrDataListener = undefined;
      }

      try {
        child.stdout?.resume();
        child.stderr?.resume();
      } catch {
        // Late stream cleanup must not replace an already-stable terminal result.
      }
    };

    const settleOnce = (result: VerificationResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();
      stopOutputCapture();
      resolve(result);
    };

    const resultForTerminalStatus = (status: TerminalStatus): VerificationResult => {
      switch (status) {
        case "timed_out":
          return resultFor(commandId, startedAt, "timed_out", true, TIMEOUT_SUMMARY);
        case "output_limit":
          return resultFor(commandId, startedAt, "output_limit", false, OUTPUT_LIMIT_SUMMARY);
        case "spawn_failed":
          return resultFor(commandId, startedAt, "spawn_failed", false, SPAWN_FAILED_SUMMARY);
      }
    };

    const settleAfterClose = (): void => {
      if (!closed || settled) {
        return;
      }

      if (terminalStatus !== undefined) {
        settleOnce(resultForTerminalStatus(terminalStatus));
        return;
      }

      settleOnce(
        Object.freeze({
          commandId,
          durationMs: elapsedMilliseconds(startedAt),
          exitCode: closeCode,
          timedOut: false,
          status: "completed" as const,
          summary: summarizeCompletedOutput(chunks, capturedBytes),
        }),
      );
    };

    const signalDirectChild = (signal: NodeJS.Signals): void => {
      try {
        child.kill(signal);
      } catch {
        // Stable terminal results deliberately do not disclose process errors.
      }
    };

    const startTerminationLifecycle = (): void => {
      if (closed || settled || terminalStatus === undefined) {
        return;
      }

      signalDirectChild("SIGTERM");
      if (closed || settled || terminationGraceTimer !== undefined) {
        return;
      }

      terminationGraceTimer = setTimeout(() => {
        terminationGraceTimer = undefined;
        if (closed || settled || terminalStatus === undefined) {
          return;
        }

        signalDirectChild("SIGKILL");
        if (closed || settled || finalCloseGraceTimer !== undefined) {
          return;
        }

        finalCloseGraceTimer = setTimeout(() => {
          finalCloseGraceTimer = undefined;
          if (closed || settled || terminalStatus === undefined) {
            return;
          }

          stopOutputCapture();
          chunks.length = 0;
          capturedBytes = 0;
          settleOnce(resultForTerminalStatus(terminalStatus));
        }, TERMINATION_FINAL_GRACE_MS);
      }, TERMINATION_SIGNAL_GRACE_MS);
    };

    const selectTerminalStatus = (status: TerminalStatus): boolean => {
      if (terminalStatus !== undefined || settled) {
        return false;
      }

      terminalStatus = status;
      if (executionTimer !== undefined) {
        clearTimeout(executionTimer);
        executionTimer = undefined;
      }
      return true;
    };

    const terminateForTerminalStatus = (status: TerminalStatus): void => {
      if (!selectTerminalStatus(status)) {
        return;
      }

      chunks.length = 0;
      capturedBytes = 0;
      startTerminationLifecycle();
    };

    const handleOutput = (chunk: Buffer): void => {
      if (terminalStatus !== undefined || settled || chunk.length === 0) {
        return;
      }

      if (
        capturedBytes > command.maxOutputBytes ||
        chunk.length > command.maxOutputBytes - capturedBytes
      ) {
        terminateForTerminalStatus("output_limit");
        return;
      }

      chunks.push(Buffer.from(chunk));
      capturedBytes += chunk.length;
    };

    child.on("error", () => terminateForTerminalStatus("spawn_failed"));

    child.once("close", (code) => {
      closed = true;
      closeCode = code;
      settleAfterClose();
    });

    if (child.stdout === null || child.stderr === null) {
      terminateForTerminalStatus("spawn_failed");
      return;
    }

    const handleStreamError = (): void => {
      terminateForTerminalStatus("spawn_failed");
    };

    child.stdout.on("error", handleStreamError);
    child.stderr.on("error", handleStreamError);
    stdoutDataListener = (chunk: Buffer): void => handleOutput(chunk);
    stderrDataListener = (chunk: Buffer): void => handleOutput(chunk);
    child.stdout.on("data", stdoutDataListener);
    child.stderr.on("data", stderrDataListener);

    executionTimer = setTimeout(() => {
      terminateForTerminalStatus("timed_out");
    }, command.timeoutMs);
  });
}

function summarizeCompletedOutput(chunks: readonly Buffer[], capturedBytes: number): string {
  const bytes = Buffer.concat(chunks, capturedBytes);
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return NON_TEXT_OUTPUT_SUMMARY;
  }

  // A CSI final can occupy a letter in a secret name; mask that value before removing the sequence.
  const preRedacted = redactCsiAwareSecretAssignments(decoded);
  const normalized = preRedacted
    .replace(ANSI_ESCAPE_SEQUENCE, "")
    .replace(C1_ANSI_ESCAPE_SEQUENCE, "")
    .replace(CONTROL_CHARACTER, CONTROL_GAP);
  return limitSummary(redactSecrets(normalized).replaceAll(CONTROL_GAP, ""));
}

function redactSecrets(value: string): string {
  return value
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .replace(OPENAI_STYLE_TOKEN, "[REDACTED]")
    .replace(SECRET_ASSIGNMENT, "$1$2[REDACTED]");
}

function redactCsiAwareSecretAssignments(value: string): string {
  return value.includes("\u009b")
    ? value.replace(CSI_AWARE_SECRET_ASSIGNMENT, "$1$2[REDACTED]")
    : value;
}

function limitSummary(value: string): string {
  if (value.length <= MAX_SUMMARY_CHARACTERS) {
    return value;
  }

  const truncated = value.slice(0, MAX_SUMMARY_CHARACTERS);
  const finalCodeUnit = truncated.charCodeAt(truncated.length - 1);
  return finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff ? truncated.slice(0, -1) : truncated;
}

function resultFor(
  commandId: string,
  startedAt: number,
  status: VerificationStatus,
  timedOut: boolean,
  summary: string,
): VerificationResult {
  return Object.freeze({
    commandId,
    durationMs: elapsedMilliseconds(startedAt),
    exitCode: null,
    timedOut,
    status,
    summary,
  });
}

function freezeCommand(command: VerificationCommand): VerificationCommand {
  return Object.freeze({
    id: command.id,
    launcher: command.launcher,
    args: Object.freeze([...command.args]) as VerificationCommand["args"],
    timeoutMs: Math.min(command.timeoutMs, MAX_VERIFICATION_TIMEOUT_MS),
    maxOutputBytes: Math.min(command.maxOutputBytes, MAX_VERIFICATION_OUTPUT_BYTES),
  });
}

function getReportedCommandId(input: unknown): string {
  try {
    if (!isRecord(input) || !isRecord(input.command) || typeof input.command.id !== "string") {
      return UNKNOWN_COMMAND_ID;
    }

    const id = input.command.id;
    if (id.length === 0 || id.length > 128 || hasControlCharacter(id) || id.trim().length === 0) {
      return UNKNOWN_COMMAND_ID;
    }

    return id.trim();
  } catch {
    return UNKNOWN_COMMAND_ID;
  }
}

function readWindowsRuntimeEnvironment(name: "SystemRoot" | "ComSpec" | "TEMP" | "TMP"): string | undefined {
  const normalizedName = name.toUpperCase();
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() === normalizedName) {
      return value;
    }
  }
  return undefined;
}

function isContainedBy(parentPath: string, candidatePath: string): boolean {
  const pathFromParent = relative(parentPath, candidatePath);
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== ".." && !isAbsolute(pathFromParent))
  );
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 31 || codePoint === 127 || (codePoint >= 128 && codePoint <= 159))
    ) {
      return true;
    }
  }

  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withControlGaps(value: string): string {
  return [...value].join(CONTROL_GAP_PATTERN);
}

function withCsiFinals(value: string): string {
  return [...value]
    .map((character) => `(?:${character}|\\u009b[0-?]*[ -/]*${character})`)
    .join("");
}
