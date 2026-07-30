import {
  MAX_PERSISTED_SUMMARY_CHARACTERS,
  MAX_PERSISTED_TEXT_INPUT_CHARACTERS,
  REDACTED_VALUE,
} from "./constants.js";
import { persistenceError } from "./errors.js";

const SENSITIVE_NAME_SUFFIXES = Object.freeze([
  "key",
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "credential",
] as const);

const KNOWN_TOKEN_PREFIXES = Object.freeze([
  "sk-",
  "sk_",
  "pk_",
  "rk_",
  "ghp_",
] as const);

const CONTROL_OR_FORMAT_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}]/u;
const CONTROL_OR_FORMAT_CHARACTERS_PATTERN = /[\p{Cc}\p{Cf}]/gu;

type RedactionRange = Readonly<{
  start: number;
  end: number;
}>;

type QuotedSegment = Readonly<{
  start: number;
  contentStart: number;
  contentEnd: number;
  end: number;
  decoded: string;
}>;

type LexedText = Readonly<{
  segments: readonly QuotedSegment[];
  segmentByStart: ReadonlyMap<number, QuotedSegment>;
}>;

type LexOutcome =
  | Readonly<{ kind: "safe"; lexed: LexedText }>
  | Readonly<{ kind: "ambiguous" }>;

type ScanOutcome =
  | Readonly<{ kind: "safe" }>
  | Readonly<{ kind: "ambiguous" }>;

type ValueScanOutcome =
  | Readonly<{ kind: "safe"; end: number }>
  | Readonly<{ kind: "ambiguous" }>;

type MalformedKeyCandidate = Readonly<{
  end: number;
  sensitive: boolean;
}>;

function isAsciiLetter(character: string): boolean {
  const code = character.charCodeAt(0);
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function isAsciiDigit(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isAsciiWordCharacter(character: string): boolean {
  return (
    isAsciiLetter(character) ||
    isAsciiDigit(character) ||
    character === "_"
  );
}

function isNameCharacter(character: string): boolean {
  return (
    isAsciiWordCharacter(character) ||
    character === "." ||
    character === "-"
  );
}

function isKnownTokenSuffixCharacter(character: string): boolean {
  return (
    isAsciiLetter(character) ||
    isAsciiDigit(character) ||
    character === "_" ||
    character === "-"
  );
}

function isLongTokenCharacter(character: string): boolean {
  return (
    isKnownTokenSuffixCharacter(character) ||
    character === "+" ||
    character === "/" ||
    character === "="
  );
}

function isHexadecimalCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return (
    isAsciiDigit(character) ||
    (code >= 65 && code <= 70) ||
    (code >= 97 && code <= 102)
  );
}

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && character.trim().length === 0;
}

function isControlOrFormatCharacter(
  character: string | undefined,
): boolean {
  return (
    character !== undefined &&
    CONTROL_OR_FORMAT_CHARACTER_PATTERN.test(character)
  );
}

function skipWhitespace(
  value: string,
  start: number,
  limit = value.length,
): number {
  let cursor = start;
  while (cursor < limit && isWhitespace(value[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function normalizedSensitiveName(value: string): string {
  return value
    .replace(CONTROL_OR_FORMAT_CHARACTERS_PATTERN, "")
    .toLowerCase();
}

function isSensitiveName(value: string): boolean {
  const normalized = normalizedSensitiveName(value);
  return (
    normalized === "authorization" ||
    SENSITIVE_NAME_SUFFIXES.some((suffix) =>
      normalized.endsWith(suffix)
    )
  );
}

function decodeQuotedEscape(
  character: string,
): string | undefined {
  switch (character) {
    case "\"":
    case "'":
    case "\\":
    case "/":
      return character;
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    default:
      return undefined;
  }
}

function scanQuotedSegment(
  value: string,
  start: number,
): QuotedSegment | undefined {
  const quote = value[start]!;
  const decoded: string[] = [];
  for (let cursor = start + 1; cursor < value.length; ) {
    const character = value[cursor]!;
    if (character === quote) {
      return {
        start,
        contentStart: start + 1,
        contentEnd: cursor,
        end: cursor + 1,
        decoded: decoded.join(""),
      };
    }
    if (character !== "\\") {
      decoded.push(character);
      cursor += 1;
      continue;
    }

    const escaped = value[cursor + 1];
    if (escaped === undefined) {
      return undefined;
    }
    if (escaped === "u") {
      const hexadecimal = value.slice(cursor + 2, cursor + 6);
      if (
        hexadecimal.length !== 4 ||
        ![...hexadecimal].every(isHexadecimalCharacter)
      ) {
        return undefined;
      }
      decoded.push(
        String.fromCharCode(Number.parseInt(hexadecimal, 16)),
      );
      cursor += 6;
      continue;
    }

    const decodedEscape = decodeQuotedEscape(escaped);
    if (decodedEscape === undefined) {
      return undefined;
    }
    decoded.push(decodedEscape);
    cursor += 2;
  }
  return undefined;
}

function decodeQuotedRange(
  value: string,
  start: number,
  end: number,
): string | undefined {
  const decoded: string[] = [];
  for (let cursor = start; cursor < end; ) {
    const character = value[cursor]!;
    if (character !== "\\") {
      decoded.push(character);
      cursor += 1;
      continue;
    }
    const escaped = value[cursor + 1];
    if (escaped === undefined || cursor + 1 >= end) {
      return undefined;
    }
    if (escaped === "u") {
      const hexadecimal = value.slice(cursor + 2, cursor + 6);
      if (
        cursor + 6 > end ||
        hexadecimal.length !== 4 ||
        ![...hexadecimal].every(isHexadecimalCharacter)
      ) {
        return undefined;
      }
      decoded.push(
        String.fromCharCode(Number.parseInt(hexadecimal, 16)),
      );
      cursor += 6;
      continue;
    }
    const decodedEscape = decodeQuotedEscape(escaped);
    if (decodedEscape === undefined) {
      return undefined;
    }
    decoded.push(decodedEscape);
    cursor += 2;
  }
  return decoded.join("");
}

function hasShiftedSensitiveQuoteCandidate(
  value: string,
  segments: readonly QuotedSegment[],
): boolean {
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1]!;
    const next = segments[index]!;
    if (value[previous.end - 1] !== value[next.start]) {
      continue;
    }
    const delimiter = skipWhitespace(value, next.start + 1);
    if (value[delimiter] !== ":" && value[delimiter] !== "=") {
      continue;
    }
    const decoded = decodeQuotedRange(
      value,
      previous.end,
      next.start,
    );
    if (decoded === undefined || isSensitiveName(decoded)) {
      return true;
    }
    const candidateEnd = hasSensitiveNamePrefix(decoded);
    if (candidateEnd !== undefined) {
      return true;
    }
  }
  return false;
}

function lexText(value: string): LexOutcome {
  const segments: QuotedSegment[] = [];
  const segmentByStart = new Map<number, QuotedSegment>();
  for (let cursor = 0; cursor < value.length; ) {
    if (value[cursor] !== "\"" && value[cursor] !== "'") {
      cursor += 1;
      continue;
    }
    const segment = scanQuotedSegment(value, cursor);
    if (segment === undefined) {
      return { kind: "ambiguous" };
    }
    segments.push(segment);
    segmentByStart.set(segment.start, segment);
    cursor = segment.end;
  }
  if (hasShiftedSensitiveQuoteCandidate(value, segments)) {
    return { kind: "ambiguous" };
  }
  return {
    kind: "safe",
    lexed: { segments, segmentByStart },
  };
}

function previousBearerBoundaryCharacter(
  value: string,
  start: number,
): string | undefined {
  let cursor = start - 1;
  while (
    cursor >= 0 &&
    isControlOrFormatCharacter(value[cursor]) &&
    !isWhitespace(value[cursor])
  ) {
    cursor -= 1;
  }
  return cursor >= 0 ? value[cursor] : undefined;
}

function matchBearerKeyword(
  value: string,
  start: number,
): number | undefined {
  const keyword = "bearer";
  let cursor = start;
  for (let index = 0; index < keyword.length; index += 1) {
    if (index > 0) {
      while (isControlOrFormatCharacter(value[cursor])) {
        cursor += 1;
      }
    }
    if (value[cursor]?.toLowerCase() !== keyword[index]) {
      return undefined;
    }
    cursor += 1;
  }
  return cursor;
}

function isBearerTokenDelimiter(
  character: string | undefined,
): boolean {
  if (character === undefined) {
    return true;
  }
  if (isControlOrFormatCharacter(character)) {
    return false;
  }
  return (
    isWhitespace(character) ||
    character === "\"" ||
    character === "'" ||
    character === "," ||
    character === ";" ||
    character === "{" ||
    character === "}" ||
    character === "[" ||
    character === "]" ||
    character === "(" ||
    character === ")" ||
    character === "&" ||
    character === "|" ||
    character === "<" ||
    character === ">"
  );
}

function replaceBearerRanges(
  value: string,
  ranges: readonly RedactionRange[],
): string {
  if (ranges.length === 0) {
    return value;
  }
  const output: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    output.push(
      value.slice(cursor, range.start),
      ` ${REDACTED_VALUE}`,
    );
    cursor = range.end;
  }
  output.push(value.slice(cursor));
  return output.join("");
}

function redactBearerTokens(value: string): string {
  const ranges: RedactionRange[] = [];
  for (let index = 0; index < value.length; ) {
    if (value[index]?.toLowerCase() !== "b") {
      index += 1;
      continue;
    }
    const previous = previousBearerBoundaryCharacter(value, index);
    if (previous !== undefined && isAsciiWordCharacter(previous)) {
      index += 1;
      continue;
    }
    const keywordEnd = matchBearerKeyword(value, index);
    if (keywordEnd === undefined) {
      index += 1;
      continue;
    }

    let tokenStart = keywordEnd;
    let hasSeparator = false;
    while (
      isWhitespace(value[tokenStart]) ||
      isControlOrFormatCharacter(value[tokenStart])
    ) {
      hasSeparator = true;
      tokenStart += 1;
    }
    if (
      !hasSeparator ||
      isBearerTokenDelimiter(value[tokenStart])
    ) {
      index = keywordEnd;
      continue;
    }

    let tokenEnd = tokenStart;
    while (!isBearerTokenDelimiter(value[tokenEnd])) {
      tokenEnd += 1;
    }
    ranges.push({ start: keywordEnd, end: tokenEnd });
    index = tokenEnd;
  }
  return replaceBearerRanges(value, ranges);
}

function createRedactionMask(length: number): Int32Array {
  return new Int32Array(length + 1);
}

function markRedaction(
  mask: Int32Array,
  start: number,
  end: number,
): void {
  if (end <= start) {
    return;
  }
  mask[start] = (mask[start] ?? 0) + 1;
  mask[end] = (mask[end] ?? 0) - 1;
}

function applyRedactionMask(
  value: string,
  mask: Int32Array,
): string {
  const output: string[] = [];
  let active = 0;
  let sliceStart = 0;
  let hasRedaction = false;
  for (let index = 0; index <= value.length; index += 1) {
    const previous = active;
    active += mask[index] ?? 0;
    if (previous === 0 && active > 0) {
      output.push(value.slice(sliceStart, index), REDACTED_VALUE);
      hasRedaction = true;
    } else if (previous > 0 && active === 0) {
      sliceStart = index;
    }
  }
  if (!hasRedaction) {
    return value;
  }
  output.push(value.slice(sliceStart));
  return output.join("");
}

function maskedPositions(mask: Int32Array): Uint8Array {
  const positions = new Uint8Array(mask.length - 1);
  let active = 0;
  for (let index = 0; index < positions.length; index += 1) {
    active += mask[index] ?? 0;
    if (active > 0) {
      positions[index] = 1;
    }
  }
  return positions;
}

function hasJsonValueBoundary(
  value: string,
  start: number,
): boolean {
  const cursor = skipWhitespace(value, start);
  return (
    cursor === value.length ||
    value[cursor] === "," ||
    value[cursor] === "}" ||
    value[cursor] === "]"
  );
}

function isAssignmentValueDelimiter(
  character: string | undefined,
): boolean {
  return (
    character === undefined ||
    isWhitespace(character) ||
    character === "," ||
    character === ";" ||
    character === "|" ||
    character === "&" ||
    character === "}" ||
    character === "]" ||
    character === ")"
  );
}

function hasAssignmentValueBoundary(
  value: string,
  start: number,
): boolean {
  return isAssignmentValueDelimiter(value[start]);
}

function scanUnquotedSensitiveValue(
  value: string,
  start: number,
  limit: number,
  endIsBoundary: boolean,
): ValueScanOutcome {
  if (value.startsWith(REDACTED_VALUE, start)) {
    const end = start + REDACTED_VALUE.length;
    if (
      end <= limit &&
      (end < limit
        ? isAssignmentValueDelimiter(value[end])
        : endIsBoundary)
    ) {
      return { kind: "safe", end };
    }
    return { kind: "ambiguous" };
  }

  let cursor = start;
  while (cursor < limit) {
    const character = value[cursor]!;
    if (
      character === "\\" ||
      character === "\"" ||
      character === "'" ||
      character === "{" ||
      character === "["
    ) {
      return { kind: "ambiguous" };
    }
    if (isAssignmentValueDelimiter(character)) {
      return cursor > start
        ? { kind: "safe", end: cursor }
        : { kind: "ambiguous" };
    }
    cursor += 1;
  }
  return cursor > start && endIsBoundary
    ? { kind: "safe", end: cursor }
    : { kind: "ambiguous" };
}

function isCanonicalBearerRedaction(
  value: string,
  start: number,
  limit: number,
): number | undefined {
  const keywordEnd = start + "bearer".length;
  if (
    keywordEnd + 1 + REDACTED_VALUE.length > limit ||
    value.slice(start, keywordEnd).toLowerCase() !== "bearer" ||
    value[keywordEnd] !== " "
  ) {
    return undefined;
  }
  const end = keywordEnd + 1 + REDACTED_VALUE.length;
  if (
    !value.startsWith(REDACTED_VALUE, keywordEnd + 1) ||
    (end < limit && !hasAssignmentValueBoundary(value, end))
  ) {
    return undefined;
  }
  return end;
}

function hasSensitiveNamePrefix(
  value: string,
): number | undefined {
  let nameEnd = 0;
  while (
    nameEnd < value.length &&
    isNameCharacter(value[nameEnd]!)
  ) {
    nameEnd += 1;
  }
  if (
    nameEnd === 0 ||
    !isSensitiveName(value.slice(0, nameEnd))
  ) {
    return undefined;
  }
  return nameEnd;
}

function scanQuotedSensitiveAssignments(
  value: string,
  lexed: LexedText,
  mask: Int32Array,
): ScanOutcome {
  for (const key of lexed.segments) {
    let cursor = skipWhitespace(value, key.end);
    const hasAssignment =
      value[cursor] === ":" || value[cursor] === "=";
    if (!isSensitiveName(key.decoded)) {
      const candidateEnd = hasSensitiveNamePrefix(key.decoded);
      const candidateRemainder =
        candidateEnd === undefined
          ? ""
          : key.decoded.slice(candidateEnd);
      if (
        candidateEnd !== undefined &&
        (hasAssignment ||
          candidateRemainder.includes(":") ||
          candidateRemainder.includes("="))
      ) {
        return { kind: "ambiguous" };
      }
      continue;
    }
    if (!hasAssignment) {
      continue;
    }

    cursor = skipWhitespace(value, cursor + 1);
    const quotedValue = lexed.segmentByStart.get(cursor);
    if (quotedValue !== undefined) {
      if (!hasJsonValueBoundary(value, quotedValue.end)) {
        return { kind: "ambiguous" };
      }
      if (
        normalizedSensitiveName(key.decoded) !== "authorization" ||
        quotedValue.decoded.toLowerCase() !==
          `bearer ${REDACTED_VALUE.toLowerCase()}`
      ) {
        markRedaction(
          mask,
          quotedValue.contentStart,
          quotedValue.contentEnd,
        );
      }
      continue;
    }

    const unquoted = scanUnquotedSensitiveValue(
      value,
      cursor,
      value.length,
      true,
    );
    if (
      unquoted.kind === "ambiguous" ||
      !hasJsonValueBoundary(value, unquoted.end)
    ) {
      return { kind: "ambiguous" };
    }
    markRedaction(mask, cursor, unquoted.end);
  }
  return { kind: "safe" };
}

function scanMalformedBareKeyCandidate(
  value: string,
  start: number,
  limit: number,
): MalformedKeyCandidate {
  let cursor = start;
  let sawEscape = false;
  while (
    cursor < limit &&
    !isWhitespace(value[cursor]) &&
    value[cursor] !== ":" &&
    value[cursor] !== "=" &&
    value[cursor] !== "\"" &&
    value[cursor] !== "'"
  ) {
    sawEscape ||= value[cursor] === "\\";
    cursor += 1;
  }
  if (
    !sawEscape ||
    (value[cursor] !== ":" && value[cursor] !== "=")
  ) {
    return { end: cursor, sensitive: false };
  }
  return { end: cursor, sensitive: true };
}

function scanBareAssignmentsInRange(
  value: string,
  start: number,
  end: number,
  endIsBoundary: boolean,
  lexed: LexedText,
  mask: Int32Array,
): ScanOutcome {
  for (let index = start; index < end; ) {
    const character = value[index]!;
    const previous = value[index - 1];
    if (
      !isAsciiLetter(character) ||
      (previous !== undefined && isAsciiWordCharacter(previous))
    ) {
      index += 1;
      continue;
    }

    let nameEnd = index + 1;
    while (
      nameEnd < end &&
      isNameCharacter(value[nameEnd]!)
    ) {
      nameEnd += 1;
    }
    const name = value.slice(index, nameEnd);
    if (!isSensitiveName(name)) {
      if (value[nameEnd] !== "\\") {
        index = nameEnd;
        continue;
      }
      const malformed = scanMalformedBareKeyCandidate(
        value,
        index,
        end,
      );
      if (malformed.sensitive) {
        return { kind: "ambiguous" };
      }
      index = Math.max(nameEnd, malformed.end);
      continue;
    }

    let cursor = skipWhitespace(value, nameEnd, end);
    if (value[cursor] !== ":" && value[cursor] !== "=") {
      if (value[cursor] === "\\") {
        const malformed = scanMalformedBareKeyCandidate(
          value,
          index,
          end,
        );
        if (malformed.sensitive) {
          return { kind: "ambiguous" };
        }
        index = Math.max(nameEnd, malformed.end);
        continue;
      }
      index = nameEnd;
      continue;
    }

    cursor = skipWhitespace(value, cursor + 1, end);
    const quotedValue = lexed.segmentByStart.get(cursor);
    if (quotedValue !== undefined) {
      if (!hasAssignmentValueBoundary(value, quotedValue.end)) {
        return { kind: "ambiguous" };
      }
      markRedaction(
        mask,
        quotedValue.contentStart,
        quotedValue.contentEnd,
      );
      index = quotedValue.end;
      continue;
    }

    if (normalizedSensitiveName(name) === "authorization") {
      const bearerEnd = isCanonicalBearerRedaction(
        value,
        cursor,
        end,
      );
      if (bearerEnd !== undefined) {
        index = bearerEnd;
        continue;
      }
    }

    const unquoted = scanUnquotedSensitiveValue(
      value,
      cursor,
      end,
      endIsBoundary,
    );
    if (unquoted.kind === "ambiguous") {
      return { kind: "ambiguous" };
    }
    markRedaction(mask, cursor, unquoted.end);
    index = unquoted.end;
  }
  return { kind: "safe" };
}

function scanBareAssignments(
  value: string,
  lexed: LexedText,
  mask: Int32Array,
): ScanOutcome {
  let bareStart = 0;
  for (const segment of lexed.segments) {
    const bare = scanBareAssignmentsInRange(
      value,
      bareStart,
      segment.start,
      false,
      lexed,
      mask,
    );
    if (bare.kind === "ambiguous") {
      return bare;
    }
    const content = scanBareAssignmentsInRange(
      value,
      segment.contentStart,
      segment.contentEnd,
      true,
      lexed,
      mask,
    );
    if (content.kind === "ambiguous") {
      return content;
    }
    bareStart = segment.end;
  }
  return scanBareAssignmentsInRange(
    value,
    bareStart,
    value.length,
    true,
    lexed,
    mask,
  );
}

function matchesKnownPrefix(
  value: string,
  start: number,
  end: number,
  protectedPositions: Uint8Array,
): number | undefined {
  const previous = value[start - 1];
  if (previous !== undefined && isAsciiWordCharacter(previous)) {
    return undefined;
  }
  for (const prefix of KNOWN_TOKEN_PREFIXES) {
    let prefixIsUnprotected = true;
    for (
      let cursor = start;
      cursor < start + prefix.length && cursor < end;
      cursor += 1
    ) {
      if (protectedPositions[cursor] !== 0) {
        prefixIsUnprotected = false;
        break;
      }
    }
    if (
      start + prefix.length > end ||
      !prefixIsUnprotected ||
      value.slice(start, start + prefix.length).toLowerCase() !==
        prefix
    ) {
      continue;
    }
    let cursor = start + prefix.length;
    while (
      cursor < end &&
      protectedPositions[cursor] === 0 &&
      isKnownTokenSuffixCharacter(value[cursor]!)
    ) {
      cursor += 1;
    }
    if (cursor - (start + prefix.length) >= 12) {
      return cursor;
    }
  }
  return undefined;
}

function scanTokenPatternsInRange(
  value: string,
  start: number,
  end: number,
  mask: Int32Array,
  protectedPositions: Uint8Array,
): void {
  for (let index = start; index < end; ) {
    if (protectedPositions[index] !== 0) {
      index += 1;
      continue;
    }
    const knownEnd = matchesKnownPrefix(
      value,
      index,
      end,
      protectedPositions,
    );
    if (knownEnd !== undefined) {
      markRedaction(mask, index, knownEnd);
      index = knownEnd;
      continue;
    }
    if (!isLongTokenCharacter(value[index]!)) {
      index += 1;
      continue;
    }
    let tokenEnd = index + 1;
    while (
      tokenEnd < end &&
      protectedPositions[tokenEnd] === 0 &&
      isLongTokenCharacter(value[tokenEnd]!)
    ) {
      tokenEnd += 1;
    }
    if (tokenEnd - index >= 32) {
      markRedaction(mask, index, tokenEnd);
    } else {
      for (
        let candidate = index + 1;
        candidate < tokenEnd;
      ) {
        const embeddedKnownEnd = matchesKnownPrefix(
          value,
          candidate,
          tokenEnd,
          protectedPositions,
        );
        if (embeddedKnownEnd === undefined) {
          candidate += 1;
          continue;
        }
        markRedaction(mask, candidate, embeddedKnownEnd);
        candidate = embeddedKnownEnd;
      }
    }
    index = tokenEnd;
  }
}

function scanTokenPatterns(
  value: string,
  lexed: LexedText,
  mask: Int32Array,
  protectedPositions: Uint8Array,
): void {
  let bareStart = 0;
  for (const segment of lexed.segments) {
    scanTokenPatternsInRange(
      value,
      bareStart,
      segment.start,
      mask,
      protectedPositions,
    );
    scanTokenPatternsInRange(
      value,
      segment.contentStart,
      segment.contentEnd,
      mask,
      protectedPositions,
    );
    bareStart = segment.end;
  }
  scanTokenPatternsInRange(
    value,
    bareStart,
    value.length,
    mask,
    protectedPositions,
  );
}

export function redactText(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_PERSISTED_TEXT_INPUT_CHARACTERS
  ) {
    throw persistenceError("INVALID_PERSISTENCE_INPUT");
  }

  const bearerProtected = redactBearerTokens(value);
  const normalized = bearerProtected.replace(
    CONTROL_OR_FORMAT_CHARACTERS_PATTERN,
    "",
  );
  const bearerRedacted = redactBearerTokens(normalized);
  const lexical = lexText(bearerRedacted);
  if (lexical.kind === "ambiguous") {
    return REDACTED_VALUE;
  }

  const mask = createRedactionMask(bearerRedacted.length);
  const quotedAssignments = scanQuotedSensitiveAssignments(
    bearerRedacted,
    lexical.lexed,
    mask,
  );
  if (quotedAssignments.kind === "ambiguous") {
    return REDACTED_VALUE;
  }
  const bareAssignments = scanBareAssignments(
    bearerRedacted,
    lexical.lexed,
    mask,
  );
  if (bareAssignments.kind === "ambiguous") {
    return REDACTED_VALUE;
  }
  scanTokenPatterns(
    bearerRedacted,
    lexical.lexed,
    mask,
    maskedPositions(mask),
  );

  return applyRedactionMask(bearerRedacted, mask).slice(
    0,
    MAX_PERSISTED_SUMMARY_CHARACTERS,
  );
}
