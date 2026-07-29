import { z } from "zod";
import { IdentifierSchema } from "./action.js";

export const MAX_VERIFICATION_TIMEOUT_MS = 60_000;
export const MAX_VERIFICATION_OUTPUT_BYTES = 65_536;

const VerificationIdSchema = z
  .string()
  .max(128)
  .refine((value) => !hasControlCharacter(value))
  .pipe(IdentifierSchema);
const NpmScriptSchema = z.enum(["check", "lint", "test", "typecheck", "verify"]);
const NpmArgumentsSchema = z.union([
  z.tuple([z.literal("test")]),
  z.tuple([z.union([z.literal("run"), z.literal("run-script")]), NpmScriptSchema]),
]);

export const VerificationCommandSchema = z
  .object({
    id: VerificationIdSchema,
    launcher: z.literal("node_npm_cli"),
    args: NpmArgumentsSchema,
    timeoutMs: z.number().int().safe().positive().max(MAX_VERIFICATION_TIMEOUT_MS),
    maxOutputBytes: z.number().int().safe().positive().max(MAX_VERIFICATION_OUTPUT_BYTES),
  })
  .strict();

type VerificationCommandArgs =
  | readonly ["test"]
  | readonly ["run" | "run-script", "check" | "lint" | "test" | "typecheck" | "verify"];

export type VerificationCommand = Readonly<{
  id: string;
  launcher: "node_npm_cli";
  args: VerificationCommandArgs;
  timeoutMs: number;
  maxOutputBytes: number;
}>;

const VerificationCommandsSchema = z
  .array(VerificationCommandSchema)
  .min(1)
  .superRefine((commands, context) => {
    const ids = new Set<string>();

    commands.forEach((command, index) => {
      if (ids.has(command.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: "Verification command ids must be unique.",
        });
      }

      ids.add(command.id);
    });
  });

export const CodeSentinelConfigSchema = z
  .object({
    verificationCommands: VerificationCommandsSchema,
  })
  .strict();

export type CodeSentinelConfig = z.infer<typeof CodeSentinelConfigSchema>;

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
