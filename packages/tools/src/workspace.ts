import { open, lstat, realpath, stat, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { TextDecoder } from "node:util";

export const MAX_READ_BYTES = 1_048_576;
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

export async function resolveExistingWorkspaceFile(
  input: WorkspaceFileInput,
): Promise<ResolvedWorkspaceFile> {
  const normalizedPath = normalizeRelativePath(input?.path);
  const workspaceRoot = await resolveWorkspaceRoot(input?.workspaceRoot);
  const candidatePath = resolve(workspaceRoot, ...normalizedPath.segments);

  if (!isPathContainedBy(workspaceRoot, candidatePath)) {
    throw toolError("PATH_OUTSIDE_WORKSPACE");
  }

  await assertNoSymbolicPathComponents(workspaceRoot, normalizedPath.segments);

  const realPath = await realpathOrThrow(candidatePath, "NOT_A_FILE");
  if (!isPathContainedBy(workspaceRoot, realPath)) {
    throw toolError("PATH_OUTSIDE_WORKSPACE");
  }

  await inspectSafeRegularFile(realPath);

  const directoryPath = await realpathOrThrow(dirname(realPath), "NOT_A_FILE");
  if (!isPathContainedBy(workspaceRoot, directoryPath)) {
    throw toolError("PATH_OUTSIDE_WORKSPACE");
  }
  await inspectSafeDirectory(directoryPath);

  return Object.freeze({
    workspaceRoot,
    path: normalizedPath.path,
    realPath,
    directoryPath,
  });
}

export async function readResolvedWorkspaceFile(
  resolvedFile: ResolvedWorkspaceFile,
): Promise<Buffer> {
  return (await readVerifiedWorkspaceFile(resolvedFile)).bytes;
}

export async function readVerifiedWorkspaceFile(
  resolvedFile: ResolvedWorkspaceFile,
): Promise<VerifiedWorkspaceFileRead> {
  const verifiedRead = await withVerifiedFile(resolvedFile, async (handle, openedSnapshot) => {
    const bounded = await readBoundedHandle(handle, MAX_READ_BYTES);
    if (bounded.truncated) {
      throw toolError("FILE_TOO_LARGE");
    }

    const finalSnapshot = fileSnapshot(await handle.stat());
    if (!sameSnapshot(openedSnapshot, finalSnapshot)) {
      throw toolError("UNSAFE_FILE");
    }

    return Object.freeze({
      bytes: Buffer.from(bounded.bytes),
      snapshot: finalSnapshot,
    });
  });

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

async function resolveWorkspaceRoot(workspaceRoot: unknown): Promise<string> {
  if (
    typeof workspaceRoot !== "string" ||
    workspaceRoot.trim().length === 0 ||
    workspaceRoot.length > MAX_PATH_LENGTH ||
    workspaceRoot.includes("\0") ||
    !isAbsoluteOnAnySupportedPlatform(workspaceRoot)
  ) {
    throw toolError("INVALID_WORKSPACE");
  }

  const realWorkspaceRoot = await realpathOrThrow(workspaceRoot, "INVALID_WORKSPACE");
  await inspectSafeDirectory(realWorkspaceRoot, "INVALID_WORKSPACE");
  return realWorkspaceRoot;
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
): Promise<void> {
  let currentPath = workspaceRoot;
  for (const [index, segment] of segments.entries()) {
    currentPath = join(currentPath, segment);
    const info = await lstatOrThrow(currentPath, "NOT_A_FILE");
    if (info.isSymbolicLink()) {
      throw toolError("SYMLINK_NOT_ALLOWED");
    }
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw toolError("NOT_A_FILE");
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
): Promise<void> {
  const linkInfo = await lstatOrThrow(directoryPath, errorCode);
  if (linkInfo.isSymbolicLink() || !linkInfo.isDirectory()) {
    throw toolError(errorCode);
  }

  const followedInfo = await statOrThrow(directoryPath, errorCode);
  if (!followedInfo.isDirectory() || !sameFile(linkInfo, followedInfo)) {
    throw toolError(errorCode);
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

async function withVerifiedFile<T>(
  resolvedFile: ResolvedWorkspaceFile,
  operation: (handle: FileHandle, openedSnapshot: WorkspaceFileSnapshot) => Promise<T>,
): Promise<T> {
  try {
    const beforeOpen = await inspectSafeRegularFile(resolvedFile.realPath);
    const currentRealPath = await realpathOrThrow(resolvedFile.realPath, "NOT_A_FILE");
    if (
      !sameWorkspacePath(currentRealPath, resolvedFile.realPath) ||
      !isPathContainedBy(resolvedFile.workspaceRoot, currentRealPath)
    ) {
      throw toolError("UNSAFE_FILE");
    }

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

      return await operation(handle, openedSnapshot);
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
