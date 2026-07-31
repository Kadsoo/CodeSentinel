import { IdentifierSchema, VerificationCommandSchema } from "../../contracts/src/index.js";

export function isConfiguredVerificationCommand(
  commandId: unknown,
  verificationCommands: unknown,
): boolean {
  const normalizedCommandId = normalizeCommandId(commandId);
  if (normalizedCommandId === undefined) {
    return false;
  }

  const parsedCommands = VerificationCommandSchema.array().safeParse(verificationCommands);
  return (
    parsedCommands.success &&
    new Set(parsedCommands.data.map((command) => command.id)).size === parsedCommands.data.length &&
    parsedCommands.data.some((command) => command.id === normalizedCommandId)
  );
}

function normalizeCommandId(value: unknown): string | undefined {
  if (typeof value !== "string" || hasControlCharacter(value)) {
    return undefined;
  }

  const parsedId = IdentifierSchema.safeParse(value);
  return parsedId.success ? parsedId.data : undefined;
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
