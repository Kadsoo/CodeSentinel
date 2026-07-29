import { z } from "zod";

const NonEmptyString = z.string().refine((value) => value.trim().length > 0, {
  message: "Must not be blank.",
});
export const IdentifierSchema = z.string().trim().min(1);
const Sha256Hash = z.string().regex(/^[0-9a-fA-F]{64}$/);
const VerificationCommandIdSchema = z
  .string()
  .refine((value) => !hasControlCharacter(value))
  .pipe(IdentifierSchema);

const ListFilesActionSchema = z
  .object({
    kind: z.literal("list_files"),
    path: NonEmptyString.optional(),
    depth: z.number().int().positive().optional(),
  })
  .strict();

const ReadFileActionSchema = z
  .object({
    kind: z.literal("read_file"),
    path: NonEmptyString,
  })
  .strict();

const SearchTextActionSchema = z
  .object({
    kind: z.literal("search_text"),
    query: NonEmptyString,
    path: NonEmptyString.optional(),
    maxResults: z.number().int().positive().optional(),
  })
  .strict();

const ProposePatchActionSchema = z
  .object({
    kind: z.literal("propose_patch"),
    path: NonEmptyString,
    baseHash: Sha256Hash,
    patch: z.string().min(1),
    reason: NonEmptyString,
  })
  .strict();

const ApplyApprovedPatchActionSchema = z
  .object({
    kind: z.literal("apply_approved_patch"),
    approvalId: IdentifierSchema,
    path: NonEmptyString,
    baseHash: Sha256Hash,
    patch: z.string().min(1),
  })
  .strict();

const RunVerificationActionSchema = z
  .object({
    kind: z.literal("run_verification"),
    commandId: VerificationCommandIdSchema,
  })
  .strict();

const FinishActionSchema = z
  .object({
    kind: z.literal("finish"),
    outcome: z.enum(["completed", "needs_human", "not_reproducible", "blocked", "failed"]),
    summary: NonEmptyString,
  })
  .strict();

export const ActionSchema = z.discriminatedUnion("kind", [
  ListFilesActionSchema,
  ReadFileActionSchema,
  SearchTextActionSchema,
  ProposePatchActionSchema,
  ApplyApprovedPatchActionSchema,
  RunVerificationActionSchema,
  FinishActionSchema,
]);

export type Action = z.infer<typeof ActionSchema>;

export const TaskKindSchema = z.enum(["test_repair", "feature_implementation"]);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const PolicyDecisionSchema = z.enum(["allow", "ask", "deny"]);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const SessionStateSchema = z.enum([
  "created",
  "running",
  "awaiting_approval",
  "completed",
  "blocked",
  "failed",
  "stopped",
]);
export type SessionState = z.infer<typeof SessionStateSchema>;

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
