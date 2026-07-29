import type { ProviderMessage, ProviderRequest } from "../../providers/src/index.js";
import type { SessionPhase } from "./types.js";

export const MAX_CONTEXT_CHARACTERS = 4_096;
export const MAX_FEEDBACK_ITEMS = 3;

const MAX_TASK_SUMMARY_CHARACTERS = 768;
const MAX_COMMAND_ID_CHARACTERS = 128;
const MAX_FEEDBACK_SUMMARY_CHARACTERS = 1_000;
const BEARER_TOKEN = /\bBearer\s+[^\s,;]+/giu;
const NAMED_SECRET_VALUE =
  /(\b(?:authorization|(?:[a-z][a-z0-9_.-]*)?(?:key|token|secret|password|passwd|pwd|credential))\b\s*[:=]\s*)[^\s,;]+/giu;
const LONG_KEY_LIKE_VALUE =
  /(?<![a-z0-9+_/-])(?:[a-z0-9+_/-]{30,}={1,2}|[a-z0-9+_/-]{32,}|(?:sk|pk|rk|ghp)_[a-z0-9_-]{12,})(?![a-z0-9+_/-])/giu;
const TRUNCATION_MARKER = "…";

const systemMessage: ProviderMessage = Object.freeze({
  role: "system",
  content:
    "Return exactly one Action JSON object. Do not include prose, Markdown, code fences, or multiple JSON objects.",
});

export type ProviderFeedback = Readonly<{
  kind: string;
  summary: string;
}>;

export type BuildProviderRequestInput = Readonly<{
  taskSummary: string;
  phase: SessionPhase;
  verificationCommandId?: string;
  feedback: readonly ProviderFeedback[];
}>;

export function buildProviderRequest(input: BuildProviderRequestInput): ProviderRequest {
  const feedback = input.feedback
    .slice(-MAX_FEEDBACK_ITEMS)
    .map(
      (item) =>
        `- ${limit(sanitize(item.kind), 96)}: ${limit(
          sanitize(item.summary),
          MAX_FEEDBACK_SUMMARY_CHARACTERS,
        )}`,
    );
  const userContent = limit(
    [
      `Task summary: ${limit(sanitize(input.taskSummary), MAX_TASK_SUMMARY_CHARACTERS)}`,
      `Phase: ${sanitize(input.phase)}`,
      `Verification command ID: ${limit(
        sanitize(input.verificationCommandId ?? "unselected"),
        MAX_COMMAND_ID_CHARACTERS,
      )}`,
      "Feedback:",
      feedback.length === 0 ? "- none" : feedback.join("\n"),
    ].join("\n"),
    MAX_CONTEXT_CHARACTERS,
  );
  const userMessage: ProviderMessage = Object.freeze({ role: "user", content: userContent });

  return Object.freeze({ messages: Object.freeze([systemMessage, userMessage]) });
}

function sanitize(value: string): string {
  return removeControlCharacters(value)
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .replace(NAMED_SECRET_VALUE, "$1[REDACTED]")
    .replace(LONG_KEY_LIKE_VALUE, "[REDACTED]");
}

function removeControlCharacters(value: string): string {
  const visibleCharacters: string[] = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 31 || codePoint === 127 || (codePoint >= 128 && codePoint <= 159))
    ) {
      continue;
    }
    visibleCharacters.push(character);
  }

  return visibleCharacters.join("");
}

function limit(value: string, maximum: number): string {
  if (value.length <= maximum) {
    return value;
  }

  return `${value.slice(0, maximum - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}
