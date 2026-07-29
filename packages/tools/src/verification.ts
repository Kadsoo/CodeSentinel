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
const ESCAPE = "\u001b";
const BELL = "\u0007";
const STRING_TERMINATOR = "\u009c";
const C1_CSI = "\u009b";
const C1_OSC = "\u009d";
const CONTROL_GAP = "\u2063";
const REDACTED_VALUE = "[REDACTED]";
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

type NormalizedOutput = Readonly<{
  display: string;
  semantic: string;
  semanticOffsets: readonly number[];
}>;

type RedactionRange = Readonly<{
  end: number;
  start: number;
}>;

type TerminalSequence = Readonly<{
  end: number;
  semanticFinal?: string;
}>;

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

  const normalized = normalizeTerminalOutput(decoded);
  return limitSummary(redactNormalizedOutput(normalized).replaceAll(CONTROL_GAP, ""));
}

function normalizeTerminalOutput(value: string): NormalizedOutput {
  let display = "";
  let semantic = "";
  const semanticOffsets = [0];

  const appendVisible = (character: string): void => {
    display += character;
    semantic += character;
    semanticOffsets.push(display.length);
  };
  const appendSemanticFinal = (character: string): void => {
    semantic += character;
    semanticOffsets.push(display.length);
  };

  for (let index = 0; index < value.length; ) {
    const character = value[index]!;

    if (character === ESCAPE) {
      const sequence = consumeSevenBitEscapeSequence(value, index);
      if (sequence !== undefined) {
        if (sequence.semanticFinal !== undefined) {
          appendSemanticFinal(sequence.semanticFinal);
        }
        index = sequence.end;
        continue;
      }
    }

    if (character === C1_CSI) {
      const sequence = consumeCsiSequence(value, index, 1);
      if (sequence !== undefined) {
        if (sequence.semanticFinal !== undefined) {
          appendSemanticFinal(sequence.semanticFinal);
        }
        index = sequence.end;
        continue;
      }
    }

    if (character === C1_OSC) {
      index = consumeOscSequence(value, index, 1);
      continue;
    }

    appendVisible(isTerminalControlCharacter(character) ? CONTROL_GAP : character);
    index += 1;
  }

  return Object.freeze({
    display,
    semantic,
    semanticOffsets: Object.freeze(semanticOffsets),
  });
}

function consumeSevenBitEscapeSequence(
  value: string,
  index: number,
): TerminalSequence | undefined {
  const next = value[index + 1];
  if (next === "]") {
    return { end: consumeOscSequence(value, index, 2) };
  }
  if (next === "[") {
    return consumeCsiSequence(value, index, 2);
  }
  if (next !== undefined && isEscapeFinal(next)) {
    return { end: index + 2 };
  }
  return undefined;
}

function consumeCsiSequence(
  value: string,
  index: number,
  prefixLength: number,
): TerminalSequence | undefined {
  let cursor = index + prefixLength;
  while (cursor < value.length && isCsiParameter(value[cursor]!)) {
    cursor += 1;
  }
  while (cursor < value.length && isCsiIntermediate(value[cursor]!)) {
    cursor += 1;
  }

  const semanticFinal = value[cursor];
  if (semanticFinal === undefined || !isCsiFinal(semanticFinal)) {
    return undefined;
  }

  return { end: cursor + 1, semanticFinal };
}

function consumeOscSequence(value: string, index: number, prefixLength: number): number {
  let cursor = index + prefixLength;
  while (cursor < value.length) {
    const character = value[cursor]!;
    if (character === BELL || character === STRING_TERMINATOR) {
      return cursor + 1;
    }
    if (character === ESCAPE && value[cursor + 1] === "\\") {
      return cursor + 2;
    }
    cursor += 1;
  }

  return value.length;
}

function redactNormalizedOutput(normalized: NormalizedOutput): string {
  const ranges = [
    ...findRedactionRanges(normalized.display, (index) => index),
    ...findRedactionRanges(
      normalized.semantic,
      (index) => normalized.semanticOffsets[index] ?? normalized.display.length,
    ),
  ];
  return replaceRedactionRanges(normalized.display, ranges);
}

function findRedactionRanges(
  value: string,
  toOutputOffset: (index: number) => number,
): RedactionRange[] {
  const ranges: RedactionRange[] = [];

  const addRange = (range: RedactionRange | undefined): void => {
    if (range === undefined) {
      return;
    }

    const start = toOutputOffset(range.start);
    const end = toOutputOffset(range.end);
    if (end > start) {
      ranges.push({ start, end });
    }
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (!isAsciiLetter(character) || !hasWordBoundaryBefore(value, index)) {
      continue;
    }

    addRange(findSecretAssignment(value, index));
    addRange(findBearerToken(value, index));
    addRange(findOpenAiStyleToken(value, index));
  }

  return ranges;
}

function findSecretAssignment(value: string, index: number): RedactionRange | undefined {
  const nameEnd = findSecretNameEnd(value, index);
  if (nameEnd === undefined) {
    return undefined;
  }

  let cursor = skipAssignmentSeparators(value, nameEnd);
  if (value[cursor] !== "=" && value[cursor] !== ":") {
    return undefined;
  }

  cursor = skipAssignmentSeparators(value, cursor + 1);
  const end = consumeSecretValue(value, cursor);
  return end > cursor ? { start: cursor, end } : undefined;
}

function findSecretNameEnd(value: string, index: number): number | undefined {
  let longestEnd: number | undefined;
  const consider = (candidate: number | undefined): void => {
    if (candidate !== undefined && (longestEnd === undefined || candidate > longestEnd)) {
      longestEnd = candidate;
    }
  };

  for (const suffix of SECRET_NAME_SUFFIXES) {
    consider(consumeSecretWord(value, index, suffix));
  }

  for (const prefix of SECRET_NAME_PREFIXES) {
    const prefixEnd = consumeSecretWord(value, index, prefix);
    if (prefixEnd === undefined) {
      continue;
    }

    let suffixStart = skipControlGaps(value, prefixEnd);
    if (value[suffixStart] === "_" || value[suffixStart] === "-") {
      suffixStart = skipControlGaps(value, suffixStart + 1);
    }

    for (const suffix of SECRET_NAME_SUFFIXES) {
      consider(consumeSecretWord(value, suffixStart, suffix));
    }
  }

  return longestEnd;
}

function findBearerToken(value: string, index: number): RedactionRange | undefined {
  const bearerEnd = consumeSecretWord(value, index, "bearer");
  if (bearerEnd === undefined) {
    return undefined;
  }

  const valueStart = skipAssignmentSeparators(value, bearerEnd);
  if (valueStart === bearerEnd) {
    return undefined;
  }

  const end = consumeSecretValue(value, valueStart);
  return end > valueStart ? { start: valueStart, end } : undefined;
}

function findOpenAiStyleToken(value: string, index: number): RedactionRange | undefined {
  const prefixEnd = consumeSecretWord(value, index, "sk");
  if (prefixEnd === undefined) {
    return undefined;
  }

  let valueStart = skipControlGaps(value, prefixEnd);
  if (value[valueStart] !== "-") {
    return undefined;
  }

  valueStart = skipControlGaps(value, valueStart + 1);
  const end = consumeSecretValue(value, valueStart);
  return end > valueStart ? { start: valueStart, end } : undefined;
}

function consumeSecretWord(value: string, index: number, word: string): number | undefined {
  let cursor = index;
  for (let wordIndex = 0; wordIndex < word.length; wordIndex += 1) {
    const character = value[cursor];
    if (character === undefined || !matchesAsciiLetter(character, word[wordIndex]!)) {
      return undefined;
    }

    cursor += 1;
    if (wordIndex < word.length - 1) {
      cursor = skipControlGaps(value, cursor);
    }
  }

  return cursor;
}

function consumeSecretValue(value: string, index: number): number {
  const first = value[index];
  if (first === "\"" || first === "'") {
    let cursor = index + 1;
    while (cursor < value.length && value[cursor] !== first) {
      cursor += 1;
    }
    return cursor < value.length ? cursor + 1 : cursor;
  }

  let cursor = index;
  while (cursor < value.length) {
    const character = value[cursor]!;
    if (character === CONTROL_GAP) {
      const gapStart = cursor;
      cursor = skipControlGaps(value, cursor);
      if (cursor < value.length && !isValueDelimiter(value[cursor]!)) {
        continue;
      }
      return gapStart;
    }
    if (isValueDelimiter(character)) {
      return cursor;
    }
    cursor += 1;
  }

  return cursor;
}

function skipAssignmentSeparators(value: string, index: number): number {
  let cursor = index;
  while (cursor < value.length) {
    const character = value[cursor]!;
    if (character !== CONTROL_GAP && !isWhitespace(character)) {
      break;
    }
    cursor += 1;
  }
  return cursor;
}

function skipControlGaps(value: string, index: number): number {
  let cursor = index;
  while (value[cursor] === CONTROL_GAP) {
    cursor += 1;
  }
  return cursor;
}

function replaceRedactionRanges(value: string, ranges: readonly RedactionRange[]): string {
  const mergedRanges = mergeRedactionRanges(value.length, ranges);
  if (mergedRanges.length === 0) {
    return value;
  }

  let cursor = 0;
  let redacted = "";
  for (const range of mergedRanges) {
    redacted += value.slice(cursor, range.start);
    redacted += REDACTED_VALUE;
    cursor = range.end;
  }
  return redacted + value.slice(cursor);
}

function mergeRedactionRanges(
  valueLength: number,
  ranges: readonly RedactionRange[],
): RedactionRange[] {
  const ordered = ranges
    .map((range) => ({
      end: Math.max(0, Math.min(valueLength, range.end)),
      start: Math.max(0, Math.min(valueLength, range.start)),
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: RedactionRange[] = [];

  for (const range of ordered) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && range.start <= previous.end) {
      merged[merged.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, range.end),
      };
    } else {
      merged.push(range);
    }
  }

  return merged;
}

function hasWordBoundaryBefore(value: string, index: number): boolean {
  const previous = value[index - 1];
  return previous === undefined || !isAsciiWordCharacter(previous);
}

function isAsciiLetter(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiWordCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return (
    isAsciiLetter(character) ||
    (code >= 48 && code <= 57) ||
    character === "_"
  );
}

function matchesAsciiLetter(character: string, expectedLowercase: string): boolean {
  const code = character.charCodeAt(0);
  const expected = expectedLowercase.charCodeAt(0);
  return code === expected || code === expected - 32;
}

function isWhitespace(character: string): boolean {
  return character.trim().length === 0;
}

function isValueDelimiter(character: string): boolean {
  return (
    isWhitespace(character) ||
    character === "," ||
    character === ";" ||
    character === "|"
  );
}

function isTerminalControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code <= 31 || code === 127 || (code >= 128 && code <= 159);
}

function isEscapeFinal(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 64 && code <= 95;
}

function isCsiParameter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 48 && code <= 63;
}

function isCsiIntermediate(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 32 && code <= 47;
}

function isCsiFinal(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 64 && code <= 126;
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
