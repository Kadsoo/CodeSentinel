export type PathDenialReason = "SENSITIVE_PATH" | "OUTSIDE_WORKSPACE";

export type PathPolicyConfig = Readonly<{
  allowedPaths: readonly string[];
  sensitivePatterns?: readonly string[];
}>;

export type PathPolicyContext = Readonly<{
  workspaceRoot: string;
  config: PathPolicyConfig;
  canonicalWorkspaceRoot?: string;
  canonicalPaths?: Readonly<Record<string, string | undefined>>;
}>;

export type PathCheck =
  | Readonly<{ status: "safe" }>
  | Readonly<{ status: "deny"; reason: PathDenialReason }>;

type WorkspaceKind = "posix" | "windows";

const BINARY_FILE_EXTENSIONS = new Set([
  "7z",
  "avi",
  "bin",
  "bmp",
  "bz2",
  "class",
  "dll",
  "dmg",
  "exe",
  "gif",
  "gz",
  "ico",
  "jar",
  "jpeg",
  "jpg",
  "mkv",
  "mov",
  "mp3",
  "mp4",
  "o",
  "pdf",
  "png",
  "rar",
  "so",
  "tar",
  "wasm",
  "wav",
  "webp",
  "zip",
]);

const CREDENTIAL_FILE_EXTENSIONS = new Set([
  "cer",
  "crt",
  "der",
  "jks",
  "kdbx",
  "key",
  "keystore",
  "p12",
  "pem",
  "pfx",
]);

const CREDENTIAL_FILE_NAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
]);

const CREDENTIAL_LIKE_SEGMENT =
  /(?:^|[._-])(?:api[-_]?keys?|credential(?:s)?|key(?:s)?|secret(?:s)?|token(?:s)?)(?:[._-]|$)/i;
const CREDENTIAL_LIKE_SUBSTRINGS = [
  "accesskey",
  "apikey",
  "clientkey",
  "credential",
  "privatekey",
  "secret",
  "token",
];

const MAX_PATH_LENGTH = 4_096;
const MAX_PATTERN_LENGTH = 4_096;
const MAX_PATH_SEGMENTS = 256;
const WINDOWS_RESERVED_DEVICE_NAME =
  /^(?:aux|con|conin\$|conout\$|nul|prn|com(?:[1-9]|[\u00B9\u00B2\u00B3])|lpt(?:[1-9]|[\u00B9\u00B2\u00B3]))(?:\..*)?$/iu;

export function evaluatePath(path: string, context: PathPolicyContext): PathCheck {
  const workspaceKind = getWorkspaceKind(context);
  if (workspaceKind === undefined) {
    return denied("OUTSIDE_WORKSPACE");
  }

  const normalizedPath = normalizeRelativePath(path, workspaceKind);
  if (normalizedPath === undefined) {
    return denied("OUTSIDE_WORKSPACE");
  }

  if (workspaceKind === "windows" && hasWindowsAliasSuffix(path)) {
    return denied("OUTSIDE_WORKSPACE");
  }

  const initialPathDenial = evaluatePolicyPath(normalizedPath, context, workspaceKind);
  if (initialPathDenial !== undefined) {
    return denied(initialPathDenial);
  }

  const canonicalPathCheck = evaluateCanonicalPath(normalizedPath, context, workspaceKind);
  if (canonicalPathCheck.status === "deny") {
    return denied("OUTSIDE_WORKSPACE");
  }

  if (canonicalPathCheck.status === "safe") {
    if (workspaceKind === "windows" && hasWindowsAliasSuffix(canonicalPathCheck.relativePath)) {
      return denied("OUTSIDE_WORKSPACE");
    }

    const canonicalPathDenial = evaluatePolicyPath(
      canonicalPathCheck.relativePath,
      context,
      workspaceKind,
    );
    if (canonicalPathDenial !== undefined) {
      return denied(canonicalPathDenial);
    }
  }

  return Object.freeze({ status: "safe" as const });
}

function denied(reason: PathDenialReason): PathCheck {
  return Object.freeze({ status: "deny" as const, reason });
}

function normalizeRelativePath(value: unknown, workspaceKind: WorkspaceKind): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    value.includes("\0")
  ) {
    return undefined;
  }

  if (workspaceKind === "windows" && value.includes("/") && value.includes("\\")) {
    return undefined;
  }

  if (
    value.startsWith("/") ||
    (workspaceKind === "windows" && value.startsWith("\\")) ||
    /^[A-Za-z]:/.test(value) ||
    value.includes(":")
  ) {
    return undefined;
  }

  const separator = workspaceKind === "windows" && value.includes("\\") ? "\\" : "/";
  const segments = value.split(separator);
  if (
    segments.length > MAX_PATH_SEGMENTS ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return undefined;
  }

  return segments.join("/");
}

function isSensitivePath(normalizedPath: string, isWindowsWorkspace: boolean): boolean {
  const segments = normalizedPath.split("/");
  const fileName = segments.at(-1)?.toLowerCase();

  if (fileName === undefined) {
    return true;
  }

  if (
    segments.some((segment) => {
      const lowerSegment = segment.toLowerCase();
      return (
        lowerSegment.startsWith(".env") ||
        lowerSegment === ".git" ||
        lowerSegment === ".ssh" ||
        lowerSegment === "node_modules" ||
        (isWindowsWorkspace && WINDOWS_RESERVED_DEVICE_NAME.test(lowerSegment)) ||
        CREDENTIAL_FILE_NAMES.has(lowerSegment) ||
        isCredentialLikeSegment(lowerSegment)
      );
    })
  ) {
    return true;
  }

  const extension = fileName.includes(".") ? fileName.split(".").at(-1) : undefined;
  return (
    extension !== undefined &&
    (BINARY_FILE_EXTENSIONS.has(extension) || CREDENTIAL_FILE_EXTENSIONS.has(extension))
  );
}

function isCredentialLikeSegment(lowerSegment: string): boolean {
  return (
    CREDENTIAL_LIKE_SEGMENT.test(lowerSegment) ||
    CREDENTIAL_LIKE_SUBSTRINGS.some((substring) => lowerSegment.includes(substring))
  );
}

function hasWindowsAliasSuffix(value: string): boolean {
  return value.split(/[\\/]/u).some((segment) => segment.endsWith(" ") || segment.endsWith("."));
}

function evaluatePolicyPath(
  normalizedPath: string,
  context: PathPolicyContext,
  workspaceKind: WorkspaceKind,
): PathDenialReason | undefined {
  if (
    isSensitivePath(normalizedPath, workspaceKind === "windows") ||
    matchesConfiguredSensitivePattern(normalizedPath, context, workspaceKind)
  ) {
    return "SENSITIVE_PATH";
  }

  return matchesAllowedPath(normalizedPath, context, workspaceKind)
    ? undefined
    : "OUTSIDE_WORKSPACE";
}

function matchesConfiguredSensitivePattern(
  normalizedPath: string,
  context: PathPolicyContext,
  workspaceKind: WorkspaceKind,
): boolean {
  const sensitivePatterns = context?.config?.sensitivePatterns;
  if (sensitivePatterns === undefined) {
    return false;
  }

  if (
    !Array.isArray(sensitivePatterns) ||
    sensitivePatterns.some((pattern) => !isValidPattern(pattern, workspaceKind))
  ) {
    return true;
  }

  return sensitivePatterns.some((pattern) =>
    matchesPathPattern(normalizedPath, pattern, workspaceKind === "windows", workspaceKind),
  );
}

function matchesAllowedPath(
  normalizedPath: string,
  context: PathPolicyContext,
  workspaceKind: WorkspaceKind,
): boolean {
  const allowedPaths = context?.config?.allowedPaths;
  if (
    !Array.isArray(allowedPaths) ||
    allowedPaths.length === 0 ||
    allowedPaths.some((pattern) => !isValidPattern(pattern, workspaceKind))
  ) {
    return false;
  }

  return allowedPaths.some((pattern) =>
    matchesPathPattern(normalizedPath, pattern, workspaceKind === "windows", workspaceKind),
  );
}

function getWorkspaceKind(context: PathPolicyContext): WorkspaceKind | undefined {
  const originalWorkspaceRoot = normalizeCanonicalAbsolutePath(context?.workspaceRoot);
  if (originalWorkspaceRoot === undefined) {
    return undefined;
  }

  if (context?.canonicalWorkspaceRoot === undefined) {
    return originalWorkspaceRoot.kind;
  }

  const canonicalWorkspaceRoot = normalizeCanonicalAbsolutePath(context.canonicalWorkspaceRoot);
  return canonicalWorkspaceRoot?.kind === originalWorkspaceRoot.kind
    ? canonicalWorkspaceRoot.kind
    : undefined;
}

function isValidPattern(value: unknown, workspaceKind: WorkspaceKind): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATTERN_LENGTH ||
    value.includes("\0")
  ) {
    return false;
  }

  if (workspaceKind === "windows" && value.includes("/") && value.includes("\\")) {
    return false;
  }

  if (
    value.startsWith("/") ||
    (workspaceKind === "windows" && value.startsWith("\\")) ||
    /^[A-Za-z]:/.test(value) ||
    value.includes(":")
  ) {
    return false;
  }

  const separator = workspaceKind === "windows" && value.includes("\\") ? "\\" : "/";
  const segments = value.split(separator);
  return (
    segments.length <= MAX_PATH_SEGMENTS &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function matchesPathPattern(
  normalizedPath: string,
  pattern: string,
  caseInsensitive: boolean,
  workspaceKind: WorkspaceKind,
): boolean {
  const normalizedPattern =
    workspaceKind === "windows" ? pattern.replaceAll("\\", "/") : pattern;
  const pathToMatch = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath;
  const patternToMatch = caseInsensitive ? normalizedPattern.toLowerCase() : normalizedPattern;
  return matchesPathSegments(
    patternToMatch.split("/"),
    pathToMatch.split("/"),
    0,
    0,
    new Map<string, boolean>(),
  );
}

function matchesPathSegments(
  patternSegments: readonly string[],
  pathSegments: readonly string[],
  patternIndex: number,
  pathIndex: number,
  memo: Map<string, boolean>,
): boolean {
  const memoKey = `${patternIndex}:${pathIndex}`;
  const cached = memo.get(memoKey);
  if (cached !== undefined) {
    return cached;
  }

  let result: boolean;
  const patternSegment = patternSegments[patternIndex];
  if (patternSegment === undefined) {
    result = pathIndex === pathSegments.length;
  } else if (patternSegment === "**") {
    result =
      matchesPathSegments(patternSegments, pathSegments, patternIndex + 1, pathIndex, memo) ||
      (pathIndex < pathSegments.length &&
        matchesPathSegments(patternSegments, pathSegments, patternIndex, pathIndex + 1, memo));
  } else {
    const pathSegment = pathSegments[pathIndex];
    result =
      pathSegment !== undefined &&
      matchesSegment(patternSegment, pathSegment) &&
      matchesPathSegments(patternSegments, pathSegments, patternIndex + 1, pathIndex + 1, memo);
  }

  memo.set(memoKey, result);
  return result;
}

function matchesSegment(pattern: string, value: string): boolean {
  const patternCharacters = Array.from(pattern);
  const valueCharacters = Array.from(value);
  let previous = Array<boolean>(valueCharacters.length + 1).fill(false);
  previous[0] = true;

  for (const patternCharacter of patternCharacters) {
    const current = Array<boolean>(valueCharacters.length + 1).fill(false);
    if (patternCharacter === "*") {
      current[0] = previous[0] ?? false;
      for (let valueIndex = 1; valueIndex <= valueCharacters.length; valueIndex += 1) {
        current[valueIndex] =
          (previous[valueIndex] ?? false) || (current[valueIndex - 1] ?? false);
      }
    } else {
      for (let valueIndex = 1; valueIndex <= valueCharacters.length; valueIndex += 1) {
        const valueCharacter = valueCharacters[valueIndex - 1];
        current[valueIndex] =
          (previous[valueIndex - 1] ?? false) &&
          (patternCharacter === "?" || patternCharacter === valueCharacter);
      }
    }
    previous = current;
  }

  return previous[valueCharacters.length] ?? false;
}

type CanonicalPathCheck =
  | Readonly<{ status: "not_provided" }>
  | Readonly<{ status: "safe"; relativePath: string }>
  | Readonly<{ status: "deny" }>;

function evaluateCanonicalPath(
  normalizedPath: string,
  context: PathPolicyContext,
  workspaceKind: WorkspaceKind,
): CanonicalPathCheck {
  const canonicalWorkspaceRoot = context?.canonicalWorkspaceRoot ?? context?.workspaceRoot;
  const normalizedCanonicalWorkspaceRoot = normalizeCanonicalAbsolutePath(canonicalWorkspaceRoot);
  if (normalizedCanonicalWorkspaceRoot === undefined) {
    return Object.freeze({ status: "deny" as const });
  }

  const canonicalPaths = context?.canonicalPaths;
  if (canonicalPaths === undefined) {
    return Object.freeze({ status: "not_provided" as const });
  }

  if (canonicalPaths === null || typeof canonicalPaths !== "object") {
    return Object.freeze({ status: "deny" as const });
  }

  if (!Object.prototype.hasOwnProperty.call(canonicalPaths, normalizedPath)) {
    return Object.freeze({ status: "deny" as const });
  }

  const canonicalPath = canonicalPaths[normalizedPath];
  const normalizedCanonicalPath = normalizeCanonicalAbsolutePath(canonicalPath);
  if (
    normalizedCanonicalPath === undefined ||
    normalizedCanonicalPath.kind !== normalizedCanonicalWorkspaceRoot.kind
  ) {
    return Object.freeze({ status: "deny" as const });
  }

  const relativePath = relativeToCanonicalRoot(
    normalizedCanonicalPath,
    normalizedCanonicalWorkspaceRoot,
  );
  if (relativePath === undefined || normalizeRelativePath(relativePath, workspaceKind) === undefined) {
    return Object.freeze({ status: "deny" as const });
  }

  return Object.freeze({ status: "safe" as const, relativePath });
}

type CanonicalPath = Readonly<{
  kind: "posix" | "windows";
  value: string;
}>;

function normalizeCanonicalAbsolutePath(value: unknown): CanonicalPath | undefined {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    return undefined;
  }

  if (value.includes("/") && value.includes("\\")) {
    return undefined;
  }

  const normalizedSeparators = value.replaceAll("\\", "/");
  if (normalizedSeparators.startsWith("//?/")) {
    return undefined;
  }

  if (/^[A-Za-z]:\//.test(normalizedSeparators)) {
    const segments = canonicalSegments(
      normalizedSeparators.slice(3),
      normalizedSeparators.length === 3,
    );
    if (segments === undefined) {
      return undefined;
    }

    const drive = normalizedSeparators.slice(0, 2).toLowerCase();
    const suffix = segments.length === 0 ? "" : segments.join("/").toLowerCase();
    return Object.freeze({ kind: "windows" as const, value: `${drive}/${suffix}` });
  }

  if (normalizedSeparators.startsWith("//")) {
    const segments = canonicalSegments(normalizedSeparators.slice(2), false);
    if (segments === undefined || segments.length < 2) {
      return undefined;
    }

    return Object.freeze({
      kind: "windows" as const,
      value: `//${segments.join("/").toLowerCase()}`,
    });
  }

  if (normalizedSeparators.startsWith("/")) {
    const segments = canonicalSegments(
      normalizedSeparators.slice(1),
      normalizedSeparators === "/",
    );
    if (segments === undefined) {
      return undefined;
    }

    return Object.freeze({ kind: "posix" as const, value: `/${segments.join("/")}` });
  }

  return undefined;
}

function canonicalSegments(value: string, isRoot: boolean): string[] | undefined {
  const segments = value.split("/");
  if (!isRoot && segments.at(-1) === "") {
    segments.pop();
  }

  return areCanonicalSegments(segments, isRoot) ? segments : undefined;
}

function areCanonicalSegments(segments: readonly string[], isRoot: boolean): boolean {
  if (isRoot) {
    return segments.length === 1 && segments[0] === "";
  }

  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !segment.includes(":"),
  );
}

function relativeToCanonicalRoot(candidate: CanonicalPath, root: CanonicalPath): string | undefined {
  if (candidate.kind !== root.kind || !isContainedBy(candidate.value, root.value)) {
    return undefined;
  }

  const prefix = root.value.endsWith("/") ? root.value : `${root.value}/`;
  const relativePath = candidate.value.slice(prefix.length);
  return relativePath.length === 0 ? undefined : relativePath;
}

function isContainedBy(candidate: string, root: string): boolean {
  if (root === "/" || root.endsWith("/")) {
    return candidate.startsWith(root);
  }

  return candidate === root || candidate.startsWith(`${root}/`);
}
