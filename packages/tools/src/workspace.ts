import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { TextDecoder } from "node:util";

export const MAX_READ_BYTES = 1_048_576;
export const MAX_LIST_DEPTH = 8;
export const MAX_LIST_ENTRIES = 500;
export const MAX_SEARCH_FILES = 100;
export const MAX_SEARCH_TOTAL_BYTES = 1_048_576;
export const MAX_SEARCH_RESULTS = 100;
export const MAX_SEARCH_SNIPPET_CHARACTERS = 240;
export const TRUNCATION_MARKER = "\n[CodeSentinel output truncated]";

export type ToolErrorCode =
  | "INVALID_WORKSPACE"
  | "INVALID_PATH"
  | "PATH_OUTSIDE_WORKSPACE"
  | "SYMLINK_NOT_ALLOWED"
  | "NOT_A_FILE"
  | "UNSAFE_FILE"
  | "BINARY_CONTENT"
  | "INVALID_MAX_BYTES"
  | "FILE_TOO_LARGE"
  | "READ_FAILED"
  | "INVALID_DEPTH"
  | "INVALID_MAX_ENTRIES"
  | "INVALID_MAX_RESULTS"
  | "INVALID_QUERY"
  | "NOT_A_DIRECTORY"
  | "LIST_FAILED"
  | "SEARCH_FAILED"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_EXPIRED"
  | "PATCH_HASH_MISMATCH"
  | "BASE_HASH_MISMATCH"
  | "INVALID_PATCH"
  | "PATCH_NOT_APPLICABLE"
  | "WRITE_FAILED";

export class CodeSentinelToolError extends Error {
  readonly code: ToolErrorCode;

  constructor(code: ToolErrorCode) {
    super(`CodeSentinel tool error: ${code}`);
    this.name = "CodeSentinelToolError";
    this.code = code;
  }
}

export type WorkspaceFileInput = Readonly<{
  workspaceRoot: string;
  path: string;
}>;

export type WorkspacePathFilter = (path: string) => boolean;

export type WorkspaceListEntry = Readonly<{
  kind: "file" | "directory";
  path: string;
}>;

export type ListWorkspaceFilesInput = Readonly<{
  workspaceRoot: string;
  path?: string;
  depth: number;
  maxEntries: number;
  shouldInclude: WorkspacePathFilter;
}>;

export type ListWorkspaceFilesResult = Readonly<{
  entries: readonly WorkspaceListEntry[];
  truncated: boolean;
}>;

export type SearchTextMatch = Readonly<{
  path: string;
  line: number;
  snippet: string;
}>;

export type SearchWorkspaceTextInput = Readonly<{
  workspaceRoot: string;
  path?: string;
  query: string;
  maxResults: number;
  shouldInclude: WorkspacePathFilter;
}>;

export type SearchWorkspaceTextResult = Readonly<{
  matches: readonly SearchTextMatch[];
  truncated: boolean;
}>;

export type ReadWorkspaceFileInput = WorkspaceFileInput &
  Readonly<{
    maxBytes: number;
  }>;

export type ReadWorkspaceFileResult = string;

export type ResolvedWorkspaceFile = Readonly<{
  workspaceRoot: string;
  path: string;
  realPath: string;
  directoryPath: string;
}>;

type NormalizedRelativePath = Readonly<{
  path: string;
  segments: readonly string[];
}>;

type WorkspaceNodeIdentity = Readonly<{
  dev: number;
  ino: number;
}>;

type BoundWorkspaceRoot = Readonly<{
  canonicalPath: string;
  identity: WorkspaceNodeIdentity;
}>;

type ResolvedWorkspaceDirectory = Readonly<{
  root: BoundWorkspaceRoot;
  directoryPath: string;
}>;

type ResolvedWorkspaceSearchTarget =
  | Readonly<{
      kind: "directory";
      root: BoundWorkspaceRoot;
      directoryPath: string;
    }>
  | Readonly<{
      kind: "file";
      root: BoundWorkspaceRoot;
      path: string;
    }>;

type WorkspaceTraversalCandidate = Readonly<{
  kind: "file" | "directory";
  absolutePath: string;
  path: string;
}>;

type WorkspaceTraversalResult = Readonly<{
  stopped: boolean;
  depthLimited: boolean;
}>;

export type WorkspaceFileSnapshot = Readonly<{
  dev: number;
  ino: number;
  nlink: number;
  mode: number;
}>;

export type VerifiedWorkspaceFileRead = Readonly<{
  bytes: Buffer;
  snapshot: WorkspaceFileSnapshot;
}>;

const MAX_PATH_LENGTH = 4_096;
const MAX_PATH_SEGMENTS = 256;
const WINDOWS_RESERVED_DEVICE_NAME =
  /^(?:aux|con|conin\$|conout\$|nul|prn|com(?:[1-9]|\u00b9|\u00b2|\u00b3)|lpt(?:[1-9]|\u00b9|\u00b2|\u00b3))(?:\..*)?$/iu;
// Keep the resolved-file API structural while retaining the root trust anchor through reads.
const workspaceRootBindings = new WeakMap<ResolvedWorkspaceFile, BoundWorkspaceRoot>();

export async function readWorkspaceFile(
  input: ReadWorkspaceFileInput,
): Promise<ReadWorkspaceFileResult> {
  validateMaxBytes(input?.maxBytes);
  const resolvedFile = await resolveExistingWorkspaceFile(input);
  const bounded = await readBoundedFile(resolvedFile, input.maxBytes);
  const prefix = bounded.truncated
    ? bounded.bytes.subarray(0, input.maxBytes)
    : bounded.bytes;
  const content = decodeBoundedText(prefix, bounded.bytes, bounded.truncated);

  return bounded.truncated ? `${content}${TRUNCATION_MARKER}` : content;
}

export async function getWorkspaceFileHash(input: WorkspaceFileInput): Promise<string> {
  const resolvedFile = await resolveExistingWorkspaceFile(input);
  const verified = await readVerifiedWorkspaceFile(resolvedFile);
  return createHash("sha256").update(verified.bytes).digest("hex");
}

export async function listWorkspaceFiles(
  input: ListWorkspaceFilesInput,
): Promise<ListWorkspaceFilesResult> {
  validateListDepth(input?.depth);
  validateListEntries(input?.maxEntries);

  try {
    const root = await resolveWorkspaceDirectory(input);
    const entries: WorkspaceListEntry[] = [];
    const traversal = await walkWorkspaceDirectory(
      root.root,
      root.directoryPath,
      input.depth,
      async (candidate) => {
        if (!input.shouldInclude(candidate.path)) {
          return false;
        }

        entries.push(
          Object.freeze({
            kind: candidate.kind,
            path: candidate.path,
          }),
        );
        return entries.length >= input.maxEntries;
      },
    );

    return Object.freeze({
      entries: Object.freeze([...entries]),
      truncated: traversal.stopped || traversal.depthLimited,
    });
  } catch (error) {
    if (isToolError(error)) {
      throw error;
    }
    throw toolError("LIST_FAILED");
  }
}

export async function searchWorkspaceText(
  input: SearchWorkspaceTextInput,
): Promise<SearchWorkspaceTextResult> {
  validateSearchQuery(input?.query);
  validateSearchMaxResults(input?.maxResults);

  try {
    const target = await resolveWorkspaceSearchTarget(input);
    const matches: SearchTextMatch[] = [];
    let scannedFiles = 0;
    let scannedBytes = 0;
    let limitReached = false;

    const searchFile = async (path: string): Promise<boolean> => {
      if (scannedBytes >= MAX_SEARCH_TOTAL_BYTES) {
        limitReached = true;
        return true;
      }
      if (!input.shouldInclude(path)) {
        return false;
      }
      if (scannedFiles >= MAX_SEARCH_FILES) {
        limitReached = true;
        return true;
      }

      scannedFiles += 1;
      try {
        const resolvedFile = await resolveBoundWorkspaceFile(
          target.root,
          normalizeRelativePath(path),
        );
        const remainingBytes = MAX_SEARCH_TOTAL_BYTES - scannedBytes;
        if (remainingBytes <= 0) {
          limitReached = true;
          return true;
        }
        const verified = await readVerifiedWorkspaceFileWithinLimit(resolvedFile, remainingBytes);

        scannedBytes += verified.bytes.length;
        const text = decodeWorkspaceText(verified.bytes);
        if (appendSearchMatches(text, path, input.query, input.maxResults, matches)) {
          limitReached = true;
          return true;
        }
      } catch (error) {
        if (isSearchContentSkipError(error)) {
          if (
            error.code === "FILE_TOO_LARGE" ||
            scannedBytes >= MAX_SEARCH_TOTAL_BYTES ||
            scannedFiles >= MAX_SEARCH_FILES
          ) {
            limitReached = true;
            return true;
          }
          return false;
        }
        throw error;
      }

      if (scannedFiles >= MAX_SEARCH_FILES || scannedBytes >= MAX_SEARCH_TOTAL_BYTES) {
        limitReached = true;
        return true;
      }
      return false;
    };

    if (target.kind === "file") {
      await searchFile(target.path);
      return Object.freeze({
        matches: Object.freeze([...matches]),
        truncated: limitReached,
      });
    }

    const traversal = await walkWorkspaceDirectory(
      target.root,
      target.directoryPath,
      MAX_LIST_DEPTH,
      async (candidate) => {
        if (candidate.kind !== "file") {
          return false;
        }
        return searchFile(candidate.path);
      },
    );
    return Object.freeze({
      matches: Object.freeze([...matches]),
      truncated: limitReached || traversal.stopped || traversal.depthLimited,
    });
  } catch (error) {
    if (isToolError(error)) {
      throw error;
    }
    throw toolError("SEARCH_FAILED");
  }
}

export async function resolveExistingWorkspaceFile(
  input: WorkspaceFileInput,
): Promise<ResolvedWorkspaceFile> {
  const normalizedPath = normalizeRelativePath(input?.path);
  const root = await bindWorkspaceRoot(input?.workspaceRoot);
  return resolveBoundWorkspaceFile(root, normalizedPath);
}

async function resolveBoundWorkspaceFile(
  root: BoundWorkspaceRoot,
  normalizedPath: NormalizedRelativePath,
): Promise<ResolvedWorkspaceFile> {
  await assertBoundWorkspaceRoot(root);
  const candidatePath = resolve(root.canonicalPath, ...normalizedPath.segments);

  if (!isPathContainedBy(root.canonicalPath, candidatePath)) {
    throw toolError("PATH_OUTSIDE_WORKSPACE");
  }

  await assertNoSymbolicPathComponents(root.canonicalPath, normalizedPath.segments);

  const realPath = await realpathOrThrow(candidatePath, "NOT_A_FILE");
  if (!isPathContainedBy(root.canonicalPath, realPath)) {
    throw toolError("PATH_OUTSIDE_WORKSPACE");
  }
  if (!sameWorkspacePath(candidatePath, realPath)) {
    throw toolError("SYMLINK_NOT_ALLOWED");
  }

  await inspectSafeRegularFile(realPath);

  const directoryPath = await realpathOrThrow(dirname(realPath), "NOT_A_FILE");
  if (!isPathContainedBy(root.canonicalPath, directoryPath)) {
    throw toolError("PATH_OUTSIDE_WORKSPACE");
  }
  await inspectSafeDirectory(directoryPath);
  await assertBoundWorkspaceRoot(root);

  const resolvedFile = Object.freeze({
    workspaceRoot: root.canonicalPath,
    path: normalizedPath.path,
    realPath,
    directoryPath,
  });
  workspaceRootBindings.set(resolvedFile, root);
  return resolvedFile;
}

export async function readResolvedWorkspaceFile(
  resolvedFile: ResolvedWorkspaceFile,
): Promise<Buffer> {
  return (await readVerifiedWorkspaceFile(resolvedFile)).bytes;
}

export async function readVerifiedWorkspaceFile(
  resolvedFile: ResolvedWorkspaceFile,
): Promise<VerifiedWorkspaceFileRead> {
  return readVerifiedWorkspaceFileWithinLimit(resolvedFile, MAX_READ_BYTES);
}

async function readVerifiedWorkspaceFileWithinLimit(
  resolvedFile: ResolvedWorkspaceFile,
  maxBytes: number,
): Promise<VerifiedWorkspaceFileRead> {
  const verifiedRead = await withVerifiedFile(
    resolvedFile,
    async (handle, openedSnapshot, openedSize) => {
      if (openedSize > maxBytes) {
        throw toolError("FILE_TOO_LARGE");
      }

      const bytes = await readExactHandle(handle, openedSize);
      const finalInfo = await handle.stat();
      const finalSnapshot = fileSnapshot(finalInfo);
      if (
        bytes.length !== openedSize ||
        !sameSnapshot(openedSnapshot, finalSnapshot) ||
        finalInfo.size !== openedSize
      ) {
        throw toolError("UNSAFE_FILE");
      }

      return Object.freeze({
        bytes: Buffer.from(bytes),
        snapshot: finalSnapshot,
      });
    },
  );

  return verifiedRead;
}

export function decodeWorkspaceText(bytes: Buffer): string {
  if (bytes.includes(0)) {
    throw toolError("BINARY_CONTENT");
  }

  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw toolError("BINARY_CONTENT");
  }
}

export function isPathContainedBy(workspaceRoot: string, candidatePath: string): boolean {
  const relativePath = relative(workspaceRoot, candidatePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${win32.sep}`) &&
      relativePath !== ".." &&
      !relativePath.startsWith("../") &&
      !isAbsolute(relativePath))
  );
}

export function sameWorkspacePath(first: string, second: string): boolean {
  return relative(first, second) === "" && relative(second, first) === "";
}

export function toolError(code: ToolErrorCode): CodeSentinelToolError {
  return new CodeSentinelToolError(code);
}

export function isToolError(error: unknown): error is CodeSentinelToolError {
  return error instanceof CodeSentinelToolError;
}

function validateMaxBytes(maxBytes: unknown): asserts maxBytes is number {
  if (
    typeof maxBytes !== "number" ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > MAX_READ_BYTES
  ) {
    throw toolError("INVALID_MAX_BYTES");
  }
}

function validateListDepth(depth: unknown): asserts depth is number {
  if (
    typeof depth !== "number" ||
    !Number.isSafeInteger(depth) ||
    depth < 1 ||
    depth > MAX_LIST_DEPTH
  ) {
    throw toolError("INVALID_DEPTH");
  }
}

function validateListEntries(maxEntries: unknown): asserts maxEntries is number {
  if (
    typeof maxEntries !== "number" ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > MAX_LIST_ENTRIES
  ) {
    throw toolError("INVALID_MAX_ENTRIES");
  }
}

function validateSearchQuery(query: unknown): asserts query is string {
  if (
    typeof query !== "string" ||
    query.trim().length === 0 ||
    query.length > MAX_PATH_LENGTH
  ) {
    throw toolError("INVALID_QUERY");
  }
}

function validateSearchMaxResults(maxResults: unknown): asserts maxResults is number {
  if (
    typeof maxResults !== "number" ||
    !Number.isSafeInteger(maxResults) ||
    maxResults < 1 ||
    maxResults > MAX_SEARCH_RESULTS
  ) {
    throw toolError("INVALID_MAX_RESULTS");
  }
}

async function resolveWorkspaceDirectory(
  input: Pick<ListWorkspaceFilesInput, "workspaceRoot" | "path">,
): Promise<ResolvedWorkspaceDirectory> {
  const root = await bindWorkspaceRoot(input?.workspaceRoot);
  if (input?.path === undefined) {
    return Object.freeze({ root, directoryPath: root.canonicalPath });
  }

  const normalizedPath = normalizeRelativePath(input.path);
  const candidatePath = resolve(root.canonicalPath, ...normalizedPath.segments);
  if (!isPathContainedBy(root.canonicalPath, candidatePath)) {
    throw toolError("PATH_OUTSIDE_WORKSPACE");
  }

  const directoryPath = await resolveBoundWorkspaceDirectory(
    root,
    candidatePath,
    "NOT_A_DIRECTORY",
  );

  return Object.freeze({ root, directoryPath });
}

async function resolveWorkspaceSearchTarget(
  input: Pick<SearchWorkspaceTextInput, "workspaceRoot" | "path">,
): Promise<ResolvedWorkspaceSearchTarget> {
  const root = await bindWorkspaceRoot(input?.workspaceRoot);
  if (input?.path === undefined) {
    return Object.freeze({
      kind: "directory",
      root,
      directoryPath: root.canonicalPath,
    });
  }

  const normalizedPath = normalizeRelativePath(input.path);
  const candidatePath = resolve(root.canonicalPath, ...normalizedPath.segments);
  if (!isPathContainedBy(root.canonicalPath, candidatePath)) {
    throw toolError("PATH_OUTSIDE_WORKSPACE");
  }

  await assertBoundWorkspaceRoot(root);
  await assertNoSymbolicPathComponents(root.canonicalPath, normalizedPath.segments);
  const linkInfo = await lstatOrThrow(candidatePath, "NOT_A_FILE");
  if (linkInfo.isDirectory()) {
    const directoryPath = await resolveBoundWorkspaceDirectory(root, candidatePath, "NOT_A_FILE");
    return Object.freeze({
      kind: "directory",
      root,
      directoryPath,
    });
  }
  if (!linkInfo.isFile()) {
    throw toolError("NOT_A_FILE");
  }

  await resolveBoundWorkspaceFile(root, normalizedPath);
  return Object.freeze({
    kind: "file",
    root,
    path: normalizedPath.path,
  });
}

async function walkWorkspaceDirectory(
  root: BoundWorkspaceRoot,
  directoryPath: string,
  maximumDepth: number,
  visit: (candidate: WorkspaceTraversalCandidate) => Promise<boolean>,
): Promise<WorkspaceTraversalResult> {
  let depthLimited = false;

  const walk = async (currentDirectoryPath: string, currentDepth: number): Promise<boolean> => {
    const canonicalCurrentDirectoryPath = await resolveSafeWorkspaceTraversalDirectory(
      root,
      currentDirectoryPath,
    );
    const directoryEntries = await readdir(canonicalCurrentDirectoryPath, { withFileTypes: true });
    await resolveSafeWorkspaceTraversalDirectory(root, canonicalCurrentDirectoryPath);
    directoryEntries.sort((first, second) => compareWorkspaceEntryNames(first.name, second.name));

    for (const directoryEntry of directoryEntries) {
      const candidatePath = join(canonicalCurrentDirectoryPath, directoryEntry.name);
      const candidate = await inspectWorkspaceTraversalCandidate(
        root,
        canonicalCurrentDirectoryPath,
        candidatePath,
      );
      if (!candidate) {
        continue;
      }
      if (await visit(candidate)) {
        return true;
      }

      if (candidate.kind === "directory") {
        if (currentDepth < maximumDepth) {
          const canonicalCandidateDirectoryPath = await resolveSafeWorkspaceTraversalDirectory(
            root,
            candidate.absolutePath,
          );
          if (await walk(canonicalCandidateDirectoryPath, currentDepth + 1)) {
            return true;
          }
        } else {
          depthLimited = true;
        }
      }
    }
    return false;
  };

  return Object.freeze({
    stopped: await walk(directoryPath, 0),
    depthLimited,
  });
}

async function inspectWorkspaceTraversalCandidate(
  root: BoundWorkspaceRoot,
  currentDirectoryPath: string,
  candidatePath: string,
): Promise<WorkspaceTraversalCandidate | undefined> {
  await resolveSafeWorkspaceTraversalDirectory(root, currentDirectoryPath);
  if (hasPosixLiteralBackslash(root.canonicalPath, candidatePath)) {
    return undefined;
  }
  const initialLinkInfo = await lstatOrThrow(candidatePath, "PATH_OUTSIDE_WORKSPACE");
  if (initialLinkInfo.isSymbolicLink()) {
    return undefined;
  }

  const canonicalCandidatePath = await resolveSafeWorkspaceTraversalPath(root, candidatePath);
  const linkInfo = await lstatOrThrow(canonicalCandidatePath, "PATH_OUTSIDE_WORKSPACE");
  if (linkInfo.isSymbolicLink()) {
    return undefined;
  }
  const followedInfo = await statOrThrow(canonicalCandidatePath, "PATH_OUTSIDE_WORKSPACE");
  if (
    linkInfo.isDirectory() &&
    followedInfo.isDirectory() &&
    sameFile(linkInfo, followedInfo)
  ) {
    const acceptedCandidatePath = await resolveSafeWorkspaceTraversalPath(
      root,
      canonicalCandidatePath,
    );
    return Object.freeze({
      kind: "directory",
      absolutePath: acceptedCandidatePath,
      path: workspaceRelativePath(root.canonicalPath, acceptedCandidatePath),
    });
  }
  if (
    linkInfo.isFile() &&
    followedInfo.isFile() &&
    linkInfo.nlink === 1 &&
    followedInfo.nlink === 1 &&
    sameFile(linkInfo, followedInfo)
  ) {
    const acceptedCandidatePath = await resolveSafeWorkspaceTraversalPath(
      root,
      canonicalCandidatePath,
    );
    return Object.freeze({
      kind: "file",
      absolutePath: acceptedCandidatePath,
      path: workspaceRelativePath(root.canonicalPath, acceptedCandidatePath),
    });
  }
  return undefined;
}

function hasPosixLiteralBackslash(workspaceRoot: string, candidatePath: string): boolean {
  return process.platform !== "win32" && relative(workspaceRoot, candidatePath).includes("\\");
}

async function resolveSafeWorkspaceTraversalDirectory(
  root: BoundWorkspaceRoot,
  directoryPath: string,
): Promise<string> {
  return resolveBoundWorkspaceDirectory(root, directoryPath, "PATH_OUTSIDE_WORKSPACE");
}

async function resolveSafeWorkspaceTraversalPath(
  root: BoundWorkspaceRoot,
  candidatePath: string,
): Promise<string> {
  return resolveBoundWorkspacePath(root, candidatePath, "PATH_OUTSIDE_WORKSPACE");
}

async function resolveBoundWorkspaceDirectory(
  root: BoundWorkspaceRoot,
  directoryPath: string,
  errorCode: ToolErrorCode,
): Promise<string> {
  const canonicalDirectoryPath = await resolveBoundWorkspacePath(root, directoryPath, errorCode);
  await inspectSafeDirectory(canonicalDirectoryPath, errorCode);
  await assertBoundWorkspaceRoot(root);
  return canonicalDirectoryPath;
}

async function resolveBoundWorkspacePath(
  root: BoundWorkspaceRoot,
  candidatePath: string,
  errorCode: ToolErrorCode,
): Promise<string> {
  await assertBoundWorkspaceRoot(root);
  if (!isPathContainedBy(root.canonicalPath, candidatePath)) {
    throw toolError("PATH_OUTSIDE_WORKSPACE");
  }

  const relativePath = workspaceRelativePath(root.canonicalPath, candidatePath);
  const segments = relativePath === "" ? [] : relativePath.split("/");
  await assertNoSymbolicPathComponents(root.canonicalPath, segments, errorCode);

  const canonicalCandidatePath = await realpathOrThrow(candidatePath, errorCode);
  if (!isPathContainedBy(root.canonicalPath, canonicalCandidatePath)) {
    throw toolError("PATH_OUTSIDE_WORKSPACE");
  }
  if (!sameWorkspacePath(candidatePath, canonicalCandidatePath)) {
    throw toolError("SYMLINK_NOT_ALLOWED");
  }

  await assertBoundWorkspaceRoot(root);
  return canonicalCandidatePath;
}

function workspaceRelativePath(workspaceRoot: string, candidatePath: string): string {
  if (!isPathContainedBy(workspaceRoot, candidatePath)) {
    throw toolError("PATH_OUTSIDE_WORKSPACE");
  }
  return relative(workspaceRoot, candidatePath).split(/[\\/]/u).join("/");
}

function compareWorkspaceEntryNames(first: string, second: string): number {
  if (first < second) {
    return -1;
  }
  if (first > second) {
    return 1;
  }
  return 0;
}

function appendSearchMatches(
  text: string,
  path: string,
  query: string,
  maxResults: number,
  matches: SearchTextMatch[],
): boolean {
  const lines = text.split(/\r\n|\n/u);
  for (const [lineIndex, line] of lines.entries()) {
    let searchStart = 0;
    while (searchStart <= line.length) {
      const occurrenceStart = line.indexOf(query, searchStart);
      if (occurrenceStart < 0) {
        break;
      }
      matches.push(
        Object.freeze({
          path,
          line: lineIndex + 1,
          snippet: createSearchSnippet(line, occurrenceStart),
        }),
      );
      if (matches.length >= maxResults) {
        return true;
      }
      searchStart = occurrenceStart + 1;
    }
  }
  return false;
}

function createSearchSnippet(line: string, occurrenceStart: number): string {
  if (line.length <= MAX_SEARCH_SNIPPET_CHARACTERS) {
    return line;
  }

  const maximumStart = line.length - MAX_SEARCH_SNIPPET_CHARACTERS;
  const start = Math.min(
    Math.max(0, occurrenceStart - Math.floor(MAX_SEARCH_SNIPPET_CHARACTERS / 2)),
    maximumStart,
  );
  return line.slice(start, start + MAX_SEARCH_SNIPPET_CHARACTERS);
}

function isSearchContentSkipError(error: unknown): error is CodeSentinelToolError {
  return (
    isToolError(error) &&
    (error.code === "BINARY_CONTENT" || error.code === "FILE_TOO_LARGE")
  );
}

async function bindWorkspaceRoot(workspaceRoot: unknown): Promise<BoundWorkspaceRoot> {
  if (
    typeof workspaceRoot !== "string" ||
    workspaceRoot.trim().length === 0 ||
    workspaceRoot.length > MAX_PATH_LENGTH ||
    workspaceRoot.includes("\0") ||
    !isAbsoluteOnAnySupportedPlatform(workspaceRoot)
  ) {
    throw toolError("INVALID_WORKSPACE");
  }

  const canonicalPath = await realpathOrThrow(workspaceRoot, "INVALID_WORKSPACE");
  const identity = await inspectSafeDirectory(canonicalPath, "INVALID_WORKSPACE");
  return Object.freeze({ canonicalPath, identity });
}

function normalizeRelativePath(value: unknown): NormalizedRelativePath {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    value.includes("\0") ||
    value.includes(":") ||
    isAbsoluteOnAnySupportedPlatform(value)
  ) {
    throw toolError("INVALID_PATH");
  }

  const segments = value.split(/[\\/]/u);
  if (
    segments.length === 0 ||
    segments.length > MAX_PATH_SEGMENTS ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(" ") ||
        segment.endsWith(".") ||
        WINDOWS_RESERVED_DEVICE_NAME.test(segment),
    )
  ) {
    throw toolError("INVALID_PATH");
  }

  return Object.freeze({ path: segments.join("/"), segments });
}

function isAbsoluteOnAnySupportedPlatform(value: string): boolean {
  return isAbsolute(value) || posix.isAbsolute(value) || win32.isAbsolute(value);
}

async function assertNoSymbolicPathComponents(
  workspaceRoot: string,
  segments: readonly string[],
  errorCode: ToolErrorCode = "NOT_A_FILE",
): Promise<void> {
  let currentPath = workspaceRoot;
  for (const [index, segment] of segments.entries()) {
    currentPath = join(currentPath, segment);
    const info = await lstatOrThrow(currentPath, errorCode);
    if (info.isSymbolicLink()) {
      throw toolError("SYMLINK_NOT_ALLOWED");
    }
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw toolError(errorCode);
    }
  }
}

async function inspectSafeRegularFile(filePath: string): Promise<WorkspaceFileSnapshot> {
  const linkInfo = await lstatOrThrow(filePath, "NOT_A_FILE");
  if (linkInfo.isSymbolicLink()) {
    throw toolError("SYMLINK_NOT_ALLOWED");
  }
  if (!linkInfo.isFile()) {
    throw toolError("NOT_A_FILE");
  }
  if (linkInfo.nlink !== 1) {
    throw toolError("UNSAFE_FILE");
  }

  const followedInfo = await statOrThrow(filePath, "NOT_A_FILE");
  const snapshot = fileSnapshot(followedInfo);
  if (!followedInfo.isFile() || snapshot.nlink !== 1 || !sameFile(linkInfo, followedInfo)) {
    throw toolError("UNSAFE_FILE");
  }

  return snapshot;
}

async function inspectSafeDirectory(
  directoryPath: string,
  errorCode: ToolErrorCode = "NOT_A_FILE",
): Promise<WorkspaceNodeIdentity> {
  const linkInfo = await lstatOrThrow(directoryPath, errorCode);
  if (linkInfo.isSymbolicLink() || !linkInfo.isDirectory()) {
    throw toolError(errorCode);
  }

  const followedInfo = await statOrThrow(directoryPath, errorCode);
  if (!followedInfo.isDirectory() || !sameFile(linkInfo, followedInfo)) {
    throw toolError(errorCode);
  }

  return Object.freeze({ dev: followedInfo.dev, ino: followedInfo.ino });
}

async function assertBoundWorkspaceRoot(root: BoundWorkspaceRoot): Promise<void> {
  const currentCanonicalPath = await realpathOrThrow(
    root.canonicalPath,
    "PATH_OUTSIDE_WORKSPACE",
  );
  if (!sameWorkspacePath(root.canonicalPath, currentCanonicalPath)) {
    throw toolError("PATH_OUTSIDE_WORKSPACE");
  }

  const currentIdentity = await inspectSafeDirectory(
    root.canonicalPath,
    "PATH_OUTSIDE_WORKSPACE",
  );
  if (!sameFile(root.identity, currentIdentity)) {
    throw toolError("PATH_OUTSIDE_WORKSPACE");
  }

  const confirmedCanonicalPath = await realpathOrThrow(
    root.canonicalPath,
    "PATH_OUTSIDE_WORKSPACE",
  );
  if (!sameWorkspacePath(root.canonicalPath, confirmedCanonicalPath)) {
    throw toolError("PATH_OUTSIDE_WORKSPACE");
  }

  const confirmedIdentity = await inspectSafeDirectory(
    root.canonicalPath,
    "PATH_OUTSIDE_WORKSPACE",
  );
  if (!sameFile(root.identity, confirmedIdentity)) {
    throw toolError("PATH_OUTSIDE_WORKSPACE");
  }
}

async function readBoundedFile(
  resolvedFile: ResolvedWorkspaceFile,
  maxBytes: number,
): Promise<Readonly<{ bytes: Buffer; truncated: boolean }>> {
  return withVerifiedFile(resolvedFile, async (handle) => readBoundedHandle(handle, maxBytes));
}

async function readBoundedHandle(
  handle: FileHandle,
  maxBytes: number,
): Promise<Readonly<{ bytes: Buffer; truncated: boolean }>> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
    if (result.bytesRead === 0) {
      break;
    }
    bytesRead += result.bytesRead;
  }
  const bytes = buffer.subarray(0, bytesRead);
  return Object.freeze({ bytes, truncated: bytesRead > maxBytes });
}

async function readExactHandle(handle: FileHandle, size: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(size);
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
    if (result.bytesRead === 0) {
      break;
    }
    bytesRead += result.bytesRead;
  }
  return Buffer.from(buffer.subarray(0, bytesRead));
}

async function withVerifiedFile<T>(
  resolvedFile: ResolvedWorkspaceFile,
  operation: (
    handle: FileHandle,
    openedSnapshot: WorkspaceFileSnapshot,
    openedSize: number,
  ) => Promise<T>,
): Promise<T> {
  try {
    const root = workspaceRootBindings.get(resolvedFile);
    if (!root) {
      const reboundFile = await resolveExistingWorkspaceFile({
        workspaceRoot: resolvedFile.workspaceRoot,
        path: resolvedFile.path,
      });
      return withVerifiedFile(reboundFile, operation);
    }

    await assertBoundWorkspaceRoot(root);
    const beforeOpen = await inspectSafeRegularFile(resolvedFile.realPath);
    const currentRealPath = await realpathOrThrow(resolvedFile.realPath, "NOT_A_FILE");
    if (
      !sameWorkspacePath(currentRealPath, resolvedFile.realPath) ||
      !isPathContainedBy(resolvedFile.workspaceRoot, currentRealPath)
    ) {
      throw toolError("UNSAFE_FILE");
    }

    await assertBoundWorkspaceRoot(root);
    const handle = await open(resolvedFile.realPath, "r");
    try {
      const openedInfo = await handle.stat();
      const openedSnapshot = fileSnapshot(openedInfo);
      if (
        !openedInfo.isFile() ||
        openedSnapshot.nlink !== 1 ||
        !sameSnapshot(beforeOpen, openedSnapshot)
      ) {
        throw toolError("UNSAFE_FILE");
      }

      await assertBoundWorkspaceRoot(root);
      const result = await operation(handle, openedSnapshot, openedInfo.size);
      await assertBoundWorkspaceRoot(root);
      return result;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isToolError(error)) {
      throw error;
    }
    throw toolError("READ_FAILED");
  }
}

function decodeBoundedText(prefix: Buffer, sample: Buffer, truncated: boolean): string {
  if (sample.includes(0)) {
    throw toolError("BINARY_CONTENT");
  }

  try {
    const validator = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    validator.decode(sample, { stream: truncated });
    if (!truncated) {
      validator.decode();
    }

    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const text = decoder.decode(prefix, { stream: truncated });
    if (!truncated) {
      decoder.decode();
    }
    return text;
  } catch {
    throw toolError("BINARY_CONTENT");
  }
}

function fileSnapshot(info: {
  dev: number;
  ino: number;
  nlink: number;
  mode: number;
}): WorkspaceFileSnapshot {
  return Object.freeze({
    dev: info.dev,
    ino: info.ino,
    nlink: info.nlink,
    mode: info.mode & 0o777,
  });
}

function sameFile(
  first: { dev: number; ino: number },
  second: { dev: number; ino: number },
): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function sameSnapshot(first: WorkspaceFileSnapshot, second: WorkspaceFileSnapshot): boolean {
  return first.mode === second.mode && first.nlink === second.nlink && sameFile(first, second);
}

async function realpathOrThrow(path: string, errorCode: ToolErrorCode): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw toolError(errorCode);
  }
}

async function lstatOrThrow(path: string, errorCode: ToolErrorCode) {
  try {
    return await lstat(path);
  } catch {
    throw toolError(errorCode);
  }
}

async function statOrThrow(path: string, errorCode: ToolErrorCode) {
  try {
    return await stat(path);
  } catch {
    throw toolError(errorCode);
  }
}
