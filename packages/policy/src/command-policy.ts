import { VerificationCommandSchema } from "../../contracts/src/index.js";
import type { VerificationCommand } from "../../contracts/src/index.js";

const PACKAGE_MANAGER_EXECUTABLES = new Set([
  "bun",
  "bun.bat",
  "bun.cmd",
  "bun.exe",
  "npm",
  "npm.bat",
  "npm.cmd",
  "npm.exe",
  "pnpm",
  "pnpm.bat",
  "pnpm.cmd",
  "pnpm.exe",
  "yarn",
  "yarn.bat",
  "yarn.cmd",
  "yarn.exe",
]);

const SAFE_PACKAGE_MANAGER_COMMANDS = new Set(["t", "test"]);
const SAFE_PACKAGE_MANAGER_SCRIPT_COMMANDS = new Set(["run", "run-script"]);
const SAFE_PACKAGE_MANAGER_SCRIPTS = new Set(["check", "lint", "test", "typecheck", "verify"]);
const CONTROL_TOKEN = /[\0&|;<>`\r\n]/u;

export function isConfiguredVerificationCommand(
  commandId: string,
  verificationCommands: readonly VerificationCommand[],
): boolean {
  const normalizedCommandId = normalizeIdentifier(commandId);
  if (normalizedCommandId === undefined || !Array.isArray(verificationCommands)) {
    return false;
  }

  const parsedCommands = parseVerificationCommands(verificationCommands);
  const command = parsedCommands?.find((candidate) => candidate.id === normalizedCommandId);
  return command !== undefined && isSafeVerificationCommand(command);
}

function parseVerificationCommands(
  verificationCommands: readonly VerificationCommand[],
): readonly VerificationCommand[] | undefined {
  const commandIds = new Set<string>();
  const parsedCommands: VerificationCommand[] = [];

  for (const command of verificationCommands) {
    const parsedCommand = VerificationCommandSchema.safeParse(command);
    if (!parsedCommand.success || commandIds.has(parsedCommand.data.id)) {
      return undefined;
    }

    commandIds.add(parsedCommand.data.id);
    parsedCommands.push(parsedCommand.data);
  }

  return parsedCommands;
}

function isSafeVerificationCommand(command: VerificationCommand): boolean {
  if (
    hasControlToken(command.executable) ||
    command.args.some((argument) => hasControlToken(argument))
  ) {
    return false;
  }

  const executable = normalizeExecutable(command.executable);
  return (
    executable !== undefined &&
    PACKAGE_MANAGER_EXECUTABLES.has(executable) &&
    isSafePackageManagerCommand(command.args)
  );
}

function isSafePackageManagerCommand(args: readonly string[]): boolean {
  const entrypoint = args[0];
  if (entrypoint === undefined) {
    return false;
  }

  if (SAFE_PACKAGE_MANAGER_COMMANDS.has(entrypoint)) {
    return args.length === 1;
  }

  if (!SAFE_PACKAGE_MANAGER_SCRIPT_COMMANDS.has(entrypoint)) {
    return false;
  }

  const script = args[1];
  return args.length === 2 && script !== undefined && SAFE_PACKAGE_MANAGER_SCRIPTS.has(script);
}

function normalizeExecutable(value: string): string | undefined {
  return value.length === 0 || value.includes("/") || value.includes("\\") || /[. ]$/u.test(value)
    ? undefined
    : value;
}

function hasControlToken(value: string): boolean {
  return CONTROL_TOKEN.test(value) || value.includes("$(");
}

function normalizeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalizedValue = value.trim();
  return normalizedValue.length === 0 ? undefined : normalizedValue;
}
