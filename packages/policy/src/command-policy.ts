import { CodeSentinelConfigSchema } from "../../contracts/src/index.js";

export function isConfiguredVerificationCommand(
  commandId: unknown,
  verificationCommands: unknown,
): boolean {
  if (typeof commandId !== "string") {
    return false;
  }

  const parsedConfig = CodeSentinelConfigSchema.safeParse({ verificationCommands });
  return (
    parsedConfig.success &&
    parsedConfig.data.verificationCommands.some((command) => command.id === commandId)
  );
}
