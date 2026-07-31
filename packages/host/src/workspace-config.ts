import { open, lstat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { CodeSentinelConfigSchema, type CodeSentinelConfig } from "../../contracts/src/index.js";
import { hostError } from "./errors.js";

const CONFIG_FILE_NAME = "codesentinel.json";
const MAX_CONFIG_BYTES = 65_536;

export type WorkspaceConfigLoadInput = Readonly<{
  workspacePath: string;
}>;

export type LoadedWorkspace = Readonly<{
  canonicalRoot: string;
  workspaceId: string;
  config: CodeSentinelConfig;
}>;

export interface WorkspaceConfigLoader {
  load(input: WorkspaceConfigLoadInput): Promise<LoadedWorkspace>;
}

export function createWorkspaceConfigLoader(): WorkspaceConfigLoader {
  return Object.freeze({
    async load(input: WorkspaceConfigLoadInput): Promise<LoadedWorkspace> {
      const workspacePath = readWorkspacePath(input);
      const canonicalRoot = await resolveCanonicalRoot(workspacePath);
      const configPath = join(canonicalRoot, CONFIG_FILE_NAME);
      const config = await readWorkspaceConfig(configPath);

      return Object.freeze({
        canonicalRoot,
        workspaceId: workspaceIdFor(canonicalRoot),
        config: snapshotConfig(config),
      });
    },
  });
}

export function workspaceIdFor(canonicalRoot: string): string {
  return `workspace-${createHash("sha256").update(canonicalRoot, "utf8").digest("hex")}`;
}

function readWorkspacePath(input: WorkspaceConfigLoadInput): string {
  try {
    const workspacePath = input.workspacePath;
    if (
      typeof workspacePath !== "string" ||
      workspacePath.trim().length === 0 ||
      workspacePath.includes("\u0000")
    ) {
      throw hostError("WORKSPACE_INVALID");
    }
    return workspacePath;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "WORKSPACE_INVALID") {
      throw error;
    }
    throw hostError("WORKSPACE_INVALID");
  }
}

async function resolveCanonicalRoot(workspacePath: string): Promise<string> {
  try {
    const initial = await lstat(workspacePath);
    if (initial.isSymbolicLink() || !initial.isDirectory()) {
      throw hostError("WORKSPACE_INVALID");
    }
    const canonicalRoot = await realpath(workspacePath);
    const canonical = await lstat(canonicalRoot);
    if (canonical.isSymbolicLink() || !canonical.isDirectory()) {
      throw hostError("WORKSPACE_INVALID");
    }
    return canonicalRoot;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "WORKSPACE_INVALID") {
      throw error;
    }
    throw hostError("WORKSPACE_INVALID");
  }
}

async function readWorkspaceConfig(configPath: string): Promise<CodeSentinelConfig> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const initial = await lstat(configPath);
    if (initial.isSymbolicLink() || !initial.isFile() || initial.size > MAX_CONFIG_BYTES) {
      throw hostError("CONFIG_INVALID");
    }
    handle = await open(configPath, "r");
    const opened = await handle.stat();
    if (opened.isSymbolicLink() || !opened.isFile() || opened.size > MAX_CONFIG_BYTES) {
      throw hostError("CONFIG_INVALID");
    }
    const contents = await readExactly(handle, opened.size);
    const afterRead = await handle.stat();
    if (afterRead.size !== opened.size || afterRead.isSymbolicLink() || !afterRead.isFile()) {
      throw hostError("CONFIG_INVALID");
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(contents.toString("utf8")) as unknown;
    } catch {
      throw hostError("CONFIG_INVALID");
    }
    const parsed = CodeSentinelConfigSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw hostError("CONFIG_INVALID");
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "CONFIG_INVALID") {
      throw error;
    }
    throw hostError("CONFIG_INVALID");
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // No I/O detail is exposed from this Host boundary.
      }
    }
  }
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
): Promise<Buffer> {
  const contents = Buffer.alloc(size);
  let offset = 0;
  while (offset < contents.length) {
    const result = await handle.read(contents, offset, contents.length - offset, offset);
    if (result.bytesRead === 0) {
      throw hostError("CONFIG_INVALID");
    }
    offset += result.bytesRead;
  }
  return contents;
}

function snapshotConfig(config: CodeSentinelConfig): CodeSentinelConfig {
  const result: CodeSentinelConfig = {
    providerProfileId: config.providerProfileId,
    allowedPaths: [...config.allowedPaths],
    verificationCommands: config.verificationCommands.map((command) => ({
      id: command.id,
      launcher: command.launcher,
      args: command.args,
      timeoutMs: command.timeoutMs,
      maxOutputBytes: command.maxOutputBytes,
    })),
    ...(config.sensitivePatterns === undefined
      ? {}
      : { sensitivePatterns: [...config.sensitivePatterns] }),
  };
  Object.freeze(result.allowedPaths);
  Object.freeze(result.sensitivePatterns);
  for (const command of result.verificationCommands) {
    Object.freeze(command.args);
    Object.freeze(command);
  }
  Object.freeze(result.verificationCommands);
  return Object.freeze(result);
}
