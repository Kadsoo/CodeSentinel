import { z } from "zod";
import { IdentifierSchema } from "./action.js";

const NonEmptyString = z.string().trim().min(1);
const PositiveSafeInteger = z.number().int().safe().positive();

export const VerificationCommandSchema = z
  .object({
    id: IdentifierSchema,
    executable: NonEmptyString,
    args: z.array(z.string()),
    timeoutMs: PositiveSafeInteger,
    maxOutputBytes: PositiveSafeInteger,
  })
  .strict();

export type VerificationCommand = z.infer<typeof VerificationCommandSchema>;

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
