import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { applyPatch, parsePatch, type StructuredPatch } from "diff";
import {
  decodeWorkspaceText,
  isPathContainedBy,
  isToolError,
  readVerifiedWorkspaceFile,
  resolveExistingWorkspaceFile,
  sameWorkspacePath,
  toolError,
  type ResolvedWorkspaceFile,
  type WorkspaceFileSnapshot,
  type WorkspaceFileInput,
} from "./workspace.js";

const UNBOUND_APPROVAL_ID = "unbound-approval";
const UNBOUND_ACTION_ID = "unbound-action";
export const MAX_PATCH_BYTES = 1_048_576;
const MAX_PATCH_RESULT_BYTES = MAX_PATCH_BYTES * 2;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

export type PatchApproval = Readonly<{
  id: string;
  actionId: string;
  patchHash: string;
  baseHash: string;
  status: string;
  createdAt: number;
  expiresAt: number;
}>;

export type ApplyApprovedPatchInput = WorkspaceFileInput &
  Readonly<{
    patch: string;
    approval: PatchApproval;
  }>;

export type ApplyApprovedPatchResult = Readonly<{
  path: string;
  hash: string;
}>;

type ValidatedApproval = Readonly<{
  baseHash: string;
}>;

type TemporaryFileOwnership = Readonly<{
  realPath: string;
  dev: number;
  ino: number;
  nlink: number;
}>;

type TemporaryFileSnapshot = TemporaryFileOwnership &
  Readonly<{
    size: number;
    hash: string;
  }>;

type RevalidatedTarget = Readonly<{
  target: ResolvedWorkspaceFile;
  snapshot: WorkspaceFileSnapshot;
}>;

type TargetBaseline = Readonly<{
  hash: string;
  snapshot: WorkspaceFileSnapshot;
}>;

/**
 * The action identifier is only syntax-checked here. Binding it to trusted,
 * one-time approval storage is intentionally owned by later Core/Persistence work.
 */
export async function applyApprovedPatch(
  input: ApplyApprovedPatchInput,
): Promise<ApplyApprovedPatchResult> {
  const request: Partial<ApplyApprovedPatchInput> = input ?? {};
  const patch = validatePatchInput(request.patch);
  const approval = validateApproval(request.approval, sha256Utf8(patch));
  const location = workspaceLocation(request);

  const initialTarget = await resolveExistingWorkspaceFile(location);
  const initialRead = await readVerifiedWorkspaceFile(initialTarget);
  const initialHash = sha256Bytes(initialRead.bytes);
  if (initialHash !== approval.baseHash) {
    throw toolError("BASE_HASH_MISMATCH");
  }

  const source = decodeWorkspaceText(initialRead.bytes);
  const parsedPatch = parseSingleFilePatch(patch, initialTarget.path, source);
  const updatedSource = applySinglePatch(source, parsedPatch);
  if (updatedSource === source) {
    throw toolError("PATCH_NOT_APPLICABLE");
  }

  const updatedBytes = Buffer.from(updatedSource, "utf8");
  if (updatedBytes.byteLength > MAX_PATCH_RESULT_BYTES) {
    throw toolError("FILE_TOO_LARGE");
  }
  decodeWorkspaceText(updatedBytes);

  await atomicallyReplaceVerifiedTarget(
    location,
    initialTarget,
    Object.freeze({ hash: initialHash, snapshot: initialRead.snapshot }),
    updatedBytes,
  );

  return Object.freeze({
    path: initialTarget.path,
    hash: sha256Bytes(updatedBytes),
  });
}

function workspaceLocation(input: Partial<ApplyApprovedPatchInput>): WorkspaceFileInput {
  return {
    workspaceRoot: typeof input.workspaceRoot === "string" ? input.workspaceRoot : "",
    path: typeof input.path === "string" ? input.path : "",
  };
}

function validatePatchInput(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_PATCH_BYTES
  ) {
    throw toolError("INVALID_PATCH");
  }
  return value;
}

function validateApproval(value: unknown, patchHash: string): ValidatedApproval {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw toolError("APPROVAL_REQUIRED");
    }

    const approval = value as Partial<PatchApproval>;
    if (
      approval.status !== "approved" ||
      !isNonEmptyField(approval.id) ||
      !isNonEmptyField(approval.actionId) ||
      approval.id === UNBOUND_APPROVAL_ID ||
      approval.actionId === UNBOUND_ACTION_ID ||
      !isSha256(approval.patchHash) ||
      !isSha256(approval.baseHash)
    ) {
      throw toolError("APPROVAL_REQUIRED");
    }

    const createdAt = approval.createdAt;
    const expiresAt = approval.expiresAt;
    const now = Date.now();
    if (
      typeof createdAt !== "number" ||
      typeof expiresAt !== "number" ||
      !Number.isFinite(createdAt) ||
      !Number.isFinite(expiresAt) ||
      createdAt > expiresAt ||
      now < createdAt ||
      now >= expiresAt
    ) {
      throw toolError("APPROVAL_EXPIRED");
    }

    if (approval.patchHash !== patchHash) {
      throw toolError("PATCH_HASH_MISMATCH");
    }

    return Object.freeze({ baseHash: approval.baseHash });
  } catch (error) {
    if (isToolError(error)) {
      throw error;
    }
    throw toolError("APPROVAL_REQUIRED");
  }
}

function isNonEmptyField(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !value.includes("\0");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function parseSingleFilePatch(
  patch: string,
  targetPath: string,
  source: string,
): StructuredPatch {
  const lines = strictPatchLines(patch);

  let parsedPatches: StructuredPatch[];
  try {
    parsedPatches = parsePatch(patch);
  } catch {
    throw toolError("INVALID_PATCH");
  }

  if (parsedPatches.length !== 1) {
    throw toolError("INVALID_PATCH");
  }

  const parsedPatch = parsedPatches[0];
  if (
    parsedPatch === undefined ||
    parsedPatch.hunks.length === 0 ||
    parsedPatch.isRename ||
    parsedPatch.isCopy ||
    parsedPatch.isCreate ||
    parsedPatch.isDelete ||
    parsedPatch.isBinary ||
    parsedPatch.oldMode !== undefined ||
    parsedPatch.newMode !== undefined ||
    !hasPatchChanges(parsedPatch)
  ) {
    throw toolError("INVALID_PATCH");
  }

  validateStrictPatchStructure(lines, parsedPatch, targetPath, source);
  return parsedPatch;
}

function hasPatchChanges(patch: StructuredPatch): boolean {
  return patch.hunks.some((hunk) =>
    hunk.lines.some((line) => line.startsWith("+") || line.startsWith("-")),
  );
}

function strictPatchLines(patch: string): string[] {
  const lines = patch.split(/\r?\n/u);
  if (patch.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

function validateStrictPatchStructure(
  lines: readonly string[],
  patch: StructuredPatch,
  targetPath: string,
  source: string,
): void {
  let cursor = 0;
  const hasRawFileHeaders = lines[0]?.startsWith("--- ") === true;
  const hasFileNames = patch.oldFileName !== undefined || patch.newFileName !== undefined;
  if (
    lines.length === 0 ||
    patch.isGit === true ||
    patch.index !== undefined ||
    (hasRawFileHeaders && !lines[1]?.startsWith("+++ ")) ||
    (!hasRawFileHeaders && (lines[0]?.startsWith("+++ ") === true || hasFileNames)) ||
    (hasRawFileHeaders && (patch.oldFileName === undefined || patch.newFileName === undefined))
  ) {
    throw toolError("INVALID_PATCH");
  }

  if (hasRawFileHeaders) {
    if (
      !headerMatchesTarget(patch.oldFileName, targetPath, "a") ||
      !headerMatchesTarget(patch.newFileName, targetPath, "b")
    ) {
      throw toolError("INVALID_PATCH");
    }
    cursor = 2;
  }

  const sourceLineCount = textLineCount(source);
  const targetLineCount = patchedLineCount(sourceLineCount, patch);
  for (const [hunkIndex, hunk] of patch.hunks.entries()) {
    validateNoNewlineMarkers(
      hunk,
      hunkIndex === patch.hunks.length - 1,
      source.endsWith("\n"),
      sourceLineCount,
      targetLineCount,
    );
    if (!isHunkHeader(lines[cursor])) {
      throw toolError("INVALID_PATCH");
    }
    cursor += 1;

    for (const hunkLine of hunk.lines) {
      if (!isHunkBodyLine(hunkLine) || lines[cursor] !== hunkLine) {
        throw toolError("INVALID_PATCH");
      }
      cursor += 1;
    }
  }

  if (cursor !== lines.length) {
    throw toolError("INVALID_PATCH");
  }
}

function isHunkHeader(line: string | undefined): boolean {
  return line !== undefined && /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u.test(line);
}

function isHunkBodyLine(line: string): boolean {
  return (
    line.startsWith(" ") ||
    line.startsWith("+") ||
    line.startsWith("-") ||
    line === NO_NEWLINE_MARKER
  );
}

function textLineCount(value: string): number {
  if (value.length === 0) {
    return 0;
  }

  const lineCount = value.split("\n").length;
  return value.endsWith("\n") ? lineCount - 1 : lineCount;
}

function patchedLineCount(sourceLineCount: number, patch: StructuredPatch): number {
  let result = sourceLineCount;
  for (const hunk of patch.hunks) {
    if (
      !Number.isSafeInteger(hunk.oldLines) ||
      !Number.isSafeInteger(hunk.newLines) ||
      hunk.oldLines < 0 ||
      hunk.newLines < 0
    ) {
      throw toolError("INVALID_PATCH");
    }

    result += hunk.newLines - hunk.oldLines;
    if (!Number.isSafeInteger(result) || result < 0) {
      throw toolError("INVALID_PATCH");
    }
  }
  return result;
}

function validateNoNewlineMarkers(
  hunk: StructuredPatch["hunks"][number],
  isFinalHunk: boolean,
  sourceHasTerminalNewline: boolean,
  sourceLineCount: number,
  targetLineCount: number,
): void {
  let lastOldBodyLine = -1;
  let lastNewBodyLine = -1;
  for (const [index, line] of hunk.lines.entries()) {
    const operation = hunkLineOperation(line);
    if (operation === " " || operation === "-") {
      lastOldBodyLine = index;
    }
    if (operation === " " || operation === "+") {
      lastNewBodyLine = index;
    }
  }

  let sawOldMarker = false;
  let sawNewMarker = false;
  for (const [index, line] of hunk.lines.entries()) {
    if (line !== NO_NEWLINE_MARKER) {
      continue;
    }

    const precedingOperation = hunkLineOperation(hunk.lines[index - 1]);
    if (
      !isFinalHunk ||
      (precedingOperation !== " " && precedingOperation !== "-" && precedingOperation !== "+")
    ) {
      throw toolError("INVALID_PATCH");
    }

    const marksOldSide = precedingOperation === " " || precedingOperation === "-";
    const marksNewSide = precedingOperation === " " || precedingOperation === "+";
    if (
      (marksOldSide && (sawOldMarker || index !== lastOldBodyLine + 1)) ||
      (marksNewSide && (sawNewMarker || index !== lastNewBodyLine + 1))
    ) {
      throw toolError("INVALID_PATCH");
    }

    if (marksOldSide) {
      const oldEnd = hunk.oldStart + hunk.oldLines - 1;
      if (
        sourceHasTerminalNewline ||
        !Number.isSafeInteger(oldEnd) ||
        oldEnd !== sourceLineCount
      ) {
        throw toolError("INVALID_PATCH");
      }
      sawOldMarker = true;
    }

    if (marksNewSide) {
      const newEnd = hunk.newStart + hunk.newLines - 1;
      if (!Number.isSafeInteger(newEnd) || newEnd !== targetLineCount) {
        throw toolError("INVALID_PATCH");
      }
      sawNewMarker = true;
    }
  }
}

function hunkLineOperation(line: string | undefined): string | undefined {
  return line === undefined || line.length === 0 ? undefined : line[0];
}

function headerMatchesTarget(
  headerPath: string | undefined,
  targetPath: string,
  prefix?: "a" | "b",
): boolean {
  if (headerPath === undefined || headerPath === "/dev/null") {
    return false;
  }

  const normalizedCandidates = [
    normalizePatchPath(headerPath),
    prefix === undefined ? undefined : normalizePatchPath(removeExpectedPrefix(headerPath, prefix)),
  ];
  return normalizedCandidates.some((candidate) => candidate === targetPath);
}

function removeExpectedPrefix(value: string, prefix: "a" | "b"): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.startsWith(`${prefix}/`) ? normalized.slice(2) : normalized;
}

function normalizePatchPath(value: string): string | undefined {
  if (value.length === 0 || value.includes("\0") || value.includes(":")) {
    return undefined;
  }

  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/")) {
    return undefined;
  }

  const segments = normalized.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(" ") ||
        segment.endsWith("."),
    )
  ) {
    return undefined;
  }

  return segments.join("/");
}

function applySinglePatch(source: string, patch: StructuredPatch): string {
  if (!hunksMatchDeclaredLocations(source, patch)) {
    throw toolError("PATCH_NOT_APPLICABLE");
  }

  try {
    const result = applyPatch(source, patch, {
      autoConvertLineEndings: false,
      fuzzFactor: 0,
    });
    if (result === false) {
      throw toolError("PATCH_NOT_APPLICABLE");
    }
    return result;
  } catch (error) {
    if (isToolError(error)) {
      throw error;
    }
    throw toolError("INVALID_PATCH");
  }
}

function hunksMatchDeclaredLocations(source: string, patch: StructuredPatch): boolean {
  const sourceLines = source.split("\n");
  let previousOldStart = 0;
  let previousOldEnd = 0;
  let accumulatedLineOffset = 0;

  for (const hunk of patch.hunks) {
    if (
      !Number.isSafeInteger(hunk.oldStart) ||
      !Number.isSafeInteger(hunk.oldLines) ||
      !Number.isSafeInteger(hunk.newStart) ||
      !Number.isSafeInteger(hunk.newLines) ||
      hunk.oldStart < 1 ||
      hunk.oldLines < 0 ||
      hunk.newStart < 1 ||
      hunk.newLines < 0
    ) {
      return false;
    }

    const oldEnd = hunk.oldStart + hunk.oldLines;
    const expectedNewStart = hunk.oldStart + accumulatedLineOffset;
    if (
      !Number.isSafeInteger(oldEnd) ||
      !Number.isSafeInteger(expectedNewStart) ||
      hunk.oldStart <= previousOldStart ||
      hunk.oldStart < previousOldEnd ||
      hunk.newStart !== expectedNewStart
    ) {
      return false;
    }

    let sourceIndex = hunk.oldStart - 1;
    if (sourceIndex >= sourceLines.length) {
      return false;
    }

    let oldLineCount = 0;
    let newLineCount = 0;
    for (const hunkLine of hunk.lines) {
      const operation = hunkLine.length === 0 ? " " : hunkLine[0];
      if (operation === " " || operation === "-") {
        const content = hunkLine.length === 0 ? "" : hunkLine.slice(1);
        if (sourceLines[sourceIndex] !== content) {
          return false;
        }
        sourceIndex += 1;
        oldLineCount += 1;
      }

      if (operation === " " || operation === "+") {
        newLineCount += 1;
      }

      if (
        operation !== " " &&
        operation !== "-" &&
        operation !== "+" &&
        (operation !== "\\" || hunkLine !== NO_NEWLINE_MARKER)
      ) {
        return false;
      }
    }

    if (oldLineCount !== hunk.oldLines || newLineCount !== hunk.newLines) {
      return false;
    }

    const nextLineOffset = accumulatedLineOffset + hunk.newLines - hunk.oldLines;
    if (!Number.isSafeInteger(nextLineOffset)) {
      return false;
    }

    previousOldStart = hunk.oldStart;
    previousOldEnd = oldEnd;
    accumulatedLineOffset = nextLineOffset;
  }

  return true;
}

async function atomicallyReplaceVerifiedTarget(
  location: WorkspaceFileInput,
  initialTarget: ResolvedWorkspaceFile,
  baseline: TargetBaseline,
  updatedBytes: Buffer,
): Promise<void> {
  let temporaryPath: string | undefined;
  let temporaryCreated = false;
  let temporaryOwnership: TemporaryFileOwnership | undefined;

  try {
    const verifiedTarget = await revalidateTarget(location, initialTarget, baseline);
    // Preserve portable POSIX permission bits only; ACLs, ownership, ADS, and xattrs are not portable.
    const targetPermissionBits = verifiedTarget.snapshot.mode;
    temporaryPath = join(
      verifiedTarget.target.directoryPath,
      `.${basename(verifiedTarget.target.realPath)}.codesentinel-${randomUUID()}.tmp`,
    );

    const handle = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      temporaryOwnership = await captureTemporaryOwnership(
        temporaryPath,
        verifiedTarget.target,
        handle,
      );
      await handle.writeFile(updatedBytes);
      await handle.chmod(targetPermissionBits);
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (temporaryOwnership === undefined) {
      throw toolError("WRITE_FAILED");
    }
    const expectedHash = sha256Bytes(updatedBytes);
    const writtenTemporary = await inspectTemporaryFile(
      temporaryPath,
      verifiedTarget.target,
      temporaryOwnership,
      updatedBytes.byteLength,
      expectedHash,
    );

    const latestTarget = await revalidateTarget(
      location,
      verifiedTarget.target,
      baseline,
    );
    if (
      !sameWorkspacePath(latestTarget.target.realPath, verifiedTarget.target.realPath) ||
      !sameWorkspacePath(
        latestTarget.target.directoryPath,
        verifiedTarget.target.directoryPath,
      ) ||
      !sameTargetSnapshot(latestTarget.snapshot, verifiedTarget.snapshot)
    ) {
      throw toolError("WRITE_FAILED");
    }

    const latestTemporary = await inspectTemporaryFile(
      temporaryPath,
      latestTarget.target,
      temporaryOwnership,
      updatedBytes.byteLength,
      expectedHash,
    );
    if (!sameTemporarySnapshot(writtenTemporary, latestTemporary)) {
      throw toolError("WRITE_FAILED");
    }

    await rename(latestTemporary.realPath, latestTarget.target.realPath);
    temporaryCreated = false;
  } catch (error) {
    if (isToolError(error)) {
      throw error;
    }
    throw toolError("WRITE_FAILED");
  } finally {
    if (
      temporaryCreated &&
      temporaryPath !== undefined &&
      temporaryOwnership !== undefined
    ) {
      await cleanupTemporaryFile(temporaryPath, initialTarget.workspaceRoot, temporaryOwnership);
    }
  }
}

async function revalidateTarget(
  location: WorkspaceFileInput,
  expectedTarget: ResolvedWorkspaceFile,
  baseline: TargetBaseline,
): Promise<RevalidatedTarget> {
  const currentTarget = await resolveExistingWorkspaceFile(location);
  if (!sameWorkspacePath(currentTarget.realPath, expectedTarget.realPath)) {
    throw toolError("WRITE_FAILED");
  }

  const currentRead = await readVerifiedWorkspaceFile(currentTarget);
  if (
    sha256Bytes(currentRead.bytes) !== baseline.hash ||
    !sameTargetSnapshot(currentRead.snapshot, baseline.snapshot)
  ) {
    throw toolError("WRITE_FAILED");
  }

  return Object.freeze({ target: currentTarget, snapshot: currentRead.snapshot });
}

async function captureTemporaryOwnership(
  temporaryPath: string,
  target: ResolvedWorkspaceFile,
  handle: FileHandle,
): Promise<TemporaryFileOwnership> {
  const realPath = await realpath(temporaryPath);
  const pathInfo = await lstat(realPath);
  const openedInfo = await handle.stat();
  if (
    !isTemporaryFileInTargetDirectory(realPath, target) ||
    pathInfo.isSymbolicLink() ||
    !pathInfo.isFile() ||
    pathInfo.nlink !== 1 ||
    !openedInfo.isFile() ||
    openedInfo.nlink !== 1 ||
    !sameFileIdentity(pathInfo, openedInfo)
  ) {
    throw toolError("WRITE_FAILED");
  }

  return Object.freeze({
    realPath,
    dev: openedInfo.dev,
    ino: openedInfo.ino,
    nlink: openedInfo.nlink,
  });
}

async function inspectTemporaryFile(
  temporaryPath: string,
  target: ResolvedWorkspaceFile,
  ownership: TemporaryFileOwnership,
  expectedSize: number,
  expectedHash: string,
): Promise<TemporaryFileSnapshot> {
  const realPath = await realpath(temporaryPath);
  const pathInfo = await lstat(realPath);
  if (
    !isTemporaryFileInTargetDirectory(realPath, target) ||
    pathInfo.isSymbolicLink() ||
    !pathInfo.isFile() ||
    pathInfo.nlink !== 1 ||
    !sameTemporaryOwnership(pathInfo, ownership) ||
    pathInfo.size !== expectedSize
  ) {
    throw toolError("WRITE_FAILED");
  }

  const handle = await open(realPath, "r");
  try {
    const openedInfo = await handle.stat();
    if (
      !openedInfo.isFile() ||
      openedInfo.nlink !== 1 ||
      !sameFileIdentity(pathInfo, openedInfo) ||
      !sameTemporaryOwnership(openedInfo, ownership) ||
      openedInfo.size !== expectedSize
    ) {
      throw toolError("WRITE_FAILED");
    }

    const buffer = Buffer.allocUnsafe(expectedSize + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    const hash = sha256Bytes(bytes);
    if (bytesRead !== expectedSize || hash !== expectedHash) {
      throw toolError("WRITE_FAILED");
    }

    return Object.freeze({
      ...ownership,
      size: expectedSize,
      hash,
    });
  } finally {
    await handle.close();
  }
}

function isTemporaryFileInTargetDirectory(
  temporaryPath: string,
  target: ResolvedWorkspaceFile,
): boolean {
  return (
    isPathContainedBy(target.workspaceRoot, temporaryPath) &&
    sameWorkspacePath(dirname(temporaryPath), target.directoryPath)
  );
}

function sameFileIdentity(
  first: { dev: number; ino: number },
  second: { dev: number; ino: number },
): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function sameTargetSnapshot(
  first: WorkspaceFileSnapshot,
  second: WorkspaceFileSnapshot,
): boolean {
  return (
    first.mode === second.mode &&
    first.nlink === second.nlink &&
    sameFileIdentity(first, second)
  );
}

function sameTemporaryOwnership(
  first: { dev: number; ino: number; nlink: number },
  second: TemporaryFileOwnership,
): boolean {
  return first.nlink === second.nlink && sameFileIdentity(first, second);
}

function sameTemporarySnapshot(
  first: TemporaryFileSnapshot,
  second: TemporaryFileSnapshot,
): boolean {
  return (
    sameWorkspacePath(first.realPath, second.realPath) &&
    first.size === second.size &&
    first.hash === second.hash &&
    sameTemporaryOwnership(first, second)
  );
}

async function cleanupTemporaryFile(
  path: string,
  workspaceRoot: string,
  ownership: TemporaryFileOwnership,
): Promise<void> {
  try {
    const realTemporaryPath = await realpath(path);
    const info = await lstat(realTemporaryPath);
    if (
      isPathContainedBy(workspaceRoot, realTemporaryPath) &&
      sameWorkspacePath(realTemporaryPath, ownership.realPath) &&
      !info.isSymbolicLink() &&
      info.isFile() &&
      info.nlink === 1 &&
      sameTemporaryOwnership(info, ownership)
    ) {
      await unlink(realTemporaryPath);
    }
  } catch {
    // Cleanup is best-effort and only ever targets the uniquely named temporary file.
  }
}

function sha256Utf8(value: string): string {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

function sha256Bytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
