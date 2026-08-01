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
  hadEscape: boolean;
  hadRawControlOrFormat: boolean;
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

type BearerScanOutcome =
  | Readonly<{
      kind: "safe";
      value: string;
    }>
  | Readonly<{ kind: "ambiguous" }>;

type ValueScanOutcome =
  | Readonly<{ kind: "safe"; end: number }>
  | Readonly<{ kind: "ambiguous" }>;

type SensitiveCandidateSummary = ReadonlyMap<string, number>;

type PotentialAssignmentOutcome =
  | "none"
  | "candidate"
  | "terminal-ambiguous";

type MalformedKeyCandidate = Readonly<{
  end: number;
  sensitive: boolean;
}>;

type CommentProjectionMode =
  | "remove"
  | "preserve-body"
  | "separator";

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
  let hadEscape = false;
  let hadRawControlOrFormat = false;
  for (let cursor = start + 1; cursor < value.length; ) {
    const character = value[cursor]!;
    if (character === quote) {
      return {
        start,
        contentStart: start + 1,
        contentEnd: cursor,
        end: cursor + 1,
        decoded: decoded.join(""),
        hadEscape,
        hadRawControlOrFormat,
      };
    }
    if (character !== "\\") {
      decoded.push(character);
      hadRawControlOrFormat ||=
        isControlOrFormatCharacter(character);
      cursor += 1;
      continue;
    }

    hadEscape = true;
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
      const decodedCharacter = String.fromCharCode(
        Number.parseInt(hexadecimal, 16),
      );
      decoded.push(decodedCharacter);
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
    const semanticCandidate = decoded?.trim();
    if (
      semanticCandidate === undefined ||
      isSensitiveName(semanticCandidate)
    ) {
      return true;
    }
    const candidateEnd = hasSensitiveNamePrefix(
      semanticCandidate,
    );
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

function recordSensitiveCandidate(
  candidates: Map<string, number>,
  candidate: string,
): void {
  candidates.set(
    candidate,
    (candidates.get(candidate) ?? 0) + 1,
  );
}

function hasPotentialAssignmentAfterSensitiveName(
  value: string,
  start: number,
  interpretResidualEscapes: boolean,
  allowAmbiguousJoiners: boolean,
): PotentialAssignmentOutcome {
  let cursor = start;
  while (cursor < value.length) {
    cursor = skipWhitespace(value, cursor);
    if (value[cursor] === ":" || value[cursor] === "=") {
      return "candidate";
    }
    if (value[cursor] === "\"" || value[cursor] === "'") {
      if (!allowAmbiguousJoiners) {
        return "none";
      }
      cursor += 1;
      continue;
    }
    if (
      value[cursor] === "/" &&
      value[cursor + 1] === "*"
    ) {
      if (!allowAmbiguousJoiners) {
        return "none";
      }
      return "terminal-ambiguous";
    }
    if (
      value[cursor] === "/" &&
      value[cursor + 1] === "/"
    ) {
      if (!allowAmbiguousJoiners) {
        return "none";
      }
      return "terminal-ambiguous";
    }
    if (!interpretResidualEscapes || value[cursor] !== "\\") {
      return "none";
    }

    const escaped = value[cursor + 1];
    if (escaped === ":" || escaped === "=") {
      return "candidate";
    }
    if (escaped === "\"" || escaped === "'") {
      cursor += 2;
      continue;
    }
    if (escaped !== "u") {
      return "none";
    }
    const hexadecimal = value.slice(cursor + 2, cursor + 6);
    if (
      hexadecimal.length !== 4 ||
      ![...hexadecimal].every(isHexadecimalCharacter)
    ) {
      return "none";
    }
    const decoded = String.fromCharCode(
      Number.parseInt(hexadecimal, 16),
    );
    if (decoded === ":" || decoded === "=") {
      return "candidate";
    }
    if (decoded !== "\"" && decoded !== "'") {
      return "none";
    }
    cursor += 6;
  }
  return "none";
}

function collectAssignmentCandidates(
  value: string,
  candidates: Map<string, number>,
  interpretResidualEscapes: boolean,
  allowAmbiguousJoiners: boolean,
): void {
  for (let index = 0; index < value.length; ) {
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
      nameEnd < value.length &&
      isNameCharacter(value[nameEnd]!)
    ) {
      nameEnd += 1;
    }
    const name = value.slice(index, nameEnd);
    if (!isSensitiveName(name)) {
      index = nameEnd;
      continue;
    }

    const assignment = hasPotentialAssignmentAfterSensitiveName(
      value,
      nameEnd,
      interpretResidualEscapes,
      allowAmbiguousJoiners,
    );
    if (assignment !== "none") {
      recordSensitiveCandidate(
        candidates,
        `assignment:${normalizedSensitiveName(name)}`,
      );
      if (assignment === "terminal-ambiguous") {
        return;
      }
    }
    index = nameEnd;
  }
}

function isBearerOpeningWrapper(
  character: string | undefined,
): boolean {
  return (
    character === "\"" ||
    character === "'" ||
    character === "[" ||
    character === "{" ||
    character === "(" ||
    character === "<"
  );
}

function bearerClosingWrapper(
  character: string | undefined,
): string | undefined {
  switch (character) {
    case "\"":
      return "\"";
    case "'":
      return "'";
    case "[":
      return "]";
    case "{":
      return "}";
    case "(":
      return ")";
    case "<":
      return ">";
    default:
      return undefined;
  }
}

function isCanonicalRedactedBearerToken(
  value: string,
  start: number,
): boolean {
  if (!value.startsWith(REDACTED_VALUE, start)) {
    return false;
  }
  const end = start + REDACTED_VALUE.length;
  return isBearerTokenDelimiter(value[end]);
}

function collectBearerCandidates(
  value: string,
  candidates: Map<string, number>,
  interpretResidualEscapes: boolean,
): void {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index]?.toLowerCase() !== "b") {
      continue;
    }
    const previous = value[index - 1];
    if (previous !== undefined && isAsciiWordCharacter(previous)) {
      continue;
    }
    const keywordEnd = matchBearerKeyword(value, index);
    if (keywordEnd === undefined) {
      continue;
    }
    let tokenStart = keywordEnd;
    let hasSeparator = false;
    while (isWhitespace(value[tokenStart])) {
      hasSeparator = true;
      tokenStart += 1;
    }
    if (
      !hasSeparator ||
      isCanonicalRedactedBearerToken(value, tokenStart)
    ) {
      continue;
    }
    const tokenStartCharacter = value[tokenStart];
    if (
      tokenStartCharacter === undefined ||
      (!interpretResidualEscapes &&
        tokenStartCharacter === "\\")
    ) {
      continue;
    }
    if (
      !isBearerOpeningWrapper(tokenStartCharacter) &&
      isBearerTokenDelimiter(tokenStartCharacter)
    ) {
      continue;
    }
    const wrapperEnd = bearerClosingWrapper(
      tokenStartCharacter,
    );
    const signatureLimit = Math.min(
      value.length,
      tokenStart + 64,
    );
    let tokenEnd = tokenStart + 1;
    while (tokenEnd < signatureLimit) {
      if (
        wrapperEnd !== undefined
          ? value[tokenEnd] === wrapperEnd
          : isBearerTokenDelimiter(value[tokenEnd])
      ) {
        if (
          wrapperEnd !== undefined &&
          value[tokenEnd] === wrapperEnd
        ) {
          tokenEnd += 1;
        }
        break;
      }
      tokenEnd += 1;
    }
    recordSensitiveCandidate(
      candidates,
      `bearer:${value
        .slice(tokenStart, tokenEnd)
        .toLowerCase()}`,
    );
  }
}

function collectTokenCandidates(
  value: string,
  candidates: Map<string, number>,
): void {
  for (let index = 0; index < value.length; ) {
    if (!isLongTokenCharacter(value[index]!)) {
      index += 1;
      continue;
    }
    let tokenEnd = index + 1;
    while (
      tokenEnd < value.length &&
      isLongTokenCharacter(value[tokenEnd]!)
    ) {
      tokenEnd += 1;
    }
    if (tokenEnd - index >= 32) {
      recordSensitiveCandidate(
        candidates,
        `long:${value.slice(index, tokenEnd)}`,
      );
    }

    for (
      let knownRunStart = index;
      knownRunStart < tokenEnd;
    ) {
      while (
        knownRunStart < tokenEnd &&
        !isKnownTokenSuffixCharacter(value[knownRunStart]!)
      ) {
        knownRunStart += 1;
      }
      if (knownRunStart >= tokenEnd) {
        break;
      }
      let knownRunEnd = knownRunStart + 1;
      while (
        knownRunEnd < tokenEnd &&
        isKnownTokenSuffixCharacter(value[knownRunEnd]!)
      ) {
        knownRunEnd += 1;
      }

      let containsKnownToken = false;
      for (
        let cursor = knownRunStart;
        cursor < knownRunEnd && !containsKnownToken;
        cursor += 1
      ) {
        const previous = value[cursor - 1];
        if (
          previous !== undefined &&
          isAsciiWordCharacter(previous)
        ) {
          continue;
        }
        containsKnownToken = KNOWN_TOKEN_PREFIXES.some(
          (prefix) =>
            cursor + prefix.length + 12 <= knownRunEnd &&
            value
              .slice(cursor, cursor + prefix.length)
              .toLowerCase() === prefix,
        );
      }
      if (containsKnownToken) {
        recordSensitiveCandidate(
          candidates,
          `known:${value
            .slice(knownRunStart, knownRunEnd)
            .toLowerCase()}`,
        );
      }
      knownRunStart = knownRunEnd;
    }
    index = tokenEnd;
  }
}

function decodeResidualSensitiveEscapes(value: string): string {
  const output: string[] = [];
  for (let cursor = 0; cursor < value.length; ) {
    if (value[cursor] !== "\\") {
      output.push(value[cursor]!);
      cursor += 1;
      continue;
    }

    while (value[cursor] === "\\") {
      cursor += 1;
    }
    if (cursor >= value.length) {
      break;
    }
    if (value[cursor] === "\r") {
      cursor += 1;
      if (value[cursor] === "\n") {
        cursor += 1;
      }
      continue;
    }
    if (value[cursor] === "\n") {
      cursor += 1;
      continue;
    }
    if (value[cursor] !== "u" && value[cursor] !== "x") {
      continue;
    }

    let decodedAny = false;
    while (value[cursor] === "u" || value[cursor] === "x") {
      const hexadecimalLength =
        value[cursor] === "u" ? 4 : 2;
      const hexadecimal = value.slice(
        cursor + 1,
        cursor + 1 + hexadecimalLength,
      );
      if (
        hexadecimal.length !== hexadecimalLength ||
        ![...hexadecimal].every(isHexadecimalCharacter)
      ) {
        break;
      }
      decodedAny = true;
      const decoded = String.fromCharCode(
        Number.parseInt(hexadecimal, 16),
      );
      output.push(decoded);
      cursor += 1 + hexadecimalLength;
      if (decoded !== "\\") {
        break;
      }
      while (value[cursor] === "\\") {
        cursor += 1;
      }
    }
    if (!decodedAny) {
      output.push(value[cursor]!);
      cursor += 1;
    }
  }
  return output.join("");
}

function removeAmbiguousSensitiveJoiners(
  value: string,
  commentMode: CommentProjectionMode = "remove",
): string {
  const output: string[] = [];
  let inUrlSpan = false;
  for (let cursor = 0; cursor < value.length; ) {
    if (value[cursor] === "\"" || value[cursor] === "'") {
      inUrlSpan = false;
      cursor += 1;
      continue;
    }
    if (isWhitespace(value[cursor])) {
      inUrlSpan = false;
    }
    if (
      value[cursor] === "/" &&
      value[cursor + 1] === "*"
    ) {
      cursor += 2;
      if (commentMode === "preserve-body") {
        continue;
      }
      while (
        cursor + 1 < value.length &&
        (value[cursor] !== "*" || value[cursor + 1] !== "/")
      ) {
        cursor += 1;
      }
      cursor = Math.min(value.length, cursor + 2);
      if (commentMode === "separator") {
        output.push(" ");
        inUrlSpan = false;
      }
      continue;
    }
    if (
      commentMode === "preserve-body" &&
      value[cursor] === "*" &&
      value[cursor + 1] === "/"
    ) {
      cursor += 2;
      continue;
    }
    if (
      value[cursor] === "/" &&
      value[cursor + 1] === "/"
    ) {
      if (value[cursor - 1] === ":" || inUrlSpan) {
        inUrlSpan = true;
        output.push("//");
        cursor += 2;
        continue;
      }
      cursor += 2;
      if (commentMode === "preserve-body") {
        continue;
      }
      while (
        cursor < value.length &&
        value[cursor] !== "\n" &&
        value[cursor] !== "\r"
      ) {
        cursor += 1;
      }
      if (value[cursor] === "\r") {
        cursor += 1;
      }
      if (value[cursor] === "\n") {
        cursor += 1;
      }
      if (commentMode === "separator") {
        output.push(" ");
        inUrlSpan = false;
      }
      continue;
    }
    if (value[cursor] !== "\\") {
      output.push(value[cursor]!);
      cursor += 1;
      continue;
    }
    while (value[cursor] === "\\") {
      cursor += 1;
    }
    if (value[cursor] === "\r") {
      cursor += 1;
      if (value[cursor] === "\n") {
        cursor += 1;
      }
    } else if (value[cursor] === "\n") {
      cursor += 1;
    }
  }
  return output.join("");
}

function projectResidualSensitiveJoiners(value: string): string {
  return removeAmbiguousSensitiveJoiners(
    decodeResidualSensitiveEscapes(value),
  );
}

function projectResidualSensitiveJoinersWithCommentBodies(
  value: string,
): string {
  return removeAmbiguousSensitiveJoiners(
    decodeResidualSensitiveEscapes(value),
    "preserve-body",
  );
}

function projectResidualSensitiveJoinersWithCommentSeparators(
  value: string,
): string {
  return removeAmbiguousSensitiveJoiners(
    decodeResidualSensitiveEscapes(value),
    "separator",
  );
}

function summarizeSensitiveCandidates(
  value: string,
  interpretResidualEscapes: boolean,
  allowAmbiguousAssignmentJoiners = true,
): SensitiveCandidateSummary {
  const normalized = value.replace(
    CONTROL_OR_FORMAT_CHARACTERS_PATTERN,
    "",
  );
  const candidates = new Map<string, number>();
  collectAssignmentCandidates(
    normalized,
    candidates,
    interpretResidualEscapes,
    allowAmbiguousAssignmentJoiners,
  );
  collectBearerCandidates(
    normalized,
    candidates,
    interpretResidualEscapes,
  );
  const bearerSeparatorNormalized = value.replace(
    CONTROL_OR_FORMAT_CHARACTERS_PATTERN,
    (character) => isWhitespace(character) ? " " : "",
  );
  if (bearerSeparatorNormalized !== normalized) {
    const separatorCandidates = new Map<string, number>();
    collectBearerCandidates(
      bearerSeparatorNormalized,
      separatorCandidates,
      interpretResidualEscapes,
    );
    for (const [candidate, count] of separatorCandidates) {
      candidates.set(
        candidate,
        Math.max(count, candidates.get(candidate) ?? 0),
      );
    }
  }
  collectTokenCandidates(normalized, candidates);
  return candidates;
}

function hasAdditionalSensitiveCandidate(
  candidates: SensitiveCandidateSummary,
  baseline: SensitiveCandidateSummary,
): boolean {
  for (const [candidate, count] of candidates) {
    if (count > (baseline.get(candidate) ?? 0)) {
      return true;
    }
  }
  return false;
}

function isRangeFullyProtected(
  protectedPositions: Uint8Array,
  start: number,
  end: number,
): boolean {
  if (start >= end) {
    return false;
  }
  for (let cursor = start; cursor < end; cursor += 1) {
    if (protectedPositions[cursor] === 0) {
      return false;
    }
  }
  return true;
}

function hasProtectedPosition(
  protectedPositions: Uint8Array,
  start: number,
  end: number,
): boolean {
  for (let cursor = start; cursor < end; cursor += 1) {
    if (protectedPositions[cursor] !== 0) {
      return true;
    }
  }
  return false;
}

function hasUnmappableDecodedSensitiveCandidate(
  value: string,
  segments: readonly QuotedSegment[],
  protectedPositions: Uint8Array,
): boolean {
  for (const segment of segments) {
    if (
      isRangeFullyProtected(
        protectedPositions,
        segment.contentStart,
        segment.contentEnd,
      )
    ) {
      continue;
    }
    if (!segment.hadEscape && !segment.hadRawControlOrFormat) {
      continue;
    }
    const decodedCandidates = summarizeSensitiveCandidates(
      segment.decoded,
      true,
    );
    const projectedCandidates = summarizeSensitiveCandidates(
      projectResidualSensitiveJoiners(segment.decoded),
      false,
    );
    const commentBodyCandidates = summarizeSensitiveCandidates(
      projectResidualSensitiveJoinersWithCommentBodies(
        segment.decoded,
      ),
      false,
    );
    const commentSeparatorCandidates =
      summarizeSensitiveCandidates(
        projectResidualSensitiveJoinersWithCommentSeparators(
          segment.decoded,
        ),
        false,
      );
    if (
      decodedCandidates.size === 0 &&
      projectedCandidates.size === 0 &&
      commentBodyCandidates.size === 0 &&
      commentSeparatorCandidates.size === 0
    ) {
      continue;
    }
    if (segment.hadRawControlOrFormat) {
      return true;
    }
    const rawCandidates = summarizeSensitiveCandidates(
      value.slice(segment.contentStart, segment.contentEnd),
      false,
      false,
    );
    if (
      hasAdditionalSensitiveCandidate(
        decodedCandidates,
        rawCandidates,
      ) ||
      hasAdditionalSensitiveCandidate(
        projectedCandidates,
        rawCandidates,
      ) ||
      hasAdditionalSensitiveCandidate(
        commentBodyCandidates,
        rawCandidates,
      ) ||
      hasAdditionalSensitiveCandidate(
        commentSeparatorCandidates,
        rawCandidates,
      )
    ) {
      return true;
    }
  }
  return false;
}

function rejoinQuotedSegments(
  value: string,
  segments: readonly QuotedSegment[],
  protectedPositions: Uint8Array,
): string {
  const output: string[] = [];
  const appendProtectedRange = (
    start: number,
    end: number,
  ): void => {
    let sliceStart = start;
    for (let cursor = start; cursor < end; ) {
      if (protectedPositions[cursor] === 0) {
        cursor += 1;
        continue;
      }
      output.push(value.slice(sliceStart, cursor), REDACTED_VALUE);
      while (
        cursor < end &&
        protectedPositions[cursor] !== 0
      ) {
        cursor += 1;
      }
      sliceStart = cursor;
    }
    output.push(value.slice(sliceStart, end));
  };
  let cursor = 0;
  for (const segment of segments) {
    appendProtectedRange(cursor, segment.start);
    const hasProtectedContent = hasProtectedPosition(
      protectedPositions,
      segment.contentStart,
      segment.contentEnd,
    );
    if (!hasProtectedContent) {
      output.push(segment.decoded);
    } else if (
      isRangeFullyProtected(
        protectedPositions,
        segment.contentStart,
        segment.contentEnd,
      ) ||
      segment.hadEscape ||
      segment.hadRawControlOrFormat
    ) {
      output.push(REDACTED_VALUE);
    } else {
      appendProtectedRange(
        segment.contentStart,
        segment.contentEnd,
      );
    }
    cursor = segment.end;
  }
  appendProtectedRange(cursor, value.length);
  return output.join("");
}

function protectedQuotedAssignmentCandidates(
  value: string,
  lexed: LexedText,
  protectedPositions: Uint8Array,
): SensitiveCandidateSummary {
  const candidates = new Map<string, number>();
  for (const key of lexed.segments) {
    if (!isSensitiveName(key.decoded)) {
      continue;
    }
    let cursor = skipWhitespace(value, key.end);
    if (value[cursor] !== ":" && value[cursor] !== "=") {
      continue;
    }
    cursor = skipWhitespace(value, cursor + 1);
    const quotedValue = lexed.segmentByStart.get(cursor);
    if (
      quotedValue === undefined ||
      !isRangeFullyProtected(
        protectedPositions,
        quotedValue.contentStart,
        quotedValue.contentEnd,
      )
    ) {
      continue;
    }
    recordSensitiveCandidate(
      candidates,
      `assignment:${normalizedSensitiveName(key.decoded)}`,
    );
  }
  return candidates;
}

function protectedSensitiveCandidateBaseline(
  value: string,
  lexed: LexedText,
  protectedPositions: Uint8Array,
  protectedValue: string,
): SensitiveCandidateSummary {
  const baseline = new Map(
    summarizeSensitiveCandidates(
      protectedValue,
      false,
      false,
    ),
  );
  for (const [candidate, count] of protectedQuotedAssignmentCandidates(
    value,
    lexed,
    protectedPositions,
  )) {
    baseline.set(
      candidate,
      Math.max(count, baseline.get(candidate) ?? 0),
    );
  }
  return baseline;
}

function hasAmbiguousRejoinedSensitiveCandidate(
  value: string,
  lexed: LexedText,
  protectedPositions: Uint8Array,
  baseline: SensitiveCandidateSummary,
): boolean {
  const rejoined = rejoinQuotedSegments(
    value,
    lexed.segments,
    protectedPositions,
  );
  return (
    hasAdditionalSensitiveCandidate(
      summarizeSensitiveCandidates(
        rejoined,
        true,
        false,
      ),
      baseline,
    ) ||
    hasAdditionalSensitiveCandidate(
      summarizeSensitiveCandidates(
        projectResidualSensitiveJoiners(rejoined),
        false,
        false,
      ),
      baseline,
    ) ||
    hasAdditionalSensitiveCandidate(
      summarizeSensitiveCandidates(
        projectResidualSensitiveJoinersWithCommentBodies(
          rejoined,
        ),
        false,
        false,
      ),
      baseline,
    ) ||
    hasAdditionalSensitiveCandidate(
      summarizeSensitiveCandidates(
        projectResidualSensitiveJoinersWithCommentSeparators(
          rejoined,
        ),
        false,
        false,
      ),
      baseline,
    )
  );
}

function hasAmbiguousProjectedSensitiveCandidate(
  protectedValue: string,
  baseline: SensitiveCandidateSummary,
): boolean {
  return hasAdditionalSensitiveCandidate(
    summarizeSensitiveCandidates(
      projectResidualSensitiveJoiners(protectedValue),
      false,
    ),
    baseline,
  ) ||
    hasAdditionalSensitiveCandidate(
      summarizeSensitiveCandidates(
        projectResidualSensitiveJoinersWithCommentBodies(
          protectedValue,
        ),
        false,
      ),
      baseline,
    ) ||
    hasAdditionalSensitiveCandidate(
      summarizeSensitiveCandidates(
        projectResidualSensitiveJoinersWithCommentSeparators(
          protectedValue,
        ),
        false,
      ),
      baseline,
    );
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

function redactBearerTokens(value: string): BearerScanOutcome {
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
      !hasSeparator
    ) {
      index = keywordEnd;
      continue;
    }
    if (isCanonicalRedactedBearerToken(value, tokenStart)) {
      index = tokenStart + REDACTED_VALUE.length;
      continue;
    }
    if (
      isBearerOpeningWrapper(value[tokenStart]) ||
      (value[tokenStart] === "\\" &&
        isBearerOpeningWrapper(value[tokenStart + 1]))
    ) {
      return { kind: "ambiguous" };
    }
    if (isBearerTokenDelimiter(value[tokenStart])) {
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
  return {
    kind: "safe",
    value: replaceBearerRanges(value, ranges),
  };
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

function hasCanonicalSensitiveAssignmentRemainder(
  value: string,
  nameEnd: number,
): boolean {
  let cursor = skipWhitespace(value, nameEnd);
  if (value[cursor] !== ":" && value[cursor] !== "=") {
    return false;
  }
  cursor = skipWhitespace(value, cursor + 1);
  if (!value.startsWith(REDACTED_VALUE, cursor)) {
    return false;
  }
  return hasAssignmentValueBoundary(
    value,
    cursor + REDACTED_VALUE.length,
  );
}

function hasCommentSeparatedAssignment(
  value: string,
  start: number,
  limit = value.length,
): boolean {
  const cursor = skipWhitespace(value, start, limit);
  return (
    value[cursor] === "/" &&
    (value[cursor + 1] === "*" || value[cursor + 1] === "/")
  );
}

function scanQuotedSensitiveAssignments(
  value: string,
  lexed: LexedText,
  mask: Int32Array,
  protectedQuotedSegments?: Set<number>,
): ScanOutcome {
  for (const key of lexed.segments) {
    if (protectedQuotedSegments?.has(key.start) === true) {
      continue;
    }
    let cursor = skipWhitespace(value, key.end);
    const hasAssignment =
      value[cursor] === ":" || value[cursor] === "=";
    const assignmentDelimiter = value[cursor];
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
        if (
          hasCanonicalSensitiveAssignmentRemainder(
            key.decoded,
            candidateEnd,
          )
        ) {
          continue;
        }
        return { kind: "ambiguous" };
      }
      continue;
    }
    if (!hasAssignment) {
      if (hasCommentSeparatedAssignment(value, key.end)) {
        return { kind: "ambiguous" };
      }
      continue;
    }

    cursor = skipWhitespace(value, cursor + 1);
    const quotedValue = lexed.segmentByStart.get(cursor);
    if (quotedValue !== undefined) {
      const hasBoundary =
        assignmentDelimiter === "="
          ? hasAssignmentValueBoundary(
              value,
              quotedValue.end,
            )
          : hasJsonValueBoundary(value, quotedValue.end);
      if (!hasBoundary) {
        return { kind: "ambiguous" };
      }
      protectedQuotedSegments?.add(quotedValue.start);
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
      (assignmentDelimiter === "="
        ? !hasAssignmentValueBoundary(value, unquoted.end)
        : !hasJsonValueBoundary(value, unquoted.end))
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
  onlyQuotedValues: boolean,
  protectedQuotedSegments?: Set<number>,
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
      if (
        hasCommentSeparatedAssignment(
          value,
          nameEnd,
          end,
        )
      ) {
        return { kind: "ambiguous" };
      }
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
      protectedQuotedSegments?.add(quotedValue.start);
      markRedaction(
        mask,
        quotedValue.contentStart,
        quotedValue.contentEnd,
      );
      index = quotedValue.end;
      continue;
    }
    if (onlyQuotedValues) {
      index = nameEnd;
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
  onlyQuotedValues = false,
  protectedQuotedSegments?: Set<number>,
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
      onlyQuotedValues,
      protectedQuotedSegments,
    );
    if (bare.kind === "ambiguous") {
      return bare;
    }
    if (protectedQuotedSegments?.has(segment.start) !== true) {
      const content = scanBareAssignmentsInRange(
        value,
        segment.contentStart,
        segment.contentEnd,
        true,
        lexed,
        mask,
        onlyQuotedValues,
        protectedQuotedSegments,
      );
      if (content.kind === "ambiguous") {
        return content;
      }
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
    onlyQuotedValues,
    protectedQuotedSegments,
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

function redactTextWithoutOutputBound(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_PERSISTED_TEXT_INPUT_CHARACTERS
  ) {
    throw persistenceError("INVALID_PERSISTENCE_INPUT");
  }

  const sourceLexical = lexText(value);
  if (sourceLexical.kind === "ambiguous") {
    return REDACTED_VALUE;
  }

  const sourceAssignmentMask = createRedactionMask(value.length);
  const protectedSourceSegments = new Set<number>();
  const sourceQuotedAssignments = scanQuotedSensitiveAssignments(
    value,
    sourceLexical.lexed,
    sourceAssignmentMask,
    protectedSourceSegments,
  );
  if (sourceQuotedAssignments.kind === "ambiguous") {
    return REDACTED_VALUE;
  }
  const sourceBareAssignments = scanBareAssignments(
    value,
    sourceLexical.lexed,
    sourceAssignmentMask,
    true,
    protectedSourceSegments,
  );
  if (sourceBareAssignments.kind === "ambiguous") {
    return REDACTED_VALUE;
  }
  const sourceProtectedPositions = maskedPositions(
    sourceAssignmentMask,
  );
  const assignmentProtectedValue = applyRedactionMask(
    value,
    sourceAssignmentMask,
  );
  const protectedCandidateBaseline =
    protectedSensitiveCandidateBaseline(
      value,
      sourceLexical.lexed,
      sourceProtectedPositions,
      assignmentProtectedValue,
    );
  if (
    hasUnmappableDecodedSensitiveCandidate(
      value,
      sourceLexical.lexed.segments,
      sourceProtectedPositions,
    ) ||
    hasAmbiguousRejoinedSensitiveCandidate(
      value,
      sourceLexical.lexed,
      sourceProtectedPositions,
      protectedCandidateBaseline,
    ) ||
    hasAmbiguousProjectedSensitiveCandidate(
      assignmentProtectedValue,
      protectedCandidateBaseline,
    )
  ) {
    return REDACTED_VALUE;
  }

  const bearerProtected = redactBearerTokens(
    assignmentProtectedValue,
  );
  if (bearerProtected.kind === "ambiguous") {
    return REDACTED_VALUE;
  }
  const normalized = bearerProtected.value.replace(
    CONTROL_OR_FORMAT_CHARACTERS_PATTERN,
    "",
  );
  const bearerRedacted = redactBearerTokens(normalized);
  if (bearerRedacted.kind === "ambiguous") {
    return REDACTED_VALUE;
  }
  const lexical = lexText(bearerRedacted.value);
  if (lexical.kind === "ambiguous") {
    return REDACTED_VALUE;
  }

  const mask = createRedactionMask(bearerRedacted.value.length);
  const quotedAssignments = scanQuotedSensitiveAssignments(
    bearerRedacted.value,
    lexical.lexed,
    mask,
  );
  if (quotedAssignments.kind === "ambiguous") {
    return REDACTED_VALUE;
  }
  const bareAssignments = scanBareAssignments(
    bearerRedacted.value,
    lexical.lexed,
    mask,
  );
  if (bareAssignments.kind === "ambiguous") {
    return REDACTED_VALUE;
  }
  scanTokenPatterns(
    bearerRedacted.value,
    lexical.lexed,
    mask,
    maskedPositions(mask),
  );

  return applyRedactionMask(bearerRedacted.value, mask);
}

export function redactText(value: string): string {
  const redacted = redactTextWithoutOutputBound(value);
  if (redacted.length <= MAX_PERSISTED_SUMMARY_CHARACTERS) {
    return redacted;
  }

  const truncated = redacted.slice(
    0,
    MAX_PERSISTED_SUMMARY_CHARACTERS,
  );
  return redactTextWithoutOutputBound(truncated) === truncated
    ? truncated
    : REDACTED_VALUE;
}
