import {
  MAX_PERSISTED_SUMMARY_CHARACTERS,
  MAX_PERSISTED_TEXT_INPUT_CHARACTERS,
  REDACTED_VALUE,
} from "./constants.js";
import { persistenceError } from "./errors.js";

export function redactText(value: string): string {
  if (typeof value !== "string" || value.length > MAX_PERSISTED_TEXT_INPUT_CHARACTERS) {
    throw persistenceError("INVALID_PERSISTENCE_INPUT");
  }

  return value
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\bBearer\s+[^\s,;}]+/giu, `Bearer ${REDACTED_VALUE}`)
    .replace(
      /(\b(?:authorization|(?:[a-z][a-z0-9_.-]*)?(?:key|token|secret|password|passwd|pwd|credential))\b\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/giu,
      `$1${REDACTED_VALUE}`,
    )
    .replace(/\b(?:sk-|sk_|pk_|rk_|ghp_)[a-z0-9_-]{12,}\b/giu, REDACTED_VALUE)
    .replace(/(?<![a-z0-9+/_=-])[a-z0-9+/_=-]{32,}(?![a-z0-9+/_=-])/giu, REDACTED_VALUE)
    .slice(0, MAX_PERSISTED_SUMMARY_CHARACTERS);
}
